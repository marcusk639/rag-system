import { describe, expect, it } from "vitest";
import type { RetrievalResult } from "./types.js";
import { topRelevanceScore } from "./relevance.js";

function hit(score: number, denseScore: number): RetrievalResult {
  return {
    text: "t",
    score,
    denseScore,
    sparseScore: 0,
    document: { id: "d", title: "D", sourceId: "s", metadata: {} },
    chunk: { id: "c", ordinal: 0, headingPath: [] },
  } as unknown as RetrievalResult;
}

describe("topRelevanceScore", () => {
  it("is null when nothing was retrieved", () => {
    expect(topRelevanceScore([])).toBeNull();
  });

  it("ignores the max-normalized RRF score, which is 1.0 for every non-empty result set", () => {
    // A poor match: rank-normalized fusion still reports 1.0 at the top, but
    // the absolute cosine similarity is low. The audit signal must be the latter
    // or the docs-gap digest's `topScore < minScore` arm can never fire.
    expect(topRelevanceScore([hit(1, 0.12), hit(0.5, 0.08)])).toBeCloseTo(0.12);
  });

  it("takes the best dense similarity, not the first row's (reranking/fusion reorder rows)", () => {
    expect(topRelevanceScore([hit(1, 0.4), hit(0.9, 0.7)])).toBeCloseTo(0.7);
  });

  it("is 0 when only sparse-only hits were retrieved (no dense evidence)", () => {
    expect(topRelevanceScore([hit(1, 0)])).toBe(0);
  });

  it("skips non-finite dense scores and returns null if none are usable", () => {
    expect(topRelevanceScore([hit(1, Number.NaN)])).toBeNull();
    expect(topRelevanceScore([hit(1, Number.NaN), hit(1, 0.3)])).toBeCloseTo(
      0.3,
    );
  });
});
