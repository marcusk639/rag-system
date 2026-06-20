import type { GenerationResult, Generator } from "@rag/rag";
import { buildCitations } from "@rag/rag";
import type { AuthorizationScope, SanitizedRetrievalResult } from "@rag/core";
import { sanitizeRetrievalResults } from "@rag/core";
import type { ServiceDeps } from "./deps.js";
import { GenerationNotConfiguredError } from "./errors.js";

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

export interface AskResult {
  answer: string;
  citations: GenerationResult["citations"];
  retrieved: SanitizedRetrievalResult[];
}

const EMPTY_ANSWER =
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
): Promise<AskResult> {
  if (!deps.generator) {
    throw new GenerationNotConfiguredError();
  }
  // Past this seam the generator is proven present; the core logic runs on the
  // narrowed `AskDeps` so it never has to re-check (or `!`-assert) the nullable.
  return ask({ ...deps, generator: deps.generator }, input, defaultTopK, scope);
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
): Promise<AskResult> {
  const retrieved = await deps.retriever.search(
    buildQuery(input, defaultTopK),
    scope,
  );

  if (retrieved.length === 0) {
    return { answer: EMPTY_ANSWER, citations: [], retrieved: [] };
  }

  const result = await deps.generator.answer(input.question, retrieved);
  return {
    answer: result.answer,
    citations: result.citations,
    retrieved: sanitizeRetrievalResults(retrieved),
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
): AsyncGenerator<AskStreamEvent> {
  if (!deps.generator) {
    throw new GenerationNotConfiguredError();
  }
  yield* askStream(
    { ...deps, generator: deps.generator },
    input,
    defaultTopK,
    scope,
  );
}

async function* askStream(
  deps: AskDeps,
  input: AskInput,
  defaultTopK: number,
  scope: AuthorizationScope,
): AsyncGenerator<AskStreamEvent> {
  const retrieved = await deps.retriever.search(
    buildQuery(input, defaultTopK),
    scope,
  );

  if (retrieved.length === 0) {
    yield { type: "token", text: EMPTY_ANSWER };
    yield { type: "done", citations: [], retrieved: [] };
    return;
  }

  for await (const chunk of deps.generator.answerStream(
    input.question,
    retrieved,
  )) {
    if (chunk) yield { type: "token", text: chunk };
  }

  yield {
    type: "done",
    citations: buildCitations(retrieved),
    retrieved: sanitizeRetrievalResults(retrieved),
  };
}
