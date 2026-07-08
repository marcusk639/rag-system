import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@rag/db";
import {
  grantClientAccess,
  resolveSourceIdsForUser,
  revokeClientAccess,
} from "@rag/db";
import { signInternalScopeToken } from "@rag/core";
import {
  assignSourceToClient,
  createCustomSource,
  openTestDb,
  truncateAll,
} from "../helpers/db.js";
import { buildTestApi, type TestInject } from "../helpers/api.js";
import { TEST_INTERNAL_SCOPE_SECRET } from "../env.js";

/**
 * SDD Task 16 (per-user-auth, final task): proves the BFF-asserted
 * scope-token mechanism end-to-end against a REAL in-process Fastify
 * instance: grantClientAccess -> signInternalScopeToken ->
 * InternalScopeAuthProvider (verified via `inject()`) -> scoped /sources
 * results -> revokeClientAccess -> the same-shaped, freshly-resolved token
 * immediately stops returning that access. Also proves a token signed with a
 * secret NOT configured on the server is rejected with 401 (forged token).
 *
 * Deliberately does NOT drive a real Entra ID browser sign-in — Auth.js's own
 * OAuth correctness is a well-tested third-party concern, not this
 * codebase's to re-verify. This spec verifies only what THIS codebase built:
 * the scope-assertion token mechanism from grant/revoke through to Fastify
 * enforcement.
 *
 * Complementary to `access-grants.spec.ts` (also Task 5/16-adjacent), which
 * exercises `grantClientAccess`/`revokeClientAccess`/
 * `listAssignmentHistoryForStaff` directly at the DB-query level with no
 * Fastify/HTTP involved. This spec instead verifies enforcement through the
 * actual HTTP layer via `InternalScopeAuthProvider`, which that spec never
 * touches. Test client/user ids here use a distinct `scope-http` naming
 * scheme so the two specs' data can never collide even if they ever run
 * against the same shared database in the same test run.
 */
describe("E2E: internal-scope-auth (web app per-user auth mechanism)", () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let inject: TestInject;
  let closeApi: () => Promise<void>;

  const USER_OID = "e2e-oid-scope-http-1";
  const CLIENT_ID = "e2e-client-scope-http-1";
  const GRANTED_BY = "e2e-admin-oid-scope-http";

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    closeDb = handle.close;
    await truncateAll(db);
    const api = await buildTestApi({ db });
    inject = api.inject;
    closeApi = api.close;
  });

  afterAll(async () => {
    await closeApi();
    // `staff_client_assignments` has no FK relationship to `sources`/
    // `documents` (userId/clientId are opaque strings), so it falls outside
    // `truncateAll`'s cascade — clean it up explicitly, mirroring
    // `access-grants.spec.ts`'s convention. `source_client_assignments` DOES
    // cascade from `sources` via its FK, so no explicit cleanup is needed
    // for it here.
    await db.execute(sql`
      DELETE FROM staff_client_assignments WHERE client_id = ${CLIENT_ID}
    `);
    await closeDb();
  });

  it("a scope-assertion token for a granted source returns that source; revoking denies it", async () => {
    const sourceId = await createCustomSource(db, "Scope HTTP Test Source");
    await assignSourceToClient(db, sourceId, CLIENT_ID);

    await grantClientAccess(db, {
      userId: USER_OID,
      clientId: CLIENT_ID,
      grantedBy: GRANTED_BY,
    });

    // Mirrors what the web BFF does: resolve the user's allowed source ids
    // from the DB, then sign a short-lived scope-assertion JWT asserting them.
    const allowedBeforeRevoke = await resolveSourceIdsForUser(db, USER_OID);
    expect(allowedBeforeRevoke).toContain(sourceId);

    const grantedToken = await signInternalScopeToken(
      { sub: USER_OID, allowedSourceIds: allowedBeforeRevoke },
      TEST_INTERNAL_SCOPE_SECRET,
    );

    const grantedRes = await inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${grantedToken}` },
    });
    expect(grantedRes.statusCode).toBe(200);
    const grantedBody = grantedRes.json() as {
      sources: Array<{ id: string }>;
    };
    expect(grantedBody.sources.map((s) => s.id)).toContain(sourceId);

    await revokeClientAccess(db, { userId: USER_OID, clientId: CLIENT_ID });

    // Freshly re-resolve (not hand-rolled to `[]`) so this proves the real
    // DB state change from revokeClientAccess, not just an assumption about
    // its effect.
    const allowedAfterRevoke = await resolveSourceIdsForUser(db, USER_OID);
    expect(allowedAfterRevoke).not.toContain(sourceId);

    const deniedToken = await signInternalScopeToken(
      { sub: USER_OID, allowedSourceIds: allowedAfterRevoke },
      TEST_INTERNAL_SCOPE_SECRET,
    );
    const deniedRes = await inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${deniedToken}` },
    });
    expect(deniedRes.statusCode).toBe(200);
    const deniedBody = deniedRes.json() as { sources: Array<{ id: string }> };
    expect(deniedBody.sources.map((s) => s.id)).not.toContain(sourceId);
  });

  it("rejects a token signed with an unconfigured secret (forged token)", async () => {
    const forgedToken = await signInternalScopeToken(
      { sub: "attacker-oid", allowedSourceIds: ["anything"] },
      "a-secret-never-configured-on-the-server",
    );
    const res = await inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${forgedToken}` },
    });
    // Must be a genuine 401 (rejected credential), not merely an empty
    // result — an empty `sources` array could also happen for unrelated
    // reasons (e.g. no sources exist), so status code is the load-bearing
    // assertion here.
    expect(res.statusCode).toBe(401);
  });
});
