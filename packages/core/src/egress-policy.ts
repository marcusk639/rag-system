import { EgressError } from "./errors.js";

/**
 * Validates outbound HTTPS hosts against a configurable allow-list.
 * Fail-closed: if the host is not on the list, throws `EgressError` rather
 * than allowing the call. This satisfies CR-1 (IRC §7216) and CR-3.
 *
 * Construction:
 *   const policy = EgressPolicy.fromEnv(); // reads EGRESS_ALLOWED_HOSTS
 *   const policy = new EgressPolicy(["generativelanguage.googleapis.com"]);
 *   const policy = new EgressPolicy([]); // blocks everything
 *
 * Usage:
 *   policy.assertAllowed("https://generativelanguage.googleapis.com/v1beta/...");
 */
export class EgressPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(hosts: readonly string[]) {
    // Normalize: lowercase, strip any accidental whitespace, drop empty strings.
    this.allowed = new Set(
      hosts.map((h) => h.trim().toLowerCase()).filter(Boolean),
    );
  }

  /**
   * Build an `EgressPolicy` from the `EGRESS_ALLOWED_HOSTS` environment variable.
   * Comma-separated hostnames, e.g.:
   *   EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com,api.openai.com
   * An empty or missing value produces a deny-all policy.
   */
  static fromEnv(): EgressPolicy {
    const raw = process.env["EGRESS_ALLOWED_HOSTS"] ?? "";
    const hosts = raw
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    return new EgressPolicy(hosts);
  }

  /**
   * Assert that the hostname of `url` is in the allow-list.
   * Throws `EgressError` if not — call MUST NOT be made if this throws.
   */
  assertAllowed(url: string): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      // Unparseable URL — treat as an unknown host and block.
      throw new EgressError(url);
    }
    if (!this.allowed.has(hostname)) {
      throw new EgressError(hostname);
    }
  }

  /** Returns the set of allowed hostnames (for logging/diagnostics). */
  get allowedHosts(): readonly string[] {
    return [...this.allowed];
  }
}

/**
 * `RequestInit` options that make the allow-list check mean what it says.
 *
 * `assertAllowed` validates the URL the code intends to dial. Nothing
 * re-validates the URL the transport ends up at after a 3xx, and `fetch`
 * follows redirects by default — so an allow-listed host that answers
 * `308 Location: https://attacker.example/collect` gets the request body
 * re-sent there (undici strips `Authorization` cross-origin but re-sends the
 * body on 307/308). For a generation call that body is the assembled prompt.
 *
 * Refusing to follow redirects closes the seam. No provider in use here depends
 * on redirects for a normal API call, so this costs nothing; if one ever does,
 * the correct fix is to re-run `assertAllowed` per hop, not to follow blindly.
 */
export const NO_REDIRECT_INIT: Pick<RequestInit, "redirect"> = {
  redirect: "error",
};

/**
 * Wrap a `fetch` so every request refuses redirects. Pass this to any SDK that
 * accepts a custom fetch; SDKs that only accept `RequestInit` take
 * `NO_REDIRECT_INIT` instead.
 *
 * `base` is injectable so tests can supply a transport without reaching the
 * network — the SDKs capture their own `fetch` reference, so stubbing
 * `globalThis.fetch` does not reliably intercept them.
 */
export function egressSafeFetch(
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => base(input, { ...init, ...NO_REDIRECT_INIT });
}
