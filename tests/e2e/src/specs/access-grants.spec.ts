import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  grantClientAccess,
  grantSourceAccess,
  listAssignmentHistoryForStaff,
  listSourceAssignmentHistoryForStaff,
  resolveSourceIdsForUser,
  revokeClientAccess,
  revokeSourceAccess,
} from "@rag/db";
import type { Db } from "@rag/db";
import {
  assignSourceToClient,
  createCustomSource,
  openTestDb,
  truncateAll,
} from "../helpers/db.js";

/**
 * SDD Task 5 (per-user-auth): `grantClientAccess` / `revokeClientAccess` /
 * `listAssignmentHistoryForStaff` on `staff_client_assignments`.
 *
 * Unlike every other query in `packages/db/src/queries.ts`, these three are
 * NOT unit-tested against a hand-rolled `Db` stub — see
 * `packages/db/src/queries.access-control.test.ts`'s own header comment: that
 * file is a deliberate DB-free stub suite because `pnpm test` (this repo's
 * "infra-free quality gate" CI job) runs with no Postgres service. Proving a
 * grant/revoke/re-grant cycle re-activates the SAME row instead of
 * accumulating duplicates isn't meaningfully testable without re-implementing
 * the SQL semantics under test in the stub — it needs real Postgres row
 * state. Only `e2e.yml`'s job provisions Postgres, so — following this
 * codebase's established convention of moving DB-behavior-dependent tests
 * out of `packages/db`'s unit suite and into `tests/e2e/src/specs/` (see
 * `governance-taxonomy.spec.ts` in this same directory, and
 * `audit-log-parity.spec.ts` on `feat/kb-governance-phase3-audit-parity` for
 * another instance of the same pattern) — this behavior lives here instead,
 * where it actually gets CI signal.
 *
 * `staff_client_assignments` has no FK relationship to `sources`/`documents`
 * (`userId` is an opaque IdP oid; `clientId` is a firm-defined string), so
 * it falls outside `../helpers/db.js`'s `truncateAll` (which only cascades
 * from `sources`). Isolation here instead comes from unique, spec-scoped
 * `clientId` values per test plus an explicit `afterEach` cleanup, mirroring
 * the per-source-name isolation pattern used by specs that DO go through
 * `truncateAll`.
 */
describe("E2E: grantClientAccess / revokeClientAccess / listAssignmentHistoryForStaff", () => {
  let db: Db;
  let close: () => Promise<void>;

  const CLIENT_GRANT_1 = "e2e-test-client-grant-1";
  const CLIENT_GRANT_2 = "e2e-test-client-grant-2";
  const CLIENT_GRANT_3 = "e2e-test-client-grant-3";

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  afterEach(async () => {
    // Hard-delete is fine here — this is test-only cleanup of rows this spec
    // created, not the production revoke path (which must never hard-delete;
    // see `revokeClientAccess`'s own doc comment). Three explicit
    // placeholders (not `ANY(${[...]})`) because the tagged-template driver
    // binds a JS array as a single scalar param, not a Postgres array —
    // `ANY($1)` on a non-array param throws 42809.
    await db.execute(sql`
      DELETE FROM staff_client_assignments
      WHERE client_id IN (${CLIENT_GRANT_1}, ${CLIENT_GRANT_2}, ${CLIENT_GRANT_3})
    `);
  });

  afterAll(async () => {
    await close();
  });

  it("grants access, then listAssignmentHistoryForStaff shows one active (non-revoked) row", async () => {
    await grantClientAccess(db, {
      userId: "e2e-aad-oid-grant-1",
      clientId: CLIENT_GRANT_1,
      grantedBy: "e2e-admin-oid-1",
    });

    const history = await listAssignmentHistoryForStaff(
      db,
      "e2e-aad-oid-grant-1",
    );
    expect(history).toHaveLength(1);
    expect(history[0]!).toMatchObject({
      clientId: CLIENT_GRANT_1,
      grantedBy: "e2e-admin-oid-1",
      revokedAt: null,
    });
  });

  it("revoking sets revokedAt without deleting the row (audit trail preserved)", async () => {
    await grantClientAccess(db, {
      userId: "e2e-aad-oid-grant-2",
      clientId: CLIENT_GRANT_2,
      grantedBy: "e2e-admin-oid-1",
    });
    await revokeClientAccess(db, {
      userId: "e2e-aad-oid-grant-2",
      clientId: CLIENT_GRANT_2,
    });

    const history = await listAssignmentHistoryForStaff(
      db,
      "e2e-aad-oid-grant-2",
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.revokedAt).not.toBeNull();
  });

  it("re-granting after a revoke un-revokes the SAME row instead of duplicating it", async () => {
    await grantClientAccess(db, {
      userId: "e2e-aad-oid-grant-3",
      clientId: CLIENT_GRANT_3,
      grantedBy: "e2e-admin-oid-1",
    });
    await revokeClientAccess(db, {
      userId: "e2e-aad-oid-grant-3",
      clientId: CLIENT_GRANT_3,
    });
    await grantClientAccess(db, {
      userId: "e2e-aad-oid-grant-3",
      clientId: CLIENT_GRANT_3,
      grantedBy: "e2e-admin-oid-2",
    });

    const history = await listAssignmentHistoryForStaff(
      db,
      "e2e-aad-oid-grant-3",
    );
    expect(history).toHaveLength(1); // not 2 — same row, re-activated
    expect(history[0]!.revokedAt).toBeNull();
    expect(history[0]!.grantedBy).toBe("e2e-admin-oid-2");
  });

  it("concurrent grants for the same (userId, clientId) pair never create duplicate rows", async () => {
    const userId = `concurrent-user-${Date.now()}`;
    const clientId = `concurrent-client-${Date.now()}`;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        grantClientAccess(db, { userId, clientId, grantedBy: "test-admin" }),
      ),
    );

    const rows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text as count FROM staff_client_assignments
      WHERE user_id = ${userId} AND client_id = ${clientId}
    `);
    expect(rows.rows[0]?.count).toBe("1");

    await db.execute(sql`
      DELETE FROM staff_client_assignments
      WHERE user_id = ${userId} AND client_id = ${clientId}
    `);
  });
});

/**
 * SDD Task 9 (per-user-auth): `grantSourceAccess` / `revokeSourceAccess` /
 * `listSourceAssignmentHistoryForStaff` on the new `staff_source_assignments`
 * table, plus the `resolveSourceIdsForUser` UNION change that reads it.
 *
 * Lives here (not `packages/db`'s unit suite) for the exact reason given in
 * this file's header comment above: `pnpm --filter @rag/db test` runs
 * DB-free, and proving grant/revoke/re-grant row semantics — and, critically,
 * proving the UNION doesn't leak one user's direct grant into another user's
 * resolved scope — needs real Postgres row state, not a hand-rolled stub.
 *
 * Unlike `staff_client_assignments`, `staff_source_assignments.source_id` DOES
 * carry `ON DELETE CASCADE → sources`, so `truncateAll` (which cascades from
 * `sources`) cleans this table for free — no manual DELETE cleanup needed.
 */
describe("E2E: grantSourceAccess / revokeSourceAccess / listSourceAssignmentHistoryForStaff", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await close();
  });

  it("grants access, then listSourceAssignmentHistoryForStaff shows one active (non-revoked) row", async () => {
    const sourceId = await createCustomSource(db, "e2e-direct-source-1");

    await grantSourceAccess(db, {
      userId: "e2e-aad-oid-src-grant-1",
      sourceId,
      grantedBy: "e2e-admin-oid-1",
    });

    const history = await listSourceAssignmentHistoryForStaff(
      db,
      "e2e-aad-oid-src-grant-1",
    );
    expect(history).toHaveLength(1);
    expect(history[0]!).toMatchObject({
      sourceId,
      grantedBy: "e2e-admin-oid-1",
      revokedAt: null,
    });
  });

  it("revoking sets revokedAt without deleting the row (audit trail preserved)", async () => {
    const sourceId = await createCustomSource(db, "e2e-direct-source-2");

    await grantSourceAccess(db, {
      userId: "e2e-aad-oid-src-grant-2",
      sourceId,
      grantedBy: "e2e-admin-oid-1",
    });
    await revokeSourceAccess(db, {
      userId: "e2e-aad-oid-src-grant-2",
      sourceId,
    });

    const history = await listSourceAssignmentHistoryForStaff(
      db,
      "e2e-aad-oid-src-grant-2",
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.revokedAt).not.toBeNull();
  });

  it("re-granting after a revoke un-revokes the SAME row instead of duplicating it", async () => {
    const sourceId = await createCustomSource(db, "e2e-direct-source-3");

    await grantSourceAccess(db, {
      userId: "e2e-aad-oid-src-grant-3",
      sourceId,
      grantedBy: "e2e-admin-oid-1",
    });
    await revokeSourceAccess(db, {
      userId: "e2e-aad-oid-src-grant-3",
      sourceId,
    });
    await grantSourceAccess(db, {
      userId: "e2e-aad-oid-src-grant-3",
      sourceId,
      grantedBy: "e2e-admin-oid-2",
    });

    const history = await listSourceAssignmentHistoryForStaff(
      db,
      "e2e-aad-oid-src-grant-3",
    );
    expect(history).toHaveLength(1); // not 2 — same row, re-activated
    expect(history[0]!.revokedAt).toBeNull();
    expect(history[0]!.grantedBy).toBe("e2e-admin-oid-2");
  });

  it("concurrent grants for the same (userId, sourceId) pair never create duplicate rows", async () => {
    const sourceId = await createCustomSource(db, "e2e-direct-source-4");
    const userId = `concurrent-user-${Date.now()}`;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        grantSourceAccess(db, { userId, sourceId, grantedBy: "test-admin" }),
      ),
    );

    const rows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text as count FROM staff_source_assignments
      WHERE user_id = ${userId} AND source_id = ${sourceId}
    `);
    expect(rows.rows[0]?.count).toBe("1");
  });
});

/**
 * SDD Task 9: `resolveSourceIdsForUser`'s UNION of the client-routed branch
 * and the new direct-grant branch.
 *
 * The negative/isolation case is the load-bearing one: a `UNION` where the
 * new subquery's `user_id = $1` binding is dropped or mis-bound would make
 * the positive case pass while silently granting every user access to every
 * directly-granted source — a real cross-tenant confidentiality break. Only
 * asserting what user A CAN see would miss that; asserting what user B and C
 * do NOT see is what actually catches it.
 */
describe("E2E: resolveSourceIdsForUser — direct grants unioned with client-routed grants", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await close();
  });

  it("a user with a direct source grant sees that source resolved (positive case)", async () => {
    const sourceId = await createCustomSource(db, "e2e-union-direct-source");
    await grantSourceAccess(db, {
      userId: "e2e-union-user-direct",
      sourceId,
      grantedBy: "e2e-admin-oid-1",
    });

    const resolved = await resolveSourceIdsForUser(db, "e2e-union-user-direct");
    expect(resolved).toContain(sourceId);
  });

  it("a user with NO grants at all does not see another user's direct source grant (isolation)", async () => {
    const sourceId = await createCustomSource(db, "e2e-union-isolation-source");
    await grantSourceAccess(db, {
      userId: "e2e-union-user-a",
      sourceId,
      grantedBy: "e2e-admin-oid-1",
    });

    const resolvedForB = await resolveSourceIdsForUser(db, "e2e-union-user-b");
    expect(resolvedForB).not.toContain(sourceId);
    expect(resolvedForB).toEqual([]);
  });

  it("a user with only a client-routed grant sees the client-routed source but NOT another user's unrelated direct grant", async () => {
    const directSourceId = await createCustomSource(
      db,
      "e2e-union-other-users-direct-source",
    );
    const clientRoutedSourceId = await createCustomSource(
      db,
      "e2e-union-client-routed-source",
    );
    const clientId = "e2e-union-client-1";

    await grantSourceAccess(db, {
      userId: "e2e-union-user-direct-owner",
      sourceId: directSourceId,
      grantedBy: "e2e-admin-oid-1",
    });
    await assignSourceToClient(db, clientRoutedSourceId, clientId);
    await grantClientAccess(db, {
      userId: "e2e-union-user-client-routed",
      clientId,
      grantedBy: "e2e-admin-oid-1",
    });

    const resolved = await resolveSourceIdsForUser(
      db,
      "e2e-union-user-client-routed",
    );
    expect(resolved).toContain(clientRoutedSourceId);
    expect(resolved).not.toContain(directSourceId);
  });
});
