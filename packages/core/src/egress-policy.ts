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
