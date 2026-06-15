import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Single source of truth for the database objects WITHOUT WHICH RETRIEVAL
 * SILENTLY DEGRADES.
 *
 * These objects are created and owned by `packages/db/drizzle/0000_init.sql` —
 * NOT by the Drizzle model in `schema.ts`. Drizzle cannot express any of them
 * cleanly (HNSW operator classes / `WITH (...)` opclass options, a GIN index on
 * a custom tsvector column, and a plpgsql trigger), so a `drizzle-kit generate`
 * run does not see them and would otherwise diff them as "removed" and emit
 * `DROP INDEX` / `DROP TRIGGER`. Dropping them produces NO error and NO failing
 * test — retrieval just falls back to sequential scans (indexes) or, worse,
 * stops populating `tsv` entirely so sparse search returns nothing (trigger).
 *
 * This list is the runtime regression guard's contract. It MUST stay in sync
 * with `0000_init.sql`:
 *   - chunks_embedding_hnsw_idx : HNSW, vector_cosine_ops  (dense ANN search)
 *   - chunks_tsv_idx            : GIN on tsv               (sparse BM25-style search)
 *   - chunks_tsv_update         : BEFORE INSERT/UPDATE trigger that fills `tsv`
 *
 * If you add another non-Drizzle-expressible search object to the migration,
 * add its name here too so startup fails fast when it goes missing. The CI
 * guard in `migration-guard.test.ts` also reads these lists.
 */
export const REQUIRED_SEARCH_INDEXES = [
  "chunks_embedding_hnsw_idx",
  "chunks_tsv_idx",
] as const;

/**
 * Triggers on `chunks` that MUST exist. `chunks_tsv_update` keeps the `tsv`
 * column in sync with `text`; if it is dropped, new chunks insert with a NULL
 * `tsv` and sparse full-text search silently matches nothing (no error, no
 * failing unit test — only a live query reveals it).
 */
export const REQUIRED_CHUNK_TRIGGERS = ["chunks_tsv_update"] as const;

/**
 * Minimal, injectable interface for "which `chunks` indexes and triggers
 * currently exist".
 *
 * Abstracting this lets {@link assertRequiredIndexes} be unit-tested without a
 * live database: a test supplies a fake runner that returns controlled sets of
 * names, simulating "all present" (passes) and "one missing" (throws, naming
 * the missing object).
 */
export interface IndexExistenceRunner {
  /** Return the names of all indexes currently defined on the `chunks` table. */
  listChunkIndexNames(): Promise<string[]>;
  /** Return the names of all (non-internal) triggers on the `chunks` table. */
  listChunkTriggerNames(): Promise<string[]>;
}

/**
 * Build an {@link IndexExistenceRunner} backed by a live Drizzle/pg pool.
 *
 * Indexes come from `pg_indexes` (a convenience view over the catalog). Triggers
 * come from `pg_trigger` joined to `pg_class`, filtering out internal
 * constraint triggers (`tgisinternal`) so only real user triggers are returned.
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
    listChunkTriggerNames: async () => {
      const result = await db.execute<{ tgname: string }>(sql`
        SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'chunks'
          AND NOT t.tgisinternal
      `);
      return result.rows.map((r) => r.tgname);
    },
  };
}

/**
 * Fail fast at startup if any required search index OR the tsv trigger is
 * missing from the `chunks` table.
 *
 * Call this once at startup AFTER the DB pool/deps exist but BEFORE the app
 * serves traffic / processes jobs (api/mcp/worker). The failure mode it guards
 * against — an object silently dropped by a `drizzle-kit generate` regenerate —
 * has no other signal: retrieval keeps "working" but degrades.
 *
 * @param runner Injected existence source. In production pass
 *   `createIndexExistenceRunner(db)`; in tests pass a fake.
 * @throws {Error} naming EXACTLY which expected object(s) are missing and
 *   warning how retrieval silently degrades.
 */
export async function assertRequiredIndexes(
  runner: IndexExistenceRunner,
): Promise<void> {
  const [indexNames, triggerNames] = await Promise.all([
    runner.listChunkIndexNames(),
    runner.listChunkTriggerNames(),
  ]);

  const presentIndexes = new Set(indexNames);
  const presentTriggers = new Set(triggerNames);

  const missingIndexes = REQUIRED_SEARCH_INDEXES.filter(
    (name) => !presentIndexes.has(name),
  );
  const missingTriggers = REQUIRED_CHUNK_TRIGGERS.filter(
    (name) => !presentTriggers.has(name),
  );

  if (missingIndexes.length === 0 && missingTriggers.length === 0) return;

  const parts: string[] = [];
  if (missingIndexes.length > 0) {
    parts.push(`index(es): ${missingIndexes.join(", ")}`);
  }
  if (missingTriggers.length > 0) {
    parts.push(`trigger(s): ${missingTriggers.join(", ")}`);
  }

  throw new Error(
    `Missing required search object(s) on the chunks table — ` +
      `${parts.join("; ")}. These are owned by ` +
      `packages/db/drizzle/0000_init.sql (HNSW + GIN indexes and the ` +
      `chunks_tsv_update trigger), not by the Drizzle schema, so a stray ` +
      `"drizzle-kit generate" can DROP them with no error and no failing test. ` +
      `Without the indexes, retrieval silently degrades to sequential scans; ` +
      `without the chunks_tsv_update trigger, new chunks insert with a NULL tsv ` +
      `and sparse full-text search silently returns nothing. To fix: re-run the ` +
      `migration (pnpm --filter @rag/db migrate) or re-create the missing ` +
      `object(s) per 0000_init.sql, and verify no regenerate is dropping them.`,
  );
}
