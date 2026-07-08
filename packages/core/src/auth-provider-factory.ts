import type { ScopedPrincipalConfig } from "./access-control.js";
import {
  CompositeAuthProvider,
  StaticTokenAuthProvider,
  type AuthProvider,
} from "./auth.js";
import { InternalScopeAuthProvider } from "./internal-scope-auth.js";
import { OidcAuthProvider, type OidcConfig } from "./oidc-auth.js";

/**
 * Discriminated config for `createAuthProvider`. The factory only switches on
 * the shape it's handed — env parsing (deciding WHICH shape to build) lives in
 * the runtime/app config layer, not here, so core stays free of env access.
 */
export type AuthProviderConfig =
  | {
      provider: "static-token";
      tokens: readonly string[];
      principals?: readonly ScopedPrincipalConfig[];
      /** When true, plain `tokens` resolve to deny-all (admin needs `isAdmin`). */
      enforceScoping?: boolean;
    }
  | { provider: "oidc"; oidc: OidcConfig }
  | {
      /** BFF-asserted scope tokens (see `InternalScopeAuthProvider`). */
      provider: "internal-scope";
      secrets: readonly string[];
    }
  | {
      provider: "composite";
      tokens: readonly string[];
      principals?: readonly ScopedPrincipalConfig[];
      /** When true, plain `tokens` resolve to deny-all (admin needs `isAdmin`). */
      enforceScoping?: boolean;
      /** Omit to build a composite with static-token only (OIDC disabled). */
      oidc?: OidcConfig;
      /** Omit/empty to exclude the internal-scope provider from the composite. */
      internalScopeSecrets?: readonly string[];
      /** Per-provider error sink (logger-backed) — never console.log. */
      onError?: (err: unknown) => void;
    };

/**
 * Build the `AuthProvider` for a deployment. For `composite`, static-token is
 * tried FIRST (cheap constant-time compare, covers existing service tokens),
 * then OIDC, then the internal-scope BFF-asserted provider (if configured).
 * When `oidc`/`internalScopeSecrets` are absent on a composite config, that
 * provider is simply omitted — a deployment with `AUTH_PROVIDER=composite`
 * and no OIDC/internal-scope env keeps behaving exactly like the legacy
 * static-token setup.
 */
export function createAuthProvider(config: AuthProviderConfig): AuthProvider {
  switch (config.provider) {
    case "static-token":
      return new StaticTokenAuthProvider(
        config.tokens,
        config.principals ?? [],
        config.enforceScoping ?? false,
      );

    case "oidc":
      return new OidcAuthProvider(config.oidc);

    case "internal-scope":
      return new InternalScopeAuthProvider(config.secrets);

    case "composite": {
      const providers: AuthProvider[] = [
        new StaticTokenAuthProvider(
          config.tokens,
          config.principals ?? [],
          config.enforceScoping ?? false,
        ),
      ];
      if (config.oidc) providers.push(new OidcAuthProvider(config.oidc));
      if (
        config.internalScopeSecrets &&
        config.internalScopeSecrets.length > 0
      ) {
        providers.push(
          new InternalScopeAuthProvider(config.internalScopeSecrets),
        );
      }
      return new CompositeAuthProvider(providers, config.onError);
    }
  }
}
