import { describe, expect, it } from "vitest";
import { hybridSearch } from "./queries.js";
import type { Db } from "./client.js";

/**
 * A `Db` stub that EXPLODES if any query is issued. Used to prove the
 * fail-closed ACL short-circuit returns `[]` BEFORE touching Postgres — the
 * one piece of the enforced source-id boundary that is unit-testable without
 * a live DB. The SQL `WHERE doc.source_id IN (...)` enforcement itself needs
 * Postgres (no integration infra here) and is verified by reading + typecheck.
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
