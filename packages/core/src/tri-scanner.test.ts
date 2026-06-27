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

  it("does not false-positive on a phone number without SSN dashes", () => {
    // Phone numbers lack the SSN dash pattern
    const result = scanForTRI("Call us at (800) 555-1234 for assistance.");
    expect(result.patterns).not.toContain("SSN");
  });

  // ── EIN ───────────────────────────────────────────────────────────────────────

  it("detects a US EIN (##-#######)", () => {
    const result = scanForTRI("Employer ID: 12-3456789");
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
