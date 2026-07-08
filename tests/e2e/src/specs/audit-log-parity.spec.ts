import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logAskEvent } from "@rag/db";
import type { Db } from "@rag/db";
import { signInternalScopeToken } from "@rag/core";
import { FakeConnector, FakeGenerator, plainTextDoc } from "@rag/test-fixtures";
import { createCustomSource, openTestDb } from "../helpers/db.js";
import { buildTestApi } from "../helpers/api.js";
import { runOneIngestion } from "../helpers/ingestion.js";
import { TEST_INTERNAL_SCOPE_SECRET } from "../env.js";

/**
 * Phase 3 (docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md): search-path audit
 * logging parity + `topScore`. Extended for SDD Task 4 (per-user-auth
 * follow-ups): threading the scope-assertion JWT's verified `sub` (AAD oid)
 * through to `audit_log.principal_subject`.
 *
 * Verified against a real, migrated Postgres (globalSetup runs
 * `packages/db/src/migrate.ts` before this file executes), for the same
 * reason Phase 2's `governance-taxonomy.spec.ts` is an e2e spec rather than a
 * `packages/db/src` unit test: `packages/db/src` tests are deliberately
 * DB-free stubs, and the property that matters here — that
 * `ALTER TABLE audit_log ADD COLUMN "endpoint" text NOT NULL DEFAULT 'ask'`
 * genuinely backfills every pre-existing row without a separate UPDATE — can
 * only be proven against a live column-default execution, not a mock.
 *
 * This spec does NOT use `truncateAll` (it doesn't clear `audit_log`, by
 * design — other specs never touch that table) and instead scopes each
 * assertion to a uniquely-hashed row so runs don't interfere with each other.
 */
describe("E2E: audit_log search-path parity + backfill (Phase 3)", () => {
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

  it("audit_log has endpoint/top_score/principal_subject with the expected types/defaults", async () => {
    const res = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'audit_log'
        AND column_name IN ('endpoint', 'top_score', 'principal_subject')
    `);

    const byName = new Map(res.rows.map((r) => [r.column_name, r]));

    const endpoint = byName.get("endpoint");
    expect(endpoint?.data_type).toBe("text");
    expect(endpoint?.is_nullable).toBe("NO");
    expect(endpoint?.column_default).toBe("'ask'::text");

    const topScore = byName.get("top_score");
    expect(topScore?.data_type).toBe("real");
    expect(topScore?.is_nullable).toBe("YES");
    expect(topScore?.column_default).toBeNull();

    const principalSubject = byName.get("principal_subject");
    expect(principalSubject?.data_type).toBe("text");
    expect(principalSubject?.is_nullable).toBe("YES");
    expect(principalSubject?.column_default).toBeNull();
  });

  it("a row inserted WITHOUT specifying endpoint/top_score backfills to the column defaults — the exact mechanism a pre-existing row relies on", async () => {
    // Deliberately bypasses AskEventRow/logAskEvent (both now require endpoint/
    // topScore at the TypeScript layer) and inserts via raw SQL omitting both
    // columns entirely. This is the only way to prove the *SQL-level* default
    // — the same mechanism that backfilled every row that existed before this
    // migration ran — rather than merely proving the application code passes
    // a value through correctly (the next test covers that instead).
    const marker = `backfill-marker-${Date.now()}-${Math.random()}`;
    await db.execute(sql`
      INSERT INTO audit_log (
        principal_kind, question_hash, channel, source_ids, chunk_ids,
        doc_ids, retrieved_count
      ) VALUES (
        'admin', ${marker}, 'api', '{}', '{}', '{}', 0
      )
    `);

    const [row] = await db
      .execute<{ endpoint: string; top_score: number | null }>(
        sql`SELECT endpoint, top_score FROM audit_log WHERE question_hash = ${marker}`,
      )
      .then((r) => r.rows);

    expect(row?.endpoint).toBe("ask");
    expect(row?.top_score).toBeNull();
  });

  it("logAskEvent writes endpoint='search' and a populated topScore end-to-end through the real application code path", async () => {
    const marker = `search-marker-${Date.now()}-${Math.random()}`;
    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      principalSubject: null,
      questionHash: marker,
      channel: "api",
      model: null,
      sourceIds: ["11111111-1111-1111-1111-111111111111"],
      chunkIds: ["22222222-2222-2222-2222-222222222222"],
      docIds: ["33333333-3333-3333-3333-333333333333"],
      retrievedCount: 1,
      endpoint: "search",
      topScore: 0.87,
    });

    const [row] = await db
      .execute<{ endpoint: string; top_score: number | null }>(
        sql`SELECT endpoint, top_score FROM audit_log WHERE question_hash = ${marker}`,
      )
      .then((r) => r.rows);

    expect(row?.endpoint).toBe("search");
    expect(row?.top_score).toBeCloseTo(0.87, 5);
  });

  it("logAskEvent writes endpoint='ask' and a null topScore when nothing was retrieved", async () => {
    const marker = `ask-empty-marker-${Date.now()}-${Math.random()}`;
    await logAskEvent(db, {
      principalKind: "scoped",
      principalSources: ["44444444-4444-4444-4444-444444444444"],
      principalSubject: null,
      questionHash: marker,
      channel: "api",
      model: "gemini-1.5-flash",
      sourceIds: [],
      chunkIds: [],
      docIds: [],
      retrievedCount: 0,
      endpoint: "ask",
      topScore: null,
    });

    const [row] = await db
      .execute<{ endpoint: string; top_score: number | null }>(
        sql`SELECT endpoint, top_score FROM audit_log WHERE question_hash = ${marker}`,
      )
      .then((r) => r.rows);

    expect(row?.endpoint).toBe("ask");
    expect(row?.top_score).toBeNull();
  });

  it("logAskEvent writes a populated principal_subject when the row carries one", async () => {
    const marker = `subject-marker-${Date.now()}-${Math.random()}`;
    await logAskEvent(db, {
      principalKind: "scoped",
      principalSources: ["55555555-5555-5555-5555-555555555555"],
      principalSubject: "aad-oid-direct-1",
      questionHash: marker,
      channel: "api",
      model: null,
      sourceIds: [],
      chunkIds: [],
      docIds: [],
      retrievedCount: 0,
      endpoint: "ask",
      topScore: null,
    });

    const [row] = await db
      .execute<{ principal_subject: string | null }>(
        sql`SELECT principal_subject FROM audit_log WHERE question_hash = ${marker}`,
      )
      .then((r) => r.rows);

    expect(row?.principal_subject).toBe("aad-oid-direct-1");
  });

  it("logAskEvent writes a null principal_subject for an admin principal (no per-user JWT involved)", async () => {
    const marker = `subject-null-marker-${Date.now()}-${Math.random()}`;
    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      principalSubject: null,
      questionHash: marker,
      channel: "api",
      model: null,
      sourceIds: [],
      chunkIds: [],
      docIds: [],
      retrievedCount: 0,
      endpoint: "ask",
      topScore: null,
    });

    const [row] = await db
      .execute<{ principal_subject: string | null }>(
        sql`SELECT principal_subject FROM audit_log WHERE question_hash = ${marker}`,
      )
      .then((r) => r.rows);

    expect(row?.principal_subject).toBeNull();
  });

  it("a real /ask request authenticated via a scope-assertion JWT records the JWT's sub as principal_subject", async () => {
    // End-to-end through the actual HTTP layer: sign a BFF-style
    // scope-assertion JWT with a known `sub`, hit a real Fastify /ask route
    // (InternalScopeAuthProvider verifies it and resolves a scoped Principal
    // carrying that subject — see packages/core/src/internal-scope-auth.ts),
    // and confirm the resulting audit_log row's principal_subject matches.
    const sourceId = await createCustomSource(db, "audit-subject-e2e-source");
    await runOneIngestion(
      db,
      sourceId,
      new FakeConnector([
        plainTextDoc({
          externalId: "audit-subject-doc",
          title: "Audit Subject Doc",
          text: "Per-user audit attribution threads the verified JWT subject through to audit_log.",
        }),
      ]),
    );

    const generator = new FakeGenerator();
    const { inject, close: closeApi } = await buildTestApi({ db, generator });
    try {
      const subject = `aad-oid-e2e-${Date.now()}`;
      const token = await signInternalScopeToken(
        { sub: subject, allowedSourceIds: [sourceId] },
        TEST_INTERNAL_SCOPE_SECRET,
      );
      const question = `what does per-user audit attribution do? ${Date.now()}-${Math.random()}`;

      const res = await inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${token}` },
        payload: { question },
      });
      expect(res.statusCode).toBe(200);

      const expectedHash = createHash("sha256").update(question).digest("hex");
      const [row] = await db
        .execute<{
          principal_subject: string | null;
          principal_kind: string;
        }>(
          sql`SELECT principal_subject, principal_kind FROM audit_log WHERE question_hash = ${expectedHash}`,
        )
        .then((r) => r.rows);

      expect(row?.principal_kind).toBe("scoped");
      expect(row?.principal_subject).toBe(subject);
    } finally {
      await closeApi();
    }
  });
});
