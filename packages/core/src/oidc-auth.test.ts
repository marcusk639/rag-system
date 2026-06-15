import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  OidcAuthProvider,
  resolveOidcPrincipal,
  type OidcConfig,
} from "./oidc-auth.js";

const ISSUER = "https://idp.example.com/";
const AUDIENCE = "api-client-id";

// A local key set injected as the JWTVerifyGetKey so tests never touch a remote
// JWKS endpoint. The keypair signs the tokens; the resolver hands jose the
// matching public key for verification.
// Derive the key type from jose itself rather than relying on a DOM/Node
// `CryptoKey` global (not in this package's tsconfig lib).
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let privateKey: KeyPair["privateKey"];
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  // The resolver ignores the protected header and always returns our one key —
  // sufficient for a single-key test set.
  getKey = (() => Promise.resolve(pair.publicKey)) as JWTVerifyGetKey;
});

async function mint(
  claims: Record<string, unknown>,
  overrides: { issuer?: string; audience?: string; expSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (overrides.expSeconds ?? 3600);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now)
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime(exp)
    .sign(privateKey);
}

const baseConfig: OidcConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  claim: "groups",
  scopeMap: [
    { claim: "group-tax", allowedSourceIds: ["src-tax"] },
    { claim: "group-audit", allowedSourceIds: ["src-audit", "src-shared"] },
  ],
  adminClaims: ["group-admins"],
};

describe("OidcAuthProvider.authenticate", () => {
  it("maps a token's group claim to the union of allowed source ids", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    const jwt = await mint({ groups: ["group-tax", "group-audit"] });
    await expect(provider.authenticate(jwt)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: expect.arrayContaining([
        "src-tax",
        "src-audit",
        "src-shared",
      ]),
    });
  });

  it("accepts a single-string claim value (not just arrays)", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    const jwt = await mint({ groups: "group-tax" });
    await expect(provider.authenticate(jwt)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["src-tax"],
    });
  });

  it("resolves admin when an admin claim is present", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    const jwt = await mint({ groups: ["group-tax", "group-admins"] });
    await expect(provider.authenticate(jwt)).resolves.toEqual({
      kind: "admin",
    });
  });

  it("returns scoped-empty (fail closed) for unmapped/missing claims", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    const unmapped = await mint({ groups: ["unknown-group"] });
    await expect(provider.authenticate(unmapped)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: [],
    });
    const missing = await mint({ sub: "u1" });
    await expect(provider.authenticate(missing)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: [],
    });
  });

  it("returns null for an expired token", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    const jwt = await mint({ groups: ["group-tax"] }, { expSeconds: -10 });
    await expect(provider.authenticate(jwt)).resolves.toBeNull();
  });

  it("returns null for the wrong audience", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    const jwt = await mint(
      { groups: ["group-tax"] },
      { audience: "some-other-client" },
    );
    await expect(provider.authenticate(jwt)).resolves.toBeNull();
  });

  it("returns null for the wrong issuer", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    const jwt = await mint(
      { groups: ["group-tax"] },
      { issuer: "https://evil.example.com/" },
    );
    await expect(provider.authenticate(jwt)).resolves.toBeNull();
  });

  it("returns null for a malformed token", async () => {
    const provider = new OidcAuthProvider(baseConfig, getKey);
    await expect(provider.authenticate("not-a-jwt")).resolves.toBeNull();
    await expect(provider.authenticate("")).resolves.toBeNull();
  });
});

describe("OidcAuthProvider construction (fail loud on misconfig)", () => {
  it("throws on a non-url issuer", () => {
    expect(
      () =>
        new OidcAuthProvider(
          { ...baseConfig, issuer: "not-a-url" } as OidcConfig,
          getKey,
        ),
    ).toThrow();
  });

  it("throws on an empty audience", () => {
    expect(
      () =>
        new OidcAuthProvider(
          { ...baseConfig, audience: "" } as OidcConfig,
          getKey,
        ),
    ).toThrow();
  });

  it("throws on a malformed scopeMap entry", () => {
    expect(
      () =>
        new OidcAuthProvider(
          {
            ...baseConfig,
            // allowedSourceIds must be string[]; a string is invalid.
            scopeMap: [{ claim: "g", allowedSourceIds: "nope" }],
          } as unknown as OidcConfig,
          getKey,
        ),
    ).toThrow();
  });
});

describe("resolveOidcPrincipal (pure policy)", () => {
  it("admin claim wins over scoped mappings", () => {
    const principal = resolveOidcPrincipal(["group-tax", "group-admins"], {
      scopeMap: baseConfig.scopeMap,
      adminClaims: baseConfig.adminClaims,
    });
    expect(principal).toEqual({ kind: "admin" });
  });

  it("empty values => scoped-empty (fail closed)", () => {
    const principal = resolveOidcPrincipal([], {
      scopeMap: baseConfig.scopeMap,
      adminClaims: baseConfig.adminClaims,
    });
    expect(principal).toEqual({ kind: "scoped", allowedSourceIds: [] });
  });
});
