import { describe, expect, it } from "vitest";
import { extractClaims } from "./claim-extractor.js";

/**
 * Extraction is tested with a stub model rather than a live one, because the
 * behaviour under test is **what the code does with a model's output**, not what
 * a model produces. The stubs below reproduce the ways real models actually
 * misbehave: paraphrasing while believing they quoted, emitting compound claims,
 * and omitting required fields.
 */

const DOC = [
  "# Extension Requests",
  "",
  "Extension requests must be filed by **April 10** to leave review time.",
  "",
  "| Form  | Deadline |",
  "| ----- | -------- |",
  "| 4868  | April 15 |",
].join("\n");

const doc = {
  externalId: "ext-001",
  title: "Extension Requests",
  markdown: DOC,
  sourceModifiedAt: "2024-03-01T00:00:00.000Z",
};

const stub = (payload: unknown) => async () => JSON.stringify(payload);

describe("extractClaims", () => {
  it("keeps a claim whose quote is real, and stores the SOURCE span", async () => {
    const res = await extractClaims(
      stub({
        claims: [
          {
            claim: "Extension requests must be filed by April 10",
            // Model dropped the markdown emphasis — a near-miss, not a lie.
            quote:
              "Extension requests must be filed by April 10 to leave review time.",
            topic: "extensions",
            distractorNote:
              "The 4868 table row says April 15, a different date",
          },
        ],
      }),
      doc,
    );

    expect(res.claims).toHaveLength(1);
    const c = res.claims[0]!;
    // The stored quote is the document's text, asterisks and all.
    expect(c.quote).toContain("**April 10**");
    expect(DOC.slice(c.start, c.end)).toBe(c.quote);
    expect(c.documentExternalId).toBe("ext-001");
    expect(c.sourceModifiedAt).toBe("2024-03-01T00:00:00.000Z");
  });

  it("DROPS a claim the model paraphrased instead of quoting", async () => {
    // The claim is true of the document. The quote is invented. This is the
    // failure the whole design exists to stop, and it must not depend on the
    // prompt having been obeyed.
    const res = await extractClaims(
      stub({
        claims: [
          {
            claim: "Extensions are due April 10",
            quote:
              "Extensions have an internal deadline of April 10 each year.",
            topic: "extensions",
            distractorNote: "the 4868 row",
          },
        ],
      }),
      doc,
    );

    expect(res.claims).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.reason).toBe("not-found");
  });

  it("drops a claim with no distractorNote before it is even verified", async () => {
    const res = await extractClaims(
      stub({
        claims: [
          {
            claim: "Form 4868 deadline is April 15",
            quote: "| 4868  | April 15 |",
            topic: "extensions",
            // no distractorNote
          },
        ],
      }),
      doc,
    );

    expect(res.claims).toHaveLength(0);
    expect(res.droppedForShape).toHaveLength(1);
    expect(res.droppedForShape[0]!.reason).toMatch(/distractorNote/);
  });

  it("reports the rung distribution and strain", async () => {
    const res = await extractClaims(
      stub({
        claims: [
          {
            claim: "a",
            quote:
              "Extension requests must be filed by **April 10** to leave review time.",
            topic: "t",
            distractorNote: "d",
          },
          {
            claim: "b",
            // Table row read as prose. NOTE: "Form" is deliberately absent —
            // it is not in the source row, and including it correctly fails.
            quote: "4868 April 15",
            topic: "t",
            distractorNote: "d",
          },
        ],
      }),
      doc,
    );

    expect(res.claims).toHaveLength(2);
    expect(res.verification.rungCounts.exact).toBe(1);
    expect(res.verification.rungCounts.markdown).toBe(1);
  });

  it("survives a model that returns prose instead of JSON", async () => {
    const res = await extractClaims(
      async () => "I'm sorry, I can't help with that.",
      doc,
    );
    expect(res.claims).toHaveLength(0);
    expect(res.rejected).toHaveLength(0);
  });

  it("handles fenced JSON", async () => {
    const res = await extractClaims(
      async () =>
        '```json\n{"claims":[{"claim":"x","quote":"| 4868  | April 15 |","topic":"t","distractorNote":"d"}]}\n```',
      doc,
    );
    expect(res.claims).toHaveLength(1);
  });
});
