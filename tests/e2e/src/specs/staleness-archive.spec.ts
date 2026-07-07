import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SCOPE } from "@rag/core";
import { getStaleDocuments, upsertDocument } from "@rag/db";
import type { Db } from "@rag/db";
import { createQueue, JOB_NAMES } from "@rag/ingestion";
import { Retriever } from "@rag/rag";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import type PgBoss from "pg-boss";
import { env } from "../env.js";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";

/**
 * Phase 5 (docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md): staleness/archive
 * workflow.
 *
 * Three things here specifically need a real Postgres rather than a mock:
 *   1. `documents.last_reviewed_at`'s column shape (migration check, mirrors
 *      `governance-taxonomy.spec.ts`'s Phase 2 column checks).
 *   2. That archiving a document ACTUALLY removes it from `hybridSearch`
 *      results (via the `Retriever`, mirroring `retrieval.spec.ts`'s setup)
 *      and that un-archiving restores it — the whole point of this phase is
 *      that the flag has a real retrieval-side effect, not just a schema
 *      change.
 *   3. `getStaleDocuments`'s SQL predicate (active + never-reviewed-or-overdue,
 *      excluding archived) and the `boss.schedule()` registration for the new
 *      `stalenessSweep` job — mirrors `docs-gap-digest.spec.ts`'s Phase 4
 *      schedule spike.
 */
describe("E2E: documents.last_reviewed_at column (Phase 5)", () => {
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

  it("is a nullable timestamptz with no default", async () => {
    const res = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'documents' AND column_name = 'last_reviewed_at'
    `);
    const row = res.rows[0];
    expect(row?.data_type).toBe("timestamp with time zone");
    expect(row?.is_nullable).toBe("YES");
    expect(row?.column_default).toBeNull();
  });
});

describe("E2E: archive workflow actually affects retrieval (Phase 5)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let sourceId: string;
  let retriever: Retriever;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    sourceId = await createCustomSource(db, "archive-workflow");
    retriever = new Retriever(db, new FakeEmbedder(), {
      topK: 5,
      denseWeight: 0.7,
      sparseWeight: 0.3,
    });
  });

  async function getDocumentId(externalId: string): Promise<string> {
    const res = await db.execute<{ id: string }>(sql`
      SELECT id FROM documents
      WHERE source_id = ${sourceId} AND external_id = ${externalId}
    `);
    const id = res.rows[0]?.id;
    if (!id) throw new Error(`document ${externalId} not found`);
    return id;
  }

  it("archiving removes a document's chunks from search results, and un-archiving restores them with no data loss", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "archive-me",
        title: "Espresso Pulling",
        text: "Espresso pulling requires fine-ground coffee and 9 bars of pressure for proper extraction.",
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);
    const documentId = await getDocumentId("archive-me");

    // Sanity: findable before archiving.
    const before = await retriever.search(
      { query: "espresso extraction pressure", topK: 5 },
      ADMIN_SCOPE,
    );
    expect(before.some((r) => r.document.id === documentId)).toBe(true);

    // Archive — a reversible status flip, never a delete.
    await db.execute(sql`
      UPDATE documents SET lifecycle_status = 'archived' WHERE id = ${documentId}
    `);

    const afterArchive = await retriever.search(
      { query: "espresso extraction pressure", topK: 5 },
      ADMIN_SCOPE,
    );
    expect(afterArchive.some((r) => r.document.id === documentId)).toBe(false);

    // The row (and its chunks) must still physically exist — archiving is not
    // a delete.
    const stillThere = await db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM documents WHERE id = ${documentId}
    `);
    expect(Number(stillThere.rows[0]?.n)).toBe(1);
    const chunkCount = await db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM chunks WHERE document_id = ${documentId}
    `);
    expect(Number(chunkCount.rows[0]?.n)).toBeGreaterThan(0);

    // Un-archive — flip back to 'active' — must restore full visibility.
    await db.execute(sql`
      UPDATE documents SET lifecycle_status = 'active' WHERE id = ${documentId}
    `);

    const afterRestore = await retriever.search(
      { query: "espresso extraction pressure", topK: 5 },
      ADMIN_SCOPE,
    );
    expect(afterRestore.some((r) => r.document.id === documentId)).toBe(true);
  });

  it("does not affect other (non-archived) documents in the same source", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "keep-me",
        title: "Sailing Basics",
        text: "Sailing requires understanding wind direction, sail trim, and steering with the rudder.",
      }),
      plainTextDoc({
        externalId: "archive-me-2",
        title: "Tomato Gardening",
        text: "Tomato gardening rewards patient growers. Stake young plants and water deeply once per week.",
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);
    const archivedId = await getDocumentId("archive-me-2");
    const keptId = await getDocumentId("keep-me");

    await db.execute(sql`
      UPDATE documents SET lifecycle_status = 'archived' WHERE id = ${archivedId}
    `);

    const sailing = await retriever.search(
      { query: "sailing wind rudder", topK: 5 },
      ADMIN_SCOPE,
    );
    expect(sailing.some((r) => r.document.id === keptId)).toBe(true);

    const gardening = await retriever.search(
      { query: "tomato gardening water plants", topK: 5 },
      ADMIN_SCOPE,
    );
    expect(gardening.some((r) => r.document.id === archivedId)).toBe(false);
  });
});

describe("E2E: getStaleDocuments (Phase 5)", () => {
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

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns active documents that are never-reviewed or overdue, and excludes fresh and archived documents", async () => {
    const sourceId = await createCustomSource(db, "stale-docs");

    const neverReviewed = await upsertDocument(db, {
      sourceId,
      externalId: "never-reviewed",
      title: "Never Reviewed",
      mimeType: "text/plain",
      contentHash: "hash-1",
      metadata: {},
      markdown: "# Never Reviewed",
    });

    const overdue = await upsertDocument(db, {
      sourceId,
      externalId: "overdue",
      title: "Overdue",
      mimeType: "text/plain",
      contentHash: "hash-2",
      metadata: {},
      markdown: "# Overdue",
    });
    await db.execute(sql`
      UPDATE documents
      SET last_reviewed_at = now() - interval '200 days'
      WHERE id = ${overdue.id}
    `);

    const fresh = await upsertDocument(db, {
      sourceId,
      externalId: "fresh",
      title: "Fresh",
      mimeType: "text/plain",
      contentHash: "hash-3",
      metadata: {},
      markdown: "# Fresh",
    });
    await db.execute(sql`
      UPDATE documents
      SET last_reviewed_at = now() - interval '5 days'
      WHERE id = ${fresh.id}
    `);

    const archivedButOverdue = await upsertDocument(db, {
      sourceId,
      externalId: "archived-overdue",
      title: "Archived But Overdue",
      mimeType: "text/plain",
      contentHash: "hash-4",
      metadata: {},
      markdown: "# Archived But Overdue",
    });
    await db.execute(sql`
      UPDATE documents
      SET last_reviewed_at = now() - interval '400 days',
          lifecycle_status = 'archived'
      WHERE id = ${archivedButOverdue.id}
    `);

    const stale = await getStaleDocuments(db, { maxAgeDays: 180 });
    const staleIds = stale.map((d) => d.id);

    expect(staleIds).toContain(neverReviewed.id);
    expect(staleIds).toContain(overdue.id);
    expect(staleIds).not.toContain(fresh.id);
    expect(staleIds).not.toContain(archivedButOverdue.id);

    const neverReviewedRow = stale.find((d) => d.id === neverReviewed.id);
    expect(neverReviewedRow?.lastReviewedAt).toBeNull();
    const overdueRow = stale.find((d) => d.id === overdue.id);
    expect(overdueRow?.lastReviewedAt).not.toBeNull();
  });
});

describe("E2E: pg-boss recurring schedule spike (Phase 5 staleness sweep)", () => {
  let boss: PgBoss;
  let db: Db;
  let close: () => Promise<void>;

  const CRON = "0 3 * * *";
  const TZ = "America/Chicago";

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
    boss = await createQueue({
      databaseUrl: env.databaseUrl,
      schema: env.pgBossSchema,
      stalenessSweepCron: CRON,
      stalenessSweepTz: TZ,
    });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await close();
  });

  it("registers stalenessSweep in <schema>.schedule with the configured cron/tz", async () => {
    const res = await db.execute<{
      name: string;
      cron: string;
      timezone: string | null;
    }>(
      sql`SELECT name, cron, timezone FROM ${sql.raw(
        env.pgBossSchema,
      )}.schedule WHERE name = ${JOB_NAMES.stalenessSweep}`,
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.cron).toBe(CRON);
    expect(res.rows[0]?.timezone).toBe(TZ);
  });

  it("getSchedules() surfaces the same registration through the public pg-boss API", async () => {
    const schedules = await boss.getSchedules();
    const mine = schedules.find((s) => s.name === JOB_NAMES.stalenessSweep);
    expect(mine).toBeDefined();
    expect(mine?.cron).toBe(CRON);
  });

  it("re-calling createQueue upserts (does not duplicate) the schedule row", async () => {
    const secondBoss = await createQueue({
      databaseUrl: env.databaseUrl,
      schema: env.pgBossSchema,
      stalenessSweepCron: CRON,
      stalenessSweepTz: "UTC", // changed tz — proves the upsert updates in place
    });
    try {
      const res = await db.execute<{ name: string; timezone: string | null }>(
        sql`SELECT name, timezone FROM ${sql.raw(
          env.pgBossSchema,
        )}.schedule WHERE name = ${JOB_NAMES.stalenessSweep}`,
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]?.timezone).toBe("UTC");
    } finally {
      await secondBoss.stop({ graceful: false, close: true });
    }
  });
});
