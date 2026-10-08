/**
 * Single source of truth for the dimensionality of the `chunks.embedding`
 * pgvector column.
 *
 * This constant is consumed in TWO places that must never drift:
 *   1. The column definition in `schema.ts` (`vector("embedding", { dimensions })`).
 *   2. `assertEmbeddingDimensions()` below, called at app startup.
 *
 * The column is `vector(768)` to match Gemini `gemini-embedding-001`, the
 * current default. It is NOT sized for `text-embedding-004`, which this file
 * named until 2026-10-07: that model is retired and must never be configured
 * (see CLAUDE.md). The coincidence of dimensions made the stale reference
 * harmless to run but dangerous to read, since this is the file someone
 * consults before changing the column.
 *
 * The system is provider-pluggable, and the other defaults reach 768 by
 * different routes: `Xenova/bge-base-en-v1.5` is natively 768, while OpenAI's
 * `text-embedding-3-small` is natively 1536 and is truncated to 768 by the
 * provider via the `dimensions` parameter. So a 1536-dim model is not a
 * mismatch to "fix" — but the
 * physical column type is fixed by the migration. Switching providers WITHOUT
 * re-typing this column would otherwise only fail at the first INSERT — after
 * embedding credits are spent and a sync is half-done, leaving partial state.
 *
 * Changing this value requires a corresponding migration that re-types the
 * column and rebuilds the HNSW index (see migrations / schema.ts header note).
 */
export const EMBEDDING_COLUMN_DIMENSIONS = 768;

/**
 * Fail fast at startup if the configured embedding provider's output
 * dimensionality does not match the physical `chunks.embedding` column.
 *
 * Call this once, early in each app that produces embeddings (api/mcp/worker),
 * BEFORE building deps or serving traffic / processing jobs — so a misconfigured
 * provider is rejected before any embedding API call or DB write occurs.
 *
 * @param configuredDimensions `config.embedding.dimensions` from @rag/core.
 * @throws {Error} with an actionable message when the value is invalid or
 *   does not equal {@link EMBEDDING_COLUMN_DIMENSIONS}.
 */
export function assertEmbeddingDimensions(configuredDimensions: number): void {
  if (!Number.isInteger(configuredDimensions) || configuredDimensions <= 0) {
    throw new Error(
      `Invalid embedding dimensions: expected a positive integer, got ${configuredDimensions}. ` +
        `Check EMBEDDING_DIMENSIONS in the environment / @rag/core config.embedding.dimensions.`,
    );
  }

  if (configuredDimensions !== EMBEDDING_COLUMN_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: the configured embedding provider emits ` +
        `${configuredDimensions}-dim vectors, but the chunks.embedding column is ` +
        `vector(${EMBEDDING_COLUMN_DIMENSIONS}). Inserting ${configuredDimensions}-dim ` +
        `vectors would fail at the first INSERT, after embedding credits are spent ` +
        `and a sync is half-done. To fix: either set EMBEDDING_DIMENSIONS=` +
        `${EMBEDDING_COLUMN_DIMENSIONS} (and use a ${EMBEDDING_COLUMN_DIMENSIONS}-dim ` +
        `model), or run a migration that re-types chunks.embedding to ` +
        `vector(${configuredDimensions}) and rebuilds the HNSW index, updating ` +
        `EMBEDDING_COLUMN_DIMENSIONS in @rag/db to match.`,
    );
  }
}
