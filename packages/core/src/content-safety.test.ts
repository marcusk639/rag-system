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
} from "./content-safety.js";
import type { ScanMatch } from "./pack/scan.js";
import { loadPack } from "./pack/load.js";

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
});

describe("applyRedaction", () => {
  it("replaces right-to-left so earlier offsets stay valid", () => {
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
});
