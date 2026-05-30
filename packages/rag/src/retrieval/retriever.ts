import type {
  EmbeddingProvider,
  RetrievalQuery,
  RetrievalResult,
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

  async search(query: RetrievalQuery): Promise<RetrievalResult[]> {
    const embedding = await this.embedder.embed(query.query);

    return hybridSearch(this.db, {
      query: query.query,
      queryEmbedding: embedding.vector,
      topK: query.topK ?? this.defaults.topK,
      sourceIds: query.sourceIds,
      metadataFilter: query.filter,
      weights: query.weights ?? {
        dense: this.defaults.denseWeight,
        sparse: this.defaults.sparseWeight,
      },
    });
  }
}
