import { describe, expect, it } from "vitest";
import {
  InternalScopeAuthProvider,
  signInternalScopeToken,
} from "./internal-scope-auth.js";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256";
const OTHER_SECRET = "a-different-rotation-secret-also-long-enough";

describe("signInternalScopeToken / InternalScopeAuthProvider", () => {
  it("round-trips a valid token to a scoped principal carrying the verified subject", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-1", allowedSourceIds: ["src-a", "src-b"] },
      SECRET,
    );
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(token)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["src-a", "src-b"],
      subject: "aad-oid-1",
    });
  });

  it("round-trips an empty allowedSourceIds to deny-all scoped principal, subject still populated", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-2", allowedSourceIds: [] },
      SECRET,
    );
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(token)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: [],
      subject: "aad-oid-2",
    });
  });

  it("returns null for an expired token (fail closed, no throw)", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-3", allowedSourceIds: ["src-a"] },
      SECRET,
    );
    // Sign again with a manually-expired custom token to avoid a real sleep:
    // reuse jose directly to control `exp`.
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({ allowedSourceIds: ["src-a"] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("aad-oid-3")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(expired)).resolves.toBeNull();
    void token; // silence unused-var (kept for readability of the "valid" shape above)
  });

  it("returns null for a tampered signature", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-4", allowedSourceIds: ["src-a"] },
      SECRET,
    );
    const tampered = token.slice(0, -4) + "abcd";
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(tampered)).resolves.toBeNull();
  });

  it("returns null for a token signed with a different algorithm's header forged onto an unsigned payload", async () => {
    // "alg: none" attack: a crafted token with no signature at all.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "attacker", allowedSourceIds: ["src-a"] }),
    ).toString("base64url");
    const forged = `${header}.${payload}.`;
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(forged)).resolves.toBeNull();
  });

  it("verifies against any configured secret (rotation support)", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-5", allowedSourceIds: ["src-c"] },
      OTHER_SECRET,
    );
    const provider = new InternalScopeAuthProvider([SECRET, OTHER_SECRET]);
    await expect(provider.authenticate(token)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["src-c"],
      subject: "aad-oid-5",
    });
  });

  it("returns null for a malformed payload shape (allowedSourceIds not a string array)", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const bad = await new SignJWT({ allowedSourceIds: "not-an-array" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("aad-oid-6")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key);
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(bad)).resolves.toBeNull();
  });

  it("omits `subject` entirely (not undefined-valued) when the token has no `sub` claim", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const noSub = await new SignJWT({ allowedSourceIds: ["src-a"] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key);
    const provider = new InternalScopeAuthProvider([SECRET]);
    const principal = await provider.authenticate(noSub);
    expect(principal).toEqual({ kind: "scoped", allowedSourceIds: ["src-a"] });
    expect(principal && "subject" in principal).toBe(false);
  });

  it("throws at construction with no secrets (fail loud on misconfig)", () => {
    expect(() => new InternalScopeAuthProvider([])).toThrow(
      /at least one secret/,
    );
  });
});
