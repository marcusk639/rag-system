import { describe, expect, it } from "vitest";
import type { Principal } from "./access-control.js";
import {
  CompositeAuthProvider,
  StaticTokenAuthProvider,
  createTokenVerifier,
  type AuthProvider,
} from "./auth.js";

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

describe("StaticTokenAuthProvider", () => {
  it("resolves a plain admin token to an admin principal", async () => {
    const provider = new StaticTokenAuthProvider(["admin-tok"], []);
    await expect(provider.authenticate("admin-tok")).resolves.toEqual({
      kind: "admin",
    });
  });

  it("resolves a scoped token to its scoped principal", async () => {
    const provider = new StaticTokenAuthProvider(
      [],
      [{ token: "scoped-tok", allowedSourceIds: ["src-a", "src-b"] }],
    );
    await expect(provider.authenticate("scoped-tok")).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["src-a", "src-b"],
    });
  });

  it("prefers scoped over admin when a token is in both (least privilege)", async () => {
    const provider = new StaticTokenAuthProvider(
      ["dual-tok"],
      [{ token: "dual-tok", allowedSourceIds: ["only-this"] }],
    );
    await expect(provider.authenticate("dual-tok")).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["only-this"],
    });
  });

  it("returns null for an unknown token (fail closed)", async () => {
    const provider = new StaticTokenAuthProvider(["admin-tok"], []);
    await expect(provider.authenticate("nope")).resolves.toBeNull();
    await expect(provider.authenticate("")).resolves.toBeNull();
  });

  it("fails loud at construction with no tokens and no principals", () => {
    expect(() => new StaticTokenAuthProvider([], [])).toThrow(
      /at least one token/,
    );
  });
});

describe("CompositeAuthProvider", () => {
  const admin: Principal = { kind: "admin" };
  const scoped: Principal = { kind: "scoped", allowedSourceIds: ["x"] };
  const ok = (p: Principal): AuthProvider => ({
    authenticate: () => Promise.resolve(p),
  });
  const reject: AuthProvider = { authenticate: () => Promise.resolve(null) };
  const thrower: AuthProvider = {
    authenticate: () => Promise.reject(new Error("boom")),
  };

  it("returns the first non-null principal (first provider wins)", async () => {
    const composite = new CompositeAuthProvider([ok(admin), ok(scoped)]);
    await expect(composite.authenticate("c")).resolves.toEqual(admin);
  });

  it("falls through to the second provider when the first rejects", async () => {
    const composite = new CompositeAuthProvider([reject, ok(scoped)]);
    await expect(composite.authenticate("c")).resolves.toEqual(scoped);
  });

  it("isolates a throwing provider and still tries the next", async () => {
    const errors: unknown[] = [];
    const composite = new CompositeAuthProvider([thrower, ok(scoped)], (err) =>
      errors.push(err),
    );
    await expect(composite.authenticate("c")).resolves.toEqual(scoped);
    expect(errors).toHaveLength(1);
  });

  it("a throwing provider does not block an earlier valid one", async () => {
    // Order matters: a valid static token before a malformed-JWT provider.
    const composite = new CompositeAuthProvider([ok(admin), thrower]);
    await expect(composite.authenticate("c")).resolves.toEqual(admin);
  });

  it("returns null when every provider yields null", async () => {
    const composite = new CompositeAuthProvider([reject, reject]);
    await expect(composite.authenticate("c")).resolves.toBeNull();
  });
});
