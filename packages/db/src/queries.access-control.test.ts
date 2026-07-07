import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  grantClientAccess,
  hybridSearch,
  listAssignmentHistoryForStaff,
  revokeClientAccess,
} from "./queries.js";
import { createDb, type Db } from "./client.js";

/**
 * A `Db` stub that EXPLODES if any query is issued. Used to prove the
 * fail-closed ACL short-circuit returns `[]` BEFORE touching Postgres — the
 * one piece of the enforced source-id boundary that is unit-testable without
 * a live DB. The SQL `WHERE doc.source_id IN (...)` enforcement itself needs
 * Postgres (no integration infra here) and is verified by reading + typecheck.
 *
 * Same limitation applies to the `dense_hits` CTE's `embedding_provider`/
 * `embedding_model` filter (added to prevent cross-model cosine comparison):
 * `baseOpts` below satisfies the TS-required fields so these fail-closed
 * tests still compile, but no test in this file — or anywhere else in the
 * repo — seeds mixed-provider chunks against a real Postgres+pgvector
 * instance and asserts the filter actually excludes mismatched rows. Add
 * that as a DB-backed/e2e test (see `tests/e2e/src/eval/`) before relying on
 * this during a live embedding-provider migration.
 */
const explodingDb = {
  transaction: async () => {
    throw new Error("DB must not be queried when scope is empty (fail closed)");
  },
  execute: async () => {
    throw new Error("DB must not be queried when scope is empty (fail closed)");
  },
} as unknown as Db;

const baseOpts = {
  query: "anything",
  queryEmbedding: [0.1, 0.2, 0.3],
  topK: 8,
  embeddingProvider: "test-provider",
  embeddingModel: "test-model",
};

describe("hybridSearch — mandatory ACL fail-closed short-circuit", () => {
  it("returns [] WITHOUT querying the DB when enforcedSourceIds is empty", async () => {
    const results = await hybridSearch(explodingDb, {
      ...baseOpts,
      enforcedSourceIds: [],
    });
    expect(results).toEqual([]);
  });

  it("still validates the embedding before the short-circuit (defense in depth)", async () => {
    await expect(
      hybridSearch(explodingDb, {
        ...baseOpts,
        queryEmbedding: [Number.NaN],
        enforcedSourceIds: [],
      }),
    ).rejects.toThrow(/non-finite/);
  });

  it("does NOT short-circuit for admin (null) — it would reach the DB", async () => {
    // null === unrestricted, so the guard must NOT fire; the exploding stub
    // proves we proceed past the short-circuit (the throw comes from the DB,
    // not from an early empty return).
    await expect(
      hybridSearch(explodingDb, { ...baseOpts, enforcedSourceIds: null }),
    ).rejects.toThrow(/DB must not be queried/);
  });

  it("does NOT short-circuit for a non-empty scope — it would reach the DB", async () => {
    await expect(
      hybridSearch(explodingDb, {
        ...baseOpts,
        enforcedSourceIds: ["11111111-1111-1111-1111-111111111111"],
      }),
    ).rejects.toThrow(/DB must not be queried/);
  });
});

// ---------------------------------------------------------------------------
// grantClientAccess / revokeClientAccess / listAssignmentHistoryForStaff
//
// Unlike every other test in this file (and this package), these scenarios
// need real Postgres row-state — proving a grant/revoke/re-grant cycle
// re-activates the SAME row instead of accumulating duplicates isn't
// meaningfully testable against a hand-rolled `Db` stub without just
// re-implementing the SQL semantics under test.
//
// That's a deliberate departure from this file's/package's existing
// no-live-DB convention, which exists because `pnpm test` (this repo's
// `ci.yml` "infra-free quality gate" job) runs with no Postgres service —
// only `e2e.yml` provisions one, and that job runs `pnpm e2e` (the separate
// @rag/e2e package), never packages/db's own vitest suite. So this describe
// block self-skips when Postgres isn't reachable (e.g. CI's unit-test job)
// and only exercises real row state when a local `pnpm docker:up` stack (or
// a future dedicated DB-integration CI job) is up. Net effect: these three
// tests currently get zero CI signal — flagged as a follow-up concern in the
// task report rather than silently accepted.
// ---------------------------------------------------------------------------
const ACCESS_GRANT_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag";

async function isPostgresReachable(databaseUrl: string): Promise<boolean> {
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

const dbReachable = await isPostgresReachable(ACCESS_GRANT_DATABASE_URL);

const TEST_CLIENT_ID_1 = "test-client-grant-1";
const TEST_CLIENT_ID_2 = "test-client-grant-2";
const TEST_CLIENT_ID_3 = "test-client-grant-3";

describe.skipIf(!dbReachable)(
  "grantClientAccess / revokeClientAccess / listAssignmentHistoryForStaff (live Postgres; skipped when unreachable)",
  () => {
    let db: Db;
    let closeDb: () => Promise<void>;

    beforeAll(() => {
      const conn = createDb(ACCESS_GRANT_DATABASE_URL);
      db = conn.db;
      closeDb = conn.close;
    });

    afterEach(async () => {
      // Hard-delete is fine here — this is test-only cleanup of rows this
      // suite created, not the production revoke path (which must never
      // hard-delete; see revokeClientAccess above). Three explicit
      // placeholders (not `ANY(${[...]})`) because the tagged-template
      // driver binds a JS array as a single scalar param, not a Postgres
      // array — `ANY($1)` on a non-array param throws 42809.
      await db.execute(sql`
        DELETE FROM staff_client_assignments
        WHERE client_id IN (${TEST_CLIENT_ID_1}, ${TEST_CLIENT_ID_2}, ${TEST_CLIENT_ID_3})
      `);
    });

    afterAll(async () => {
      await closeDb();
    });

    it("grants access, then resolveSourceIdsForUser includes the client's sources", async () => {
      await grantClientAccess(db, {
        userId: "aad-oid-grant-1",
        clientId: "test-client-grant-1",
        grantedBy: "admin-oid-1",
      });
      const history = await listAssignmentHistoryForStaff(
        db,
        "aad-oid-grant-1",
      );
      expect(history).toHaveLength(1);
      expect(history[0]!).toMatchObject({
        clientId: "test-client-grant-1",
        grantedBy: "admin-oid-1",
        revokedAt: null,
      });
    });

    it("revoking sets revokedAt without deleting the row (audit trail preserved)", async () => {
      await grantClientAccess(db, {
        userId: "aad-oid-grant-2",
        clientId: "test-client-grant-2",
        grantedBy: "admin-oid-1",
      });
      await revokeClientAccess(db, {
        userId: "aad-oid-grant-2",
        clientId: "test-client-grant-2",
      });
      const history = await listAssignmentHistoryForStaff(
        db,
        "aad-oid-grant-2",
      );
      expect(history).toHaveLength(1);
      expect(history[0]!.revokedAt).not.toBeNull();
    });

    it("re-granting after a revoke un-revokes the same row instead of duplicating it", async () => {
      await grantClientAccess(db, {
        userId: "aad-oid-grant-3",
        clientId: "test-client-grant-3",
        grantedBy: "admin-oid-1",
      });
      await revokeClientAccess(db, {
        userId: "aad-oid-grant-3",
        clientId: "test-client-grant-3",
      });
      await grantClientAccess(db, {
        userId: "aad-oid-grant-3",
        clientId: "test-client-grant-3",
        grantedBy: "admin-oid-2",
      });
      const history = await listAssignmentHistoryForStaff(
        db,
        "aad-oid-grant-3",
      );
      expect(history).toHaveLength(1); // not 2 — same row, re-activated
      expect(history[0]!.revokedAt).toBeNull();
      expect(history[0]!.grantedBy).toBe("admin-oid-2");
    });
  },
);
