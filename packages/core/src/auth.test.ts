import { describe, expect, it } from "vitest";
import { createTokenVerifier } from "./auth.js";

describe("createTokenVerifier", () => {
  it("accepts a configured token", () => {
    const verify = createTokenVerifier(["alpha", "bravo"]);
    expect(verify("alpha")).toBe(true);
    expect(verify("bravo")).toBe(true);
  });

  it("rejects an unknown token", () => {
    const verify = createTokenVerifier(["alpha"]);
    expect(verify("charlie")).toBe(false);
  });

  it("rejects the empty string and near-misses", () => {
    const verify = createTokenVerifier(["secret-token"]);
    expect(verify("")).toBe(false);
    expect(verify("secret-toke")).toBe(false);
    expect(verify("secret-token ")).toBe(false);
  });

  it("throws at construction when no tokens are configured", () => {
    // A reject-everything verifier would lock callers out silently; the factory
    // fails loud instead so a misconfig surfaces at startup.
    expect(() => createTokenVerifier([])).toThrow(/at least one token/);
  });
});
