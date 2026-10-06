import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditLogRecord, AuditLogSink } from "@rag/core";
import { getAuditLogShipperWatermark, logAskEvent } from "@rag/db";
import type { Db } from "@rag/db";
import { createQueue, JOB_NAMES } from "@rag/ingestion";
import type PgBoss from "pg-boss";
import { handleShipAuditLog, type WorkerDeps } from "@rag/worker";
import { env } from "../env.js";
import { openTestDb } from "../helpers/db.js";

/**
 * The audit-log-shipping job — second recurring (pg-boss
 * `schedule()`) job in this codebase after docsGapDigest. Two things here
 * specifically need a real Postgres rather than a mock:
 *   1. `getAuditLogRowsSince`/`advanceAuditLogShipperWatermark` against the
 *      real `audit_log_shipper_state` singleton row — proving the watermark
 *      actually persists and gates subsequent reads, not just that it
 *      compiles (the unit test in apps/worker mocks @rag/db entirely).
 *   2. `boss.schedule()` registering a SECOND named schedule alongside
 *      docsGapDigest without clobbering it.
 *
 * Does not use `truncateAll` (audit_log is intentionally never truncated by
 * any spec — see docs-gap-digest.spec.ts) — each assertion scopes to a
 * unique per-run questionHash marker. `audit_log_shipper_state` is a
 * singleton row shared across the whole suite; this file's vitest config
 * runs specs with `fileParallelism: false` + `singleFork: true`, so there is
 * no cross-file race on that row.
 */
function fakeLogger() {
  const l: Record<string, unknown> = {};
  l.child = () => l;
  l.info = () => undefined;
  l.warn = () => undefined;
  l.error = () => undefined;
  l.debug = () => undefined;
  return l;
}

function fakeJob(id: string) {
  return { id } as unknown as Parameters<typeof handleShipAuditLog>[0];
}

describe("E2E: handleShipAuditLog", () => {
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

  it("ships audit_log rows created since the watermark through the configured sink, then advances the watermark", async () => {
    const marker = `ship-audit-log-${Date.now()}-${Math.random()}`;
    await logAskEvent(db, {
      principalKind: "scoped",
      principalSources: [`source-${marker}`],
      principalSubject: "aad-oid-marker",
      questionHash: marker,
      questionText: null,
      answerText: null,
      channel: "api",
      model: "gemini-2.5-flash",
      embeddingProvider: "test-embedding-provider",
      embeddingModel: "test-embedding-model",
      sourceIds: [`source-${marker}`],
      chunkIds: ["chunk-1"],
      docIds: ["doc-1"],
      retrievedCount: 1,
      endpoint: "ask",
      topScore: 0.9,
      answerId: marker,
    });

    const watermarkBefore = await getAuditLogShipperWatermark(db);

    const shippedBatches: AuditLogRecord[][] = [];
    const fakeSink: AuditLogSink = {
      ship: async (rows) => {
        shippedBatches.push(rows);
      },
    };
    const deps = {
      db,
      logger: fakeLogger(),
      auditLogSink: fakeSink,
    } as unknown as WorkerDeps;

    await handleShipAuditLog(fakeJob("e2e-ship-success"), deps);

    const mine = shippedBatches.flat().find((r) => r.questionHash === marker);
    expect(mine).toBeDefined();
    expect(mine?.principalSubject).toBe("aad-oid-marker");
    expect(mine?.sourceIds).toEqual([`source-${marker}`]);

    const watermarkAfter = await getAuditLogShipperWatermark(db);
    expect(watermarkAfter).not.toBeNull();
    if (watermarkBefore) {
      expect(watermarkAfter!.getTime()).toBeGreaterThan(
        watermarkBefore.getTime(),
      );
    }
  });

  it("does NOT advance the watermark when the sink's ship() throws (simulating an egress rejection or network failure) -- the batch must be retried on the next tick", async () => {
    const marker = `ship-audit-log-fail-${Date.now()}-${Math.random()}`;
    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      principalSubject: null,
      questionHash: marker,
      questionText: null,
      answerText: null,
      channel: "api",
      model: null,
      embeddingProvider: "test-embedding-provider",
      embeddingModel: "test-embedding-model",
      sourceIds: [`source-${marker}`],
      chunkIds: [],
      docIds: [],
      retrievedCount: 0,
      endpoint: "ask",
      topScore: null,
      answerId: marker,
    });

    const watermarkBefore = await getAuditLogShipperWatermark(db);

    const failingSink: AuditLogSink = {
      ship: async () => {
        throw new Error("simulated egress rejection");
      },
    };
    const deps = {
      db,
      logger: fakeLogger(),
      auditLogSink: failingSink,
    } as unknown as WorkerDeps;

    await expect(
      handleShipAuditLog(fakeJob("e2e-ship-failure"), deps),
    ).rejects.toThrow("simulated egress rejection");

    const watermarkAfter = await getAuditLogShipperWatermark(db);
    expect(watermarkAfter?.getTime()).toBe(watermarkBefore?.getTime());
  });

  it("no-ops when auditLogSink is null (AUDIT_SINK_PROVIDER=none) without touching the watermark", async () => {
    const watermarkBefore = await getAuditLogShipperWatermark(db);
    const deps = {
      db,
      logger: fakeLogger(),
      auditLogSink: null,
    } as unknown as WorkerDeps;

    await handleShipAuditLog(fakeJob("e2e-ship-disabled"), deps);

    const watermarkAfter = await getAuditLogShipperWatermark(db);
    expect(watermarkAfter?.getTime()).toBe(watermarkBefore?.getTime());
  });
});

describe("E2E: pg-boss recurring schedule for shipAuditLog", () => {
  let boss: PgBoss;
  let db: Db;
  let close: () => Promise<void>;

  const CRON = "0 * * * *";
  const TZ = "America/Chicago";

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
    boss = await createQueue({
      databaseUrl: env.databaseUrl,
      schema: env.pgBossSchema,
      docsGapDigestCron: "0 6 * * 1",
      docsGapDigestTz: "UTC",
      shipAuditLogCron: CRON,
      shipAuditLogTz: TZ,
    });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await close();
  });

  it("registers shipAuditLog in <schema>.schedule with the configured cron/tz, alongside docsGapDigest", async () => {
    const res = await db.execute<{
      name: string;
      cron: string;
      timezone: string | null;
    }>(
      sql`SELECT name, cron, timezone FROM ${sql.raw(
        env.pgBossSchema,
      )}.schedule WHERE name = ${JOB_NAMES.shipAuditLog}`,
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.cron).toBe(CRON);
    expect(res.rows[0]?.timezone).toBe(TZ);

    const digestRes = await db.execute<{ name: string }>(
      sql`SELECT name FROM ${sql.raw(
        env.pgBossSchema,
      )}.schedule WHERE name = ${JOB_NAMES.docsGapDigest}`,
    );
    expect(digestRes.rows).toHaveLength(1);
  });

  it("getSchedules() surfaces the same registration through the public pg-boss API", async () => {
    const schedules = await boss.getSchedules();
    const mine = schedules.find((s) => s.name === JOB_NAMES.shipAuditLog);
    expect(mine).toBeDefined();
    expect(mine?.cron).toBe(CRON);
  });
});
