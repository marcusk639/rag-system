import { auth } from "@/lib/auth";
import { getScopeAssertionToken } from "@/lib/scope-token";
import { jsonError, proxyDownload } from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** BFF proxy for GET /documents/:id/download (download the original cited file). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.oid) {
    return jsonError(401, "UNAUTHENTICATED", "Sign-in required.");
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return jsonError(400, "INVALID_ID", "Document id must be a UUID.");
  }

  const token = await getScopeAssertionToken(session.oid);
  return proxyDownload(`/documents/${id}/download`, token);
}
