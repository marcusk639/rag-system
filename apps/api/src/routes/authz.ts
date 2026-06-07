import { principalToScope, type AuthorizationScope } from "@rag/core";
import type { FastifyRequest } from "fastify";

/**
 * Fail-closed authorization scope for an empty/missing principal: read NOTHING.
 * The auth hook always sets `request.principal` for authenticated routes, so a
 * missing principal here would be a wiring bug — and the safe failure for a
 * confidentiality boundary is zero results, never the whole corpus.
 */
const DENY_ALL_SCOPE: AuthorizationScope = { enforcedSourceIds: [] };

/**
 * Derive the MANDATORY retrieval authorization scope from the authenticated
 * request's principal. Centralized so /search and /ask cannot diverge, and so
 * the fail-closed default is applied identically at both call sites.
 */
export function scopeFromRequest(request: FastifyRequest): AuthorizationScope {
  return request.principal
    ? principalToScope(request.principal)
    : DENY_ALL_SCOPE;
}
