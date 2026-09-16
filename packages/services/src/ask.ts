import { randomUUID } from "node:crypto";
import type { GenerationResult, Generator } from "@rag/rag";
import {
  buildCitations,
  contextualizeQuestion,
  filterCitationsToAnswer,
  type ConversationTurn,
} from "@rag/rag";
import type {
  AuthorizationScope,
  RetrievalResult,
  SanitizedRetrievalResult,
} from "@rag/core";
import { sanitizeRetrievalResults } from "@rag/core";
import { getChunksByOrdinals } from "@rag/db";
import type { ServiceDeps } from "./deps.js";
import { GenerationNotConfiguredError } from "./errors.js";

/**
 * The knowledge base is indexed as-is, so the same SOP often exists as several
 * copies. Identical chunks from different files would otherwise take several
 * of the `topK` context slots with one passage. Keeps the best-ranked copy.
 *
 * Compared on the chunk BODY: chunk text opens with a `# Title › heading` line
 * that differs between copies with different file names, so that line is
 * ignored, and whitespace and case are normalized.
 */
export function dropDuplicateChunks(
  results: RetrievalResult[],
): RetrievalResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const newline = r.text.indexOf("\n");
    const body =
      r.text.startsWith("# ") && newline !== -1
        ? r.text.slice(newline)
        : r.text;
    const key = body.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Per-document diversity cap. Returns a NEW array (no mutation) keeping at most
 * `cap` chunks from any single document, preserving the original relevance
 * order. Stops one long file from crowding out other sources before the
 * generator (or caller) sees the results. `cap <= 0` disables the cap.
 */
export function capChunksPerDocument(
  results: RetrievalResult[],
  cap: number,
): RetrievalResult[] {
  if (cap <= 0) return results;
  const seenPerDoc = new Map<string, number>();
  return results.filter((r) => {
    const count = seenPerDoc.get(r.document.id) ?? 0;
    if (count >= cap) return false;
    seenPerDoc.set(r.document.id, count + 1);
    return true;
  });
}

/**
 * `ServiceDeps` with the generator proven non-null. Retrieval+generation logic
 * is typed against this so "no generator" is unrepresentable in the core path;
 * the one place that proves it is the `askQuestion` seam below.
 */
export type AskDeps = Omit<ServiceDeps, "generator"> & {
  generator: Generator;
};

export interface AskInput {
  question: string;
  /** Falls back to `defaultTopK` when omitted. */
  topK?: number;
  sourceIds?: string[];
  filter?: Record<string, string | string[]>;
  /**
   * Prior turns of the conversation, already resolved by the transport (today
   * the request body; later a server-side session). Used ONLY to rewrite a
   * follow-up into a standalone RETRIEVAL query — generation always receives
   * `question` itself. How many turns count is decided by the condenser.
   */
  history?: ConversationTurn[];
}

/**
 * Server-sourced review status stamped on every generated answer. Circular 230
 * §10.37: AI output is a DRAFT that a qualified practitioner must review before
 * use. It is a typed field (not free text in the answer body) so a transport or
 * UI cannot silently drop it, and it is set HERE — never by the client.
 */
export const REVIEW_STATUS = "draft_requires_practitioner_review" as const;
export const ANSWER_DISCLAIMER =
  "Draft — AI-generated and may be inaccurate. Requires review by a qualified " +
  "practitioner before use.";

export interface AskResult {
  answer: string;
  citations: GenerationResult["citations"];
  retrieved: SanitizedRetrievalResult[];
  /** Always present; AI answers are drafts pending practitioner review. */
  reviewStatus: typeof REVIEW_STATUS;
  /** Human-readable form of `reviewStatus` for direct display. */
  disclaimer: string;
  /** Stable id for this answer; feedback references it. */
  answerId: string;
}

export const EMPTY_ANSWER =
  "The available documents do not contain enough information to answer that.";

/**
 * Retrieval + grounded generation. Transport-agnostic core of POST /ask and
 * the `ask` MCP tool.
 *
 * - Throws `GenerationNotConfiguredError` when no generator is configured.
 * - Short-circuits with a fixed answer when retrieval returns nothing (the
 *   model would otherwise hallucinate).
 *
 * `scope` is the MANDATORY confidentiality boundary (P1) — the same enforced
 * source-id scope applied to /search. Generation runs against the FULL
 * retrieved results (it only ever emits answer text + citations), but the
 * `retrieved` array returned to the caller is passed through the metadata
 * allowlist (P2) so non-exposable metadata never leaves the service.
 */
export async function askQuestion(
  deps: ServiceDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
  maxChunksPerDocument = 0,
  options: AskOptions = {},
): Promise<AskResult> {
  if (!deps.generator) {
    throw new GenerationNotConfiguredError();
  }
  // Past this seam the generator is proven present; the core logic runs on the
  // narrowed `AskDeps` so it never has to re-check (or `!`-assert) the nullable.
  return ask(
    { ...deps, generator: deps.generator },
    input,
    defaultTopK,
    scope,
    maxChunksPerDocument,
    options,
  );
}

/**
 * How many extra candidates to fetch when the per-document cap is on. Capping
 * exactly `topK` results silently shrinks the generator's context — worst when
 * one long document dominates the ranking, which is precisely when the cap is
 * meant to make room for other sources.
 */
const CAP_OVERFETCH_MULTIPLIER = 3;

/**
 * "Small-to-big" context expansion. For the top `documents` documents in the
 * ranking, fetch up to `chunksPerDocument` chunks adjacent to the ones that
 * were retrieved, so a procedure whose steps span several chunks reaches the
 * generator whole rather than as isolated fragments.
 */
export interface NeighborExpansion {
  /** How many top-ranked documents to expand. `0` disables expansion. */
  documents: number;
  /** Maximum extra chunks fetched per expanded document. */
  chunksPerDocument: number;
}

/** Tuning for /ask beyond the per-document cap. Every field is optional. */
export interface AskOptions {
  neighborExpansion?: NeighborExpansion;
  /**
   * Relevance floor. Chunks with no keyword match AND dense (cosine)
   * similarity below this are dropped before generation; if none remain the
   * fixed refusal is returned without a model call. Unset disables it — tune
   * it from the audit log's `top_score` distribution for the live embedder.
   */
  minDenseSimilarity?: number;
}

/**
 * Hybrid search always returns its nearest neighbours, so without a floor an
 * off-topic question still reaches the model with whatever was least unlike
 * it. A chunk with a keyword match is kept regardless: identifiers and form
 * numbers score low on cosine similarity by nature.
 */
export function applyRelevanceFloor(
  results: RetrievalResult[],
  minDenseSimilarity: number | undefined,
): RetrievalResult[] {
  if (minDenseSimilarity === undefined) return results;
  return results.filter(
    (r) => r.sparseScore > 0 || r.denseScore >= minDenseSimilarity,
  );
}

export const NO_NEIGHBOR_EXPANSION: NeighborExpansion = {
  documents: 0,
  chunksPerDocument: 0,
};

/**
 * Add neighbouring chunks of the top documents to `results`. Originals keep
 * their positions; added chunks are appended with zero scores (they were not
 * retrieved on relevance) and share their document's object. Neighbour order
 * follows the rank of the retrieved chunk they sit beside, so a small budget
 * spends itself around the best evidence first.
 *
 * Only documents already present in `results` are touched, and those were
 * returned by the scope-enforced retriever, so expansion cannot widen access.
 * A failure degrades to the unexpanded results rather than failing the answer.
 */
export async function expandWithNeighbors(
  deps: Pick<ServiceDeps, "db" | "logger">,
  results: RetrievalResult[],
  expansion: NeighborExpansion,
): Promise<RetrievalResult[]> {
  if (expansion.documents <= 0 || expansion.chunksPerDocument <= 0) {
    return results;
  }

  const byDocument = new Map<string, RetrievalResult[]>();
  for (const r of results) {
    const list = byDocument.get(r.document.id);
    if (list) list.push(r);
    else byDocument.set(r.document.id, [r]);
  }
  const topDocuments = [...byDocument.entries()].slice(
    0,
    expansion.documents,
  );

  try {
    const added = await Promise.all(
      topDocuments.map(async ([documentId, hits]) => {
        const have = new Set(hits.map((h) => h.chunk.ordinal));
        const wanted: number[] = [];
        for (const h of hits) {
          for (const o of [h.chunk.ordinal - 1, h.chunk.ordinal + 1]) {
            if (o >= 0 && !have.has(o) && !wanted.includes(o)) wanted.push(o);
          }
        }
        const ordinals = wanted.slice(0, expansion.chunksPerDocument);
        if (ordinals.length === 0) return [];
        const rows = await getChunksByOrdinals(deps.db, documentId, ordinals);
        const document = hits[0]!.document;
        return rows.map(
          (row): RetrievalResult => ({
            text: row.text,
            score: 0,
            denseScore: 0,
            sparseScore: 0,
            document,
            chunk: {
              id: row.id,
              ordinal: row.ordinal,
              headingPath: row.headingPath,
              ...(row.page != null ? { page: row.page } : {}),
            },
          }),
        );
      }),
    );
    return [...results, ...added.flat()];
  } catch (err) {
    deps.logger.warn(
      { err, marker: "ask.neighbor_expansion_failed" },
      "neighbour chunk expansion failed; answering from retrieved chunks only",
    );
    return results;
  }
}

/**
 * Let the generator remove context it must not send (per-chunk TRI screening),
 * BEFORE generation. Everything downstream — the prompt, the citations, and the
 * `retrieved` returned to the caller — uses the screened list, so the `[N]` the
 * model writes always indexes the documents it was actually shown. Empty
 * retrieval is left alone: it short-circuits without a provider call.
 */
function screenForGeneration(
  deps: AskDeps,
  question: string,
  retrieved: RetrievalResult[],
): RetrievalResult[] {
  if (retrieved.length === 0) return retrieved;
  // `screen` is required by the Generator contract; this guard only tolerates
  // unit-test doubles cast past the type. Every real generator screens.
  if (typeof deps.generator.screen !== "function") return retrieved;
  return deps.generator.screen(question, retrieved);
}

/**
 * The text retrieval searches with: the question itself, or — when there is
 * conversation history and the generator offers a bare completion — the
 * follow-up rewritten as a standalone question. Condensation fails open.
 */
async function retrievalQuery(deps: AskDeps, input: AskInput): Promise<string> {
  const complete = deps.generator.complete?.bind(deps.generator);
  if (!complete || !input.history?.length) return input.question;
  return contextualizeQuestion(complete, input.question, input.history);
}

async function retrieveForAnswer(
  deps: AskDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
  maxChunksPerDocument: number,
): Promise<RetrievalResult[]> {
  const query = buildQuery(
    input,
    defaultTopK,
    await retrievalQuery(deps, input),
  );
  if (maxChunksPerDocument <= 0) {
    return dropDuplicateChunks(await deps.retriever.search(query, scope));
  }
  const candidates = await deps.retriever.search(
    { ...query, topK: query.topK * CAP_OVERFETCH_MULTIPLIER },
    scope,
  );
  return capChunksPerDocument(
    dropDuplicateChunks(candidates),
    maxChunksPerDocument,
  ).slice(
    0,
    query.topK,
  );
}

function buildQuery(input: AskInput, defaultTopK: number, query: string) {
  return {
    query,
    topK: input.topK ?? defaultTopK,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    ...(input.filter ? { filter: input.filter } : {}),
  };
}

async function ask(
  deps: AskDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
  maxChunksPerDocument: number,
  options: AskOptions,
): Promise<AskResult> {
  const answerId = randomUUID();
  const retrieved = screenForGeneration(
    deps,
    input.question,
    await expandWithNeighbors(
      deps,
      applyRelevanceFloor(
        await retrieveForAnswer(
          deps,
          input,
          defaultTopK,
          scope,
          maxChunksPerDocument,
        ),
        options.minDenseSimilarity,
      ),
      options.neighborExpansion ?? NO_NEIGHBOR_EXPANSION,
    ),
  );

  if (retrieved.length === 0) {
    return {
      answer: EMPTY_ANSWER,
      citations: [],
      retrieved: [],
      reviewStatus: REVIEW_STATUS,
      disclaimer: ANSWER_DISCLAIMER,
      answerId,
    };
  }

  const result = await deps.generator.answer(input.question, retrieved);
  return {
    answer: result.answer,
    // Faithful to what the answer actually cites, not everything retrieved.
    // Built here, from the same `retrieved` the generator saw, so the
    // streaming and non-streaming paths cannot drift apart.
    citations: filterCitationsToAnswer(
      result.answer,
      buildCitations(retrieved),
    ),
    retrieved: sanitizeRetrievalResults(retrieved),
    reviewStatus: REVIEW_STATUS,
    disclaimer: ANSWER_DISCLAIMER,
    answerId,
  };
}

/**
 * Incremental answer text chunk, or the terminal payload carrying citations
 * and the (PII-allowlisted) retrieved results. Mirrors the SSE event contract
 * consumed by the web client's stream parser.
 */
export type AskStreamEvent =
  | { type: "token"; text: string }
  | {
      type: "done";
      citations: GenerationResult["citations"];
      retrieved: SanitizedRetrievalResult[];
      reviewStatus: typeof REVIEW_STATUS;
      disclaimer: string;
      answerId: string;
    };

/**
 * Streaming counterpart of `askQuestion`. Same confidentiality scope (P1),
 * empty-retrieval short-circuit, and metadata allowlist (P2) — but yields the
 * answer incrementally so transports can forward tokens as they arrive.
 *
 * Throws `GenerationNotConfiguredError` synchronously (before any token) when
 * no generator is configured, so a transport can still map it to a 503 before
 * committing to a streaming response.
 */
export async function* askQuestionStream(
  deps: ServiceDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
  maxChunksPerDocument = 0,
  options: AskOptions = {},
): AsyncGenerator<AskStreamEvent> {
  if (!deps.generator) {
    throw new GenerationNotConfiguredError();
  }
  yield* askStream(
    { ...deps, generator: deps.generator },
    input,
    defaultTopK,
    scope,
    maxChunksPerDocument,
    options,
  );
}

async function* askStream(
  deps: AskDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
  maxChunksPerDocument: number,
  options: AskOptions,
): AsyncGenerator<AskStreamEvent> {
  const answerId = randomUUID();
  const retrieved = screenForGeneration(
    deps,
    input.question,
    await expandWithNeighbors(
      deps,
      applyRelevanceFloor(
        await retrieveForAnswer(
          deps,
          input,
          defaultTopK,
          scope,
          maxChunksPerDocument,
        ),
        options.minDenseSimilarity,
      ),
      options.neighborExpansion ?? NO_NEIGHBOR_EXPANSION,
    ),
  );

  if (retrieved.length === 0) {
    yield { type: "token", text: EMPTY_ANSWER };
    yield {
      type: "done",
      citations: [],
      retrieved: [],
      reviewStatus: REVIEW_STATUS,
      disclaimer: ANSWER_DISCLAIMER,
      answerId,
    };
    return;
  }

  let answerText = "";
  for await (const chunk of deps.generator.answerStream(
    input.question,
    retrieved,
  )) {
    if (chunk) {
      answerText += chunk;
      yield { type: "token", text: chunk };
    }
  }

  yield {
    type: "done",
    // Faithful to what the answer actually cites, not everything retrieved.
    citations: filterCitationsToAnswer(answerText, buildCitations(retrieved)),
    retrieved: sanitizeRetrievalResults(retrieved),
    reviewStatus: REVIEW_STATUS,
    disclaimer: ANSWER_DISCLAIMER,
    answerId,
  };
}
