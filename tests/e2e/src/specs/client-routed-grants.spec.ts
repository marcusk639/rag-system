import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
 */
describe("E2E: clientRoutedGrantsForSource — access that survives a direct revoke", () => {
  let db: Db;
  let close: () => Promise<void>;
  let sourceId: string;

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
    await assignSourceToClient(db, sourceId, "smithco");
    await grantClientAccess(db, {
      userId: "u-client",
      clientId: "smithco",
      grantedBy: "adm",
    });
    // Also give a direct grant, so the revoke below has something to remove.
    await grantSourceAccess(db, {
      userId: "u-client",
      sourceId,
      grantedBy: "adm",
    });

    expect(await clientRoutedGrantsForSource(db, "u-client", sourceId)).toEqual(
      ["smithco"],
    );

    await revokeSourceAccess(db, { userId: "u-client", sourceId });

    // The direct grant is gone, but the user still reaches the source. This is
    // the case a bare "revoked" would misreport.
    expect(await clientRoutedGrantsForSource(db, "u-client", sourceId)).toEqual(
      ["smithco"],
    );
    expect(await resolveSourceIdsForUser(db, "u-client")).toEqual([sourceId]);
  });

  it("goes empty once the client assignment itself is revoked, and then so does the scope", async () => {
    await assignSourceToClient(db, sourceId, "smithco");
    await grantClientAccess(db, {
      userId: "u-rev",
      clientId: "smithco",
      grantedBy: "adm",
    });
    expect(await clientRoutedGrantsForSource(db, "u-rev", sourceId)).toEqual([
      "smithco",
    ]);

    await revokeClientAccess(db, { userId: "u-rev", clientId: "smithco" });

    expect(await clientRoutedGrantsForSource(db, "u-rev", sourceId)).toEqual(
      [],
    );
    expect(await resolveSourceIdsForUser(db, "u-rev")).toEqual([]);
  });

  it("does not leak one user's client-routed access to another", async () => {
    await assignSourceToClient(db, sourceId, "smithco");
    await grantClientAccess(db, {
      userId: "u-member",
      clientId: "smithco",
      grantedBy: "adm",
    });
    expect(
      await clientRoutedGrantsForSource(db, "u-stranger", sourceId),
    ).toEqual([]);
    expect(await resolveSourceIdsForUser(db, "u-stranger")).toEqual([]);
  });

  it("returns [] for a source the client is not assigned to", async () => {
    const other = await createCustomSource(db, "client-routed-other");
    await assignSourceToClient(db, sourceId, "smithco");
    await grantClientAccess(db, {
      userId: "u-scoped",
      clientId: "smithco",
      grantedBy: "adm",
    });
    expect(await clientRoutedGrantsForSource(db, "u-scoped", sourceId)).toEqual(
      ["smithco"],
    );
    expect(await clientRoutedGrantsForSource(db, "u-scoped", other)).toEqual(
      [],
    );
  });
});
