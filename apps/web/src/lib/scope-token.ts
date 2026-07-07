import { resolveSourceIdsForUser } from "@rag/db";
import { signInternalScopeToken } from "@rag/core";
import { getWebDb } from "./db.js";

/**
 * Resolve `oid`'s current per-client access (fresh from Postgres every call —
 * never cached beyond the returned token's own 60s lifetime, so a revoked
 * grant stops working within one request cycle) and mint the signed
 * scope-assertion JWT the BFF presents to Fastify as its bearer credential.
 *
 * Fails closed by construction: if `resolveSourceIdsForUser` throws (e.g. the
 * database is briefly unavailable), this function throws too — callers must
 * NOT catch this and fall back to a default/admin scope.
 */
export async function getScopeAssertionToken(oid: string): Promise<string> {
  const secret = process.env.INTERNAL_SCOPE_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "INTERNAL_SCOPE_JWT_SECRET must be set for the web app's BFF to mint scope-assertion tokens.",
    );
  }
  const allowedSourceIds = await resolveSourceIdsForUser(getWebDb(), oid);
  return signInternalScopeToken({ sub: oid, allowedSourceIds }, secret);
}
