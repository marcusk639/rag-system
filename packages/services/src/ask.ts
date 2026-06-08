import type { GenerationResult } from "@rag/rag";
import type { RetrievalResult } from "@rag/core";
import type { ServiceDeps } from "./deps.js";
import { GenerationNotConfiguredError } from "./errors.js";

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
