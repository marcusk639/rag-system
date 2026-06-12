import { createHash, timingSafeEqual } from "node:crypto";

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
