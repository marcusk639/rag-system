import type { RetrievalResult } from "@rag/core";
import type { ServiceDeps } from "./deps.js";

export interface SearchInput {
  query: string;
  /** Falls back to `defaultTopK` when omitted. */
  topK?: number;
  sourceIds?: string[];
  filter?: Record<string, string | string[]>;
}

/**
 * Hybrid retrieval. Transport-agnostic core of POST /search and the
 * `search_documents` MCP tool.
 */
export async function searchDocuments(
  deps: ServiceDeps,
  input: SearchInput,
  defaultTopK: number,
): Promise<RetrievalResult[]> {
  return deps.retriever.search({
    query: input.query,
    topK: input.topK ?? defaultTopK,
    ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    ...(input.filter ? { filter: input.filter } : {}),
  });
}
