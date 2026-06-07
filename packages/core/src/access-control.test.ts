import { describe, expect, it } from "vitest";
import {
  ADMIN_SCOPE,
  computeEnforcedSourceIds,
  effectiveSourceFilter,
  parsePrincipalsConfig,
  principalToScope,
  resolvePrincipal,
  type Principal,
} from "./access-control.js";

describe("parsePrincipalsConfig", () => {
  it("returns an empty list for undefined / empty input", () => {
    expect(parsePrincipalsConfig(undefined)).toEqual([]);
    expect(parsePrincipalsConfig("")).toEqual([]);
    expect(parsePrincipalsConfig("   ")).toEqual([]);
  });

  it("parses a JSON array of scoped principals", () => {
    const json = JSON.stringify([
      { token: "tok-staff-a", allowedSourceIds: ["s1", "s2"] },
      { token: "tok-staff-b", allowedSourceIds: [] },
    ]);
    expect(parsePrincipalsConfig(json)).toEqual([
      { token: "tok-staff-a", allowedSourceIds: ["s1", "s2"] },
      { token: "tok-staff-b", allowedSourceIds: [] },
    ]);
  });

  it("rejects malformed JSON loudly (fail fast at startup)", () => {
    expect(() => parsePrincipalsConfig("{not json")).toThrow(/API_PRINCIPALS/);
  });

  it("rejects entries missing token or allowedSourceIds", () => {
    expect(() =>
      parsePrincipalsConfig(JSON.stringify([{ token: "x" }])),
    ).toThrow(/API_PRINCIPALS/);
    expect(() =>
      parsePrincipalsConfig(JSON.stringify([{ allowedSourceIds: ["s1"] }])),
    ).toThrow(/API_PRINCIPALS/);
  });

  it("rejects a non-array top level", () => {
    expect(() =>
      parsePrincipalsConfig(
        JSON.stringify({ token: "x", allowedSourceIds: [] }),
      ),
    ).toThrow(/API_PRINCIPALS/);
  });
});

describe("resolvePrincipal", () => {
  const scoped = [
    { token: "tok-staff-a", allowedSourceIds: ["s1", "s2"] },
    { token: "tok-empty", allowedSourceIds: [] },
  ];
  const adminTokens = ["tok-admin"];

  it("maps a plain (unscoped) admin token to an admin principal", () => {
    const p = resolvePrincipal("tok-admin", adminTokens, scoped);
    expect(p).toEqual({ kind: "admin" });
  });

  it("maps a scoped token to a scoped principal with its source ids", () => {
    const p = resolvePrincipal("tok-staff-a", adminTokens, scoped);
    expect(p).toEqual({ kind: "scoped", allowedSourceIds: ["s1", "s2"] });
  });

  it("maps a scoped token with an empty allow-list to an empty scoped principal", () => {
    const p = resolvePrincipal("tok-empty", adminTokens, scoped);
    expect(p).toEqual({ kind: "scoped", allowedSourceIds: [] });
  });

  it("returns null for an unknown token (caller treats as 401)", () => {
    expect(resolvePrincipal("nope", adminTokens, scoped)).toBeNull();
  });

  it("prefers the scoped mapping when a token appears in BOTH lists (least privilege)", () => {
    const p = resolvePrincipal(
      "dual",
      ["dual"],
      [{ token: "dual", allowedSourceIds: ["s9"] }],
    );
    expect(p).toEqual({ kind: "scoped", allowedSourceIds: ["s9"] });
  });
});

describe("computeEnforcedSourceIds / principalToScope", () => {
  it("admin principal => null (unrestricted)", () => {
    expect(computeEnforcedSourceIds({ kind: "admin" })).toBeNull();
    expect(principalToScope({ kind: "admin" })).toEqual({
      enforcedSourceIds: null,
    });
  });

  it("scoped principal => its source ids", () => {
    const p: Principal = { kind: "scoped", allowedSourceIds: ["s1", "s2"] };
    expect(computeEnforcedSourceIds(p)).toEqual(["s1", "s2"]);
    expect(principalToScope(p)).toEqual({ enforcedSourceIds: ["s1", "s2"] });
  });

  it("empty scoped principal => empty array (fail closed, NOT null)", () => {
    const p: Principal = { kind: "scoped", allowedSourceIds: [] };
    expect(computeEnforcedSourceIds(p)).toEqual([]);
    expect(principalToScope(p)).toEqual({ enforcedSourceIds: [] });
  });

  it("ADMIN_SCOPE is the unrestricted scope", () => {
    expect(ADMIN_SCOPE).toEqual({ enforcedSourceIds: null });
  });
});

describe("effectiveSourceFilter (caller filter ∩ enforced set)", () => {
  it("admin (null enforced) + no caller filter => no restriction (null)", () => {
    expect(effectiveSourceFilter(undefined, null)).toBeNull();
  });

  it("admin (null enforced) + caller filter => the caller filter passes through", () => {
    expect(effectiveSourceFilter(["s1", "s2"], null)).toEqual(["s1", "s2"]);
  });

  it("scoped, no caller filter => the enforced set", () => {
    expect(effectiveSourceFilter(undefined, ["s1", "s2"])).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("scoped + caller filter => intersection (caller narrows within scope)", () => {
    expect(effectiveSourceFilter(["s2", "s3"], ["s1", "s2"])).toEqual(["s2"]);
  });

  it("caller filter disjoint from enforced set => empty (fail closed, zero rows)", () => {
    expect(effectiveSourceFilter(["s9"], ["s1", "s2"])).toEqual([]);
  });

  it("empty enforced set => empty regardless of caller filter (fail closed)", () => {
    expect(effectiveSourceFilter(undefined, [])).toEqual([]);
    expect(effectiveSourceFilter(["s1"], [])).toEqual([]);
  });

  it("does not let a caller widen beyond the enforced set", () => {
    // caller asks for s1+s2+s3, but only s1 is in scope
    expect(effectiveSourceFilter(["s1", "s2", "s3"], ["s1"])).toEqual(["s1"]);
  });
});
