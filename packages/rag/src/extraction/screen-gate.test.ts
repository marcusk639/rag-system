import { describe, expect, it } from "vitest";
import {
  corpusFingerprint,
  evaluateExtractionGate,
  type ScreenSignoff,
  type ScreenState,
} from "./screen-gate.js";

/**
 * This gate is the only thing standing between "we have not checked whether the
 * corpus contains client data" and "we sent the corpus to a third-party model."
 * Every test here is a way that could go wrong, so the bias throughout is that
 * anything other than an explicit, current, complete sign-off must fail.
 */

const DOCS = [
  { externalId: "b", contentHash: "h2" },
  { externalId: "a", contentHash: "h1" },
];

const FP = corpusFingerprint(DOCS);

const state: ScreenState = {
  generatedAt: "2026-08-01T00:00:00.000Z",
  documentCount: 2,
  flaggedExternalIds: ["a"],
  corpusFingerprint: FP,
};

const signoff: ScreenSignoff = {
  approvedBy: "Chris",
  approvedOn: "2026-08-02",
  corpusFingerprint: FP,
  clearedExternalIds: ["a"],
  excludedExternalIds: [],
};

describe("corpusFingerprint", () => {
  it("is order-independent", () => {
    expect(corpusFingerprint([...DOCS].reverse())).toBe(FP);
  });

  it("changes when a document's content changes", () => {
    expect(
      corpusFingerprint([
        { externalId: "a", contentHash: "CHANGED" },
        DOCS[0]!,
      ]),
    ).not.toBe(FP);
  });

  it("changes when a document is added", () => {
    expect(
      corpusFingerprint([...DOCS, { externalId: "c", contentHash: "h3" }]),
    ).not.toBe(FP);
  });

  it("changes when a document is removed", () => {
    expect(corpusFingerprint([DOCS[0]!])).not.toBe(FP);
  });
});

describe("evaluateExtractionGate — fails closed", () => {
  it("refuses when no screen has run", () => {
    const r = evaluateExtractionGate(null, signoff);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toMatch(/No screen has been run/);
  });

  it("refuses when the screen ran but nobody signed off", () => {
    const r = evaluateExtractionGate(state, null);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toMatch(/nobody has signed off/);
  });

  it("refuses an unattributed sign-off", () => {
    const r = evaluateExtractionGate(state, { ...signoff, approvedBy: "  " });
    expect(r.allowed).toBe(false);
  });

  it("refuses when the corpus changed since review", () => {
    // The case the fingerprint exists for: reviewed corpus ≠ corpus about to
    // be sent. A document ingested after the review was never looked at.
    const drifted: ScreenState = {
      ...state,
      corpusFingerprint: corpusFingerprint([
        ...DOCS,
        { externalId: "new", contentHash: "h9" },
      ]),
    };
    const r = evaluateExtractionGate(drifted, signoff);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toMatch(/does not match the current corpus/);
  });

  it("refuses when a flagged document was never decided", () => {
    const r = evaluateExtractionGate(
      { ...state, flaggedExternalIds: ["a", "b"] },
      signoff, // only "a" cleared
    );
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toMatch(/neither cleared nor excluded/);
  });

  it("refuses a contradictory sign-off rather than guessing", () => {
    const r = evaluateExtractionGate(state, {
      ...signoff,
      excludedExternalIds: ["a"],
    });
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toMatch(/both cleared and excluded/);
  });
});

describe("evaluateExtractionGate — allows only a complete, current sign-off", () => {
  it("allows when every flag is resolved", () => {
    const r = evaluateExtractionGate(state, signoff);
    expect(r.allowed).toBe(true);
  });

  it("carries excluded documents forward so extraction skips them", () => {
    const r = evaluateExtractionGate(
      { ...state, flaggedExternalIds: ["a", "b"] },
      { ...signoff, clearedExternalIds: ["a"], excludedExternalIds: ["b"] },
    );
    expect(r.allowed).toBe(true);
    if (!r.allowed) return;
    // A document confirmed to hold client material must never be extracted.
    expect(r.excludedExternalIds.has("b")).toBe(true);
    expect(r.excludedExternalIds.has("a")).toBe(false);
  });

  it("allows a clean corpus with nothing flagged", () => {
    const r = evaluateExtractionGate(
      { ...state, flaggedExternalIds: [] },
      { ...signoff, clearedExternalIds: [] },
    );
    expect(r.allowed).toBe(true);
  });
});
