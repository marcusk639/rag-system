import type { AuthProvider, Principal } from "@rag/core";
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
 * Build a Fastify `onRequest` hook that enforces `Authorization: Bearer
 * <credential>` and resolves the credential to a `Principal` via the injected
 * `AuthProvider`, decorating it onto the request.
 *
 * The provider is the single pluggable seam: a `StaticTokenAuthProvider`
 * preserves the legacy admin/scoped-token behavior exactly, while a
 * `CompositeAuthProvider` additionally accepts OIDC JWTs. The hook itself is
 * transport-only and IdP-agnostic — it never inspects the credential's shape.
 * Identity-to-scope mapping (admin vs. scoped, scoped wins for least privilege)
 * lives inside the provider / @rag/core access-control.
 *
 * `authenticate` returning `null` is the fail-closed signal: respond 401 and
 * never serve an unscoped request for an unrecognized credential.
 */
export function createAuthHook(provider: AuthProvider) {
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

    const credential = header.slice("Bearer ".length).trim();
    const principal = await provider.authenticate(credential);
    if (!principal) {
      // Fail CLOSED — invalid/expired token or an unrecognized principal.
      await reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid bearer token" },
      });
      return;
    }
    request.principal = principal;
  };
}
