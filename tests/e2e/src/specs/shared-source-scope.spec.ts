import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { grantSourceAccess, resolveSharedSourceIdsForUsers } from "@rag/db";
import type { Db } from "@rag/db";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";

/**
 * SDD Teams-bot Task 1: `resolveSharedSourceIdsForUsers` — the channel-safe
 * intersection query.
 *
 * This is the compliance core of the Teams KB bot: a channel answer may only
 * draw on sources that EVERY member of the channel can already see on their
 * own, so the bot can never surface content one member has access to but
 * another doesn't. It reuses the SAME grant UNION as `resolveSourceIdsForUser`
 * (client-routed + direct grants), so per-user scope and channel scope can
 * never diverge on what counts as a grant.
 *
 * The isolation case (assertion 2) is the load-bearing one, mirroring the
 * isolation test for `resolveSourceIdsForUser` in access-grants.spec.ts: if
 * the `HAVING count(DISTINCT user_id) = N` intersection were dropped or
 * mis-bound in favor of a plain UNION, the positive case would still pass
 * while silently leaking a source only ONE of the two members can see — a
 * real cross-user confidentiality break in a shared channel.
 */
describe("E2E: resolveSharedSourceIdsForUsers — channel-safe intersection scope", () => {
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

  it("a source directly granted to BOTH users is in the intersection", async () => {
    const sharedSourceId = await createCustomSource(
      db,
      "e2e-shared-scope-intersection-source",
    );
    await grantSourceAccess(db, {
      userId: "e2e-shared-scope-user-a",
      sourceId: sharedSourceId,
      grantedBy: "e2e-admin-oid-1",
    });
    await grantSourceAccess(db, {
      userId: "e2e-shared-scope-user-b",
      sourceId: sharedSourceId,
      grantedBy: "e2e-admin-oid-1",
    });

    const resolved = await resolveSharedSourceIdsForUsers(db, [
      "e2e-shared-scope-user-a",
      "e2e-shared-scope-user-b",
    ]);
    expect(resolved.sort()).toEqual([sharedSourceId].sort());
  });

  it("(THE leak test) a source granted only to user A is NOT shared when B lacks a grant to it", async () => {
    const soloSourceId = await createCustomSource(
      db,
      "e2e-shared-scope-isolation-source",
    );
    await grantSourceAccess(db, {
      userId: "e2e-shared-scope-user-a2",
      sourceId: soloSourceId,
      grantedBy: "e2e-admin-oid-1",
    });
    // user-b2 is granted NOTHING at all.

    const resolved = await resolveSharedSourceIdsForUsers(db, [
      "e2e-shared-scope-user-a2",
      "e2e-shared-scope-user-b2",
    ]);
    expect(resolved).not.toContain(soloSourceId);
    expect(resolved).toEqual([]);
  });

  it("a client_confidential source granted to BOTH users is still excluded from the result", async () => {
    const confidentialSourceId = await createCustomSource(
      db,
      "e2e-shared-scope-confidential-source",
      {},
      "client_confidential",
    );
    await grantSourceAccess(db, {
      userId: "e2e-shared-scope-user-c1",
      sourceId: confidentialSourceId,
      grantedBy: "e2e-admin-oid-1",
    });
    await grantSourceAccess(db, {
      userId: "e2e-shared-scope-user-c2",
      sourceId: confidentialSourceId,
      grantedBy: "e2e-admin-oid-1",
    });

    const resolved = await resolveSharedSourceIdsForUsers(db, [
      "e2e-shared-scope-user-c1",
      "e2e-shared-scope-user-c2",
    ]);
    expect(resolved).not.toContain(confidentialSourceId);
    expect(resolved).toEqual([]);
  });

  it("empty userIds resolves to []", async () => {
    const resolved = await resolveSharedSourceIdsForUsers(db, []);
    expect(resolved).toEqual([]);
  });
});
