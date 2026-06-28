import { describe, expect, it } from "vitest";
import { scanForTRI } from "./tri-scanner.js";

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
    const result = scanForTRI("1099-NEC shows non-employee compensation of $18,500.");
    expect(result.detected).toBe(true);
    expect(result.patterns).toContain("1099+amount");
  });

  it("detects 1099-MISC with a dollar amount", () => {
    const result = scanForTRI("The client received a 1099-MISC for $3,200 in rents.");
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
    const result = scanForTRI("Please complete Schedule C for your business income.");
    expect(result.patterns).not.toContain("schedule+amount");
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
