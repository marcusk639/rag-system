import { describe, it, expect } from "vitest";
import {
  aggregateFaithfulness,
  buildJudgePrompt,
  checkCitations,
  parseJudgeReply,
  type FaithfulnessResult,
} from "../eval/faithfulness.js";
import {
  validateGoldSet,
  isGoldSetUsable,
  type TwkGoldQuestion,
} from "../eval/twk-gold-set.js";

const chunk = (doc: string, text = "some text") => ({
  chunkId: `${doc}-c1`,
  documentExternalId: doc,
  text,
});

describe("checkCitations", () => {
  it("flags a citation to a document that was never retrieved", () => {
    const { fabricatedCitations } = checkCitations({
      question: "q",
      answer: "a",
      retrieved: [chunk("doc-a")],
      citedDocumentIds: ["doc-a", "doc-INVENTED"],
    });
    expect(fabricatedCitations).toEqual(["doc-INVENTED"]);
  });

  it("passes when every citation was retrieved", () => {
    const { fabricatedCitations } = checkCitations({
      question: "q",
      answer: "a",
      retrieved: [chunk("doc-a"), chunk("doc-b")],
      citedDocumentIds: ["doc-b"],
    });
    expect(fabricatedCitations).toEqual([]);
  });
});

describe("buildJudgePrompt", () => {
  it("instructs the judge NOT to assess professional correctness (C2)", () => {
    const p = buildJudgePrompt({
      question: "q",
      answer: "a",
      retrieved: [chunk("doc-a")],
      citedDocumentIds: [],
    });
    expect(p).toMatch(
      /Do NOT judge whether the answer is correct\s+accounting/,
    );
    expect(p).toMatch(/out of scope/);
  });

  it("tells the judge that declining to answer is correct behaviour", () => {
    const p = buildJudgePrompt({
      question: "q",
      answer: "a",
      retrieved: [chunk("doc-a")],
      citedDocumentIds: [],
    });
    expect(p).toMatch(/correct\s+behaviour, not a failure/);
  });
});

describe("parseJudgeReply", () => {
  it("computes faithfulness as supported / total", () => {
    const r = parseJudgeReply(
      '{"supportedClaims":3,"unsupportedClaims":1,"abstained":false}',
    );
    expect(r.faithfulness).toBeCloseTo(0.75);
  });

  it("returns null — NOT 0 — when the answer abstained", () => {
    // Coercing this to 0 would penalise the system for correctly declining,
    // training confident guessing over honest abstention.
    const r = parseJudgeReply(
      '{"supportedClaims":0,"unsupportedClaims":0,"abstained":true}',
    );
    expect(r.faithfulness).toBeNull();
    expect(r.abstained).toBe(true);
  });

  it("tolerates prose wrapped around the JSON object", () => {
    const r = parseJudgeReply(
      'Here is my assessment:\n{"supportedClaims":2,"unsupportedClaims":0}\nDone.',
    );
    expect(r.faithfulness).toBe(1);
  });

  it("throws rather than guessing when the reply has no JSON", () => {
    expect(() => parseJudgeReply("I could not comply.")).toThrow(/no JSON/);
  });
});

describe("aggregateFaithfulness", () => {
  const mk = (o: Partial<FaithfulnessResult>): FaithfulnessResult => ({
    supportedClaims: 0,
    unsupportedClaims: 0,
    faithfulness: null,
    fabricatedCitations: [],
    unsupportingCitations: [],
    abstained: false,
    ...o,
  });

  it("excludes abstentions from the mean instead of scoring them zero", () => {
    const s = aggregateFaithfulness([
      mk({ faithfulness: 1 }),
      mk({ faithfulness: 0.5 }),
      mk({ faithfulness: null, abstained: true }),
    ]);
    expect(s.meanFaithfulness).toBeCloseTo(0.75); // not 0.5
    expect(s.scored).toBe(2);
    expect(s.abstained).toBe(1);
    expect(s.total).toBe(3);
  });

  it("counts fabricated citations separately so they can hard-fail a run", () => {
    const s = aggregateFaithfulness([
      mk({ faithfulness: 1, fabricatedCitations: ["ghost-doc"] }),
    ]);
    expect(s.answersWithFabricatedCitations).toBe(1);
  });

  it("reports a null mean when nothing was scoreable", () => {
    const s = aggregateFaithfulness([mk({ abstained: true })]);
    expect(s.meanFaithfulness).toBeNull();
  });
});

describe("gold set validation", () => {
  const base: TwkGoldQuestion = {
    id: "twk-q-001",
    query: "What is our PTO policy?",
    relevant: ["doc-1"],
    tier: "tier1-automatable",
  };

  it("treats the shipped (empty) gold set as unusable", () => {
    // Guards the real risk: a run that reports success against zero questions.
    expect(isGoldSetUsable()).toBe(false);
  });

  it("rejects an expectedAnswer with no verifier attribution", () => {
    const issues = validateGoldSet([
      { ...base, expectedAnswer: "20 days", tier: "tier2-cpa-verified" },
    ]);
    expect(issues.map((i) => i.problem)).toContain(
      "expectedAnswer set without verifiedBy + verifiedOn",
    );
  });

  it("accepts a fully attributed tier-2 question", () => {
    expect(
      validateGoldSet([
        {
          ...base,
          tier: "tier2-cpa-verified",
          expectedAnswer: "20 days",
          verifiedBy: "Doug",
          verifiedOn: "2026-08-01",
        },
      ]),
    ).toEqual([]);
  });

  it("requires an expectedAnswer for tier2 questions", () => {
    const issues = validateGoldSet([{ ...base, tier: "tier2-cpa-verified" }]);
    expect(issues.map((i) => i.problem)).toContain(
      "tier2-cpa-verified requires an expectedAnswer",
    );
  });

  it("catches duplicate ids", () => {
    const issues = validateGoldSet([base, base]);
    expect(issues.map((i) => i.problem)).toContain("duplicate id");
  });

  it("allows an empty relevant[] as a deliberate coverage test", () => {
    expect(validateGoldSet([{ ...base, relevant: [] }])).toEqual([]);
  });
});
