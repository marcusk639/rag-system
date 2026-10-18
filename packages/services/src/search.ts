import type { AuthorizationScope, SanitizedRetrievalResult } from "@rag/core";
import { sanitizeRetrievalResults } from "@rag/core";
import { dropDuplicateChunks } from "./ask.js";
import type { ServiceDeps } from "./deps.js";

/**
 * Candidates fetched per requested result. The same SOP is often indexed as
 * several files; collapsing those copies would otherwise return fewer than
 * `topK` distinct passages.
 */
const DUPLICATE_OVERFETCH_MULTIPLIER = 2;

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
 *
 * `scope` is the MANDATORY confidentiality boundary (P1): the principal's
 * enforced source-id set (admin => all; scoped => only its sources; missing =>
 * deny all). It is passed to the retriever, which intersects it with any caller
 * `sourceIds` so the optional caller filter can only narrow WITHIN the scope.
 *
 * Results pass through the metadata allowlist (P2) before returning, so
 * non-exposable metadata (author/from/to/subject/connector `extra`) never
 * leaves the service regardless of transport.
 */
export async function searchDocuments(
  deps: ServiceDeps,
  input: SearchInput,
  defaultTopK: number,
  scope: AuthorizationScope,
): Promise<SanitizedRetrievalResult[]> {
  // The query is embedded by the configured provider, which may be an external
  // API. Screen it under the generator's TRI policy first, exactly as /ask
  // does. A search-only deployment (no generator) has no policy to apply.
  if (deps.generator && typeof deps.generator.screen === "function") {
    deps.generator.screen(input.query, []);
  }
  const topK = input.topK ?? defaultTopK;
  const results = await deps.retriever.search(
    {
      query: input.query,
      topK: topK * DUPLICATE_OVERFETCH_MULTIPLIER,
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
    },
    scope,
  );
  return sanitizeRetrievalResults(dropDuplicateChunks(results).slice(0, topK));
}
