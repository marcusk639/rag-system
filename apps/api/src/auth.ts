import { createTokenVerifier } from "@rag/core";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Endpoints exempt from bearer-token auth — health checks must always work
 * for load balancers / orchestrators without provisioning a token.
 */
const PUBLIC_PATHS = new Set<string>(["/health", "/ready"]);

/**
 * Build a Fastify `onRequest` hook that enforces `Authorization: Bearer <token>`
 * against the configured token allow-list using the shared constant-time
 * verifier (@rag/core/auth).
 */
export function createAuthHook(tokens: readonly string[]) {
  const verifyToken = createTokenVerifier(tokens);

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
  };
}
