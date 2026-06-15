import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import type { Principal } from "./access-control.js";
import type { AuthProvider } from "./auth.js";

/**
 * Generic, IdP-NEUTRAL OIDC bearer-token authentication.
 *
 * This module knows ONLY standard OIDC concepts — issuer, audience, a JWKS
 * endpoint, and arbitrary token claims. It contains NO provider-specific names
 * (no "microsoft", "entra", tenant ids, or well-known group names). Mapping a
 * deployment's IdP onto sources is pure configuration (`scopeMap`,
 * `adminClaims`), supplied per deployment via env — see env.example for a
 * Microsoft Entra ID example.
 *
 * Trust model: a JWT is accepted only if `jose` verifies its signature against
 * the issuer's published JWKS AND its `iss`/`aud`/`exp` match the configured
 * values. Verification failure of ANY kind resolves to `null` (fail closed) —
 * we never throw out of `authenticate` for a bad token. Throws are reserved for
 * MISCONFIGURATION at construction (bad issuer/audience/scopeMap), consistent
 * with `createTokenVerifier`.
 */

/** A single claim→sources mapping entry. */
const ScopeMapEntry = z.object({
  /** The claim VALUE that grants access (e.g. an IdP group id/name). */
  claim: z.string().min(1),
  /** Source ids unlocked when the token carries `claim`. */
  allowedSourceIds: z.array(z.string()),
});

/**
 * OIDC config schema. Validated at construction so a misconfigured deployment
 * fails loud at startup rather than silently rejecting every token later.
 */
export const OidcConfig = z.object({
  /** Expected `iss` — the IdP's issuer URL. */
  issuer: z.string().url(),
  /** Expected `aud` — this API's client/app id at the IdP. */
  audience: z.string().min(1),
  /**
   * JWKS endpoint. Optional: when omitted we derive the conventional
   * `<issuer>/.well-known/jwks.json`. Most IdPs publish a non-conventional
   * path, so set this explicitly when in doubt.
   */
  jwksUri: z.string().url().optional(),
  /**
   * Token claim carrying the caller's group/role identifiers. May be a single
   * string or an array of strings in the token. Defaults to "groups".
   */
  claim: z.string().min(1).default("groups"),
  /** Claim-value → allowed-source-ids mappings. */
  scopeMap: z.array(ScopeMapEntry),
  /**
   * Claim values that grant ADMIN / all-access. If the token carries ANY of
   * these in its `claim`, it resolves to `{ kind: "admin" }`. Optional.
   */
  adminClaims: z.array(z.string()).optional(),
});
export type OidcConfig = z.infer<typeof OidcConfig>;

/**
 * Derive the conventional JWKS URI from an issuer when none is configured.
 * Handles a trailing slash so we don't emit a doubled `//`.
 */
function deriveJwksUri(issuer: string): string {
  const trimmed = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  return `${trimmed}/.well-known/jwks.json`;
}

/**
 * Normalize a token claim that may be a single string or an array of strings
 * into a flat `string[]`. Anything else (number, object, missing) yields `[]`,
 * which is fail-closed: a token whose claim we can't read maps to zero sources.
 */
function claimValues(payload: JWTPayload, claim: string): string[] {
  const raw = payload[claim];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw))
    return raw.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Resolve a verified token's claim values to a `Principal` using the config's
 * scope map. Pure and synchronous so the policy is trivially testable.
 *
 *   - any value in `adminClaims` present => admin (all-access)
 *   - otherwise => scoped to the UNION of `allowedSourceIds` across every
 *     `scopeMap` entry whose `claim` the token carries.
 *
 * An empty union is intentional fail-closed (scoped to nothing => zero rows),
 * NOT all-access. A token with valid signature but no mapped groups sees
 * nothing rather than everything.
 */
export function resolveOidcPrincipal(
  values: readonly string[],
  config: Pick<OidcConfig, "scopeMap" | "adminClaims">,
): Principal {
  const present = new Set(values);

  if (config.adminClaims?.some((c) => present.has(c))) {
    return { kind: "admin" };
  }

  const allowed = new Set<string>();
  for (const entry of config.scopeMap) {
    if (present.has(entry.claim)) {
      for (const id of entry.allowedSourceIds) allowed.add(id);
    }
  }
  return { kind: "scoped", allowedSourceIds: [...allowed] };
}

export class OidcAuthProvider implements AuthProvider {
  private readonly config: OidcConfig;
  private readonly getKey: JWTVerifyGetKey;

  /**
   * @param config OIDC settings (validated here — throws on misconfig).
   * @param getKey Optional key resolver. Defaults to `createRemoteJWKSet` over
   *   the configured/derived JWKS URI. Injectable so tests can pass a local key
   *   set without standing up a remote JWKS endpoint.
   */
  constructor(config: OidcConfig, getKey?: JWTVerifyGetKey) {
    // Validate (and apply defaults) at construction — fail loud on misconfig.
    this.config = OidcConfig.parse(config);
    this.getKey =
      getKey ??
      createRemoteJWKSet(
        new URL(this.config.jwksUri ?? deriveJwksUri(this.config.issuer)),
      );
  }

  async authenticate(credential: string): Promise<Principal | null> {
    let payload: JWTPayload;
    try {
      // jose enforces signature, `iss`, `aud`, and `exp`/`nbf` in one call.
      ({ payload } = await jwtVerify(credential, this.getKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
      }));
    } catch {
      // Any verification failure — bad signature, wrong issuer/audience,
      // expired, malformed — is a rejected CREDENTIAL, not a misconfig. Fail
      // closed by returning null; never throw out of authenticate.
      return null;
    }

    return resolveOidcPrincipal(
      claimValues(payload, this.config.claim),
      this.config,
    );
  }
}
