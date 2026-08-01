import { describe, expect, it } from "vitest";
import { verifyClaim, verifyClaims } from "./claim-verification.js";

/**
 * The guarantee under test is narrow and absolute: **what comes out is a slice
 * of the document, never the model's string.** Everything else here supports
 * that one claim.
 *
 * The invariant `markdown.slice(start, end) === quote` is asserted on every
 * success path rather than in one place, because it is the property that makes
 * the whole corpus-grounded design trustworthy — if index mapping is off by one
 * anywhere, a stored "verbatim" quote is silently wrong.
 */

const DOC = [
  "# Catch-up Bookkeeping",
  "",
  "The time code for catch-up bookkeeping is **BK-CATCHUP**.",
  "Work performed under this code is billed at the standard",
  "bookkeeping rate.",
  "",
  "| Field | Value |",
  "| ----- | ----- |",
  "| Code  | BK-CATCHUP |",
  "",
  "Returns are due by the 15th — no extensions are granted for",
  "internal deadlines.",
].join("\n");

function expectSlice(md: string, r: ReturnType<typeof verifyClaim>) {
  if (!r.ok) throw new Error("expected verification to succeed");
  // THE invariant.
  expect(md.slice(r.start, r.end)).toBe(r.quote);
}

describe("verifyClaim — the stored quote comes from the document", () => {
  it("matches exactly when the model quotes verbatim", () => {
    const r = verifyClaim(
      DOC,
      "The catch-up bookkeeping time code is BK-CATCHUP",
      "The time code for catch-up bookkeeping is **BK-CATCHUP**.",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rung).toBe("exact");
    expect(r.modelQuoteDiffered).toBe(false);
    expectSlice(DOC, r);
  });

  it("stores the SOURCE span, not the model's string, when they differ", () => {
    // The model collapses the line break. The source has a newline.
    const r = verifyClaim(
      DOC,
      "Catch-up work bills at the standard bookkeeping rate",
      "Work performed under this code is billed at the standard bookkeeping rate.",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rung).toBe("whitespace");
    // The whole point: what we keep contains the real newline.
    expect(r.quote).toContain("\n");
    expect(r.quote).not.toBe(
      "Work performed under this code is billed at the standard bookkeeping rate.",
    );
    expect(r.modelQuoteDiffered).toBe(true);
    expectSlice(DOC, r);
  });

  it("folds unicode the model normalized (em dash)", () => {
    const r = verifyClaim(
      DOC,
      "Returns are due on the 15th",
      "Returns are due by the 15th - no extensions are granted",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rung).toBe("unicode");
    // Source em dash preserved in what we store.
    expect(r.quote).toContain("—");
    expectSlice(DOC, r);
  });

  it("recovers a quote the model stripped markdown from", () => {
    const r = verifyClaim(
      DOC,
      "The code is BK-CATCHUP",
      "The time code for catch-up bookkeeping is BK-CATCHUP.",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rung).toBe("markdown");
    // Stored span still carries the asterisks — it is the document's text.
    expect(r.quote).toContain("**BK-CATCHUP**");
    expectSlice(DOC, r);
  });

  it("reads a table row the model rendered as prose", () => {
    const r = verifyClaim(DOC, "Code is BK-CATCHUP", "Code BK-CATCHUP");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rung).toBe("markdown");
    expectSlice(DOC, r);
  });
});

describe("verifyClaim — rejections are the point, not an error path", () => {
  it("REJECTS a paraphrase that never appears in the document", () => {
    // The critical test. This claim is true of the document; the quote is not
    // in it. Accepting this would defeat the entire design.
    const r = verifyClaim(
      DOC,
      "Catch-up bookkeeping uses code BK-CATCHUP",
      "Catch-up bookkeeping work should be coded as BK-CATCHUP for billing.",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-found");
  });

  it("REJECTS a quote from a different document", () => {
    const r = verifyClaim(
      DOC,
      "Payroll runs monthly",
      "Payroll is processed on the last business day of each month.",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an empty quote — an unquoted claim is unverifiable", () => {
    const r = verifyClaim(DOC, "Some claim", "   ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("empty-quote");
  });

  it("rejects an empty claim", () => {
    const r = verifyClaim(DOC, "  ", "The time code");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("empty-claim");
  });

  it("does not let a near-miss slide: one wrong word fails", () => {
    const r = verifyClaim(
      DOC,
      "Code is BK-CATCHUP",
      "The time code for catch-up accounting is BK-CATCHUP.",
    );
    expect(r.ok).toBe(false);
  });
});

describe("verifyClaims — the rung distribution is a diagnostic", () => {
  it("counts rungs and flags ladder strain when exact matches are rare", () => {
    const report = verifyClaims(DOC, [
      // exact
      {
        claim: "a",
        quote: "The time code for catch-up bookkeeping is **BK-CATCHUP**.",
      },
      // markdown rung
      {
        claim: "b",
        quote: "The time code for catch-up bookkeeping is BK-CATCHUP.",
      },
      // markdown rung
      { claim: "c", quote: "Code BK-CATCHUP" },
    ]);

    expect(report.verified).toHaveLength(3);
    expect(report.rungCounts.exact).toBe(1);
    expect(report.rungCounts.markdown).toBe(2);
    // 1/3 exact — the prompt is paraphrasing, and the report says so.
    expect(report.ladderStrain).toBe(true);
  });

  it("does not flag strain when the model quotes properly", () => {
    const report = verifyClaims(DOC, [
      {
        claim: "a",
        quote: "The time code for catch-up bookkeeping is **BK-CATCHUP**.",
      },
      { claim: "b", quote: "internal deadlines." },
    ]);
    expect(report.rungCounts.exact).toBe(2);
    expect(report.ladderStrain).toBe(false);
  });

  it("separates rejected claims without throwing", () => {
    const report = verifyClaims(DOC, [
      { claim: "good", quote: "internal deadlines." },
      { claim: "bad", quote: "this sentence is not in the document at all" },
    ]);
    expect(report.verified).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.reason).toBe("not-found");
  });
});

describe("the slice invariant holds under perturbation", () => {
  // Not a hand-picked case: take every substring of the document as a candidate
  // quote, perturb it the way a model would, and assert that whenever we accept
  // a match the stored quote is exactly the span we claim it is. An off-by-one
  // in the index map would surface here and nowhere else.
  const perturbations: ((s: string) => string)[] = [
    (s) => s,
    (s) => s.replace(/\s+/g, " "),
    (s) => s.replace(/\*/g, ""),
    (s) => s.replace(/—/g, "-"),
    (s) => s.replace(/\s+/g, " ").replace(/[*|]/g, ""),
  ];

  it("markdown.slice(start,end) === quote for every accepted match", () => {
    let accepted = 0;
    for (let start = 0; start < DOC.length; start += 7) {
      for (const len of [12, 31, 60]) {
        const raw = DOC.slice(start, start + len).trim();
        if (raw.length < 5) continue;
        for (const p of perturbations) {
          const r = verifyClaim(DOC, "c", p(raw));
          if (!r.ok) continue;
          accepted++;
          expect(DOC.slice(r.start, r.end)).toBe(r.quote);
        }
      }
    }
    // Guard against the test passing because nothing ever matched.
    expect(accepted).toBeGreaterThan(50);
  });
});
