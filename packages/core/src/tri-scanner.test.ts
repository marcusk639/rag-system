import { describe, expect, it } from "vitest";
import {
  TRI_IDENTIFYING_LABELS,
  TRI_PATTERN_LABELS,
  identifyingTRIPatterns,
  scanForTRI,
} from "./tri-scanner.js";

describe("scanForTRI", () => {
  // ── Clean text ────────────────────────────────────────────────────────────────

  it("returns detected=false for clean firm SOP text", () => {
    const result = scanForTRI(
      "Please review the depreciation schedule attached to the engagement letter. " +
        "The client has elected Section 179 expensing for qualifying assets.",
    );
    expect(result.detected).toBe(false);
    expect(result.patterns).toEqual([]);
  });

  it("returns detected=false for empty string", () => {
    expect(scanForTRI("").detected).toBe(false);
  });

  // ── SSN ───────────────────────────────────────────────────────────────────────

  it("detects a US SSN (###-##-####)", () => {
    const result = scanForTRI("Social security number: 123-45-6789");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("SSN");
  });

  it("detects a space-separated SSN (### ## ####)", () => {
    const result = scanForTRI("SSN: 123 45 6789 on file.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("SSN");
  });

  it("does not false-positive on a phone number without SSN dashes", () => {
    // Phone numbers lack the SSN digit-group pattern
    const result = scanForTRI("Call us at (800) 555-1234 for assistance.");
    expect(result.patterns).not.toContain("SSN");
  });

  // ── EIN ───────────────────────────────────────────────────────────────────────

  it("detects a US EIN (##-#######)", () => {
    const result = scanForTRI("Employer ID: 12-3456789");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("EIN");
  });

  it("detects a space-separated EIN (## #######)", () => {
    const result = scanForTRI("EIN 12 3456789 per IRS records.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("EIN");
  });

  // ── taxpayer + amount ─────────────────────────────────────────────────────────

  it("detects 'taxpayer' followed by a dollar amount", () => {
    const result = scanForTRI("The taxpayer owes $4,200 in penalties.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("taxpayer+amount");
  });

  it("does not flag 'taxpayer' without a nearby dollar amount", () => {
    const result = scanForTRI("The taxpayer filed an extension request.");
    expect(result.patterns).not.toContain("taxpayer+amount");
  });

  // ── Tax form + amount ─────────────────────────────────────────────────────────

  it("detects Form 1040 with a dollar amount", () => {
    const result = scanForTRI(
      "Form 1040 line 15 shows $85,000 in taxable income.",
    );
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("tax-form+amount");
  });

  it("detects Form 1065 (partnership return)", () => {
    const result = scanForTRI(
      "The partnership filed Form 1065 reporting $120,000.",
    );
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("tax-form+amount");
  });

  it("detects Form 1120 (corporate return)", () => {
    const result = scanForTRI("Form 1120 shows net income of $500,000.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("tax-form+amount");
  });

  it("detects Form 1041 (fiduciary return)", () => {
    const result = scanForTRI(
      "The estate filed Form 1041 with $30,000 distributable income.",
    );
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("tax-form+amount");
  });

  it("does not flag a form reference without a dollar amount", () => {
    const result = scanForTRI(
      "Please attach Form 1040 to your extension request.",
    );
    expect(result.patterns).not.toContain("tax-form+amount");
  });

  // ── Newline-spanning contextual patterns (finding 2 regression) ──────────────

  it("detects taxpayer+amount when the amount is on the next line", () => {
    // The 's' (dotAll) flag is required; without it '.' stops at '\n'.
    const result = scanForTRI("The taxpayer\nowes $4,200 in penalties.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("taxpayer+amount");
  });

  it("detects tax-form+amount when the amount is on the next line", () => {
    const result = scanForTRI("Form 1040\nline 15: $85,000 taxable income.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("tax-form+amount");
  });

  // ── 1099 series ───────────────────────────────────────────────────────────────

  it("detects 1099-NEC with a dollar amount", () => {
    const result = scanForTRI(
      "1099-NEC shows non-employee compensation of $18,500.",
    );
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("1099+amount");
  });

  it("detects 1099-MISC with a dollar amount", () => {
    const result = scanForTRI(
      "The client received a 1099-MISC for $3,200 in rents.",
    );
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("1099+amount");
  });

  it("does not flag a bare 1099 reference without an amount", () => {
    const result = scanForTRI("Please attach your 1099-NEC from the payer.");
    expect(result.patterns).not.toContain("1099+amount");
  });

  // ── W-2 / W2 ─────────────────────────────────────────────────────────────────

  it("detects W-2 with a dollar amount", () => {
    const result = scanForTRI("W-2 wages reported: $72,000.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("W2+amount");
  });

  it("detects W2 (no hyphen) with a dollar amount", () => {
    const result = scanForTRI("The W2 shows federal withholding of $14,400.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("W2+amount");
  });

  it("does not flag a W-2 reference without a nearby dollar amount", () => {
    const result = scanForTRI("Please provide your W-2 from your employer.");
    expect(result.patterns).not.toContain("W2+amount");
  });

  // ── IRS Schedules ─────────────────────────────────────────────────────────────

  it("detects Schedule C with a dollar amount", () => {
    const result = scanForTRI("Schedule C reports net profit of $42,000.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("schedule+amount");
  });

  it("detects Schedule SE with a dollar amount", () => {
    const result = scanForTRI("Sch SE self-employment tax: $5,936.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("schedule+amount");
  });

  it("detects abbreviated Sch. D with a dollar amount", () => {
    const result = scanForTRI("Sch. D shows long-term gain of $15,000.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("schedule+amount");
  });

  it("does not flag a Schedule reference without a nearby dollar amount", () => {
    const result = scanForTRI(
      "Please complete Schedule C for your business income.",
    );
    expect(result.patterns).not.toContain("schedule+amount");
  });

  // ── Separator-variant bypass hardening ────────────────────────────────────────

  it("detects 1099 with space-hyphen-space separator (1099 - MISC)", () => {
    const result = scanForTRI("1099 - MISC payment of $3,200.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("1099+amount");
  });

  it("detects 1099 with double-space separator (1099  NEC)", () => {
    const result = scanForTRI("1099  NEC non-employee compensation: $18,500.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("1099+amount");
  });

  it("detects 1099 with en-dash separator (1099–MISC, OCR/PDF variant)", () => {
    const result = scanForTRI("1099–MISC shows $3,200 in rents.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("1099+amount");
  });

  it("detects 1099 with em-dash separator (1099—NEC, OCR/PDF variant)", () => {
    const result = scanForTRI("1099—NEC non-employee compensation: $18,500.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("1099+amount");
  });

  it("detects W-2 with en-dash separator (W – 2)", () => {
    const result = scanForTRI("W – 2 wages reported: $72,000.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("W2+amount");
  });

  it("detects W-2 with space-hyphen-space separator (W - 2)", () => {
    const result = scanForTRI("W - 2 shows federal withholding of $14,400.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("W2+amount");
  });

  it("detects Schedule with hyphen separator (Schedule-C)", () => {
    const result = scanForTRI("Schedule-C net profit: $42,000.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("schedule+amount");
  });

  // ── Multiple patterns ─────────────────────────────────────────────────────────

  it("reports all matched patterns when multiple are present", () => {
    const result = scanForTRI(
      "SSN 123-45-6789; taxpayer owes $1,000; Form 1040 line 15: $80,000.",
    );
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("SSN");
    expect(result.patterns).toContain("taxpayer+amount");
    expect(result.patterns).toContain("tax-form+amount");
  });
});

describe("identifyingTRIPatterns", () => {
  // Why this split exists: a screen of the TWK corpus (858 documents) flagged
  // 41% of it, but the classes are not alike. `tax-form+amount` matched 316
  // documents and its hits are what a procedure explaining how to review a
  // return looks like. `SSN`/`EIN` matched 24, one of which held 260 distinct
  // SSN-shaped values — a client roster, not a placeholder. A single policy
  // knob governing both is what let a permissive default cover the second case.

  it("selects the identifying labels out of a mixed scan result", () => {
    const { patterns } = scanForTRI(
      "SSN 123-45-6789; taxpayer owes $1,000; Form 1040 line 15: $80,000.",
    );

    expect(identifyingTRIPatterns(patterns)).toEqual(["SSN"]);
  });

  it("returns empty for a contextual-only result", () => {
    const { patterns } = scanForTRI(
      "Confirm the Form 1040 refund does not exceed $25,000 before release.",
    );

    expect(patterns.length).toBeGreaterThan(0);
    expect(identifyingTRIPatterns(patterns)).toEqual([]);
  });

  it("selects EIN as identifying", () => {
    const { patterns } = scanForTRI("Employer ID 12-3456789 on file.");

    expect(identifyingTRIPatterns(patterns)).toEqual(["EIN"]);
  });

  it("returns empty for an empty input", () => {
    expect(identifyingTRIPatterns([])).toEqual([]);
  });

  // Drift guard. The split is a list of label STRINGS matched against what the
  // scanner emits, so renaming a pattern's label would silently downgrade an
  // identifying pattern to contextual — the exact failure this exists to
  // prevent, and one no other test would catch.
  it("every identifying label corresponds to a real scanner pattern", () => {
    for (const label of TRI_IDENTIFYING_LABELS) {
      expect(TRI_PATTERN_LABELS).toContain(label);
    }
  });
});

describe("unformatted tax identifiers", () => {
  // Regression guard for the gap the identifying/contextual split opened.
  //
  // The `SSN` pattern matches only FORMATTED identifiers, and its comment used
  // to justify that narrowness by saying unformatted 9-digit strings "are
  // caught by taxpayer+amount and tax-form+amount". Once those two moved to the
  // contextual class — which `triPolicy = "warn"` does not block (the
  // default has since moved to `block`, but `warn` remains available) —
  // that backstop was gone: an OCR'd return carrying `SSN 123456789` scanned as
  // contextual-only and was disclosed to a third-party model.
  //
  // The pattern added to close it is context-gated on purpose. A bare 9-digit
  // run overlaps account numbers, phone digits, and zip+4, which is the
  // false-positive problem the original comment worried about; requiring an
  // adjacent SSN/TIN/ITIN token keeps the identifying class precise enough that
  // "blocks regardless of policy" stays a defensible rule.

  it("treats a labelled unformatted SSN as identifying", () => {
    const { detected, patterns } = scanForTRI("SSN 123456789");

    expect(detected).toBe(true);
    expect(patterns).toContain("SSN-unformatted");
    expect(identifyingTRIPatterns(patterns)).toContain("SSN-unformatted");
  });

  it.each([
    ["social security", "Social Security Number: 123456789"],
    ["TIN", "TIN 123456789 on file"],
    ["ITIN", "ITIN: 912345678"],
    ["cross-line OCR output", "SSN\n123456789"],
  ])("matches the %s form", (_label, text) => {
    expect(identifyingTRIPatterns(scanForTRI(text).patterns)).toContain(
      "SSN-unformatted",
    );
  });

  // The OCR'd-1040 scenario end to end: before the fix this scanned as
  // contextual-only, so a "warn" policy let the whole chunk through.
  it("blocks an OCR'd return that carries no formatted identifier", () => {
    const chunk = "SSN 123456789\nForm 1040 line 15: $80,000";
    const { patterns } = scanForTRI(chunk);

    expect(patterns).not.toContain("SSN");
    expect(identifyingTRIPatterns(patterns).length).toBeGreaterThan(0);
  });

  it("does not fire on a bare 9-digit run with no identifier context", () => {
    const { patterns } = scanForTRI("Account 123456789 was reconciled.");

    expect(patterns).not.toContain("SSN-unformatted");
  });

  it("does not fire on an SOP that names the field without a value", () => {
    const { patterns } = scanForTRI(
      "Enter the client's SSN in the engagement record before filing.",
    );

    expect(patterns).not.toContain("SSN-unformatted");
  });
});
