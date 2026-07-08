import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  grantClientAccess,
  listAssignmentHistoryForStaff,
  revokeClientAccess,
} from "@rag/db";
import type { Db } from "@rag/db";
import { openTestDb } from "../helpers/db.js";

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
});
