import { describe, expect, it } from "vitest";
import {
  mean,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "../eval/metrics.js";

/**
 * Pure metric-math tests. No DB / docker required — these pin the scoring so a
 * refactor of the harness can't silently change what "recall@5" means.
 */
describe("eval metrics", () => {
  const ranking = ["a", "b", "c", "d", "e"];

  describe("recallAtK", () => {
    it("counts relevant docs found within k, normalized by relevant-set size", () => {
      expect(recallAtK(ranking, ["a"], 1)).toBe(1);
      expect(recallAtK(ranking, ["c"], 1)).toBe(0);
      expect(recallAtK(ranking, ["a", "c"], 3)).toBe(1); // both in top-3
      expect(recallAtK(ranking, ["a", "d"], 3)).toBe(0.5); // only a in top-3
    });

    it("returns 0 for an empty relevant set (never poisons an average)", () => {
      expect(recallAtK(ranking, [], 5)).toBe(0);
    });
  });

  describe("precisionAtK", () => {
    it("is hits divided by k", () => {
      expect(precisionAtK(ranking, ["a", "b"], 2)).toBe(1);
      expect(precisionAtK(ranking, ["a"], 2)).toBe(0.5);
      expect(precisionAtK(ranking, ["a", "b"], 4)).toBe(0.5);
    });

    it("returns 0 for k<=0", () => {
      expect(precisionAtK(ranking, ["a"], 0)).toBe(0);
    });
  });

  describe("ndcgAtK", () => {
    it("is 1.0 when the single relevant doc is ranked first", () => {
      expect(ndcgAtK(ranking, ["a"], 5)).toBeCloseTo(1, 10);
    });

    it("discounts a relevant doc ranked lower (1/log2(rank+1))", () => {
      // relevant doc at rank index 1 (2nd): DCG = 1/log2(3); IDCG (one rel) = 1/log2(2)=1
      expect(ndcgAtK(ranking, ["b"], 5)).toBeCloseTo(1 / Math.log2(3), 10);
    });

    it("rewards ranking both relevant docs ahead of irrelevant ones", () => {
      const ideal = ndcgAtK(["a", "b", "c"], ["a", "b"], 3);
      const worse = ndcgAtK(["c", "a", "b"], ["a", "b"], 3);
      expect(ideal).toBeCloseTo(1, 10);
      expect(worse).toBeLessThan(ideal);
    });

    it("returns 0 for an empty relevant set", () => {
      expect(ndcgAtK(ranking, [], 5)).toBe(0);
    });
  });

  describe("reciprocalRank", () => {
    it("is the reciprocal of the first relevant rank", () => {
      expect(reciprocalRank(ranking, ["a"])).toBe(1);
      expect(reciprocalRank(ranking, ["b"])).toBe(0.5);
      expect(reciprocalRank(ranking, ["c", "e"])).toBeCloseTo(1 / 3, 10);
    });

    it("is 0 when no relevant doc is retrieved", () => {
      expect(reciprocalRank(ranking, ["z"])).toBe(0);
    });
  });

  describe("mean", () => {
    it("averages and treats empty as 0", () => {
      expect(mean([1, 2, 3])).toBe(2);
      expect(mean([])).toBe(0);
    });
  });
});
