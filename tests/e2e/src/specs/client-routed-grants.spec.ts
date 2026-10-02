import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  clientRoutedGrantsForSource,
  grantClientAccess,
  grantSourceAccess,
  resolveSourceIdsForUser,
  revokeClientAccess,
  revokeSourceAccess,
} from "@rag/db";
import {
  assignSourceToClient,
  createCustomSource,
  openTestDb,
  truncateAll,
} from "../helpers/db.js";
import type { Db } from "@rag/db";

/**
 * `clientRoutedGrantsForSource` answers "does this user still reach this source
 * after I revoke their direct grant?"
 *
 * It exists because `revokeSourceAccess` can only remove a direct grant while
 * `resolveSourceIdsForUser` also honours the client-routed path, so a caller
 * that reports "revoked" after a direct revoke can be wrong. The assertions
 * below pair it with `resolveSourceIdsForUser` rather than testing it alone —
 * agreement with the function the BFF actually uses is the property that
 * matters, and it is what would break if either query gained a condition the
 * other did not.
 *
 * That property covers the client-routed join the two queries SHARE. It cannot
 * catch a condition added to `resolveSourceIdsForUser`'s direct-grant branch,
 * because this query has no direct branch to diverge.
 */
describe("E2E: clientRoutedGrantsForSource — access that survives a direct revoke", () => {
  let db: Db;
  let close: () => Promise<void>;
  let sourceId: string;

  // Spec-scoped id, not the schema docblock's example CLIENT: `truncateAll`
  // cascades from `sources`, and `staff_client_assignments` has no FK to
  // `sources` (user_id and client_id are opaque text), so rows created here
  // outlive the suite. access-grants.spec.ts documents the same trap and
  // handles it this way.
  const CLIENT = "e2e-test-client-routed";

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  afterEach(async () => {
    // Hard-delete is test-only cleanup of rows this spec created — not the
    // production revoke path, which must never hard-delete.
    await db.execute(
      sql`DELETE FROM staff_client_assignments WHERE client_id = ${CLIENT}`,
    );
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    sourceId = await createCustomSource(db, "client-routed");
  });

  it("returns [] when the user has only a direct grant", async () => {
    await grantSourceAccess(db, {
      userId: "u-direct",
      sourceId,
      grantedBy: "adm",
    });
    expect(await resolveSourceIdsForUser(db, "u-direct")).toEqual([sourceId]);
    expect(await clientRoutedGrantsForSource(db, "u-direct", sourceId)).toEqual(
      [],
    );
  });

  it("names the client when access is client-routed, and survives a direct revoke", async () => {
    await assignSourceToClient(db, sourceId, CLIENT);
    await grantClientAccess(db, {
      userId: "u-client",
      clientId: CLIENT,
      grantedBy: "adm",
    });
    // Also give a direct grant, so the revoke below has something to remove.
    await grantSourceAccess(db, {
      userId: "u-client",
      sourceId,
      grantedBy: "adm",
    });

    expect(await clientRoutedGrantsForSource(db, "u-client", sourceId)).toEqual(
      [CLIENT],
    );

    await revokeSourceAccess(db, { userId: "u-client", sourceId });

    // The direct grant is gone, but the user still reaches the source. This is
    // the case a bare "revoked" would misreport.
    expect(await clientRoutedGrantsForSource(db, "u-client", sourceId)).toEqual(
      [CLIENT],
    );
    expect(await resolveSourceIdsForUser(db, "u-client")).toEqual([sourceId]);
  });

  it("goes empty once the client assignment itself is revoked, and then so does the scope", async () => {
    await assignSourceToClient(db, sourceId, CLIENT);
    await grantClientAccess(db, {
      userId: "u-rev",
      clientId: CLIENT,
      grantedBy: "adm",
    });
    expect(await clientRoutedGrantsForSource(db, "u-rev", sourceId)).toEqual([
      CLIENT,
    ]);

    await revokeClientAccess(db, { userId: "u-rev", clientId: CLIENT });

    expect(await clientRoutedGrantsForSource(db, "u-rev", sourceId)).toEqual(
      [],
    );
    expect(await resolveSourceIdsForUser(db, "u-rev")).toEqual([]);
  });

  it("does not leak one user's client-routed access to another", async () => {
    await assignSourceToClient(db, sourceId, CLIENT);
    await grantClientAccess(db, {
      userId: "u-member",
      clientId: CLIENT,
      grantedBy: "adm",
    });
    expect(
      await clientRoutedGrantsForSource(db, "u-stranger", sourceId),
    ).toEqual([]);
    expect(await resolveSourceIdsForUser(db, "u-stranger")).toEqual([]);
  });

  it("returns [] for a source the client is not assigned to", async () => {
    const other = await createCustomSource(db, "client-routed-other");
    await assignSourceToClient(db, sourceId, CLIENT);
    await grantClientAccess(db, {
      userId: "u-scoped",
      clientId: CLIENT,
      grantedBy: "adm",
    });
    expect(await clientRoutedGrantsForSource(db, "u-scoped", sourceId)).toEqual(
      [CLIENT],
    );
    expect(await clientRoutedGrantsForSource(db, "u-scoped", other)).toEqual(
      [],
    );
    // Pair against the BFF's own resolver, as the other four cases do: the user
    // reaches the assigned source and not the unassigned one.
    expect(await resolveSourceIdsForUser(db, "u-scoped")).toEqual([sourceId]);
  });
});
