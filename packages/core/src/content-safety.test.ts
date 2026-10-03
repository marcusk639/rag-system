import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  redactText,
  redactOrThrow,
  applyRedaction,
  isExcludedPath,
  ContentSafetyError,
  DEFAULT_EXCLUDED_PATH_FRAGMENTS,
  scanForClientContextOrThrow,
} from "./content-safety.js";
import type { ScanMatch } from "./pack/scan.js";
import type { LoadedPack } from "./pack/load.js";
import { loadPack } from "./pack/load.js";
import type { ContentScanner } from "./interfaces.js";

/**
 * `packs/cpa/pack.yaml` exists (Task 6 authored it) and is the real shipped
 * artifact, so these tests — the pre-existing SPECIFICATION for redactText's
 * behaviour — load it directly rather than building an equivalent pack by
 * hand in TypeScript. Loading the real pack means a regression in
 * `pack.yaml` itself (e.g. an SSN pattern losing its `\b` anchors) fails
 * these tests, instead of silently passing against a fixture that has
 * drifted from the artifact actually shipped. Same four scanners, same
 * validators/context as the original hardcoded PATTERNS this file used to
 * exercise directly, resolved through the real compiled-in registry
 * (Task 2) so Ruling R3's luhn `digits.length > 0` guard is live here too.
 *
 * `content-safety.test.ts` sits in `packages/core/src/`, one level shallower
 * than `pack/cpa-pack.test.ts`, so this needs one fewer `../` than that
 * file's `../../../../packs/cpa`.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PACK = loadPack(join(__dirname, "../../../packs/cpa"));

describe("redactText — catches structured identifiers", () => {
  it("redacts a delimiter-formatted SSN", () => {
    const r = redactText("Taxpayer SSN: 123-45-6789 on file.", TEST_PACK);
    expect(r.text).toContain("[REDACTED-SSN]");
    expect(r.text).not.toContain("123-45-6789");
    expect(r.findings).toContainEqual({ kind: "ssn", count: 1 });
  });

  it("redacts an EIN", () => {
    const r = redactText("EIN 12-3456789 for the entity.", TEST_PACK);
    expect(r.text).toContain("[REDACTED-EIN]");
    expect(r.totalRedacted).toBe(1);
  });

  it("redacts a Luhn-valid card number", () => {
    const r = redactText("Card 4111 1111 1111 1111 was used.", TEST_PACK);
    expect(r.text).toContain("[REDACTED-CARD]");
  });

  it("counts multiple instances of the same kind", () => {
    const r = redactText("111-22-3333 and 444-55-6666", TEST_PACK);
    expect(r.findings).toContainEqual({ kind: "ssn", count: 2 });
  });
});

describe("redactText — does NOT destroy legitimate tax SOP content", () => {
  // The failure that looks like success. 316 of 355 screen hits were documents
  // that merely NAME a form; a redactor that strips those is useless.
  it("leaves form numbers alone", () => {
    const text =
      "Complete Form 1125-E and attach it to Form 1120. See Form 941 and 1040.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });

  it("leaves dollar amounts, percentages and years alone", () => {
    const text =
      "For 2024, deduct 50% of meals up to $12,500. Rates rose in 2019-2024.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });

  it("leaves IRC section and regulation references alone", () => {
    const text = "Under IRC §7216 and Circular 230 §10.22, and Reg. 1.199A-1.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });

  it("does not treat a bare 9-digit number as an SSN", () => {
    // Deliberate: in this corpus bare 9-digit runs are far more often amounts
    // or internal ids. Over-redaction here would gut the SOPs.
    const text = "Invoice reference 123456789 posted.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });

  it("leaves a phone number alone", () => {
    const text = "Call the office at 555-123-4567.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });
});

describe("redactText — checksum and context gating", () => {
  it("ignores a 9-digit number that fails the ABA checksum even near bank words", () => {
    const text = "Bank routing 123456789 listed.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });

  it("redacts an ABA-valid routing number when bank vocabulary is nearby", () => {
    // 021000021 is a well-known valid ABA test value.
    const r = redactText(
      "Wire to routing number 021000021 at the bank.",
      TEST_PACK,
    );
    expect(r.text).toContain("[REDACTED-ROUTING]");
  });

  it("leaves an ABA-valid number alone with no banking context", () => {
    const text = "Document control code 021000021 appears in the header.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });

  it("ignores a long digit run that fails Luhn", () => {
    const text = "Batch id 1234567890123456 recorded.";
    expect(redactText(text, TEST_PACK).text).toBe(text);
  });
});

describe("redactText — reporting", () => {
  it("never returns the redacted values themselves", () => {
    const r = redactText("SSN 123-45-6789", TEST_PACK);
    expect(JSON.stringify(r.findings)).not.toContain("123-45-6789");
  });

  it("reports zero findings for clean text", () => {
    const r = redactText(
      "Standard operating procedure for monthly close.",
      TEST_PACK,
    );
    expect(r.totalRedacted).toBe(0);
    expect(r.findings).toEqual([]);
  });
});

describe("isExcludedPath — Layer 2 structural exclusion", () => {
  it("excludes a per-client billing analysis folder", () => {
    const r = isExcludedPath(
      "/root:/Knowledge Base/Approved/Client Service Package Files/Batch 2/Billing & Production Analysis/x.xlsx",
    );
    expect(r.excluded).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it("excludes client package pricing sheets", () => {
    expect(
      isExcludedPath("/root:/KB/Client Package Pricing Sheets/foo.xlsx")
        .excluded,
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isExcludedPath("/KB/BILLING ANALYSIS/x.xlsx").excluded).toBe(true);
  });

  it("does NOT exclude a genuine procedure", () => {
    const r = isExcludedPath(
      "/root:/Knowledge Base/Tax Preparation/1040 (Individual Tax Return)/SOP's/Preparation - Individual Tax Return.docx",
    );
    expect(r.excluded).toBe(false);
  });

  it("does not exclude payroll or quarterly instructions", () => {
    expect(
      isExcludedPath("/KB/Payroll/Quarterly Payroll Tax Instructions.docx")
        .excluded,
    ).toBe(false);
  });

  it("handles a missing path without throwing", () => {
    expect(isExcludedPath(undefined).excluded).toBe(false);
    expect(isExcludedPath(null).excluded).toBe(false);
    expect(isExcludedPath("").excluded).toBe(false);
  });

  it("accepts caller-supplied fragments", () => {
    expect(isExcludedPath("/a/Secret/b", ["secret"]).excluded).toBe(true);
    expect(isExcludedPath("/a/Secret/b", ["other"]).excluded).toBe(false);
  });

  it("ships a non-empty default denylist", () => {
    expect(DEFAULT_EXCLUDED_PATH_FRAGMENTS.length).toBeGreaterThan(0);
  });
});

describe("redactOrThrow — fails closed", () => {
  it("returns a result on normal input", () => {
    expect(redactOrThrow("SSN 123-45-6789", TEST_PACK).totalRedacted).toBe(1);
  });

  it("throws ContentSafetyError rather than passing text through", () => {
    // A redactor that silently returns raw text on failure manufactures
    // confidence — the same class of failure as an unmonitored backup.
    expect(() => redactOrThrow(null as unknown as string, TEST_PACK)).toThrow(
      ContentSafetyError,
    );
  });

  it("refuses to redact against a pack that declares no scanners, naming the pack id", () => {
    // `LoadedPack` is an exported, structurally-constructible interface — a
    // pack with `scanners: []` would otherwise pass every guard (`scanText`
    // loops zero times, `findings` stays empty) and let raw identifiers
    // through on what looks like a healthy run.
    const emptyPack: LoadedPack = {
      id: "empty-pack",
      version: "1.0.0",
      scanners: [],
    };
    expect(() => redactOrThrow("SSN 123-45-6789", emptyPack)).toThrow(
      ContentSafetyError,
    );
    expect(() => redactOrThrow("SSN 123-45-6789", emptyPack)).toThrow(
      /empty-pack/,
    );
    expect(() => redactOrThrow("SSN 123-45-6789", emptyPack)).toThrow(
      /no scanners/,
    );
  });
});

describe("applyRedaction", () => {
  it("replaces every span without disturbing surrounding text", () => {
    const text = "a 111-11-1111 b 222-22-2222 c";
    const matches: ScanMatch[] = [
      {
        scannerId: "ssn",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 2,
        end: 13,
        maskedSample: "1XXXXXXXXX1",
      },
      {
        scannerId: "ssn",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 16,
        end: 27,
        maskedSample: "2XXXXXXXXX2",
      },
    ];
    expect(applyRedaction(text, matches, () => "[X]")).toBe("a [X] b [X] c");
  });

  it("ignores low-confidence matches", () => {
    const text = "a 111-11-1111 b";
    const matches: ScanMatch[] = [
      {
        scannerId: "ssn",
        kind: "identifying",
        disposition: "exclude",
        confidence: "low",
        start: 2,
        end: 13,
        maskedSample: "1XXXXXXXXX1",
      },
    ];
    expect(applyRedaction(text, matches, () => "[X]")).toBe(text);
  });

  it("merges two overlapping high matches into one masked span with no text loss (Ruling R9)", () => {
    // Confirmed defect before R9: replacing right-to-left WITHOUT merging
    // silently dropped the second match's mask token AND the trailing text
    // after it ("01[a]" instead of "01[a]01") because the earlier match's
    // stale `end` offset landed past the end of the already-shortened string.
    const text = "0123456789012345678901"; // 22 chars, indices 0..21
    const matches: ScanMatch[] = [
      {
        scannerId: "a",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 2,
        end: 13,
        maskedSample: "x",
      },
      {
        scannerId: "b",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 8,
        end: 20,
        maskedSample: "x",
      },
    ];
    // One merged span [2, 20), masked once with the EARLIEST (outermost,
    // smallest-start) contributing match's token — "a", not "b" — and the
    // untouched text on both sides ("01" ... "01") fully preserved.
    expect(applyRedaction(text, matches, (m) => `[${m.scannerId}]`)).toBe(
      "01[a]01",
    );
  });

  it("does NOT merge adjacent-but-not-overlapping matches (does not over-reach)", () => {
    const text = "abcdefghij";
    const matches: ScanMatch[] = [
      {
        scannerId: "m1",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 2,
        end: 5,
        maskedSample: "x",
      },
      {
        scannerId: "m2",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 5,
        end: 8,
        maskedSample: "x",
      },
    ];
    // Two separate mask tokens, not one merged span covering [2, 8).
    expect(applyRedaction(text, matches, (m) => `[${m.scannerId}]`)).toBe(
      "ab[m1][m2]ij",
    );
  });

  it("stays correct across several thousand disjoint matches (linear-rewrite regression)", () => {
    // Fix (MEDIUM, whole-branch review): the previous implementation rebuilt
    // the whole string via slice+concat once PER SPAN
    // (`out = out.slice(0, s) + mask + out.slice(e)`), which is
    // O(matches × textLength) — 1.6 MB with 60,000 matches measured at 6.9s
    // on one core, long enough to stall the worker's event loop and cause
    // pg-boss to reap the job as stalled. This does not re-time the rewrite
    // (a timing assertion would be flaky and slow the suite); it exercises
    // several thousand matches to prove the single left-to-right pass stays
    // byte-correct at a scale the old quadratic code would visibly struggle
    // with, without adding a slow benchmark to the suite.
    const N = 5000;
    const token = "1234567890"; // 10 chars, never overlapping/adjacent
    const textParts: string[] = [];
    const matches: ScanMatch[] = [];
    let cursor = 0;
    for (let i = 0; i < N; i++) {
      textParts.push(token);
      matches.push({
        scannerId: "x",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: cursor,
        end: cursor + token.length,
        maskedSample: "x",
      });
      cursor += token.length;
      if (i < N - 1) {
        textParts.push("|");
        cursor += 1;
      }
    }
    const text = textParts.join("");
    const result = applyRedaction(text, matches, () => "[X]");
    expect(result).toBe(Array(N).fill("[X]").join("|"));
  });
});

describe("parity with the generation-time TRI scanner", () => {
  // The two detectors in this package must not disagree about what counts as an
  // identifier. When the redactor was strictly weaker, the chain was: no
  // redaction -> not quarantined -> embedded and sent to the hosted model (the
  // §7216 disclosure) -> an audit event written documenting it -> generation
  // then refuses to answer from that document forever. Disclosed AND
  // unanswerable — the worst of both outcomes.
  //
  // These cases are exactly the ones verified to reach the embedding API.

  it.each([
    ["space-separated SSN", "Client SSN: 123 45 6789"],
    ["space-separated EIN", "Employer EIN 12 3456789"],
  ])(
    "redacts %s, matching the scanner's dash-or-space rule",
    (_label, text) => {
      const { findings } = redactText(text, TEST_PACK);
      expect(findings.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ["labelled bare SSN", "SSN 123456789"],
    ["labelled bare ITIN", "ITIN 912781234"],
    ["TIN with colon", "TIN: 123456789"],
    ["cross-line OCR label", "Social Security Number\n123456789"],
  ])("redacts %s, matching SSN-unformatted", (_label, text) => {
    const { findings } = redactText(text, TEST_PACK);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("still redacts the canonical dash forms (regression guard)", () => {
    expect(redactText("SSN 123-45-6789", TEST_PACK).findings.length).toBe(1);
    expect(redactText("EIN 12-3456789", TEST_PACK).findings.length).toBe(1);
  });
});

describe("tabular identifier columns", () => {
  // The corpus screen's worst document held 522 SSN-shaped values in a
  // spreadsheet. Parsed to markdown a row looks like
  //   | Smith, John | 123456789 | 45,200 |
  // with the "SSN" header rows away, so an adjacent-label rule cannot see it
  // and the ABA/routing gate does not fire. It was caught by nothing.
  //
  // The signal that separates a roster from an SOP is DENSITY: a roster has
  // many bare 9-digit runs, a procedure document has none or one incidental
  // form number. Gating on vocabulary AND repetition targets the roster shape
  // without redacting the SOPs the assistant exists to answer from.

  const roster = [
    "| Client | SSN | YTD |",
    "| --- | --- | --- |",
    "| Smith, John | 123456789 | 45,200 |",
    "| Doe, Jane | 987654321 | 51,000 |",
    "| Roe, Sam | 456789123 | 38,750 |",
  ].join("\n");

  it("redacts a column of bare 9-digit identifiers", () => {
    const { totalRedacted, text } = redactText(roster, TEST_PACK);
    // `findings` is one entry PER KIND, so assert the occurrence count.
    expect(totalRedacted).toBeGreaterThanOrEqual(3);
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("987654321");
  });

  it("leaves an ordinary SOP alone when it has one incidental 9-digit number", () => {
    // The false positive that matters: over-redaction turns a procedure into
    // unusable prose, which is the failure that looks like success.
    const sop =
      "Review the prior-year return before filing. Reference document " +
      "100200300 in the engagement folder. Confirm the client signed Form 8879.";
    expect(redactText(sop, TEST_PACK).findings.length).toBe(0);
  });

  it("does not fire on repeated 9-digit runs with no identifier vocabulary", () => {
    const invoices = [
      "| Invoice | Ref | Total |",
      "| A | 100200300 | 10 |",
      "| B | 100200301 | 20 |",
      "| C | 100200302 | 30 |",
    ].join("\n");
    expect(redactText(invoices, TEST_PACK).findings.length).toBe(0);
  });
});

describe("scanForClientContextOrThrow — fails closed", () => {
  // Layer 1.5: semantic detection of client-identifying context that pattern
  // redaction structurally cannot see (a name in prose, not a formatted SSN).
  // Same fail-closed contract as redactOrThrow: no scanner, or a scanner that
  // throws, must quarantine the document rather than let it through unchecked.
  const cleanScanner: ContentScanner = {
    name: "fake-clean",
    scan: async () => ({ flagged: false, findings: [] }),
  };
  const flaggingScanner: ContentScanner = {
    name: "fake-flagging",
    scan: async () => ({
      flagged: true,
      findings: ["possible client name: John Smith"],
    }),
  };
  const throwingScanner: ContentScanner = {
    name: "fake-throwing",
    scan: async () => {
      throw new Error("model unreachable");
    },
  };

  it("returns a clean result when the scanner reports nothing", async () => {
    const result = await scanForClientContextOrThrow(
      "Standard filing checklist, no client mentioned.",
      cleanScanner,
    );
    expect(result.flagged).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("returns the scanner's findings when it flags content", async () => {
    const result = await scanForClientContextOrThrow(
      "Please see the attached letter for John Smith.",
      flaggingScanner,
    );
    expect(result.flagged).toBe(true);
    expect(result.findings).toContain("possible client name: John Smith");
  });

  it("throws ContentSafetyError when no scanner is configured, rather than skipping the check", async () => {
    // A document ingested with this layer silently skipped would be
    // indistinguishable in the index from one the layer actually cleared.
    await expect(
      scanForClientContextOrThrow("some text", undefined),
    ).rejects.toThrow(ContentSafetyError);
    await expect(
      scanForClientContextOrThrow("some text", undefined),
    ).rejects.toThrow(/no content scanner configured/);
  });

  it("throws ContentSafetyError when the scanner itself throws", async () => {
    await expect(
      scanForClientContextOrThrow("some text", throwingScanner),
    ).rejects.toThrow(ContentSafetyError);
  });
});
