# TASK: Harden the search-index / migration split (the codebase's #1 fragility)

> **For a fresh Claude Code session.** This document is self-contained — you do
> NOT need to re-read the whole codebase. Everything you need (exact object
> names, file paths, full code, tests, verification) is below. Just execute the
> steps in order.

## Why this task exists

The two indexes that make retrieval work — plus the trigger that populates the
sparse-search column — are **owned by the hand-authored migration**
`packages/db/drizzle/0000_init.sql`, NOT by the Drizzle model in
`packages/db/src/schema.ts`. Drizzle cannot express HNSW opclass options or a
plpgsql trigger, so:

- A `drizzle-kit generate` (`pnpm db:generate`) run diffs these objects as
  "removed" and emits `DROP INDEX` / `DROP TRIGGER` into a new migration.
- Applying that migration throws **no error**, fails **no test**, passes
  **typecheck**, and retrieval keeps returning results — just silently degraded
  (dense → sequential scan; or, if the trigger dies, `tsv` stays NULL and sparse
  search returns nothing).

Today the only guard is `assertRequiredIndexes` (runtime, startup-only) and it
checks **only the two index names** — not the trigger, and nothing runs in CI.

## Source of truth — protected objects (from `0000_init.sql`)

| Object                  | Name                        | Kind                                        |
| ----------------------- | --------------------------- | ------------------------------------------- |
| Dense ANN index         | `chunks_embedding_hnsw_idx` | HNSW, `vector_cosine_ops`                   |
| Sparse FTS index        | `chunks_tsv_idx`            | GIN on `tsv`                                |
| tsv-maintenance trigger | `chunks_tsv_update`         | `BEFORE INSERT OR UPDATE OF text ON chunks` |
| tsv trigger function    | `chunks_tsv_trigger`        | plpgsql (referenced by the trigger)         |

`0000_init.sql` legitimately contains `DROP TRIGGER IF EXISTS chunks_tsv_update`
(it's part of its own idempotent create) — the CI guard below MUST exclude that
file by name.

## What to change (3 edits, all inside `packages/db`)

1. **Extend the startup guard** (`required-indexes.ts`) to also verify the
   `chunks_tsv_update` trigger exists — not just the two indexes.
2. **Update the guard's unit tests** (`required-indexes.test.ts`).
3. **Add a CI guard test** (`migration-guard.test.ts`, new file) that scans the
   `drizzle/` SQL migrations and fails if any non-owner migration drops a
   protected object. This catches a stray `drizzle-kit generate` at `pnpm test`
   time, not just at boot.

No app code changes: the 3 call sites
(`apps/{api,mcp,worker}/src/main.ts` → `assertRequiredIndexes(createIndexExistenceRunner(deps.db))`)
keep working unchanged because the function name/signature is preserved. The
`@rag/db` barrel (`packages/db/src/index.ts`) already does
`export * from "./required-indexes.js"`, so new exports flow automatically.

---

## STEP 1 — Replace `packages/db/src/required-indexes.ts` with this

```ts
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
```

## STEP 2 — Replace `packages/db/src/required-indexes.test.ts` with this

```ts
import { describe, it, expect } from "vitest";
import {
  REQUIRED_CHUNK_TRIGGERS,
  REQUIRED_SEARCH_INDEXES,
  assertRequiredIndexes,
  type IndexExistenceRunner,
} from "./required-indexes.js";

/**
 * Build a fake existence-runner reporting `indexes`/`triggers` as the sets of
 * existing objects on `chunks`, so the guard can be exercised without a live DB.
 */
function fakeRunner(opts: {
  indexes?: readonly string[];
  triggers?: readonly string[];
}): IndexExistenceRunner {
  return {
    listChunkIndexNames: async () => [...(opts.indexes ?? [])],
    listChunkTriggerNames: async () => [...(opts.triggers ?? [])],
  };
}

const ALL_PRESENT = {
  indexes: [
    ...REQUIRED_SEARCH_INDEXES,
    // Extra unrelated objects must not matter.
    "chunks_document_idx",
    "chunks_hash_idx",
  ],
  triggers: [...REQUIRED_CHUNK_TRIGGERS],
};

describe("assertRequiredIndexes", () => {
  it("passes silently when both indexes and the tsv trigger are present", async () => {
    await expect(
      assertRequiredIndexes(fakeRunner(ALL_PRESENT)),
    ).resolves.toBeUndefined();
  });

  it("throws naming the missing HNSW index when it is absent", async () => {
    const runner = fakeRunner({
      indexes: REQUIRED_SEARCH_INDEXES.filter(
        (n) => n !== "chunks_embedding_hnsw_idx",
      ),
      triggers: REQUIRED_CHUNK_TRIGGERS,
    });
    let message = "";
    await expect(assertRequiredIndexes(runner)).rejects.toThrow();
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_embedding_hnsw_idx");
    expect(message).toMatch(/sequential scan/i);
  });

  it("throws naming the missing GIN tsvector index when it is absent", async () => {
    const runner = fakeRunner({
      indexes: REQUIRED_SEARCH_INDEXES.filter((n) => n !== "chunks_tsv_idx"),
      triggers: REQUIRED_CHUNK_TRIGGERS,
    });
    let message = "";
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_tsv_idx");
    expect(message).toMatch(/sequential scan/i);
  });

  it("throws naming the missing tsv trigger when it is absent (sparse search would silently break)", async () => {
    const runner = fakeRunner({
      indexes: REQUIRED_SEARCH_INDEXES,
      triggers: [],
    });
    let message = "";
    await expect(assertRequiredIndexes(runner)).rejects.toThrow();
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_tsv_update");
    // Must explain the silent failure mode: NULL tsv → sparse returns nothing.
    expect(message).toMatch(/tsv/i);
  });

  it("names every missing object when indexes AND the trigger are all gone", async () => {
    const runner = fakeRunner({ indexes: [], triggers: [] });
    let message = "";
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    for (const name of [
      ...REQUIRED_SEARCH_INDEXES,
      ...REQUIRED_CHUNK_TRIGGERS,
    ]) {
      expect(message).toContain(name);
    }
  });

  it("tracks exactly the two search indexes and one trigger owned by 0000_init.sql", () => {
    expect([...REQUIRED_SEARCH_INDEXES].sort()).toEqual([
      "chunks_embedding_hnsw_idx",
      "chunks_tsv_idx",
    ]);
    expect([...REQUIRED_CHUNK_TRIGGERS]).toEqual(["chunks_tsv_update"]);
  });
});
```

## STEP 3 — Create `packages/db/src/migration-guard.test.ts` (new file)

This is a pure file-scan test (no DB). It fails `pnpm test` if any **generated**
migration drops a protected object — catching a stray `drizzle-kit generate`
before it ever reaches Postgres. It deliberately excludes `0000_init.sql`, which
legitimately contains `DROP TRIGGER IF EXISTS chunks_tsv_update` as part of its
own idempotent create.

```ts
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_CHUNK_TRIGGERS,
  REQUIRED_SEARCH_INDEXES,
} from "./required-indexes.js";

/**
 * Regression guard against the codebase's #1 fragility: the HNSW + GIN indexes
 * and the chunks_tsv_update trigger are owned by 0000_init.sql but are INVISIBLE
 * to the Drizzle model, so `drizzle-kit generate` will diff them as "removed"
 * and emit DROP statements into a new migration. Applying that silently degrades
 * retrieval with no error and no other failing test.
 *
 * This test scans every migration EXCEPT the owner (0000_init.sql) and fails if
 * any of them drops a protected object — turning that silent footgun into a
 * loud `pnpm test` failure at PR time.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");

/** The migration that legitimately owns (and re-creates) the protected objects. */
const OWNER_MIGRATION = "0000_init.sql";

const PROTECTED_OBJECTS = [
  ...REQUIRED_SEARCH_INDEXES,
  ...REQUIRED_CHUNK_TRIGGERS,
] as const;

/** Match `DROP INDEX`/`DROP TRIGGER [IF EXISTS] [schema.]<name>` for a protected object. */
function dropStatementsFor(sqlText: string, objectName: string): boolean {
  const escaped = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `drop\\s+(index|trigger)\\s+(if\\s+exists\\s+)?("?[\\w]+"?\\.)?"?${escaped}"?`,
    "i",
  );
  return re.test(sqlText);
}

describe("drizzle migration guard — protected search objects", () => {
  it("no generated migration drops the HNSW/GIN indexes or the tsv trigger", async () => {
    const entries = await readdir(MIGRATIONS_DIR);
    const sqlFiles = entries.filter(
      (f) => f.endsWith(".sql") && f !== OWNER_MIGRATION,
    );

    const violations: string[] = [];
    for (const file of sqlFiles) {
      const text = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      for (const obj of PROTECTED_OBJECTS) {
        if (dropStatementsFor(text, obj)) {
          violations.push(`${file} drops protected object "${obj}"`);
        }
      }
    }

    expect(
      violations,
      `A migration drops an object owned by ${OWNER_MIGRATION}. ` +
        `These objects are invisible to Drizzle, so "drizzle-kit generate" ` +
        `emits DROP statements for them. Remove the DROP(s) from the generated ` +
        `migration (the search indexes/trigger must survive), then re-run. ` +
        `Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("still scans at least one non-owner migration (guard is actually wired)", async () => {
    // Sanity: if the drizzle dir layout changes and we accidentally scan
    // nothing, this catches it so the guard can't silently become a no-op.
    const entries = await readdir(MIGRATIONS_DIR);
    const nonOwner = entries.filter(
      (f) => f.endsWith(".sql") && f !== OWNER_MIGRATION,
    );
    expect(nonOwner.length).toBeGreaterThan(0);
  });
});
```

> NOTE: the second test asserts there is ≥1 non-owner migration. At time of
> writing `drizzle/` contains `0001_documents_metadata_gin.sql`, so this passes.
> If that ever changes, relax/remove that sanity test rather than weakening the
> real guard.

---

## STEP 4 — Verify

Run, in order, from the repo root:

```bash
pnpm --filter @rag/db typecheck      # types compile (new runner method, exports)
pnpm --filter @rag/db test           # required-indexes + migration-guard pass, no DB needed
pnpm typecheck                       # nothing else broke (3 app call sites unchanged)
```

Expected: all green. The two new/extended test files run without Postgres.

(Optional sanity that the guard actually bites: temporarily append
`DROP INDEX chunks_tsv_idx;` to `drizzle/0001_documents_metadata_gin.sql`, run
`pnpm --filter @rag/db test`, confirm `migration-guard.test.ts` FAILS naming the
file + object, then revert.)

## STEP 5 — Optional follow-ups (note, don't necessarily do)

- The runtime guard still can't detect a `tsv` trigger that _exists but is
  broken_ (e.g. function body changed to a no-op). A deeper check would sample a
  freshly-inserted chunk and assert `tsv IS NOT NULL`, but that needs a live DB
  and belongs in the e2e suite, not the unit guard.
- Consider a one-line note in `packages/db/src/schema.ts` (the big
  ⚠️ SOURCE-OF-TRUTH WARNING block ~line 171) pointing at
  `migration-guard.test.ts` as the CI enforcement, so the next person finds it.

## Constraints / gotchas for the executing session

- A PostToolUse Prettier hook auto-formats `.ts`/`.md` on save — don't fight it.
- Do NOT edit `0000_init.sql` (it's the owner and is correct) or `pnpm-lock.yaml`
  or any `.env` (hook-blocked).
- Keep `assertRequiredIndexes`'s name and signature — `apps/api/src/main.ts`,
  `apps/mcp/src/main.ts`, `apps/worker/src/main.ts` import and call it.
- Commit only when the user asks; branch first if on `main`.

```

```
