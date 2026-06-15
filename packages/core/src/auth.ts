import { createHash, timingSafeEqual } from "node:crypto";
import {
  resolvePrincipal,
  type Principal,
  type ScopedPrincipalConfig,
} from "./access-control.js";

/**
 * Build a constant-time bearer-token verifier. Single-sourced here so the HTTP
 * API Fastify hook and the MCP HTTP transport share one implementation.
 *
 * Both sides are hashed to a fixed-length SHA-256 digest before
 * `timingSafeEqual` so neither length nor content leaks through timing — a raw
 * `Set.has(token)` lookup relies on V8's hashmap string compare, which is not
 * guaranteed constant-time and could in principle leak a valid token
 * character-by-character over a low-latency network.
 *
 * The allowed tokens are pre-hashed once at construction; the returned closure
 * hashes only the presented token per call.
 */
export function createTokenVerifier(
  tokens: readonly string[],
): (presented: string) => boolean {
  // An empty set yields a verifier that rejects everything — safe, but it would
  // lock out all callers silently. Fail loud so a misconfigured token list is a
  // startup error, not a mysterious 401 storm.
  if (tokens.length === 0) {
    throw new Error(
      "createTokenVerifier requires at least one token; refusing to build a verifier that rejects every request",
    );
  }

  const hashedTokens = tokens.map((t) =>
    createHash("sha256").update(t).digest(),
  );

  return (presented: string): boolean => {
    const presentedHash = createHash("sha256").update(presented).digest();
    let ok = false;
    for (const candidate of hashedTokens) {
      // Iterate every candidate even after a match so the total work doesn't
      // shrink for valid tokens — keeps the timing profile flat.
      if (timingSafeEqual(presentedHash, candidate)) ok = true;
    }
    return ok;
  };
}

/**
 * Provider-neutral authentication abstraction. A `credential` is whatever the
 * transport presented as a bearer value — a static opaque token, an OIDC JWT,
 * anything. The provider's job is ONLY authentication + identity resolution:
 * map a credential to the `Principal` it represents, or `null` to REJECT.
 *
 * `null` is the single fail-closed signal. A provider MUST NOT throw to reject
 * a bad credential — an invalid/expired/forged credential is an expected
 * runtime condition, not a programming error. Throws are reserved for
 * MISCONFIGURATION (bad config at construction), never for bad input.
 *
 * The downstream authorization contract (`Principal` → `AuthorizationScope` →
 * scope-threaded retrieval) is intentionally UNCHANGED: this abstraction sits
 * in front of `resolvePrincipal`, it does not replace the scope machinery.
 */
export interface AuthProvider {
  authenticate(credential: string): Promise<Principal | null>;
}

/**
 * The original static-token strategy, repackaged behind `AuthProvider`.
 *
 * Behavior is IDENTICAL to the pre-abstraction API hook: every admin token and
 * every scoped-principal token feeds one shared constant-time verifier; a
 * presented credential that passes the verifier is then mapped to its
 * `Principal` via `resolvePrincipal` (scoped wins over admin — least privilege).
 * Anything the verifier rejects, or that `resolvePrincipal` can't place,
 * resolves to `null` (fail closed).
 */
export class StaticTokenAuthProvider implements AuthProvider {
  private readonly verify: (presented: string) => boolean;
  private readonly tokens: readonly string[];
  private readonly principals: readonly ScopedPrincipalConfig[];

  constructor(
    tokens: readonly string[],
    principals: readonly ScopedPrincipalConfig[] = [],
  ) {
    // Reuse the constant-time verifier — it throws on an empty allow-list, so a
    // misconfigured token set fails loud at construction (consistent with the
    // pre-abstraction hook).
    this.verify = createTokenVerifier([
      ...tokens,
      ...principals.map((p) => p.token),
    ]);
    this.tokens = tokens;
    this.principals = principals;
  }

  authenticate(credential: string): Promise<Principal | null> {
    // Wrap the synchronous resolution in a resolved promise — the work itself
    // is sync (constant-time compare + plain-equality lookup) but the
    // interface is async so JWT-style providers can do real I/O.
    if (!this.verify(credential)) return Promise.resolve(null);
    return Promise.resolve(
      resolvePrincipal(credential, this.tokens, this.principals),
    );
  }
}

/**
 * Tries an ordered list of providers and returns the first non-null
 * `Principal`. Used to run static-token and OIDC side by side so a single
 * deployment can accept both opaque service tokens AND federated JWTs.
 *
 * Each provider is ISOLATED: if one throws (a provider SHOULD return null
 * rather than throw, but we don't trust that), the error is reported via
 * `onError` and the composite continues to the next provider. A malformed JWT
 * that makes the OIDC provider throw must never block a valid static token, and
 * vice-versa. We never `console.log` (production-code rule) — callers inject a
 * logger-backed `onError` if they want visibility.
 */
export class CompositeAuthProvider implements AuthProvider {
  private readonly providers: readonly AuthProvider[];
  private readonly onError?: (err: unknown) => void;

  constructor(
    providers: readonly AuthProvider[],
    onError?: (err: unknown) => void,
  ) {
    this.providers = providers;
    this.onError = onError;
  }

  async authenticate(credential: string): Promise<Principal | null> {
    for (const provider of this.providers) {
      try {
        const principal = await provider.authenticate(credential);
        if (principal) return principal;
      } catch (err) {
        // Isolate the failure — one provider's exception must not deny a
        // credential another provider would have accepted. Fail closed for
        // THIS provider only, then continue.
        this.onError?.(err);
      }
    }
    return null;
  }
}
