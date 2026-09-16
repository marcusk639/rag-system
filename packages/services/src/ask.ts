import { randomUUID } from "node:crypto";
import type { GenerationResult, Generator } from "@rag/rag";
import { buildCitations, filterCitationsToAnswer } from "@rag/rag";
import type {
  AuthorizationScope,
  RetrievalResult,
  SanitizedRetrievalResult,
} from "@rag/core";
import { sanitizeRetrievalResults } from "@rag/core";
import type { ServiceDeps } from "./deps.js";
import { GenerationNotConfiguredError } from "./errors.js";

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
  );
}

/**
 * How many extra candidates to fetch when the per-document cap is on. Capping
 * exactly `topK` results silently shrinks the generator's context — worst when
 * one long document dominates the ranking, which is precisely when the cap is
 * meant to make room for other sources.
 */
const CAP_OVERFETCH_MULTIPLIER = 3;

async function retrieveForAnswer(
  deps: AskDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
  maxChunksPerDocument: number,
): Promise<RetrievalResult[]> {
  const query = buildQuery(input, defaultTopK);
  if (maxChunksPerDocument <= 0) {
    return deps.retriever.search(query, scope);
  }
  const candidates = await deps.retriever.search(
    { ...query, topK: query.topK * CAP_OVERFETCH_MULTIPLIER },
    scope,
  );
  return capChunksPerDocument(candidates, maxChunksPerDocument).slice(
    0,
    query.topK,
  );
}

function buildQuery(input: AskInput, defaultTopK: number) {
  return {
    query: input.question,
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
): Promise<AskResult> {
  const answerId = randomUUID();
  const retrieved = await retrieveForAnswer(
    deps,
    input,
    defaultTopK,
    scope,
    maxChunksPerDocument,
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
    citations: filterCitationsToAnswer(result.answer, result.citations),
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
  );
}

async function* askStream(
  deps: AskDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
  maxChunksPerDocument: number,
): AsyncGenerator<AskStreamEvent> {
  const answerId = randomUUID();
  const retrieved = await retrieveForAnswer(
    deps,
    input,
    defaultTopK,
    scope,
    maxChunksPerDocument,
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
