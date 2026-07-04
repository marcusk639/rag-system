import {
  effectiveSourceFilter,
  type AuthorizationScope,
  type EmbeddingProvider,
  type Reranker,
  type RetrievalQuery,
  type RetrievalResult,
} from "@rag/core";
import { hybridSearch, type Db } from "@rag/db";

/**
 * Orchestrates a single retrieval call:
 *   1. Embed the query (one provider call).
 *   2. Run hybrid dense + sparse search in Postgres.
 *   3. Optionally rerank the over-fetched candidate pool by true relevance.
 *   4. Return ranked results with citation metadata.
 *
 * Why the embed happens here and not in the SQL: pgvector doesn't have a
 * built-in embedder, and centralizing the embed call lets us batch multi-query
 * variants (HyDE, query expansion) before the SQL round-trip.
 */
export class Retriever {
  private readonly reranker: Reranker | null;
  private readonly rerankPoolMultiplier: number;
  private readonly onRerankError: (err: unknown) => void;

  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly defaults: {
      topK: number;
      denseWeight: number;
      sparseWeight: number;
    },
    /**
     * Optional reranking stage. When a reranker is provided, the retriever
     * over-fetches `poolMultiplier × topK` candidates from hybrid search, asks
     * the reranker to re-order them by true relevance, and returns the top
     * `topK`. When null (the default), behavior is identical to plain hybrid
     * search — no over-fetch. `onError` is invoked (not thrown) if the reranker
     * fails, after which we degrade to the RRF order.
     */
    rerank?: {
      reranker: Reranker | null;
      poolMultiplier?: number;
      onError?: (err: unknown) => void;
    },
  ) {
    this.reranker = rerank?.reranker ?? null;
    this.rerankPoolMultiplier = rerank?.poolMultiplier ?? 5;
    this.onRerankError = rerank?.onError ?? (() => {});
  }

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

    // Use the query-side embedding when the provider distinguishes query vs.
    // document task types (Gemini); fall back to `embed` for providers that
    // don't (OpenAI). Embedding a query as a document degrades retrieval.
    const embedding = this.embedder.embedQuery
      ? await this.embedder.embedQuery(query.query)
      : await this.embedder.embed(query.query);

    const topK = query.topK ?? this.defaults.topK;
    // With a reranker, over-fetch a candidate pool so it has more than `topK`
    // to choose from. Without one, fetch exactly `topK` (no behavior change).
    const fetchK = this.reranker ? topK * this.rerankPoolMultiplier : topK;

    const results = await hybridSearch(this.db, {
      query: query.query,
      queryEmbedding: embedding.vector,
      topK: fetchK,
      // Restrict dense (cosine) matching to chunks embedded by this same
      // provider/model — vectors from a different provider aren't comparable
      // even at matching dimensionality (see HybridSearchOptions' comment).
      embeddingProvider: this.embedder.name,
      embeddingModel: this.embedder.model,
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

    if (!this.reranker) return results;

    // Rerank the pool by true relevance, returning the top `topK`. A reranker
    // failure must never fail the query — degrade to the RRF order (truncated).
    try {
      return await this.reranker.rerank(query.query, results, topK);
    } catch (err) {
      this.onRerankError(err);
      return results.slice(0, topK);
    }
  }
}
