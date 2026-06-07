import { createHash, timingSafeEqual } from "node:crypto";
import {
  resolvePrincipal,
  type Principal,
  type ScopedPrincipalConfig,
} from "@rag/core";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Endpoints exempt from bearer-token auth — health checks must always work
 * for load balancers / orchestrators without provisioning a token.
 */
const PUBLIC_PATHS = new Set<string>(["/health", "/ready"]);

/**
 * Per-request caller identity, attached by the auth hook. Carries the resolved
 * principal (admin or source-scoped) so route handlers can derive the MANDATORY
 * `AuthorizationScope` passed into `Retriever.search`. See @rag/core
 * access-control. Decorated onto every authenticated request.
 */
declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

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
 * against the configured token allow-list using constant-time comparison, then
 * resolves the token to a `Principal` and decorates it onto the request.
 *
 * `tokens` are plain (unscoped) ADMIN tokens; `principals` are scoped tokens.
 * A token is valid if it is in EITHER list (both feed the constant-time
 * allow-list). Identity resolution then maps it to admin vs. scoped — scoped
 * wins for least privilege. See @rag/core access-control for the policy.
 */
export function createAuthHook(
  tokens: readonly string[],
  principals: readonly ScopedPrincipalConfig[] = [],
) {
  // Every valid token (admin OR scoped) participates in the constant-time
  // allow-list. Pre-hash once at startup.
  const allTokens = [...tokens, ...principals.map((p) => p.token)];
  const hashedTokens = allTokens.map((t) =>
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

    // Token is valid — resolve identity. A plain `API_TOKENS` token => admin;
    // a token in `principals` => scoped (and scoped wins if it's in both).
    const principal = resolvePrincipal(token, tokens, principals);
    if (!principal) {
      // Defensive: verifyToken accepted it, so this should be unreachable. If
      // the two lists ever drift, fail CLOSED rather than serving unscoped.
      await reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Unrecognized principal" },
      });
      return;
    }
    request.principal = principal;
  };
}
