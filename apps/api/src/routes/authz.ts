import {
  DENY_ALL_SCOPE,
  principalToScope,
  type AuthorizationScope,
} from "@rag/core";
import type { FastifyRequest } from "fastify";

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
