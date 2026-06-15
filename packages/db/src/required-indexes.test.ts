import { describe, it, expect } from "vitest";
import {
  REQUIRED_CHUNK_TRIGGERS,
  REQUIRED_SEARCH_INDEXES,
  assertRequiredIndexes,
  type IndexExistenceRunner,
} from "./required-indexes.js";

/**
 * Build a fake existence-runner reporting `indexes`/`triggers` as the sets of
 * existing objects on `chunks`, so the guard can be exercised without a live DB.
 */
function fakeRunner(opts: {
  indexes?: readonly string[];
  triggers?: readonly string[];
}): IndexExistenceRunner {
  return {
    listChunkIndexNames: async () => [...(opts.indexes ?? [])],
    listChunkTriggerNames: async () => [...(opts.triggers ?? [])],
  };
}

const ALL_PRESENT = {
  indexes: [
    ...REQUIRED_SEARCH_INDEXES,
    // Extra unrelated objects must not matter.
    "chunks_document_idx",
    "chunks_hash_idx",
  ],
  triggers: [...REQUIRED_CHUNK_TRIGGERS],
};

describe("assertRequiredIndexes", () => {
  it("passes silently when both indexes and the tsv trigger are present", async () => {
    await expect(
      assertRequiredIndexes(fakeRunner(ALL_PRESENT)),
    ).resolves.toBeUndefined();
  });

  it("throws naming the missing HNSW index when it is absent", async () => {
    const runner = fakeRunner({
      indexes: REQUIRED_SEARCH_INDEXES.filter(
        (n) => n !== "chunks_embedding_hnsw_idx",
      ),
      triggers: REQUIRED_CHUNK_TRIGGERS,
    });
    let message = "";
    await expect(assertRequiredIndexes(runner)).rejects.toThrow();
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_embedding_hnsw_idx");
    expect(message).toMatch(/sequential scan/i);
  });

  it("throws naming the missing GIN tsvector index when it is absent", async () => {
    const runner = fakeRunner({
      indexes: REQUIRED_SEARCH_INDEXES.filter((n) => n !== "chunks_tsv_idx"),
      triggers: REQUIRED_CHUNK_TRIGGERS,
    });
    let message = "";
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_tsv_idx");
    expect(message).toMatch(/sequential scan/i);
  });

  it("throws naming the missing tsv trigger when it is absent (sparse search would silently break)", async () => {
    const runner = fakeRunner({
      indexes: REQUIRED_SEARCH_INDEXES,
      triggers: [],
    });
    let message = "";
    await expect(assertRequiredIndexes(runner)).rejects.toThrow();
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_tsv_update");
    // Must explain the silent failure mode: NULL tsv → sparse returns nothing.
    expect(message).toMatch(/tsv/i);
  });

  it("names every missing object when indexes AND the trigger are all gone", async () => {
    const runner = fakeRunner({ indexes: [], triggers: [] });
    let message = "";
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    for (const name of [
      ...REQUIRED_SEARCH_INDEXES,
      ...REQUIRED_CHUNK_TRIGGERS,
    ]) {
      expect(message).toContain(name);
    }
  });

  it("tracks exactly the two search indexes and one trigger owned by 0000_init.sql", () => {
    expect([...REQUIRED_SEARCH_INDEXES].sort()).toEqual([
      "chunks_embedding_hnsw_idx",
      "chunks_tsv_idx",
    ]);
    expect([...REQUIRED_CHUNK_TRIGGERS]).toEqual(["chunks_tsv_update"]);
  });
});
