import { auth } from "@/lib/auth";
import { getScopeAssertionToken } from "@/lib/scope-token";
import { proxyJsonGet, resolveRequestBearerToken } from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** BFF proxy for GET /sources (read-only source list). */
export async function GET(): Promise<Response> {
  const resolved = await resolveRequestBearerToken(
    auth,
    getScopeAssertionToken,
  );
  if (resolved.errorResponse) return resolved.errorResponse;
  return proxyJsonGet("/sources", resolved.token);
}
