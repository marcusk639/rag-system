import { describe, expect, it } from "vitest";
import { createAuthProvider } from "./auth-provider-factory.js";
import { CompositeAuthProvider, StaticTokenAuthProvider } from "./auth.js";
import { OidcAuthProvider, type OidcConfig } from "./oidc-auth.js";

const oidc: OidcConfig = {
  issuer: "https://idp.example.com/",
  audience: "aud",
  claim: "groups",
  scopeMap: [],
};

describe("createAuthProvider", () => {
  it("builds a StaticTokenAuthProvider for 'static-token'", () => {
    const provider = createAuthProvider({
      provider: "static-token",
      tokens: ["t"],
    });
    expect(provider).toBeInstanceOf(StaticTokenAuthProvider);
  });

  it("builds an OidcAuthProvider for 'oidc'", () => {
    const provider = createAuthProvider({ provider: "oidc", oidc });
    expect(provider).toBeInstanceOf(OidcAuthProvider);
  });

  it("builds a CompositeAuthProvider (static + oidc) for 'composite'", async () => {
    const provider = createAuthProvider({
      provider: "composite",
      tokens: ["admin-tok"],
      oidc,
    });
    expect(provider).toBeInstanceOf(CompositeAuthProvider);
    // Static path still works inside the composite — admin token resolves.
    await expect(provider.authenticate("admin-tok")).resolves.toEqual({
      kind: "admin",
    });
  });

  it("degrades 'composite' without oidc to static-token-only behavior", async () => {
    // Backward compatibility: a deployment with AUTH_PROVIDER=composite but no
    // OIDC config must behave exactly like the legacy static-token setup.
    const provider = createAuthProvider({
      provider: "composite",
      tokens: ["admin-tok"],
    });
    await expect(provider.authenticate("admin-tok")).resolves.toEqual({
      kind: "admin",
    });
    await expect(provider.authenticate("nope")).resolves.toBeNull();
  });
});
