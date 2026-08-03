import { describe, expect, it } from "vitest";
import {
  aggregateCorpusGrounded,
  buildEntailmentPrompt,
  findConflictCandidates,
  parseEntailmentReply,
  type CorpusClaimRef,
  type CorpusGroundedResult,
} from "../eval/corpus-grounded.js";
import { validateGoldSet, type TwkGoldQuestion } from "../eval/twk-gold-set.js";

function claim(overrides: Partial<CorpusClaimRef> = {}): CorpusClaimRef {
  return {
    id: "claim-1",
    claim: "Engagement letters are routed for signature before work begins.",
    quote:
      "Route the engagement letter for signature; work does not begin until it is returned.",
    documentExternalId: "doc-a",
    documentTitle: "New Client Onboarding SOP",
    sourceModifiedAt: "2025-11-04T00:00:00Z",
    topic: "engagement-letter-routing",
    ...overrides,
  };
}

function result(
  overrides: Partial<CorpusGroundedResult> = {},
): CorpusGroundedResult {
  return {
    claimId: "claim-1",
    verdict: "supported",
    documentExternalId: "doc-a",
    ...overrides,
  };
}

describe("buildEntailmentPrompt", () => {
  it("puts the verbatim quote in the prompt, not the claim alone", () => {
    // The quote is the whole design: without it the judge is comparing the
    // answer to an LLM's summary rather than to what the document says.
    const prompt = buildEntailmentPrompt({
      question: "when do we send engagement letters?",
      answer: "Before work begins [1].",
      claim: claim(),
    });

    expect(prompt).toContain(
      "Route the engagement letter for signature; work does not begin until it is returned.",
    );
    expect(prompt).toContain("Before work begins [1].");
  });

  it("names all three verdicts so 'unaddressed' is reachable", () => {
    const prompt = buildEntailmentPrompt({
      question: "q",
      answer: "a",
      claim: claim(),
    });

    expect(prompt).toContain("supported");
    expect(prompt).toContain("contradicted");
    expect(prompt).toContain("unaddressed");
  });

  it("forbids the judge from ruling on professional correctness", () => {
    // Same boundary faithfulness.ts holds: the judge compares two texts. It
    // must not decide whether the SOP is right as tax practice (constraint C2).
    const prompt = buildEntailmentPrompt({
      question: "q",
      answer: "a",
      claim: claim(),
    });

    expect(prompt.toLowerCase()).toContain("do not judge");
  });
});

describe("parseEntailmentReply", () => {
  it.each(["supported", "contradicted", "unaddressed"] as const)(
    "parses the %s verdict",
    (verdict) => {
      const parsed = parseEntailmentReply(
        `{"verdict": "${verdict}", "notes": "n"}`,
        claim(),
      );

      expect(parsed.verdict).toBe(verdict);
      expect(parsed.claimId).toBe("claim-1");
      // Carried through so a contradiction can be traced to its document
      // without re-joining against the claim set.
      expect(parsed.documentExternalId).toBe("doc-a");
    },
  );

  it("tolerates prose around the JSON object", () => {
    const parsed = parseEntailmentReply(
      'Here is my assessment:\n{"verdict": "supported"}\nHope that helps.',
      claim(),
    );

    expect(parsed.verdict).toBe("supported");
  });

  it("throws on a reply containing no JSON object", () => {
    expect(() => parseEntailmentReply("I think it is fine", claim())).toThrow(
      /no JSON object/i,
    );
  });

  it("throws on an unrecognized verdict rather than defaulting", () => {
    // Defaulting an unknown verdict to `unaddressed` would silently convert a
    // judge malfunction into a retrieval finding.
    expect(() =>
      parseEntailmentReply('{"verdict": "mostly right"}', claim()),
    ).toThrow(/verdict/i);
  });
});

describe("aggregateCorpusGrounded", () => {
  it("scores supported against contradicted only", () => {
    const summary = aggregateCorpusGrounded([
      result({ claimId: "a", verdict: "supported" }),
      result({ claimId: "b", verdict: "supported" }),
      result({ claimId: "c", verdict: "contradicted" }),
    ]);

    expect(summary.corpusGrounded).toBeCloseTo(2 / 3);
    expect(summary.supported).toBe(2);
    expect(summary.contradicted).toBe(1);
  });

  it("excludes unaddressed from the ratio instead of zeroing it", () => {
    // An unaddressed claim is a RETRIEVAL miss, not an answer-quality defect.
    // Folding it in as 0 would blame the generator for the retriever's failure
    // and make the two indistinguishable in the number.
    const summary = aggregateCorpusGrounded([
      result({ claimId: "a", verdict: "supported" }),
      result({ claimId: "b", verdict: "unaddressed" }),
    ]);

    expect(summary.corpusGrounded).toBe(1);
    expect(summary.unaddressed).toBe(1);
    expect(summary.total).toBe(2);
  });

  it("returns null rather than NaN when nothing is scoreable", () => {
    const summary = aggregateCorpusGrounded([
      result({ verdict: "unaddressed" }),
    ]);

    expect(summary.corpusGrounded).toBeNull();
  });

  it("returns null for an empty result set", () => {
    expect(aggregateCorpusGrounded([]).corpusGrounded).toBeNull();
  });

  it("lists the contradicted claims so they can be triaged", () => {
    const summary = aggregateCorpusGrounded([
      result({ claimId: "bad", verdict: "contradicted" }),
      result({ claimId: "ok", verdict: "supported" }),
    ]);

    expect(summary.contradictedClaimIds).toEqual(["bad"]);
  });
});

describe("findConflictCandidates", () => {
  it("pairs same-topic claims from different documents", () => {
    const conflicts = findConflictCandidates([
      claim({ id: "a", documentExternalId: "doc-a" }),
      claim({
        id: "b",
        documentExternalId: "doc-b",
        sourceModifiedAt: "2024-01-02T00:00:00Z",
      }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.claims.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("carries both dates and resolves nothing", () => {
    // Recency is evidence, not a verdict — a recently-touched file may be a
    // copy while the authoritative version is older. The record must not name
    // a winner.
    const conflicts = findConflictCandidates([
      claim({ id: "a", sourceModifiedAt: "2025-11-04T00:00:00Z" }),
      claim({
        id: "b",
        documentExternalId: "doc-b",
        sourceModifiedAt: "2024-01-02T00:00:00Z",
      }),
    ]);

    const dates = conflicts[0]?.claims.map((c) => c.sourceModifiedAt);
    expect(dates).toContain("2025-11-04T00:00:00Z");
    expect(dates).toContain("2024-01-02T00:00:00Z");
    expect(conflicts[0]).not.toHaveProperty("winner");
    expect(conflicts[0]).not.toHaveProperty("supersededBy");
  });

  it("does not pair two claims from the same document", () => {
    // One document elaborating its own topic is not a conflict.
    const conflicts = findConflictCandidates([
      claim({ id: "a", documentExternalId: "doc-a" }),
      claim({ id: "b", documentExternalId: "doc-a" }),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("does not pair claims on different topics", () => {
    const conflicts = findConflictCandidates([
      claim({ id: "a", topic: "engagement-letter-routing" }),
      claim({ id: "b", documentExternalId: "doc-b", topic: "payroll-cutoff" }),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("tolerates a null modified date without dropping the pair", () => {
    // A document with no source date is exactly the case a human most needs to
    // see; dropping it would hide the hardest conflicts.
    const conflicts = findConflictCandidates([
      claim({ id: "a", sourceModifiedAt: null }),
      claim({ id: "b", documentExternalId: "doc-b" }),
    ]);

    expect(conflicts).toHaveLength(1);
  });
});

describe("ScoringTier — tier1-corpus-grounded", () => {
  const base: TwkGoldQuestion = {
    id: "twk-q-900",
    query: "when do we send engagement letters?",
    relevant: ["doc-a"],
    tier: "tier1-corpus-grounded",
  };

  it("accepts a corpus-grounded question with no expectedAnswer", () => {
    expect(validateGoldSet([base])).toEqual([]);
  });

  it("rejects a corpus-grounded question carrying an expectedAnswer", () => {
    // The whole point of a separate tier. A corpus quote is not a verified gold
    // answer, and writing one into `expectedAnswer` would launder a document
    // excerpt into a CPA attestation — even with verifiedBy set, because the
    // attestation would be attributed to someone who signed for a different
    // kind of claim.
    const issues = validateGoldSet([
      {
        ...base,
        expectedAnswer: "Before work begins.",
        verifiedBy: "Someone",
        verifiedOn: "2026-08-03",
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.problem).toMatch(/corpus-grounded/i);
  });

  it("still requires expectedAnswer for the CPA tier", () => {
    // Guard against the new branch loosening the existing rule.
    const issues = validateGoldSet([{ ...base, tier: "tier2-cpa-verified" }]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.problem).toMatch(/tier2-cpa-verified/);
  });
});
