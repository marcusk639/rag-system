import { describe, it, expect } from "vitest";
import {
  resolveValidator,
  resolveContext,
  assertStatelessContextRegex,
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

  it("rejects a context regex carrying the g or y flag", () => {
    // A shared, module-level context regex with `g`/`y` would advance `lastIndex`
    // across `.test()` calls from unrelated scanners — a silent, order-dependent
    // demotion bug. This must never reach the engine.
    expect(() => assertStatelessContextRegex(/foo/g, 'context "x"')).toThrow(
      /must not use the "g" or "y" flag/,
    );
    expect(() => assertStatelessContextRegex(/foo/y, 'context "x"')).toThrow(
      /must not use the "g" or "y" flag/,
    );
  });

  it("accepts a context regex without g or y", () => {
    expect(() =>
      assertStatelessContextRegex(/foo/i, 'context "x"'),
    ).not.toThrow();
  });

  it("resolveContext never returns a g/y-flagged regex for a registered name", () => {
    // account-vocab is the only registered context today; this guards that it
    // (and any future addition) stays stateless as resolved through the public API.
    expect(resolveContext("account-vocab").flags).not.toMatch(/[gy]/);
  });
});
