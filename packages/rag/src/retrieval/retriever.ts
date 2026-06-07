import {
  effectiveSourceFilter,
  type AuthorizationScope,
  type EmbeddingProvider,
  type RetrievalQuery,
  type RetrievalResult,
} from "@rag/core";
import { hybridSearch, type Db } from "@rag/db";

/**
 * Orchestrates a single retrieval call:
 *   1. Embed the query (one provider call).
 *   2. Run hybrid dense + sparse search in Postgres.
 *   3. Optionally rerank (placeholder — wire in a cross-encoder here later).
 *   4. Return ranked results with citation metadata.
 *
 * Why the embed happens here and not in the SQL: pgvector doesn't have a
 * built-in embedder, and centralizing the embed call lets us batch multi-query
 * variants (HyDE, query expansion) before the SQL round-trip.
 */
export class Retriever {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly defaults: {
      topK: number;
      denseWeight: number;
      sparseWeight: number;
    },
  ) {}

  /**
   * Run a retrieval.
   *
   * `authz` is a MANDATORY positional argument — NOT an optional field on
   * `query` — so no route can forget to pass it. It carries the caller's
   * principal scope (`enforcedSourceIds`: `null` === admin/unrestricted, `[]`
   * === fail closed). The effective source filter handed to the DB is the
   * caller's optional `query.sourceIds` convenience filter INTERSECTED with the
   * enforced set (admin bypasses; empty scope => zero rows). See @rag/core
   * `effectiveSourceFilter`.
   */
  async search(
    query: RetrievalQuery,
    authz: AuthorizationScope,
  ): Promise<RetrievalResult[]> {
    const enforcedSourceIds = effectiveSourceFilter(
      query.sourceIds,
      authz.enforcedSourceIds,
    );

    const embedding = await this.embedder.embed(query.query);

    return hybridSearch(this.db, {
      query: query.query,
      queryEmbedding: embedding.vector,
      topK: query.topK ?? this.defaults.topK,
      // Mandatory ACL boundary (already intersected with the caller filter).
      enforcedSourceIds,
      // The optional caller filter is folded into `enforcedSourceIds` above,
      // so it is intentionally NOT passed again as the convenience `sourceIds`
      // (which would re-AND the same set — harmless but redundant).
      metadataFilter: query.filter,
      weights: query.weights ?? {
        dense: this.defaults.denseWeight,
        sparse: this.defaults.sparseWeight,
      },
    });
  }
}
