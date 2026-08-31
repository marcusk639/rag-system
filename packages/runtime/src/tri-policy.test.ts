import { describe, expect, it } from "vitest";
import { resolveTriPolicy } from "./index.js";

/**
 * The `client-data` override is the control that five separate doc comments in
 * this codebase discharge their safety argument onto — including the decision
 * to let `triPolicy=off` disable the SSN/EIN guard at all. It had no test.
 *
 * It is a pure decision, so it is tested as one: `buildCoreDeps` around it
 * wires a Postgres pool and a pg-boss queue, and mocking those to reach one
 * ternary would test the mocks.
 */
describe("resolveTriPolicy", () => {
  it("forces block under client-data, overriding a permissive setting", () => {
    // The whole point: a deployment that has declared real client data in scope
    // must not inherit the internal-corpus leniency by omission OR by explicit
    // misconfiguration.
    expect(resolveTriPolicy("client-data", "warn")).toBe("block");
  });

  it("forces block under client-data even when TRI scanning was turned off", () => {
    // `off` skips the scan entirely, which disables the SSN/EIN identifying
    // guard too. That is the most dangerous setting to inherit silently.
    expect(resolveTriPolicy("client-data", "off")).toBe("block");
  });

  it("forces block under client-data when nothing is configured", () => {
    expect(resolveTriPolicy("client-data", undefined)).toBe("block");
  });

  it("leaves an explicit policy alone outside client-data", () => {
    expect(resolveTriPolicy("none", "warn")).toBe("warn");
    expect(resolveTriPolicy("none", "off")).toBe("off");
    expect(resolveTriPolicy("none", "block")).toBe("block");
  });

  it("defaults to block outside client-data when nothing is configured", () => {
    // Matches the zod default in @rag/core and the generators' own fallback.
    // All three have to agree, or the effective default depends on which
    // construction path a caller happens to take.
    expect(resolveTriPolicy("none", undefined)).toBe("block");
    expect(resolveTriPolicy(undefined, undefined)).toBe("block");
  });

  // Fail-safe direction. An unrecognised compliance mode must not be treated as
  // client-data (that would break every ordinary deployment), but it also must
  // not silently unlock anything — it simply is not the override.
  it("treats an unknown compliance mode as not-client-data", () => {
    expect(resolveTriPolicy("something-else", "warn")).toBe("warn");
  });
});
