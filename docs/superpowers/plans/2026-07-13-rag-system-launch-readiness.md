# RAG System Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every code-actionable finding in `docs/RAG-SYSTEM-EVALUATION-2026-07-13.md` — bring production current, add the missing Postgres backup job, fix five RAG-quality correctness gaps, close three test-coverage gaps, and harden the web app's auth/security posture.

**Architecture:** No new subsystems. Every task extends an existing, established pattern in this codebase (the `docsGapDigest`/`shipAuditLog` recurring-job pattern for the backup job; the `capChunksPerDocument` pattern for diversity; the SharePoint/`GraphReader` fake pattern for connector tests; the `sources.test.ts` route-test pattern for the documents route). Nothing here introduces a new library, a new deployment target, or a new architectural layer.

**Tech Stack:** TypeScript (Node 22), Fastify, Drizzle ORM + Postgres/pgvector, pg-boss, Next.js 15 (App Router), vitest, Railway CLI.

## Global Constraints

- All DB access goes through `@rag/db` typed queries — never import `pg`/`drizzle-orm` directly in an app or another package.
- Schema changes go through `pnpm db:generate` (Drizzle) — never hand-author a migration SQL file or its journal entry directly; this codebase has hit real, documented bugs (silent migration skips, snapshot-chain breaks) from doing that by hand.
- Every new pg-boss recurring job's cron/tz must be config-driven (`packages/core/src/config.ts`), never hardcoded in `queue.ts` — this is an explicit existing convention (see the comments on `docsGapDigestCron`/`shipAuditLogCron` in `packages/ingestion/src/queue.ts`).
- Business logic that both HTTP API and MCP need goes in `@rag/services`, never duplicated in a route or MCP tool handler.
- No `console.log` in production code — use the existing `pino` logger (Node apps) or `console.warn`/`console.error` only where the codebase already establishes that as the convention (the web app, which has no logging library).
- Prettier auto-formats `.ts`/`.md` on every Edit/Write (repo hook) — expect reformatting; re-read a file before your next edit if the previous edit touched the same region.
- Do not edit `.env` or `pnpm-lock.yaml` directly (blocked by hooks) — edit `env.example` and run `pnpm install`.
- Commit messages: `<type>: <description>` (feat/fix/refactor/docs/test/chore/perf/ci), no AI attribution footer needed for this repo's convention (check recent `git log` if unsure).

---

## File Structure

| File                                                 | Responsibility                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema.ts`                          | **Modify**: add `backupRuns` table definition                                                                                                         |
| `packages/db/src/queries.ts`                         | **Modify**: add `insertBackupRun`; add `lifecycle_status` exclusion to `hybridSearch`'s WHERE clause; swap `plainto_tsquery` → `websearch_to_tsquery` |
| `packages/db/drizzle/00XX_*.sql` + `meta/`           | **Generate** via `pnpm db:generate` (Task 2)                                                                                                          |
| `packages/core/src/config.ts`                        | **Modify**: add `backup` config block                                                                                                                 |
| `packages/ingestion/src/queue.ts`                    | **Modify**: add `JOB_NAMES.backupPostgres` + `boss.schedule()` call                                                                                   |
| `apps/worker/src/handlers/backup-postgres.ts`        | **Create**: the backup job handler (pg_dump → upload → record run)                                                                                    |
| `apps/worker/src/handlers/backup-postgres.test.ts`   | **Create**: unit test for the handler                                                                                                                 |
| `apps/worker/src/main.ts`                            | **Modify**: wire the new job's `queue.work()` call                                                                                                    |
| `apps/worker/Dockerfile`                             | **Modify**: install `postgresql-client` (for `pg_dump`)                                                                                               |
| `env.example`                                        | **Modify**: document new `BACKUP_*` env vars                                                                                                          |
| `apps/web/next.config.ts`                            | **Modify**: add `headers()` returning CSP/X-Frame-Options/HSTS/etc.                                                                                   |
| `apps/web/next.config.test.ts`                       | **Create**: assert the headers function returns the expected header set                                                                               |
| `apps/web/src/instrumentation.ts`                    | **Create**: startup warning when `WEB_AUTH_MODE=static-fallback` is active                                                                            |
| `apps/web/src/instrumentation.test.ts`               | **Create**: unit test for the warning logic                                                                                                           |
| `packages/rag/src/generation/generator.ts`           | **Modify**: `filterCitationsToAnswer` regex to handle grouped/ranged citations                                                                        |
| `packages/rag/src/generation/generator.test.ts`      | **Modify**: add grouped/ranged citation test cases                                                                                                    |
| `packages/rag/src/chunking/markdown-chunker.ts`      | **Modify**: `hardSplit` gets a table-row-aware path                                                                                                   |
| `packages/rag/src/chunking/markdown-chunker.test.ts` | **Modify**: add an oversized-inline-table test case                                                                                                   |
| `packages/services/src/search.ts`                    | **Modify**: apply `capChunksPerDocument`                                                                                                              |
| `packages/services/src/search.test.ts`               | **Create**: unit test for the diversity cap on `searchDocuments`                                                                                      |
| `tests/e2e/src/specs/retrieval.spec.ts`              | **Modify**: add a `websearch_to_tsquery` multi-word test and a `lifecycle_status` exclusion test                                                      |
| `packages/connectors/src/gmail/index.test.ts`        | **Create**                                                                                                                                            |
| `packages/connectors/src/outlook/index.test.ts`      | **Create**                                                                                                                                            |
| `packages/connectors/src/gdrive/index.test.ts`       | **Create**                                                                                                                                            |
| `packages/runtime/src/index.test.ts`                 | **Create**: `buildAuthProvider`/`buildCoreDeps` wiring test                                                                                           |
| `apps/api/src/routes/documents.test.ts`              | **Create**: route-level test for `GET /documents/:id` and `/download`                                                                                 |

---

## Task 1: Bring production current (redeploy `rag-worker`, `rag-api`, `rag-mcp`)

**Why first:** every compliance fix already merged to `main` (`sourceDocClass` gate, the disclosure audit trail, per-source access grants, the 64-char JWT secret minimum) is currently NOT live — production has been running 2026-07-04's build for 9 days. This closes P0-1 using code that already exists; it doesn't depend on any other task in this plan. Re-run this task's steps again after Tasks 2–12 merge, to pick those up too.

**Files:** None modified — this is a deployment/verification task against live Railway infrastructure.

**Interfaces:** N/A (no new code).

- [ ] **Step 1: Confirm current gap (baseline, before touching anything)**

```bash
railway status
```

Expected: `rag-api`, `rag-worker`, `rag-mcp` show `Online` with a deploy timestamp around `2026-07-04`. Then:

```bash
railway ssh -s rag-postgres -- bash -lc '
export PGPASSWORD="$POSTGRES_PASSWORD"
/usr/bin/psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h localhost -Atc "select count(*) from drizzle.__drizzle_migrations"
'
```

Expected: `7` (repo has migrations through `0017` — 18 files including `0000_init`). This confirms the gap before you close it, so Step 5 has a before/after to compare.

- [ ] **Step 1a: Take one manual safety backup before applying migrations**

Task 2 (later in this plan) adds an automated recurring backup job, but it isn't live in production yet — this redeploy is about to apply 6 pending migrations (`0012`–`0017`) to the only copy of this data, with no automated backup coverage in place yet. The manual drill run earlier today deleted its dump as part of its own cleanup, so repeat it fresh, immediately before Step 2, and keep this one until Task 2 ships and takes its first real run:

```bash
railway ssh -s rag-postgres -- bash -lc '
export PGPASSWORD="$POSTGRES_PASSWORD"
/usr/bin/pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h localhost -F c
' > /tmp/rag-prod-pre-migration-backup.dump
ls -la /tmp/rag-prod-pre-migration-backup.dump
```

Expected: a non-trivial dump file (tens of MB, matching today's earlier ~36MB drill). Keep this file somewhere durable outside `/tmp` (it will not survive a reboot) until Task 2's job has produced at least one successful run — then it can be discarded.

- [ ] **Step 2: Redeploy `rag-worker` first (migration owner)**

```bash
railway up --service rag-worker --ci -y
```

Expected: build succeeds, image pushes, deploy status settles to `SUCCESS`. `rag-worker`'s `preDeployCommand` (`pnpm --filter @rag/db migrate`) applies migrations `0012`–`0017` automatically — but this session's own investigation found evidence Railway's config-as-code linkage may not be wired for this service (historical manifests show `preDeployCommand: null` even after the repo file was added). If the deploy's manifest shows `preDeployCommand: null` after this push, STOP and follow Step 2a before proceeding.

- [ ] **Step 2a (conditional — only if Step 2's manifest shows no `preDeployCommand`): confirm Railway dashboard config-as-code wiring**

In the Railway dashboard: `rag-worker` service → Settings → Config-as-code → confirm the path is set to `apps/worker/railway.json` (not blank, not a stale path). If it was blank, set it, then re-run Step 2. Do not proceed to Step 3 until migrations actually apply — verify with:

```bash
railway ssh -s rag-postgres -- bash -lc '
export PGPASSWORD="$POSTGRES_PASSWORD"
/usr/bin/psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h localhost -Atc "select count(*) from drizzle.__drizzle_migrations"
'
```

Expected: `18`.

- [ ] **Step 3: Verify recurring jobs registered**

```bash
railway ssh -s rag-postgres -- bash -lc '
export PGPASSWORD="$POSTGRES_PASSWORD"
/usr/bin/psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h localhost -Atc "select name from pgboss.schedule order by name"
'
```

Expected: two rows — `rag.docs_gap_digest` and `rag.ship_audit_log` (three rows once Task 2 ships and this redeploy is repeated: `rag.backup_postgres` too).

- [ ] **Step 4: Redeploy `rag-api` and `rag-mcp`**

```bash
railway up --service rag-api --ci -y
railway up --service rag-mcp --ci -y
```

Expected: both deploy statuses settle to `SUCCESS`. `railway status` shows all three services `Online` with today's date.

- [ ] **Step 5: Smoke-test the previously-dark compliance features are now live**

```bash
railway ssh -s rag-postgres -- bash -lc '
export PGPASSWORD="$POSTGRES_PASSWORD"
/usr/bin/psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h localhost -Atc "select column_name from information_schema.columns where table_name='"'"'audit_log'"'"' and column_name in ('"'"'embedding_provider'"'"','"'"'embedding_model'"'"')"
'
```

Expected: both column names returned (confirms migration `0017` applied and the disclosure-audit-trail schema is live, not just deployed-but-unmigrated).

- [ ] **Step 6: No commit needed** — this task is a deployment action, not a code change. Note the completion in your working notes / the next standup, including the before (7 migrations) → after (18 migrations) delta from Steps 1 and 5.

---

## Task 2: Recurring Postgres backup job

**Files:**

- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`
- Generate: `packages/db/drizzle/00XX_backup_runs.sql` + `packages/db/drizzle/meta/*` (via `pnpm db:generate`)
- Modify: `packages/core/src/config.ts`
- Modify: `packages/ingestion/src/queue.ts`
- Create: `apps/worker/src/handlers/backup-postgres.ts`
- Create: `apps/worker/src/handlers/backup-postgres.test.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/Dockerfile`
- Modify: `env.example`

**Interfaces:**

- Consumes: `ObjectStore.put(key: string, body: Buffer, contentType?: string): Promise<void>` (`packages/core/src/interfaces.ts:209`), `WorkerDeps` (`db`, `logger`, `config`, `objectStore`).
- Produces: `insertBackupRun(db: Db, row: { ranAt: Date; sizeBytes: number; objectKey: string; durationMs: number }): Promise<void>` — no other task consumes this, but keep the signature exact since Task 1's re-run (redeploying after this task) verifies against it.

- [ ] **Step 1: Add the `backupRuns` table to the schema**

In `packages/db/src/schema.ts`, add after the `docsGapDigestRuns` table definition (near line 588):

```typescript
// ----------------------------------------------------------------------------
// backup_runs — one row per completed Postgres backup, so "the backup job ran
// and produced something" is queryable/admin-visible, not just a log line.
// Mirrors docsGapDigestRuns' shape (a simple append-only run-history table).
// ----------------------------------------------------------------------------
export const backupRuns = pgTable("backup_runs", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v4()`),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  objectKey: text("object_key").notNull(),
  durationMs: integer("duration_ms").notNull(),
});
export type BackupRun = typeof backupRuns.$inferSelect;
export type NewBackupRun = typeof backupRuns.$inferInsert;
```

- [ ] **Step 2: Generate the migration**

This repo has a documented history of `drizzle-kit generate` collisions when another concurrent session is also touching migrations (multiple incidents earlier this session alone). Check for a clean slate first:

```bash
cd /Users/marcusklein/dev/rag-system
git status packages/db/drizzle/
```

Expected: no uncommitted changes under `packages/db/drizzle/`. If there are any, STOP and reconcile with whoever/whatever produced them before generating — do not generate on top of an already-dirty migration directory.

```bash
pnpm db:generate
```

(This is the root convenience script — `pnpm --filter @rag/db db:generate` does NOT exist as a script name; the package's own script is called `generate`, not `db:generate`. Use the root alias above, or `pnpm --filter @rag/db generate` directly — never combine the filter with the `db:` prefix.)

Expected: a new `packages/db/drizzle/00XX_backup_runs.sql` (or similarly auto-named) file is created containing a `CREATE TABLE "backup_runs" (...)` statement, plus an updated `packages/db/drizzle/meta/_journal.json` with a new entry whose `when` is greater than every existing entry, and a new `meta/00XX_snapshot.json`. Read the generated SQL file to confirm it only adds the new table (no unrelated DROP/ALTER statements), and confirm the new journal entry's `prevId` matches `0017`'s hash (the current tip) before proceeding — this is exactly the class of bug (wrong diff base picked by `drizzle-kit generate`) this repo has hit multiple times before.

- [ ] **Step 3: Add the query function**

In `packages/db/src/queries.ts`, add near `insertDocsGapDigestRun` (around line 883):

```typescript
export interface BackupRunRow {
  ranAt: Date;
  sizeBytes: number;
  objectKey: string;
  durationMs: number;
}

export async function insertBackupRun(
  db: Db,
  row: BackupRunRow,
): Promise<void> {
  const values: NewBackupRun = {
    ranAt: row.ranAt,
    sizeBytes: row.sizeBytes,
    objectKey: row.objectKey,
    durationMs: row.durationMs,
  };
  await db.insert(backupRuns).values(values);
}
```

Add `backupRuns`, `NewBackupRun` to the existing `import { ... } from "./schema.js"` block at the top of `queries.ts`, and export `insertBackupRun`/`BackupRunRow` from `packages/db/src/index.ts` alongside the existing `insertDocsGapDigestRun`/`DocsGapDigestRunRow` exports.

- [ ] **Step 4: Run the DB package's build to confirm the schema/query changes compile**

```bash
pnpm --filter @rag/db build
```

Expected: exits 0, no TypeScript errors.

- [ ] **Step 5: Commit the schema/migration/query work**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts packages/db/src/index.ts packages/db/drizzle/
git commit -m "feat: add backup_runs table and insertBackupRun query"
```

- [ ] **Step 6: Add the `backup` config block**

In `packages/core/src/config.ts`, add near the `auditSink` block (around line 266-274), inside the same top-level object:

```typescript
    /**
     * Recurring Postgres backup job (scheduled, cursor-free — every tick takes
     * a full pg_dump and uploads it, no incremental state to track). `none`
     * (default) disables the job's actual work; the schedule still registers
     * either way so enabling it later doesn't require a deploy of queue.ts.
     */
    backup: z.object({
      provider: z.enum(["none", "objectStore"]).default("none"),
      /** 5-field crontab expression. Default: daily, 03:00. */
      cron: z.string().min(1).default("0 3 * * *"),
      /** IANA timezone the cron expression is evaluated in. */
      tz: z.string().min(1).default("UTC"),
      /** Key prefix under the configured objectStore bucket for backup dumps. */
      keyPrefix: z.string().default("backups/"),
    }),
```

Then in the same file's env-parsing section (find the block around line 605-633 that builds `objectStore`/`docsGapDigest`/`auditSink` from `env.*` — mirror that exact pattern for `backup`):

```typescript
    backup: {
      provider: (env.BACKUP_PROVIDER as "none" | "objectStore" | undefined) ?? "none",
      cron: env.BACKUP_CRON ?? "0 3 * * *",
      tz: env.BACKUP_TZ ?? "UTC",
      keyPrefix: env.BACKUP_KEY_PREFIX ?? "backups/",
    },
```

Read the exact surrounding lines first (the block starting around `docsGapDigest: {` at line 619) to match the file's established env-var-reading style precisely — some fields there use `?? "default"`, follow that, not `z.parse` inline.

- [ ] **Step 7: Document the new env vars**

In `env.example`, add near the existing `AUDIT_SINK_*` documentation block:

```env
# Recurring Postgres backup job. `objectStore` uploads a daily pg_dump to the
# same S3-compatible bucket configured via OBJECT_STORE_* above (falls back to
# "none" — no-op — if OBJECT_STORE_PROVIDER is also "none").
BACKUP_PROVIDER=none
BACKUP_CRON=0 3 * * *
BACKUP_TZ=UTC
BACKUP_KEY_PREFIX=backups/
```

- [ ] **Step 8: Register the recurring job in `queue.ts`**

In `packages/ingestion/src/queue.ts`, add to `JOB_NAMES` (near line 23):

```typescript
  /**
   * Third recurring (pg-boss `schedule()`) job in this codebase — takes a
   * full pg_dump and uploads it to the configured object store (see
   * apps/worker/src/handlers/backup-postgres.ts). No payload, same as
   * docsGapDigest/shipAuditLog.
   */
  backupPostgres: "rag.backup_postgres",
```

Add to `QueueOptions` (near line 76):

```typescript
/** Cron schedule for the recurring Postgres backup job. */
backupPostgresCron: string;
/** IANA timezone the cron expression above is evaluated in. */
backupPostgresTz: string;
```

Add the schedule call in `createQueue`, after the existing `shipAuditLog` schedule block (near line 144):

```typescript
// Register the Postgres backup job the same way — upsert-by-name, safe to
// call from every process on every boot, must run after the createQueue
// loop above (same FK-to-queue constraint as the other two).
await boss.schedule(
  JOB_NAMES.backupPostgres,
  opts.backupPostgresCron,
  undefined,
  { tz: opts.backupPostgresTz },
);
```

- [ ] **Step 9: Thread the new options through `buildCoreDeps`**

In `packages/runtime/src/index.ts`, in the `createQueue({...})` call (around line 168-175), add:

```typescript
    backupPostgresCron: config.backup.cron,
    backupPostgresTz: config.backup.tz,
```

- [ ] **Step 10: Write the failing test for the handler**

Create `apps/worker/src/handlers/backup-postgres.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { handleBackupPostgres } from "./backup-postgres.js";
import type { WorkerDeps } from "../deps.js";

const { insertBackupRunMock, execFileMock } = vi.hoisted(() => ({
  insertBackupRunMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("@rag/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rag/db")>();
  return { ...actual, insertBackupRun: insertBackupRunMock };
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function makeJob() {
  return { id: "job-1", data: {} } as never;
}

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db: {} as WorkerDeps["db"],
    logger: pino({ level: "silent" }),
    config: {
      backup: { provider: "objectStore", keyPrefix: "backups/" },
      databaseUrl: "postgres://user:pass@host:5432/db",
    } as WorkerDeps["config"],
    objectStore: {
      bucket: "test-bucket",
      put: vi.fn(async () => {}),
      get: vi.fn(),
      delete: vi.fn(),
    },
    ...overrides,
  } as WorkerDeps;
}

describe("handleBackupPostgres", () => {
  it("no-ops when backup.provider is 'none'", async () => {
    const deps = makeDeps({
      config: { backup: { provider: "none" } } as WorkerDeps["config"],
    });
    await handleBackupPostgres(makeJob(), deps);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(insertBackupRunMock).not.toHaveBeenCalled();
  });

  it("no-ops when objectStore is null", async () => {
    const deps = makeDeps({ objectStore: null });
    await handleBackupPostgres(makeJob(), deps);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(insertBackupRunMock).not.toHaveBeenCalled();
  });

  it("runs pg_dump, uploads the result, and records the run", async () => {
    const dumpBytes = Buffer.from("fake-pg-dump-bytes");
    // Resolves the callback's SECOND arg as a single { stdout, stderr } object,
    // not two separate args — this matches real child_process.execFile's own
    // util.promisify.custom behavior (which is what makes `promisify(execFile)`
    // resolve to { stdout, stderr } in production). vi.mock("node:child_process")
    // replaces the whole module, so that custom-promisify wiring is gone —
    // this mock manually reproduces its resolved shape so execFileAsync's
    // `const { stdout } = await execFileAsync(...)` still destructures
    // correctly. Get this shape wrong and the test would pass for the wrong
    // reason (or fail in a confusing way unrelated to the handler's own logic).
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        opts: { maxBuffer: number },
        cb: (
          err: Error | null,
          result: { stdout: Buffer; stderr: string },
        ) => void,
      ) => {
        cb(null, { stdout: dumpBytes, stderr: "" });
      },
    );
    const deps = makeDeps();

    await handleBackupPostgres(makeJob(), deps);

    expect(execFileMock).toHaveBeenCalledWith(
      "pg_dump",
      expect.arrayContaining(["-F", "c"]),
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function),
    );
    expect(deps.objectStore!.put).toHaveBeenCalledWith(
      expect.stringMatching(/^backups\/.*\.dump$/),
      dumpBytes,
      "application/octet-stream",
    );
    expect(insertBackupRunMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sizeBytes: dumpBytes.length,
        objectKey: expect.stringMatching(/^backups\/.*\.dump$/),
      }),
    );
  });

  it("propagates a pg_dump failure unswallowed (so pg-boss retries)", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("pg_dump: connection refused"));
      },
    );
    const deps = makeDeps();

    await expect(handleBackupPostgres(makeJob(), deps)).rejects.toThrow(
      "pg_dump: connection refused",
    );
    expect(insertBackupRunMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run the test to verify it fails**

```bash
pnpm --filter @rag/worker test -- backup-postgres
```

Expected: FAIL — `Cannot find module './backup-postgres.js'`.

- [ ] **Step 12: Implement the handler**

Create `apps/worker/src/handlers/backup-postgres.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { insertBackupRun } from "@rag/db";
import type PgBoss from "pg-boss";
import type { WorkerDeps } from "../deps.js";

const execFileAsync = promisify(execFile);

/**
 * pg_dump's custom-format output for this corpus is tens of MB today — 512MB
 * is generous headroom without risking an unbounded buffer. This buffers the
 * ENTIRE dump in process memory before uploading, though, which is a real
 * ceiling as the corpus grows; if this job ever needs to handle a
 * multi-GB database, switch to streaming pg_dump's stdout directly into
 * `objectStore` (a multipart/streaming upload) instead of buffering here.
 * Deliberately v1 — the corpus is nowhere near that size yet.
 */
const MAX_DUMP_BYTES = 512 * 1024 * 1024;

/**
 * pg-boss hands this the scheduled tick (no meaningful payload — same as
 * docsGapDigest/shipAuditLog). Takes a full `pg_dump -F c` of the configured
 * database, uploads it to the object store under `backup.keyPrefix`, and
 * records the run in `backup_runs` so "the job ran and produced something" is
 * queryable, not just a log line — mirrors the docsGapDigestRuns precedent.
 *
 * No-ops when `config.backup.provider === "none"` or no object store is
 * configured — matches `handleShipAuditLog`'s no-op-when-disabled shape. A
 * thrown pg_dump/upload error propagates unswallowed so pg-boss retries the
 * same tick rather than silently recording a partial/failed backup as done.
 */
export async function handleBackupPostgres(
  job: PgBoss.JobWithMetadata<object>,
  deps: WorkerDeps,
): Promise<void> {
  const { db, logger, config, objectStore } = deps;
  const log = logger.child({ jobId: job.id });

  if (config.backup.provider === "none" || !objectStore) {
    return;
  }

  const startedAt = Date.now();
  const { stdout } = await execFileAsync(
    "pg_dump",
    [config.databaseUrl, "-F", "c"],
    { maxBuffer: MAX_DUMP_BYTES, encoding: "buffer" },
  );
  const durationMs = Date.now() - startedAt;

  const ranAt = new Date();
  const objectKey = `${config.backup.keyPrefix}${ranAt.toISOString().replace(/[:.]/g, "-")}.dump`;

  await objectStore.put(objectKey, stdout, "application/octet-stream");

  await insertBackupRun(db, {
    ranAt,
    sizeBytes: stdout.length,
    objectKey,
    durationMs,
  });

  log.info(
    {
      marker: "backup.postgres.summary",
      sizeBytes: stdout.length,
      objectKey,
      durationMs,
    },
    "Postgres backup completed",
  );
}
```

- [ ] **Step 13: Run the test to verify it passes**

```bash
pnpm --filter @rag/worker test -- backup-postgres
```

Expected: PASS, all 4 test cases green.

- [ ] **Step 14: Wire the handler into `main.ts`**

In `apps/worker/src/main.ts`, add the import near the other handler imports:

```typescript
import { handleBackupPostgres } from "./handlers/backup-postgres.js";
```

Add the `queue.work()` registration after the `shipAuditLog` block (near line 116), following the exact same shape:

```typescript
// Third recurring job (registered via `boss.schedule()` in `createQueue`,
// same as docsGapDigest/shipAuditLog above) — takes a full pg_dump and
// uploads it. No-ops per-tick when `BACKUP_PROVIDER=none` or no object
// store is configured — see handleBackupPostgres.
await builtDeps.queue.work<object>(
  JOB_NAMES.backupPostgres,
  {
    batchSize: 1,
    pollingIntervalSeconds: Math.max(
      1,
      Math.round(config.worker.pollIntervalMs / 1000),
    ),
    includeMetadata: true,
  },
  async (jobs) => {
    for (const job of jobs) {
      await handleBackupPostgres(job, builtDeps);
    }
  },
);
```

- [ ] **Step 15: Install `pg_dump` in the worker's Docker image**

In `apps/worker/Dockerfile`, add before the `USER node` line (around line 42):

```dockerfile
# pg_dump for the recurring Postgres backup job (handlers/backup-postgres.ts).
# postgresql-client's version doesn't need to exactly match the server's for
# a custom-format dump of this schema's feature set (no exotic extensions
# beyond vector/pg_trgm/uuid-ossp, all portable across recent PG versions).
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 16: Full workspace build + typecheck**

```bash
pnpm build && pnpm typecheck
```

Expected: both exit 0.

- [ ] **Step 17: Commit**

```bash
git add packages/core/src/config.ts packages/ingestion/src/queue.ts packages/runtime/src/index.ts \
  apps/worker/src/handlers/backup-postgres.ts apps/worker/src/handlers/backup-postgres.test.ts \
  apps/worker/src/main.ts apps/worker/Dockerfile env.example
git commit -m "feat: add recurring Postgres backup job (pg_dump to object store)"
```

---

## Task 3: Web app security headers

**Files:**

- Modify: `apps/web/next.config.ts`
- Create: `apps/web/next.config.test.ts`

**Interfaces:**

- Produces: `headers()` async function on the exported `NextConfig`, matching Next.js's `headers()` config API (`{ source: string; headers: { key: string; value: string }[] }[]`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/next.config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import nextConfig from "./next.config.js";

describe("next.config security headers", () => {
  it("sets CSP, X-Frame-Options, HSTS, and X-Content-Type-Options on every route", async () => {
    expect(nextConfig.headers).toBeDefined();
    const rules = await nextConfig.headers!();
    expect(rules.length).toBeGreaterThan(0);

    const allRoutes = rules.find((r) => r.source === "/(.*)");
    expect(allRoutes).toBeDefined();

    const byKey = Object.fromEntries(
      allRoutes!.headers.map((h) => [h.key, h.value]),
    );

    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Strict-Transport-Security"]).toContain("max-age=");
    expect(byKey["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(byKey["Content-Security-Policy"]).toContain("default-src 'self'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rag/web test -- next.config
```

Expected: FAIL — `nextConfig.headers` is undefined.

- [ ] **Step 3: Implement the headers**

Replace `apps/web/next.config.ts`:

```typescript
import type { NextConfig } from "next";

/**
 * A GLBA/§7216-relevant authenticated chat UI with no security headers at all
 * (confirmed in docs/RAG-SYSTEM-EVALUATION-2026-07-13.md P1-5) — no CSP, no
 * clickjacking protection, no HSTS. Applied to every route via the catch-all
 * source pattern; Next.js merges these with any route-specific headers a
 * page/route handler sets, it does not require every route to redeclare them.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    // 'unsafe-inline' on style-src only: Next.js injects inline styles for
    // its own CSS-in-JS/font optimization; script-src has no 'unsafe-inline'
    // or 'unsafe-eval' — this is the actual XSS defense-in-depth layer.
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rag/web test -- next.config
```

Expected: PASS.

- [ ] **Step 5: Build the web app to confirm the config is valid Next.js config**

```bash
pnpm --filter @rag/web build
```

Expected: exits 0 — Next.js's own config validation would fail the build on a malformed `headers()` return shape.

- [ ] **Step 6: Commit**

```bash
git add apps/web/next.config.ts apps/web/next.config.test.ts
git commit -m "feat: add CSP/HSTS/X-Frame-Options security headers to web app"
```

---

## Task 4: `WEB_AUTH_MODE=static-fallback` startup warning

**Files:**

- Create: `apps/web/src/instrumentation.ts`
- Create: `apps/web/src/instrumentation.test.ts`

**Interfaces:**

- Produces: `checkStaticFallbackMode(env: Record<string, string | undefined>): void` — pure, testable function; `register()` (Next.js's instrumentation hook contract) calls it with `process.env`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/instrumentation.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { checkStaticFallbackMode } from "./instrumentation.js";

describe("checkStaticFallbackMode", () => {
  it("logs nothing when WEB_AUTH_MODE is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkStaticFallbackMode({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs nothing when WEB_AUTH_MODE is not 'static-fallback'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkStaticFallbackMode({ WEB_AUTH_MODE: "entra" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns loudly on startup when static-fallback is active", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkStaticFallbackMode({ WEB_AUTH_MODE: "static-fallback" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WEB_AUTH_MODE=static-fallback is ACTIVE"),
    );
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rag/web test -- instrumentation
```

Expected: FAIL — `Cannot find module './instrumentation.js'`.

- [ ] **Step 3: Implement**

Create `apps/web/src/instrumentation.ts`:

```typescript
/**
 * WEB_AUTH_MODE=static-fallback is a complete, unexpiring bypass of per-user
 * auth (docs/RAG-SYSTEM-EVALUATION-2026-07-13.md P2) — every request served
 * this way is already logged per-request via console.warn in
 * resolveRequestBearerToken (lib/rag-api.ts), but nothing previously warned
 * ONCE, loudly, at process start, where an operator watching deploy logs
 * would actually see it. This does not add an expiry (the per-request log is
 * the audit trail; a hard TTL would risk locking out the emergency rollback
 * it exists for) — it makes the condition impossible to miss on boot.
 */
export function checkStaticFallbackMode(
  env: Record<string, string | undefined>,
): void {
  if (env.WEB_AUTH_MODE === "static-fallback") {
    console.warn(
      "[rag-web] WEB_AUTH_MODE=static-fallback is ACTIVE — per-user Entra ID " +
        "auth is bypassed for every request; all traffic is authorized by one " +
        "shared static token. This is meant to be a TEMPORARY emergency " +
        "rollback. If this is not an active incident, unset WEB_AUTH_MODE now.",
    );
  }
}

/**
 * Next.js instrumentation hook — runs once when the server starts, before any
 * request is served. See https://nextjs.org/docs/app/guides/instrumentation.
 */
export function register(): void {
  checkStaticFallbackMode(process.env);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rag/web test -- instrumentation
```

Expected: PASS, all 3 cases green.

- [ ] **Step 5: Enable the instrumentation hook in Next.js config**

Read `apps/web/next.config.ts` (just modified in Task 3) and confirm `next` is `15.5.20` — instrumentation is stable (no `experimental.instrumentationHook` flag needed) on Next.js 15. No config change needed beyond the file existing at `src/instrumentation.ts`; Next.js auto-detects it.

- [ ] **Step 6: Build to confirm Next.js picks up the hook without error**

```bash
pnpm --filter @rag/web build
```

Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/instrumentation.ts apps/web/src/instrumentation.test.ts
git commit -m "feat: warn loudly on startup when WEB_AUTH_MODE=static-fallback is active"
```

---

## Task 5: Citation filter handles grouped/ranged citations

**Files:**

- Modify: `packages/rag/src/generation/generator.ts`
- Modify: `packages/rag/src/generation/generator.test.ts`

**Interfaces:**

- Produces: `filterCitationsToAnswer(answer: string, citations: GenerationResult["citations"]): GenerationResult["citations"]` — same signature, just more inputs recognized. No caller (`packages/services/src/ask.ts`) changes.

- [ ] **Step 1: Write the failing tests**

In `packages/rag/src/generation/generator.test.ts`, add (matching the existing `describe("filterCitationsToAnswer"` block if one exists — otherwise add a new one):

```typescript
describe("filterCitationsToAnswer — grouped/ranged citations", () => {
  const citations = [
    {
      index: 1,
      documentId: "d1",
      title: "Doc 1",
      url: null,
      downloadable: false,
      chunkId: "c1",
      score: 0.9,
    },
    {
      index: 2,
      documentId: "d2",
      title: "Doc 2",
      url: null,
      downloadable: false,
      chunkId: "c2",
      score: 0.8,
    },
    {
      index: 3,
      documentId: "d3",
      title: "Doc 3",
      url: null,
      downloadable: false,
      chunkId: "c3",
      score: 0.7,
    },
  ];

  it("recognizes a comma-space group like [1, 2]", () => {
    const result = filterCitationsToAnswer(
      "See sources [1, 2] for details.",
      citations,
    );
    expect(result.map((c) => c.index)).toEqual([1, 2]);
  });

  it("recognizes a comma-no-space group like [1,2]", () => {
    const result = filterCitationsToAnswer(
      "See sources [1,2] for details.",
      citations,
    );
    expect(result.map((c) => c.index)).toEqual([1, 2]);
  });

  it("recognizes a range like [1-3]", () => {
    const result = filterCitationsToAnswer(
      "See sources [1-3] for details.",
      citations,
    );
    expect(result.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it("still recognizes plain single citations like [3]", () => {
    const result = filterCitationsToAnswer("See source [3].", citations);
    expect(result.map((c) => c.index)).toEqual([3]);
  });

  it("de-duplicates across mixed single and grouped forms", () => {
    const result = filterCitationsToAnswer(
      "See [1] and also [1, 2].",
      citations,
    );
    expect(result.map((c) => c.index)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @rag/rag test -- generator
```

Expected: FAIL — the `[1, 2]`/`[1,2]`/`[1-3]` cases return `[]` (current regex only matches single digits), while the single-citation and no-group tests already pass.

- [ ] **Step 3: Implement the fix**

In `packages/rag/src/generation/generator.ts`, replace `filterCitationsToAnswer` (lines 89-99):

```typescript
/**
 * Filter a citations array down to only the indices the answer text actually
 * references via `[N]` notation. `buildCitations` returns one entry per
 * retrieved chunk regardless of what the model cited — for a system whose
 * citations are meant to be an audit trail, showing an entry the answer never
 * referenced is misleading (a reader can't tell "cited" from "merely
 * retrieved"). Applied by callers (ask.ts) AFTER the full answer text is
 * known, since it depends on generation output, not just retrieval.
 *
 * Recognizes three bracket forms the model has been observed to emit despite
 * the system prompt instructing singular `[N]` notation:
 *   - Single: `[3]`
 *   - Comma-separated group: `[1, 2]` or `[1,2]`
 *   - Range: `[1-3]` (inclusive, expands to 1, 2, 3)
 * A malformed range (e.g. a non-numeric bound, or start > end) is treated as
 * no match for that bracket rather than throwing — a citation-audit filter
 * failing loud would take down an entire answer over a formatting quirk.
 */
export function filterCitationsToAnswer(
  answer: string,
  citations: GenerationResult["citations"],
): GenerationResult["citations"] {
  const referenced = new Set<number>();
  for (const match of answer.matchAll(/\[([\d,\s-]+)\]/g)) {
    const body = match[1]!.trim();
    if (body.includes("-") && !body.includes(",")) {
      const [startStr, endStr] = body.split("-").map((s) => s.trim());
      const start = Number(startStr);
      const end = Number(endStr);
      if (Number.isInteger(start) && Number.isInteger(end) && start <= end) {
        for (let n = start; n <= end; n++) referenced.add(n);
      }
      continue;
    }
    for (const part of body.split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n)) referenced.add(n);
    }
  }
  return citations.filter((c) => referenced.has(c.index));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @rag/rag test -- generator
```

Expected: PASS, all new and existing cases green (including any pre-existing single-citation tests in the same file — re-read the full test file first if any fail unexpectedly, since the regex changed from `\[(\d+)\]` to `\[([\d,\s-]+)\]`).

- [ ] **Step 5: Commit**

```bash
git add packages/rag/src/generation/generator.ts packages/rag/src/generation/generator.test.ts
git commit -m "fix: citation filter recognizes grouped and ranged [N] forms"
```

---

## Task 6: Sparse search — `websearch_to_tsquery` instead of `plainto_tsquery`

**Files:**

- Modify: `packages/db/src/queries.ts`
- Modify: `tests/e2e/src/specs/retrieval.spec.ts`

**Interfaces:** No signature change — `hybridSearch`'s public shape is unchanged; only the SQL predicate inside it changes.

- [ ] **Step 1: Write the failing test**

In `tests/e2e/src/specs/retrieval.spec.ts`, add a new `it` inside the existing `describe("E2E: hybrid retrieval"` block (after the existing tests, using the same `beforeEach`-seeded `retriever`/`sourceId`):

```typescript
it("sparse side still matches a verbose multi-word query (websearch_to_tsquery OR-ish semantics)", async () => {
  const connector = new FakeConnector([
    plainTextDoc({
      externalId: "backup-runbook",
      title: "Postgres Backup Runbook",
      text: "This runbook explains how to configure automated nightly backups for the production Postgres database using pg_dump, verify restore integrity, and rotate old backup files safely.",
    }),
    plainTextDoc({
      externalId: "unrelated",
      title: "Espresso Notes",
      text: "Espresso pulling requires fine-ground coffee and nine bars of pressure for proper extraction.",
    }),
  ]);
  await runOneIngestion(db, sourceId, connector);

  // A verbose, real-world-shaped question. Under plainto_tsquery (AND
  // semantics), requiring every one of these 10+ words to co-occur in one
  // chunk would collapse the sparse side to zero hits; websearch_to_tsquery
  // (OR-ish, phrase-aware) should still surface the relevant document.
  const results = await retriever.search(
    {
      query:
        "how do I configure automated nightly backups and verify restore integrity for the production database",
      topK: 3,
    },
    ADMIN_SCOPE,
  );

  expect(results.length).toBeGreaterThan(0);
  expect(results[0]!.document.title).toBe("Postgres Backup Runbook");
  expect(results[0]!.sparseScore).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker compose -f docker/docker-compose.yml up -d
pnpm --filter @rag/e2e test -- retrieval.spec
```

Expected: the new test FAILs or the assertion on `sparseScore > 0` fails — under `plainto_tsquery`'s AND semantics, this many co-occurring terms in one chunk is unlikely to match, so `sparseScore` is `0` for the top (dense-only-driven) result. (If the FakeEmbedder's dense side alone happens to still rank the right doc first, the `sparseScore` assertion is what actually proves the bug — keep it.)

- [ ] **Step 3: Implement the fix**

In `packages/db/src/queries.ts`, change line 526:

```typescript
               plainto_tsquery('english', ${opts.query}) AS q_tsquery
```

to:

```typescript
               websearch_to_tsquery('english', ${opts.query}) AS q_tsquery
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rag/e2e test -- retrieval.spec
```

Expected: PASS. Also re-run the full retrieval/metadata-filter suites to confirm no regression:

```bash
pnpm --filter @rag/e2e test -- retrieval.spec metadata-filter.spec
```

Expected: all PASS — `websearch_to_tsquery` is a superset-compatible replacement for simple queries (single/few keywords behave the same; it adds OR/phrase/exclusion support on top).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/queries.ts tests/e2e/src/specs/retrieval.spec.ts
git commit -m "fix: use websearch_to_tsquery for sparse search (was plainto_tsquery AND-only)"
```

---

## Task 7: Exclude archived documents from retrieval

**Depends on: Task 6 must be committed first.** Both tasks modify the same two files (`packages/db/src/queries.ts` and `tests/e2e/src/specs/retrieval.spec.ts`) in different regions. If dispatched via subagent-driven-development, do NOT run Task 6 and Task 7 as parallel subagents — a fresh subagent per task means two agents editing the same files concurrently, which races on the same working tree regardless of the edits landing in different line ranges. Run Task 6 to completion (through its commit) before starting Task 7.

**Files:**

- Modify: `packages/db/src/queries.ts`
- Modify: `tests/e2e/src/specs/retrieval.spec.ts`

**Interfaces:** No signature change — `hybridSearch`'s WHERE clause gains one more condition, applied unconditionally (not opt-in), consistent with how `enforcedSourceFilter` is already unconditional.

- [ ] **Step 1: Write the failing test**

In `tests/e2e/src/specs/retrieval.spec.ts`, add (needs a way to set `lifecycleStatus` post-ingest — use `db.update` directly against the `documents` table, mirroring how other specs in this file already import `Db`/query helpers rather than adding a new test-only mutation path):

```typescript
it("excludes archived documents from hybrid search by default", async () => {
  const { documents } = await import("@rag/db/schema");
  const { eq } = await import("drizzle-orm");

  const connector = new FakeConnector([
    plainTextDoc({
      externalId: "current-sop",
      title: "Current Engagement SOP",
      text: "This engagement SOP covers current firm procedures for client onboarding and billing.",
    }),
  ]);
  await runOneIngestion(db, sourceId, connector);

  await db
    .update(documents)
    .set({ lifecycleStatus: "archived" })
    .where(eq(documents.title, "Current Engagement SOP"));

  const results = await retriever.search(
    { query: "engagement SOP client onboarding billing procedures", topK: 5 },
    ADMIN_SCOPE,
  );

  expect(
    results.find((r) => r.document.title === "Current Engagement SOP"),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rag/e2e test -- retrieval.spec
```

Expected: FAIL — the archived document is currently retrieved identically to an active one (`lifecycle_status` is never referenced in `hybridSearch`'s query).

- [ ] **Step 3: Implement the fix**

In `packages/db/src/queries.ts`, find the final `SELECT ... WHERE TRUE ...` block (around lines 572-596) and add the exclusion right after `WHERE TRUE`:

```typescript
      WHERE TRUE
        AND doc.lifecycle_status != 'archived'
      ${enforcedSourceFilter}
      ${sourceFilter}
      ${sql.join(metadataConditions, sql` `)}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rag/e2e test -- retrieval.spec
```

Expected: PASS. Re-run the full e2e suite's retrieval-adjacent specs to confirm no other test seeded a document with `lifecycleStatus: "archived"` expecting it to be retrievable (grep first):

```bash
grep -rn "lifecycleStatus" tests/e2e/src/
pnpm --filter @rag/e2e test -- retrieval.spec metadata-filter.spec idempotency.spec
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/queries.ts tests/e2e/src/specs/retrieval.spec.ts
git commit -m "fix: hybridSearch excludes archived documents by default"
```

---

## Task 8: Apply the diversity cap to `searchDocuments`

**Files:**

- Modify: `packages/services/src/search.ts`
- Create: `packages/services/src/search.test.ts`

**Interfaces:**

- Consumes: `capChunksPerDocument(results: RetrievalResult[], cap: number): RetrievalResult[]` (`packages/services/src/ask.ts:18`, already exported from that module).
- Produces: `searchDocuments(deps: ServiceDeps, input: SearchInput, defaultTopK: number, scope: AuthorizationScope, maxChunksPerDocument?: number): Promise<SanitizedRetrievalResult[]>` — **signature changes** (new optional 5th param, defaulting to `0` = disabled, matching `askQuestion`'s existing `maxChunksPerDocument = 0` default). Callers (`apps/api/src/routes/search.ts`, `apps/mcp/src/tools/search-documents.ts`) must pass `config.retrieval.maxChunksPerDocument` the same way `ask.ts`/`apps/mcp/src/tools/ask.ts` already do — grep both call sites for `askQuestion(` to find the exact config field name and mirror it into the `searchDocuments(` call sites.

- [ ] **Step 1: Write the failing test**

Create `packages/services/src/search.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationScope, RetrievalResult } from "@rag/core";
import { searchDocuments } from "./search.js";
import type { ServiceDeps } from "./deps.js";

function chunk(documentId: string, chunkId: string): RetrievalResult {
  return {
    text: `text for ${chunkId}`,
    score: 1,
    denseScore: 1,
    sparseScore: 1,
    document: {
      id: documentId,
      title: `Doc ${documentId}`,
      sourceId: "src-1",
      sourceKind: "custom",
      hasOriginal: false,
      metadata: {},
    },
    chunk: {
      id: chunkId,
      headingPath: [],
      ordinal: 0,
      page: null,
    },
  } as RetrievalResult;
}

const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };

describe("searchDocuments — per-document diversity cap", () => {
  it("passes results through uncapped when maxChunksPerDocument is 0 (default)", async () => {
    const results = [
      chunk("doc-1", "c1"),
      chunk("doc-1", "c2"),
      chunk("doc-1", "c3"),
    ];
    const deps = {
      retriever: { search: vi.fn(async () => results) },
    } as unknown as ServiceDeps;

    const out = await searchDocuments(deps, { query: "q" }, 10, ADMIN_SCOPE);

    expect(out).toHaveLength(3);
  });

  it("caps chunks per document when maxChunksPerDocument is set", async () => {
    const results = [
      chunk("doc-1", "c1"),
      chunk("doc-1", "c2"),
      chunk("doc-1", "c3"),
      chunk("doc-2", "c4"),
    ];
    const deps = {
      retriever: { search: vi.fn(async () => results) },
    } as unknown as ServiceDeps;

    const out = await searchDocuments(deps, { query: "q" }, 10, ADMIN_SCOPE, 2);

    expect(out.filter((r) => r.document.id === "doc-1")).toHaveLength(2);
    expect(out.filter((r) => r.document.id === "doc-2")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rag/services test -- search
```

Expected: FAIL on the second test — `searchDocuments` currently has no 5th parameter, so `maxChunksPerDocument` is silently ignored (TypeScript would actually error on the extra argument once `searchDocuments`'s signature is strict — confirm this by running `pnpm --filter @rag/services typecheck` too, expect a type error there before Step 3).

- [ ] **Step 3: Implement the fix**

Replace `packages/services/src/search.ts`:

```typescript
import type { AuthorizationScope, SanitizedRetrievalResult } from "@rag/core";
import { sanitizeRetrievalResults } from "@rag/core";
import { capChunksPerDocument } from "./ask.js";
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
 *
 * `scope` is the MANDATORY confidentiality boundary (P1): the principal's
 * enforced source-id set (admin => all; scoped => only its sources; missing =>
 * deny all). It is passed to the retriever, which intersects it with any caller
 * `sourceIds` so the optional caller filter can only narrow WITHIN the scope.
 *
 * `maxChunksPerDocument` mirrors `askQuestion`'s diversity cap
 * (`capChunksPerDocument`, ask.ts) — previously only the generation path had
 * this, so a single long document could dominate plain /search results too.
 * `0` (default) disables the cap, matching `askQuestion`'s default.
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
  maxChunksPerDocument = 0,
): Promise<SanitizedRetrievalResult[]> {
  const results = capChunksPerDocument(
    await deps.retriever.search(
      {
        query: input.query,
        topK: input.topK ?? defaultTopK,
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        ...(input.filter ? { filter: input.filter } : {}),
      },
      scope,
    ),
    maxChunksPerDocument,
  );
  return sanitizeRetrievalResults(results);
}
```

- [ ] **Step 4: Update both call sites**

Read `apps/api/src/routes/ask.ts` and find the exact config field `askQuestion(...)` passes as its `maxChunksPerDocument` argument (it's `config.retrieval.maxChunksPerDocument` per the evaluation doc's citation of `packages/core/src/config.ts:138`). In `apps/api/src/routes/search.ts`, find the `searchDocuments(...)` call and add the same argument in the same position. Do the identical change in `apps/mcp/src/tools/search-documents.ts`, matching how `apps/mcp/src/tools/ask.ts` already passes it to `askQuestion`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @rag/services test -- search
pnpm --filter @rag/services typecheck
pnpm --filter @rag/api typecheck
pnpm --filter @rag/mcp typecheck
```

Expected: all PASS/exit 0.

- [ ] **Step 6: Run the existing api/mcp test suites to confirm no regression at the route/tool layer**

```bash
pnpm --filter @rag/api test
pnpm --filter @rag/mcp test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/services/src/search.ts packages/services/src/search.test.ts \
  apps/api/src/routes/search.ts apps/mcp/src/tools/search-documents.ts
git commit -m "fix: apply per-document diversity cap to searchDocuments (was ask-only)"
```

---

## Task 9: Row-aware splitting for oversized inline markdown tables

**Files:**

- Modify: `packages/rag/src/chunking/markdown-chunker.ts`
- Modify: `packages/rag/src/chunking/markdown-chunker.test.ts`

**Interfaces:** No public signature change — `MarkdownChunker.chunk()` is unchanged; `hardSplit` (private-module-level helper) gains a table-aware branch, scoped v1: detects GFM pipe-table syntax and splits on row boundaries instead of raw character offsets, when a unit passed to `hardSplit` is itself a table. Does not attempt full table-vs-prose detection at the section/paragraph level (that's `TableChunker`'s job for spreadsheet-origin documents, per `composite-chunker.ts`'s existing scope) — this only fixes the specific failure mode where an inline markdown table ends up as one oversized "paragraph" unit and gets character-sliced.

- [ ] **Step 1: Write the failing test**

In `packages/rag/src/chunking/markdown-chunker.test.ts`, add:

```typescript
describe("MarkdownChunker — oversized inline table", () => {
  it("splits an oversized markdown table on row boundaries, never mid-row", async () => {
    const header = "| Client | Fee | Due Date |\n| --- | --- | --- |\n";
    const rows = Array.from(
      { length: 60 },
      (_, i) => `| Client ${i} | $${1000 + i} | 2026-0${(i % 9) + 1}-15 |\n`,
    ).join("");
    const chunker = new MarkdownChunker({ chunkSize: 200, chunkOverlap: 0 });

    const chunks = await chunker.chunk({
      title: "Fee Schedule",
      markdown: `# Fee Schedule\n\n${header}${rows}`,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must contain only WHOLE table rows — never a row split
    // mid-way through a "| ... |" line (the character-offset bug this fixes).
    for (const c of chunks) {
      const lines = c.text.split("\n").filter((l) => l.trim().startsWith("|"));
      for (const line of lines) {
        expect(line.trim().endsWith("|")).toBe(true);
      }
    }
    // No client row's fee/date got separated from its client name across a
    // chunk boundary in a way that drops it entirely.
    const allText = chunks.map((c) => c.text).join("\n");
    expect(allText).toContain("Client 0");
    expect(allText).toContain("Client 59");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rag/rag test -- markdown-chunker
```

Expected: FAIL — some chunk's `line.trim().endsWith("|")` assertion fails because `hardSplit`'s current char-offset slicing (`markdown-chunker.ts:202-206`) cuts a `| Client N | $... | ...` line mid-string.

- [ ] **Step 3: Implement the fix**

In `packages/rag/src/chunking/markdown-chunker.ts`, replace `hardSplit` (lines 187-219):

```typescript
/**
 * Last-resort splitter for a single unit (paragraph or code block) larger than
 * chunkSize. If the unit looks like a GFM pipe table (every non-blank line
 * starts with `|`), split on row boundaries so no chunk ever cuts a table row
 * mid-way — the header + separator row is repeated at the top of every piece
 * so each chunk stays self-contained. Otherwise splits by sentence first, then
 * by character if a sentence is itself huge.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  if (looksLikeMarkdownTable(text)) {
    return hardSplitTable(text, maxTokens);
  }

  const sentences = text.match(/[^.!?]+[.!?]?\s*/g) ?? [text];
  const out: string[] = [];
  let buffer = "";
  let bufferTokens = 0;

  for (const s of sentences) {
    const t = countTokens(s);
    if (t > maxTokens) {
      // Even a single sentence is too big — fall back to character chunking.
      if (buffer) {
        out.push(buffer);
        buffer = "";
        bufferTokens = 0;
      }
      const charPerToken = 4;
      const charBudget = maxTokens * charPerToken;
      for (let i = 0; i < s.length; i += charBudget) {
        out.push(s.slice(i, i + charBudget));
      }
      continue;
    }
    if (bufferTokens + t > maxTokens) {
      out.push(buffer);
      buffer = "";
      bufferTokens = 0;
    }
    buffer += s;
    bufferTokens += t;
  }
  if (buffer) out.push(buffer);
  return out;
}

/** True when every non-blank line of `text` is a GFM pipe-table row (`| ... |`). */
function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.length >= 2 && lines.every((l) => l.trim().startsWith("|"));
}

/**
 * Split a markdown table into row-boundary-respecting pieces. The header row
 * and its `| --- | --- |` separator are repeated at the top of every piece
 * past the first so each chunk stays a valid, self-contained table.
 */
function hardSplitTable(text: string, maxTokens: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const headerLine = lines[0]!;
  const separatorLine = lines[1]!;
  const dataRows = lines.slice(2);

  const out: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = countTokens(`${headerLine}\n${separatorLine}\n`);

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(`${headerLine}\n${separatorLine}\n${buffer.join("\n")}`);
    buffer = [];
    bufferTokens = countTokens(`${headerLine}\n${separatorLine}\n`);
  };

  for (const row of dataRows) {
    const rowTokens = countTokens(row);
    if (bufferTokens + rowTokens > maxTokens && buffer.length > 0) {
      flush();
    }
    buffer.push(row);
    bufferTokens += rowTokens;
  }
  flush();

  return out.length > 0 ? out : [text];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rag/rag test -- markdown-chunker
```

Expected: PASS. Re-run the full package's test suite to confirm the existing non-table `hardSplit` tests (long-sentence/long-paragraph cases) still pass unchanged:

```bash
pnpm --filter @rag/rag test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rag/src/chunking/markdown-chunker.ts packages/rag/src/chunking/markdown-chunker.test.ts
git commit -m "fix: split oversized inline markdown tables on row boundaries, not raw char offset"
```

---

## Task 10: Test coverage for Gmail, Outlook, and Google Drive connectors

**Files:**

- Create: `packages/connectors/src/gmail/index.test.ts`
- Create: `packages/connectors/src/outlook/index.test.ts`
- Create: `packages/connectors/src/gdrive/index.test.ts`

**Interfaces:** No production code changes — these are pure test additions against each connector's existing public `Connector` interface (`validate`/`list`/`fetch`).

- [ ] **Step 1: Write the Outlook test (reuses SharePoint's `GraphReader` fake — same underlying `GraphClient`)**

Create `packages/connectors/src/outlook/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { OutlookConnector } from "./index.js";
import type { GraphCredentials, GraphReader } from "../sharepoint/client.js";

const CREDS: GraphCredentials = {
  tenantId: "t",
  clientId: "c",
  clientSecret: "s",
};
const noop = () => undefined;
const LOGGER = {
  info: noop,
  error: noop,
  warn: noop,
  debug: noop,
  child: () => LOGGER,
} as unknown as Logger;

class FakeGraph implements GraphReader {
  readonly calls: string[] = [];
  constructor(private readonly route: (url: string) => unknown) {}
  async getJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    const res = this.route(url);
    if (res === undefined) throw new Error(`FakeGraph: no route for ${url}`);
    return res as T;
  }
  async getBytes(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    this.calls.push(url);
    return { bytes: Buffer.from("bytes"), contentType: "message/rfc822" };
  }
}

function makeConnector(route: (url: string) => unknown) {
  // OutlookConnector constructs its own GraphClient from credentials; we can't
  // inject a fake the way SharePoint's constructor allows (no optional 4th
  // arg), so this suite drives it through `graph.getJson` indirectly by
  // testing the pure page-building logic is unreachable without a network
  // client. Given that constraint, these tests exercise validate()'s URL
  // shape and list()'s pagination/cursor contract via the connector's own
  // paginate() usage, which IS unit-testable without a live Graph client by
  // constructing OutlookConnector with a minimal config and asserting the
  // ValidationError path for invalid config — the one fully offline-testable
  // surface without a client-injection seam.
  return route;
}

describe("OutlookConnector", () => {
  it("rejects an invalid config at construction (missing userId)", () => {
    expect(() => new OutlookConnector({}, CREDS, LOGGER)).toThrow(
      /invalid Outlook config/,
    );
  });

  it("kind is 'outlook'", () => {
    const connector = new OutlookConnector(
      { userId: "doug@twkcpa.com" },
      CREDS,
      LOGGER,
    );
    expect(connector.kind).toBe("outlook");
  });
});
```

- [ ] **Step 2: Run and check the Outlook test's honest limitation**

```bash
pnpm --filter @rag/connectors test -- outlook/index
```

Expected: PASS (2 cases). Note in your PR description: `OutlookConnector`'s constructor doesn't accept an injectable `GraphReader` the way `SharePointConnector`'s does (`packages/connectors/src/sharepoint/index.ts`'s constructor has an optional 4th `graph?: GraphReader` param SharePoint's tests use — Outlook's doesn't). This test intentionally covers only the offline-testable surface (config validation, `kind`) rather than fabricating a deeper integration test against a real `GraphClient`. **Flag as a follow-up, don't silently expand scope here**: adding the same injectable-client seam to `OutlookConnector` (mirroring SharePoint's constructor shape) would unlock the same depth of pagination/error-handling test SharePoint already has, but that's a production code change beyond this task's scope (test-only, per this plan's stated boundary).

- [ ] **Step 3: Write the Gmail test (has a real client-injection seam via its own constructor pattern? — check first)**

Re-read `packages/connectors/src/gmail/index.ts:59-74`: the constructor takes `(rawConfig, credentials: GoogleCredentials, logger)` and calls `createGmailClient(credentials, ...)` internally — same non-injectable shape as Outlook. Write the equivalent offline-testable suite:

Create `packages/connectors/src/gmail/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { GmailConnector } from "./index.js";
import type { GoogleCredentials } from "./client.js";

const CREDS: GoogleCredentials = {
  type: "service_account",
  clientEmail: "svc@example.iam.gserviceaccount.com",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
} as GoogleCredentials;

const noop = () => undefined;
const LOGGER = {
  info: noop,
  error: noop,
  warn: noop,
  debug: noop,
  child: () => LOGGER,
} as unknown as Logger;

describe("GmailConnector", () => {
  it("rejects an invalid config at construction (missing userId)", () => {
    expect(() => new GmailConnector({}, CREDS, LOGGER)).toThrow(
      /invalid Gmail config/,
    );
  });

  it("kind is 'gmail'", () => {
    const connector = new GmailConnector(
      { userId: "doug@twkcpa.com" },
      CREDS,
      LOGGER,
    );
    expect(connector.kind).toBe("gmail");
  });

  it("fetch() rejects an externalId with no matching attachment on the message (requires a real client to reach — documents the contract via config validation instead)", () => {
    // GmailConnector has no injectable client seam (constructor builds its own
    // gmail_v1.Gmail from credentials), so fetch()/list()'s Graph-calling paths
    // aren't unit-testable without a live client or a larger refactor beyond
    // this task's test-only scope. This suite covers the offline-testable
    // surface (config validation, kind) — see Outlook's test for the same
    // documented limitation and the follow-up recommendation.
    expect(() => new GmailConnector({ userId: 123 }, CREDS, LOGGER)).toThrow(
      /invalid Gmail config/,
    );
  });
});
```

- [ ] **Step 4: Write the GDrive test (same shape)**

Create `packages/connectors/src/gdrive/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { GDriveConnector } from "./index.js";
import type { GoogleCredentials } from "./client.js";

const CREDS: GoogleCredentials = {
  type: "service_account",
  clientEmail: "svc@example.iam.gserviceaccount.com",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
} as GoogleCredentials;

const noop = () => undefined;
const LOGGER = {
  info: noop,
  error: noop,
  warn: noop,
  debug: noop,
  child: () => LOGGER,
} as unknown as Logger;

describe("GDriveConnector", () => {
  it("rejects an invalid config at construction (bad folderId type)", () => {
    expect(() => new GDriveConnector({ folderId: 123 }, CREDS, LOGGER)).toThrow(
      /invalid GDrive config/,
    );
  });

  it("kind is 'gdrive'", () => {
    const connector = new GDriveConnector(
      { folderId: "1AbCdEf" },
      CREDS,
      LOGGER,
    );
    expect(connector.kind).toBe("gdrive");
  });
});
```

- [ ] **Step 5: Run all three new suites**

```bash
pnpm --filter @rag/connectors test -- gmail/index outlook/index gdrive/index
```

Expected: PASS, 7 total cases (3 gmail + 2 outlook + 2 gdrive).

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/gmail/index.test.ts packages/connectors/src/outlook/index.test.ts packages/connectors/src/gdrive/index.test.ts
git commit -m "test: add config-validation coverage for gmail/outlook/gdrive connectors"
```

**Note for whoever picks up the next round:** this task closes the "zero test files" gap but is intentionally shallow (config validation + `kind` only) because none of these three connectors has an injectable API-client seam the way `SharePointConnector` does. A real follow-up (separate task, production code change, not in this plan's scope) is: add an optional injectable client parameter to `GmailConnector`/`OutlookConnector`/`GDriveConnector`'s constructors mirroring `SharePointConnector`'s 4th-arg pattern, then write the same depth of pagination/cursor/error-handling tests `sharepoint/index.test.ts` already has.

---

## Task 11: Test coverage for `buildCoreDeps`/`buildAuthProvider` wiring

**Files:**

- Create: `packages/runtime/src/index.test.ts`

**Interfaces:** No production code changes — pure test addition against `buildAuthProvider(config: Config, logger: Logger): AuthProvider` (already exported, `packages/runtime/src/index.ts:81`).

- [ ] **Step 1: Write the test**

`buildCoreDeps` opens a real DB pool and pg-boss connection, so a true unit test needs those mocked at the module level — but `buildAuthProvider` is pure (config + logger in, an `AuthProvider` out, no I/O), making it the right target for a real, non-mocked-to-uselessness test. Create `packages/runtime/src/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { Config } from "@rag/core";
import { buildAuthProvider } from "./index.js";

const LOGGER = pino({ level: "silent" });

function baseConfig(overrides: Partial<Config["auth"]> = {}): Config {
  return {
    auth: {
      provider: "static-token",
      internalScopeSecrets: [],
      ...overrides,
    },
    api: {
      tokens: ["test-token-aaaaaaaa"],
      principals: [],
      enforceScoping: true,
    },
  } as unknown as Config;
}

describe("buildAuthProvider", () => {
  it("builds a static-token provider that authenticates a configured token", async () => {
    const config = baseConfig({ provider: "static-token" });
    const provider = buildAuthProvider(config, LOGGER);

    const principal = await provider.authenticate("test-token-aaaaaaaa");
    expect(principal).not.toBeNull();
  });

  it("static-token provider rejects an unconfigured token", async () => {
    const config = baseConfig({ provider: "static-token" });
    const provider = buildAuthProvider(config, LOGGER);

    const principal = await provider.authenticate("not-a-real-token");
    expect(principal).toBeNull();
  });

  it("throws when provider is 'oidc' but no OIDC config was built", () => {
    const config = baseConfig({ provider: "oidc", oidc: undefined });
    expect(() => buildAuthProvider(config, LOGGER)).toThrow(
      /auth.provider is 'oidc' but no OIDC config was built/,
    );
  });

  it("composite provider tries static tokens first, falls through cleanly with no OIDC configured", async () => {
    const config = baseConfig({
      provider: "composite",
      internalScopeSecrets: [],
    });
    const provider = buildAuthProvider(config, LOGGER);

    const principal = await provider.authenticate("test-token-aaaaaaaa");
    expect(principal).not.toBeNull();

    const rejected = await provider.authenticate("garbage");
    expect(rejected).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @rag/runtime test -- index
```

Expected: PASS, 4 cases. If any fail, read `packages/core/src/auth-provider-factory.ts`'s `createAuthProvider` to confirm the exact `AuthProvider.authenticate` contract (`Promise<Principal | null>`) and adjust the `baseConfig` fixture's shape to match `Config["auth"]`/`Config["api"]`'s real Zod-inferred types exactly — this is the one task in this plan most likely to need a fixture-shape adjustment after reading the actual `Config` type, since `buildAuthProvider` was read but the full `Config["api"]` shape (principals array element type) wasn't re-verified line-by-line in this planning pass.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/index.test.ts
git commit -m "test: add buildAuthProvider wiring coverage (static-token, oidc-missing-config, composite)"
```

---

## Task 12: Route-level test coverage for `GET /documents/:id` and `/download`

**Files:**

- Create: `apps/api/src/routes/documents.test.ts`

**Interfaces:** No production code changes — pure test addition, mocking `@rag/db`'s `getDocument` the same way `sources.test.ts` mocks `listSources`/`getSource`/`createSource`.

- [ ] **Step 1: Write the test**

Create `apps/api/src/routes/documents.test.ts`:

```typescript
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Config } from "@rag/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

const { getDocumentMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
}));

vi.mock("@rag/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rag/db")>();
  return { ...actual, getDocument: getDocumentMock };
});

const DOC_ID = "11111111-1111-1111-1111-111111111111";
const ADMIN_TOKEN = "admin-token-aaaaaaaa";
const SCOPED_A_TOKEN = "scoped-a-token-bbbbbbbb";
const SRC_A = "22222222-2222-2222-2222-222222222222";
const SRC_B = "33333333-3333-3333-3333-333333333333";

function documentRow(
  sourceId: string,
  opts: { storageKey?: string | null } = {},
) {
  return {
    id: DOC_ID,
    sourceId,
    externalId: "ext-1",
    title: "Fee Schedule 2026",
    mimeType: "application/pdf",
    sourceModifiedAt: null,
    contentHash: "hash",
    sizeBytes: 100,
    metadata: { author: "should-not-leak" },
    markdown: "# Fee Schedule",
    storageKey:
      opts.storageKey === undefined ? "docs/fee-schedule.pdf" : opts.storageKey,
    storageBucket: "test-bucket",
    originalSizeBytes: 100,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    contentType: null,
    ownerId: null,
    lifecycleStatus: "active",
  };
}

function makeDeps(): Deps {
  return {
    db: {} as Deps["db"],
    queue: {} as Deps["queue"],
    retriever: {} as Deps["retriever"],
    embedder: {
      name: "test-provider",
      model: "test-model",
    } as Deps["embedder"],
    generator: null,
    objectStore: {
      bucket: "test-bucket",
      put: vi.fn(),
      get: vi.fn(async () => ({
        body: Readable.from(Buffer.from("pdf-bytes")),
        contentType: "application/pdf",
        contentLength: 9,
      })),
      delete: vi.fn(),
    },
    logger: pino({ level: "silent" }),
    close: async () => {},
  } as Deps;
}

// buildServer takes ONE object argument { config, logger, deps } (confirmed
// in apps/api/src/server.ts:24 and mirrored exactly from sources.test.ts's
// own buildApp helper) — NOT two positional args. ADMIN_TOKEN is a plain
// `api.tokens` entry (resolves to admin/all-access, per config.ts's own
// comment on that field); SCOPED_A_TOKEN is an `api.principals` entry keyed
// by `allowedSourceIds` (NOT `sourceIds` — that field name doesn't exist on
// this type).
const config = {
  api: {
    tokens: [ADMIN_TOKEN],
    principals: [{ token: SCOPED_A_TOKEN, allowedSourceIds: [SRC_A] }],
  },
  auth: { provider: "static-token" },
  retrieval: { defaultTopK: 8 },
} as unknown as Config;

async function buildApp(): Promise<FastifyInstance> {
  const app = await buildServer({
    config,
    logger: pino({ level: "silent" }),
    deps: makeDeps(),
  });
  await app.ready();
  return app;
}

describe("GET /documents/:id", () => {
  it("returns the document for an in-scope caller", async () => {
    getDocumentMock.mockResolvedValue(documentRow(SRC_A));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/documents/${DOC_ID}`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(DOC_ID);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for a caller scoped to a different source (not 403 — indistinguishable from missing)", async () => {
    getDocumentMock.mockResolvedValue(documentRow(SRC_B));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/documents/${DOC_ID}`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the document does not exist", async () => {
    getDocumentMock.mockResolvedValue(null);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/documents/${DOC_ID}`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("GET /documents/:id/download", () => {
  it("streams the original file with correct headers for an in-scope caller", async () => {
    getDocumentMock.mockResolvedValue(documentRow(SRC_A));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/documents/${DOC_ID}/download`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toContain(
        'attachment; filename="Fee Schedule 2026"',
      );
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the document has no stored original", async () => {
    getDocumentMock.mockResolvedValue(documentRow(SRC_A, { storageKey: null }));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/documents/${DOC_ID}/download`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for a caller scoped to a different source", async () => {
    getDocumentMock.mockResolvedValue(documentRow(SRC_B));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/documents/${DOC_ID}/download`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @rag/api test -- documents
```

Expected: PASS, all 7 cases green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/documents.test.ts
git commit -m "test: add route-level coverage for GET /documents/:id and /download"
```

---

## Final Verification

- [ ] **Step 1: Full workspace build, typecheck, lint, test**

```bash
cd /Users/marcusklein/dev/rag-system
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Expected: all exit 0.

- [ ] **Step 2: Full e2e suite (needs Postgres + parser running)**

```bash
pnpm docker:up
pnpm e2e
```

Expected: exit 0, including the new/modified specs from Tasks 6, 7.

- [ ] **Step 3: Re-run Task 1's redeploy to pick up every commit from Tasks 2–12**

```bash
railway up --service rag-worker --ci -y
railway up --service rag-api --ci -y
railway up --service rag-mcp --ci -y
railway status
```

Expected: all three `Online`, today's date, no `Deploy failed` annotation.

- [ ] **Step 4: Confirm the recurring backup job registered**

```bash
railway ssh -s rag-postgres -- bash -lc '
export PGPASSWORD="$POSTGRES_PASSWORD"
/usr/bin/psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h localhost -Atc "select name, cron from pgboss.schedule order by name"
'
```

Expected: three rows — `rag.backup_postgres`, `rag.docs_gap_digest`, `rag.ship_audit_log`.

- [ ] **Step 5: Set `BACKUP_PROVIDER=objectStore` in production (only if `OBJECT_STORE_PROVIDER` is already `s3` there — check first)**

```bash
railway variables --service rag-worker --kv | grep OBJECT_STORE_PROVIDER
```

If it shows `s3`, enable the backup job:

```bash
railway variable set BACKUP_PROVIDER=objectStore --service rag-worker
railway restart --service rag-worker -y
```

If `OBJECT_STORE_PROVIDER` is `none`, leave `BACKUP_PROVIDER=none` (the default) and flag this as a follow-up decision, not something to enable blindly — the whole point of Task 2 was that backups need somewhere real to land.

- [ ] **Step 6: Update `docs/RAG-SYSTEM-EVALUATION-2026-07-13.md`'s P0/P1 findings to reflect closure**

Read the file, and for each finding this plan closed (P0-1, P0-2, P1-1's five sub-items, P1-2's three sub-items, P1-5), add a one-line "RESOLVED — see commit `<hash>`" note, following the same citation discipline the rest of the document already uses — don't leave the document claiming things are open that this plan just closed, which is exactly the stale-doc failure mode the document itself was written to avoid perpetuating.

---

## Self-Review

**Spec coverage** — every code-actionable P0/P1/P2 finding from `docs/RAG-SYSTEM-EVALUATION-2026-07-13.md` maps to a task: P0-1 → Task 1, P0-2 → Task 2, P1-1 (5 sub-findings) → Tasks 5/6/7/8/9, P1-2 (3 sub-findings) → Tasks 10/11/12, P1-5 → Task 3, the `static-fallback` P2 item → Task 4. Explicitly NOT covered (by design, stated in the evaluation doc's own scoping): P0-3 (DPA/legal), P0-4 (content audit), P1-3 (product decision), P1-4 (usage diary) — none are code tasks. Also explicitly deferred, not silently dropped: unconfigured Sentry DSN/scrubbing hook and the audit-sink webhook config (both moot until Task 1 makes the shipping job live in the first place; flagged in the evaluation doc as P2/P3, not re-scoped here to keep this plan's size manageable), the citation-metadata trust fields, the digest push-notification delivery, and reranking evaluation (deliberately deferred per `docs/EVAL-BASELINE.md`).

**Placeholder scan** — every step has real, complete code (no `TBD`/"add appropriate handling"/bare descriptions). Task 10's Gmail/Outlook connector tests are the one place this plan is honest about a real depth limitation (no injectable client seam) rather than faking deeper coverage — that's a documented scope boundary, not a placeholder.

**Type consistency** — `capChunksPerDocument` (Task 8) is imported from `ask.js`, matching its actual export location (`packages/services/src/ask.ts:18`, confirmed by reading the file, not assumed). `searchDocuments`'s new `maxChunksPerDocument = 0` default matches `askQuestion`'s existing default exactly (both `= 0`, both optional last param). `insertBackupRun`'s `BackupRunRow` shape (Task 2) matches what `handleBackupPostgres` (also Task 2) actually constructs — checked they use the same field names (`ranAt`/`sizeBytes`/`objectKey`/`durationMs`) end to end.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-13-rag-system-launch-readiness.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
