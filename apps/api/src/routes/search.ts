import {
  type Config,
  type RetrievalQuery,
  sanitizeRetrievalResults,
} from "@rag/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { scopeFromRequest } from "./authz.js";

/**
 * Metadata filter: each key matches against `documents.metadata->>key`. A
 * string value is exact-match; an array is OR-matched (any of the values).
 *
 * Bounded to prevent query amplification: an attacker with a valid token
 * could otherwise send hundreds of keys, each with hundreds of values,
 * causing the hybrid-search query to balloon into an N-way OR scan.
 */
const FilterValue = z.union([
  z.string().max(256),
  z.array(z.string().max(256)).max(50),
]);
// 20-key cap stops query amplification — z.record has no `.max()` on its
// key count, so we apply it via `.refine()`. With per-value bounds already
// in place, 20 keys × 50 values × 256 chars is the worst case (256 KB of
// filter data), well below the body-size limit and the planner's tolerance.
const MAX_FILTER_KEYS = 20;
const FilterSchema = z
  .record(z.string().max(64), FilterValue)
  .refine((obj) => Object.keys(obj).length <= MAX_FILTER_KEYS, {
    message: `filter accepts at most ${MAX_FILTER_KEYS} keys`,
  });

const SearchBody = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().positive().max(100).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
  filter: FilterSchema.optional(),
});

export async function registerSearchRoute(
  app: FastifyInstance,
  deps: Deps,
  config: Config,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /search — retrieval only (no LLM)
  typed.post("/search", { schema: { body: SearchBody } }, async (request) => {
    const { query, topK, sourceIds, filter } = request.body;

    const rq: RetrievalQuery = {
      query,
      topK: topK ?? config.retrieval.defaultTopK,
      ...(sourceIds ? { sourceIds } : {}),
      ...(filter ? { filter } : {}),
    };

    // MANDATORY confidentiality boundary: the principal's enforced source-id
    // scope (admin => all; scoped => only its sources; missing => deny all).
    // The optional caller `sourceIds` above narrows WITHIN this scope.
    const results = await deps.retriever.search(rq, scopeFromRequest(request));
    // PII boundary: strip non-allowlisted metadata fields (author/from/to/
    // subject/extra) before the results leave the API. See @rag/core
    // metadata-policy. Retrieval/filtering above used the full metadata.
    return { results: sanitizeRetrievalResults(results) };
  });
}
