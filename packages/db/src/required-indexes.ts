import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Single source of truth for the search indexes WITHOUT WHICH RETRIEVAL
 * SILENTLY DEGRADES TO SEQUENTIAL SCANS.
 *
 * These two indexes (and the `tsv` trigger that feeds the GIN index) are
 * created and owned by `packages/db/drizzle/0000_init.sql` — NOT by the
 * Drizzle model in `schema.ts`. Drizzle cannot express either object cleanly
 * (HNSW operator classes / `WITH (...)` opclass options, and a plpgsql trigger
 * for the tsvector), so a `drizzle-kit generate` run does not see them and
 * would otherwise diff them as "removed" and emit `DROP INDEX`. Dropping them
 * produces NO error and NO failing test — dense + sparse search just fall back
 * to sequential scans and queries quietly get slow.
 *
 * This list is the regression guard's contract. It MUST stay in sync with the
 * `CREATE INDEX` statements in `0000_init.sql`:
 *   - chunks_embedding_hnsw_idx : HNSW, vector_cosine_ops  (dense ANN search)
 *   - chunks_tsv_idx            : GIN on tsv               (sparse BM25-style search)
 *
 * If you add another non-Drizzle-expressible search index to the migration,
 * add its name here too so startup fails fast when it goes missing.
 */
export const REQUIRED_SEARCH_INDEXES = [
  "chunks_embedding_hnsw_idx",
  "chunks_tsv_idx",
] as const;

/**
 * Minimal, injectable interface for "which `chunks` indexes currently exist".
 *
 * Abstracting this lets {@link assertRequiredIndexes} be unit-tested without a
 * live database: a test supplies a fake runner that returns a controlled set
 * of index names, simulating "both present" (passes) and "one missing"
 * (throws, naming the missing index).
 */
export interface IndexExistenceRunner {
  /** Return the names of all indexes currently defined on the `chunks` table. */
  listChunkIndexNames(): Promise<string[]>;
}

/**
 * Build an {@link IndexExistenceRunner} backed by a live Drizzle/pg pool.
 *
 * Queries `pg_indexes` for the public-schema `chunks` table. (`pg_indexes` is
 * a convenience view over `pg_class`/`pg_index`; querying it keeps the guard
 * readable and avoids hand-joining the catalog tables.)
 */
export function createIndexExistenceRunner(db: Db): IndexExistenceRunner {
  return {
    listChunkIndexNames: async () => {
      const result = await db.execute<{ indexname: string }>(sql`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'chunks'
      `);
      return result.rows.map((r) => r.indexname);
    },
  };
}

/**
 * Fail fast at startup if any of the {@link REQUIRED_SEARCH_INDEXES} is missing
 * from the `chunks` table.
 *
 * Unlike {@link assertEmbeddingDimensions}, this guard needs the DATABASE, so
 * call it once at startup AFTER the DB pool/deps exist but BEFORE the app
 * serves traffic / processes jobs (api/mcp/worker). The failure mode it guards
 * against — an index silently dropped by a `drizzle-kit generate` regenerate —
 * has no other signal: retrieval keeps "working" but every search becomes a
 * sequential scan.
 *
 * @param runner Injected index-existence source. In production pass
 *   `createIndexExistenceRunner(db)`; in tests pass a fake.
 * @throws {Error} naming EXACTLY which expected index(es) are missing and
 *   warning that retrieval will silently degrade to sequential scans.
 */
export async function assertRequiredIndexes(
  runner: IndexExistenceRunner,
): Promise<void> {
  const present = new Set(await runner.listChunkIndexNames());
  const missing = REQUIRED_SEARCH_INDEXES.filter((name) => !present.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Missing required search index(es) on the chunks table: ` +
        `${missing.join(", ")}. These are owned by ` +
        `packages/db/drizzle/0000_init.sql (HNSW + GIN), not by the Drizzle ` +
        `schema, so a stray "drizzle-kit generate" can DROP them with no error ` +
        `and no failing test. Without them, retrieval silently degrades to ` +
        `sequential scans (dense ANN search loses ` +
        `chunks_embedding_hnsw_idx; sparse full-text search loses ` +
        `chunks_tsv_idx) — queries keep returning results but get slow at ` +
        `scale. To fix: re-run the migration (pnpm --filter @rag/db migrate) ` +
        `or re-create the missing index(es) per 0000_init.sql, and verify no ` +
        `regenerate is dropping them.`,
    );
  }
}
