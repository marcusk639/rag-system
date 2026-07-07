import { auth } from "@/lib/auth";
import { getScopeAssertionToken } from "@/lib/scope-token";
import { jsonError, proxyJsonGet, resolveBearerToken } from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** BFF proxy for GET /sources (read-only source list). */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.oid) {
    return jsonError(401, "UNAUTHENTICATED", "Sign-in required.");
  }
  const token = await getScopeAssertionToken(session.oid);
  return proxyJsonGet("/sources", resolveBearerToken({ scopeToken: token }));
}
