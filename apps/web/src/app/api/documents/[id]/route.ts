import { jsonError, proxyJsonGet } from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** BFF proxy for GET /documents/:id (cited-document viewer). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return jsonError(400, "INVALID_ID", "Document id must be a UUID.");
  }
  return proxyJsonGet(`/documents/${id}`);
}
