import type { GenerationResult, Generator } from "@rag/rag";
import type { RetrievalResult } from "@rag/core";
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
  retrieved: RetrievalResult[];
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
 */
export async function askQuestion(
  deps: ServiceDeps,
  input: AskInput,
  defaultTopK: number,
): Promise<AskResult> {
  if (!deps.generator) {
    throw new GenerationNotConfiguredError();
  }
  // Past this seam the generator is proven present; the core logic runs on the
  // narrowed `AskDeps` so it never has to re-check (or `!`-assert) the nullable.
  return ask({ ...deps, generator: deps.generator }, input, defaultTopK);
}

async function ask(
  deps: AskDeps,
  input: AskInput,
  defaultTopK: number,
): Promise<AskResult> {
  const retrieved = await deps.retriever.search({
    query: input.question,
    topK: input.topK ?? defaultTopK,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    ...(input.filter ? { filter: input.filter } : {}),
  });

  if (retrieved.length === 0) {
    return { answer: EMPTY_ANSWER, citations: [], retrieved };
  }

  const result = await deps.generator.answer(input.question, retrieved);
  return { answer: result.answer, citations: result.citations, retrieved };
}
