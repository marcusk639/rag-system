import {
  createTokenVerifier,
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
 * Build a Fastify `onRequest` hook that enforces `Authorization: Bearer <token>`
 * against the configured token allow-list using the shared constant-time
 * verifier (@rag/core/auth), then resolves the token to a `Principal` and
 * decorates it onto the request.
 *
 * `tokens` are plain (unscoped) ADMIN tokens; `principals` are scoped tokens.
 * A token is valid if it is in EITHER list (both feed the shared constant-time
 * verifier). Identity resolution then maps it to admin vs. scoped — scoped wins
 * for least privilege. See @rag/core access-control for the policy.
 */
export function createAuthHook(
  tokens: readonly string[],
  principals: readonly ScopedPrincipalConfig[] = [],
) {
  // Every valid token (admin OR scoped) feeds the shared constant-time verifier,
  // which pre-hashes the allow-list once at startup.
  const verifyToken = createTokenVerifier([
    ...tokens,
    ...principals.map((p) => p.token),
  ]);

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
    if (!verifyToken(token)) {
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
