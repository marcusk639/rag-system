import { describe, it, expect } from "vitest";
import {
  REQUIRED_SEARCH_INDEXES,
  assertRequiredIndexes,
  type IndexExistenceRunner,
} from "./required-indexes.js";

/**
 * Build a fake query-runner that reports `present` as the set of existing
 * index names on `chunks`, so the guard can be exercised without a live DB.
 */
function fakeRunner(present: readonly string[]): IndexExistenceRunner {
  return {
    listChunkIndexNames: async () => [...present],
  };
}

describe("assertRequiredIndexes", () => {
  it("passes silently when both required search indexes are present", async () => {
    const runner = fakeRunner([
      ...REQUIRED_SEARCH_INDEXES,
      // Extra unrelated indexes must not matter.
      "chunks_document_idx",
      "chunks_hash_idx",
    ]);
    await expect(assertRequiredIndexes(runner)).resolves.toBeUndefined();
  });

  it("throws naming the missing HNSW index when it is absent", async () => {
    const present = REQUIRED_SEARCH_INDEXES.filter(
      (n) => n !== "chunks_embedding_hnsw_idx",
    );
    const runner = fakeRunner(present);

    let message = "";
    await expect(assertRequiredIndexes(runner)).rejects.toThrow();
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_embedding_hnsw_idx");
    // Must warn that retrieval silently degrades to sequential scans.
    expect(message).toMatch(/sequential scan/i);
  });

  it("throws naming the missing GIN tsvector index when it is absent", async () => {
    const present = REQUIRED_SEARCH_INDEXES.filter(
      (n) => n !== "chunks_tsv_idx",
    );
    const runner = fakeRunner(present);

    let message = "";
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chunks_tsv_idx");
    expect(message).toMatch(/sequential scan/i);
  });

  it("names every missing index when more than one is gone", async () => {
    const runner = fakeRunner([]);

    let message = "";
    try {
      await assertRequiredIndexes(runner);
    } catch (err) {
      message = (err as Error).message;
    }
    for (const name of REQUIRED_SEARCH_INDEXES) {
      expect(message).toContain(name);
    }
  });

  it("tracks exactly the two search indexes owned by 0000_init.sql", () => {
    expect([...REQUIRED_SEARCH_INDEXES].sort()).toEqual([
      "chunks_embedding_hnsw_idx",
      "chunks_tsv_idx",
    ]);
  });
});
