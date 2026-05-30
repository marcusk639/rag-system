import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Endpoints exempt from bearer-token auth — health checks must always work
 * for load balancers / orchestrators without provisioning a token.
 */
const PUBLIC_PATHS = new Set<string>(["/health", "/ready"]);

/**
 * Constant-time comparison of presented token against the allow-list.
 *
 * We hash both sides to a fixed-length SHA-256 digest before `timingSafeEqual`
 * so neither length nor content leaks through timing. `Set.has(token)` is
 * a hash lookup but the underlying string compare inside V8's hashmap is
 * not guaranteed constant-time — over a low-latency network an attacker
 * could in principle infer a valid token character-by-character.
 */
function verifyToken(presented: string, allowed: Buffer[]): boolean {
  const presentedHash = createHash("sha256").update(presented).digest();
  let ok = false;
  for (const candidate of allowed) {
    // Iterate every candidate even after a match so the total work doesn't
    // shrink for valid tokens — keeps the timing profile flat.
    if (timingSafeEqual(presentedHash, candidate)) ok = true;
  }
  return ok;
}

/**
 * Build a Fastify `onRequest` hook that enforces `Authorization: Bearer <token>`
 * against the configured token allow-list using constant-time comparison.
 */
export function createAuthHook(tokens: readonly string[]) {
  // Pre-hash the allowed tokens once at startup so each request just hashes
  // the presented token and compares fixed-length digests.
  const hashedTokens = tokens.map((t) =>
    createHash("sha256").update(t).digest(),
  );

  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Fastify v5 removed `routerPath`; fall back to the parsed URL (which
    // already excludes the query string).
    const path = request.url.split("?")[0] ?? request.url;
    if (PUBLIC_PATHS.has(path)) return;

    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      await reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Missing bearer token" },
      });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    if (!verifyToken(token, hashedTokens)) {
      await reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid bearer token" },
      });
      return;
    }
  };
}
