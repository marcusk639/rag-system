import { describe, expect, it } from "vitest";
import { TRUNCATION_NOTICE } from "@rag/rag";
import type { GoldQuestion } from "../eval/gold-set.js";
import { scoreGoldRun, type GoldObservation } from "../eval/gold-eval.js";

const REFUSAL =
  "The available documents do not contain enough information to answer that.";

const q = (
  id: string,
  relevant: string[],
  tier: GoldQuestion["tier"] = "tier1-automatable",
): GoldQuestion => ({ id, query: `question ${id}`, relevant, tier });

const obs = (
  id: string,
  retrieved: string[],
  cited: string[],
  answer = "An answer [1].",
): GoldObservation => ({
  id,
  answer,
  retrievedExternalIds: retrieved,
  citedExternalIds: cited,
});

describe("scoreGoldRun", () => {
  it("computes recall@k and MRR over answerable questions only", () => {
    const report = scoreGoldRun(
      [q("a", ["doc-1"]), q("b", ["doc-2"]), q("n", [])],
      [
        obs("a", ["doc-1", "doc-9"], ["doc-1"]),
        obs("b", ["doc-9", "doc-8", "doc-2"], ["doc-2"]),
        obs("n", ["doc-9"], [], REFUSAL),
      ],
    );
    expect(report.answerable).toBe(2);
    expect(report.recallAtK[1]).toBeCloseTo(0.5);
    expect(report.recallAtK[3]).toBeCloseTo(1);
    expect(report.mrr).toBeCloseTo((1 + 1 / 3) / 2);
  });

  it("scores refusals: correct on out-of-coverage questions, wrong on answerable ones", () => {
    const report = scoreGoldRun(
      [q("n1", []), q("n2", []), q("a", ["doc-1"])],
      [
        obs("n1", [], [], REFUSAL),
        obs("n2", ["doc-1"], ["doc-1"], "Confident made-up answer [1]."),
        obs("a", ["doc-1"], [], REFUSAL),
      ],
    );
    expect(report.coverage).toEqual({ total: 2, correctlyRefused: 1 });
    expect(report.wrongRefusals).toEqual(["a"]);
  });

  it("counts partial answers (the 'Not covered by the documents:' shape) as answers, not refusals", () => {
    const report = scoreGoldRun(
      [q("a", ["doc-1"])],
      [
        obs(
          "a",
          ["doc-1"],
          ["doc-1"],
          "Step one [1].\n\nNot covered by the documents: step two.",
        ),
      ],
    );
    expect(report.wrongRefusals).toEqual([]);
  });

  it("flags a citation to a document that was not retrieved as fabricated", () => {
    const report = scoreGoldRun(
      [q("a", ["doc-1"])],
      [obs("a", ["doc-1"], ["doc-1", "doc-404"])],
    );
    expect(report.fabricatedCitations).toEqual([
      { id: "a", externalIds: ["doc-404"] },
    ]);
  });

  it("counts truncated answers", () => {
    const report = scoreGoldRun(
      [q("a", ["doc-1"])],
      [
        obs(
          "a",
          ["doc-1"],
          ["doc-1"],
          `Step [1]${TRUNCATION_NOTICE}`,
        ),
      ],
    );
    expect(report.truncated).toEqual(["a"]);
  });

  it("reports a question with no observation as an error rather than scoring it zero", () => {
    const report = scoreGoldRun([q("a", ["doc-1"])], []);
    expect(report.missing).toEqual(["a"]);
    expect(report.answerable).toBe(0);
  });
});
