import { SignJWT, jwtVerify } from "jose";
import type { Principal } from "./access-control.js";
import type { AuthProvider } from "./auth.js";

/**
 * The scope-assertion token's payload shape. Signed by a trusted BFF (the web
 * app) after it resolves a user's per-client access via `resolveSourceIdsForUser`,
 * and verified here by Fastify — no DB round-trip on this side, since the BFF
 * already did the lookup.
 */
export interface InternalScopeTokenPayload {
  /** The signed-in user's stable identity key (e.g. an AAD object id). */
  sub: string;
  allowedSourceIds: string[];
}

const ALG = "HS256";
const EXPIRY = "60s";
const CLOCK_TOLERANCE_SECONDS = 5;

/**
 * Sign a short-lived scope-assertion JWT. Called by a trusted BFF, never by
 * Fastify itself. `secret` must be at least 64 hex characters (256 bits of
 * entropy) for HS256 — enforced here since the BFF reads the secret directly
 * from process.env and never routes through config validation.
 */
export async function signInternalScopeToken(
  payload: InternalScopeTokenPayload,
  secret: string,
): Promise<string> {
  if (secret.length < 64) {
    throw new Error(
      "INTERNAL_SCOPE_JWT_SECRET must be at least 64 hex characters (256 bits of entropy for HS256) — " +
        "generate with: openssl rand -hex 32",
    );
  }
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ allowedSourceIds: payload.allowedSourceIds })
    .setProtectedHeader({ alg: ALG })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(key);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Verifies scope-assertion JWTs minted by a trusted BFF (see
 * `signInternalScopeToken`) and maps them directly to a `Principal` — no DB
 * lookup here, since the signer already resolved the scope.
 *
 * SECURITY: `algorithms: ["HS256"]` is passed explicitly to `jwtVerify` to
 * reject `alg: none` and algorithm-swap attacks. This is non-negotiable —
 * the token's claims directly control corpus-wide confidentiality scope.
 *
 * Supports multiple secrets (tried in order) so a secret can be rotated
 * without downtime: add the new secret, deploy, wait out the old tokens'
 * ~60s lifetime, then drop the old secret and redeploy — mirrors the
 * existing multi-token `API_TOKENS` rotation pattern.
 */
export class InternalScopeAuthProvider implements AuthProvider {
  private readonly keys: Uint8Array[];

  constructor(secrets: readonly string[]) {
    if (secrets.length === 0) {
      throw new Error(
        "InternalScopeAuthProvider requires at least one secret; refusing to build a verifier that rejects every request",
      );
    }
    this.keys = secrets.map((s) => new TextEncoder().encode(s));
  }

  async authenticate(credential: string): Promise<Principal | null> {
    for (const key of this.keys) {
      try {
        const { payload } = await jwtVerify(credential, key, {
          algorithms: [ALG],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        const allowedSourceIds = payload["allowedSourceIds"];
        if (!isStringArray(allowedSourceIds)) return null;
        return {
          kind: "scoped",
          allowedSourceIds,
          ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}),
        };
      } catch {
        // This key didn't verify it — try the next one (rotation). Only
        // after every key has failed is the credential truly rejected.
      }
    }
    return null;
  }
}
