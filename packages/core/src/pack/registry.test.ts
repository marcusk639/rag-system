import { describe, it, expect } from "vitest";
import {
  resolveValidator,
  resolveContext,
  VALIDATOR_NAMES,
  CONTEXT_NAMES,
} from "./registry.js";

describe("registry", () => {
  it("resolves luhn and accepts a valid card number", () => {
    expect(resolveValidator("luhn")("4111111111111111")).toBe(true);
  });

  it("luhn rejects a number one digit off", () => {
    expect(resolveValidator("luhn")("4111111111111112")).toBe(false);
  });

  it("resolves aba and accepts a valid routing number", () => {
    expect(resolveValidator("aba")("011000015")).toBe(true);
  });

  it("aba rejects a 9-digit run that fails the checksum", () => {
    expect(resolveValidator("aba")("123456789")).toBe(false);
  });

  it("resolves account-vocab and matches nearby banking words", () => {
    expect(resolveContext("account-vocab").test("routing number follows")).toBe(
      true,
    );
    expect(resolveContext("account-vocab").test("invoice total follows")).toBe(
      false,
    );
  });

  it("throws on an unknown validator name rather than defaulting", () => {
    expect(() => resolveValidator("nope")).toThrow(/unknown validator "nope"/);
  });

  it("throws on an unknown context name rather than defaulting", () => {
    expect(() => resolveContext("nope")).toThrow(/unknown context "nope"/);
  });

  it("exposes its registered names for pack validation", () => {
    expect(VALIDATOR_NAMES).toContain("luhn");
    expect(CONTEXT_NAMES).toContain("account-vocab");
  });
});
