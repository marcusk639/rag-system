import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWeakResultAuditEvents, logAskEvent } from "@rag/db";
import type { Db } from "@rag/db";
import { createQueue, JOB_NAMES } from "@rag/ingestion";
import type PgBoss from "pg-boss";
import { env } from "../env.js";
import { openTestDb } from "../helpers/db.js";

/**
 * Phase 4 (docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md): the
 * documentation-gap digest — the first recurring (pg-boss `schedule()`) job
 * in this codebase.
 *
 * Two things here specifically need a real Postgres rather than a mock:
 *   1. `getWeakResultAuditEvents`'s SQL predicate (retrievedCount = 0 OR
 *      array_length(chunkIds, 1) IS NULL OR topScore < minScore) — proving it
 *      actually excludes a "fine" row, not just that it compiles.
 *   2. `boss.schedule()` — this pg-boss API has never been called anywhere in
 *      this codebase before. This is the "spike/smoke test" the plan calls
 *      for: confirm it registers a row in `<schema>.schedule` with the
 *      configured cron/tz, rather than trusting the type signature alone.
 *
 * Does not use `truncateAll` (audit_log is intentionally never truncated by
 * any spec — see audit-log-parity.spec.ts) — each assertion scopes to a
 * unique per-run sourceId/questionHash so runs don't interfere.
 */
describe("E2E: getWeakResultAuditEvents (Phase 4)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  afterAll(async () => {
    await close();
  });

  it("returns zero-result, empty-chunk, and weak-score rows but excludes a fine/strong-score row", async () => {
    const marker = `docs-gap-${Date.now()}-${Math.random()}`;
    const sourceIds = [`source-${marker}`];
    const minScore = 0.3;

    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      questionHash: `${marker}-zero-retrieved`,
      channel: "api",
      model: null,
      sourceIds,
      chunkIds: [],
      docIds: [],
      retrievedCount: 0,
      endpoint: "ask",
      topScore: null,
    });

    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      questionHash: `${marker}-weak-score`,
      channel: "api",
      model: null,
      sourceIds,
      chunkIds: ["chunk-1"],
      docIds: ["doc-1"],
      retrievedCount: 1,
      endpoint: "search",
      topScore: 0.1, // below minScore
    });

    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      questionHash: `${marker}-fine`,
      channel: "api",
      model: null,
      sourceIds,
      chunkIds: ["chunk-2"],
      docIds: ["doc-2"],
      retrievedCount: 1,
      endpoint: "ask",
      topScore: 0.9, // well above minScore — must be excluded
    });

    const since = new Date(Date.now() - 60_000);
    const rows = await getWeakResultAuditEvents(db, { since, minScore });
    // `getWeakResultAuditEvents` returns a narrow projection (no
    // `questionHash` — see its doc comment), so "mine" is identified by the
    // unique per-run `sourceIds` marker, and each expected row is
    // distinguished by its (endpoint, retrievedCount, topScore) shape rather
    // than by a hash.
    const mine = rows.filter((r) => r.sourceIds[0] === sourceIds[0]);

    expect(mine).toHaveLength(2);
    expect(mine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "ask",
          retrievedCount: 0,
          topScore: null,
        }),
        expect.objectContaining({
          endpoint: "search",
          retrievedCount: 1,
          topScore: 0.1,
        }),
      ]),
    );
    // The "fine" row (topScore 0.9, well above minScore) must be excluded.
    expect(mine.some((r) => r.topScore === 0.9)).toBe(false);
  });

  it("excludes rows older than `since` even if they'd otherwise be weak", async () => {
    const marker = `docs-gap-old-${Date.now()}-${Math.random()}`;
    const sourceIds = [`source-${marker}`];

    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      questionHash: marker,
      channel: "api",
      model: null,
      sourceIds,
      chunkIds: [],
      docIds: [],
      retrievedCount: 0,
      endpoint: "ask",
      topScore: null,
    });

    // `since` in the future relative to the row we just inserted.
    const since = new Date(Date.now() + 60_000);
    const rows = await getWeakResultAuditEvents(db, { since, minScore: 0.3 });
    expect(rows.some((r) => r.sourceIds[0] === sourceIds[0])).toBe(false);
  });
});

describe("E2E: pg-boss recurring schedule spike (Phase 4, first use of boss.schedule() in this codebase)", () => {
  let boss: PgBoss;
  let db: Db;
  let close: () => Promise<void>;

  const CRON = "0 6 * * 1";
  const TZ = "America/Chicago";

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
    boss = await createQueue({
      databaseUrl: env.databaseUrl,
      schema: env.pgBossSchema,
      docsGapDigestCron: CRON,
      docsGapDigestTz: TZ,
    });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await close();
  });

  it("registers docsGapDigest in <schema>.schedule with the configured cron/tz", async () => {
    const res = await db.execute<{
      name: string;
      cron: string;
      timezone: string | null;
    }>(
      sql`SELECT name, cron, timezone FROM ${sql.raw(
        env.pgBossSchema,
      )}.schedule WHERE name = ${JOB_NAMES.docsGapDigest}`,
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.cron).toBe(CRON);
    expect(res.rows[0]?.timezone).toBe(TZ);
  });

  it("getSchedules() surfaces the same registration through the public pg-boss API", async () => {
    const schedules = await boss.getSchedules();
    const mine = schedules.find((s) => s.name === JOB_NAMES.docsGapDigest);
    expect(mine).toBeDefined();
    expect(mine?.cron).toBe(CRON);
  });

  it("re-calling createQueue upserts (does not duplicate) the schedule row", async () => {
    const secondBoss = await createQueue({
      databaseUrl: env.databaseUrl,
      schema: env.pgBossSchema,
      docsGapDigestCron: CRON,
      docsGapDigestTz: "UTC", // changed tz — proves the upsert updates in place
    });
    try {
      const res = await db.execute<{ name: string; timezone: string | null }>(
        sql`SELECT name, timezone FROM ${sql.raw(
          env.pgBossSchema,
        )}.schedule WHERE name = ${JOB_NAMES.docsGapDigest}`,
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]?.timezone).toBe("UTC");
    } finally {
      await secondBoss.stop({ graceful: false, close: true });
    }
  });
});
