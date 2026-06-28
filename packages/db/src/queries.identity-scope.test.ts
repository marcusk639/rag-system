import { describe, expect, it } from "vitest";
import { resolveSourceIdsForUser } from "./queries.js";
import type { Db } from "./client.js";

// ---------------------------------------------------------------------------
// Unit tests for resolveSourceIdsForUser (no live DB required)
//
// The SQL logic (join + revoked_at IS NULL filter) is integration-tested by
// the E2E suite once fixtures are seeded. These tests cover the resolver's
// contract at the boundary: empty result → [], rows → mapped source_ids,
// and the function never throws on empty or multiple rows.
// ---------------------------------------------------------------------------

function stubDb(rows: { source_id: string }[]): Db {
  return {
    execute: async () => ({ rows }),
  } as unknown as Db;
}

describe("resolveSourceIdsForUser", () => {
  it("returns [] for an unmapped user (no rows)", async () => {
    const db = stubDb([]);
    const result = await resolveSourceIdsForUser(db, "user-unknown");
    expect(result).toEqual([]);
  });

  it("returns the correct source_id for a user with one assignment", async () => {
    const sourceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const db = stubDb([{ source_id: sourceId }]);
    const result = await resolveSourceIdsForUser(db, "user-alice");
    expect(result).toEqual([sourceId]);
  });

  it("returns all source_ids for a user spanning multiple clients", async () => {
    const ids = [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ];
    const db = stubDb(ids.map((id) => ({ source_id: id })));
    const result = await resolveSourceIdsForUser(db, "user-bob");
    expect(result).toEqual(ids);
  });

  it("result fed to hybridSearch as enforcedSourceIds=[] short-circuits (fail-closed)", async () => {
    // Verifies the contract: [] from resolveSourceIdsForUser + hybridSearch
    // fail-closed = zero results without a DB call.
    const db = stubDb([]);
    const sourceIds = await resolveSourceIdsForUser(db, "user-unmapped");
    // The hybridSearch short-circuit is tested separately in
    // queries.access-control.test.ts; here we just assert the shape is right.
    expect(sourceIds).toHaveLength(0);
    expect(Array.isArray(sourceIds)).toBe(true);
  });
});
