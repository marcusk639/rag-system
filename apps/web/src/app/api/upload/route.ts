import { getRagApiConfig, jsonError } from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirror of the API's allowlist (apps/api/src/routes/sources.ts) so obviously
// unsupported files are rejected same-origin before a round-trip. The API
// re-validates — this is defense-in-depth, not the source of truth.
const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
]);

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * BFF proxy for a document upload: forwards a multipart file to the RAG API's
 * `POST /sources/:id/documents` with the server-side bearer token injected here
 * (never exposed to the browser). The target source id is a same-origin query
 * param, validated as a UUID before use.
 */
export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  const sourceId = new URL(request.url).searchParams.get("sourceId");
  if (!sourceId || !UUID_RE.test(sourceId)) {
    return jsonError(
      400,
      "INVALID_SOURCE_ID",
      "A valid sourceId query parameter is required.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "INVALID_BODY", "Expected multipart form data.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError(400, "NO_FILE", "No file was provided.");
  }
  if (file.size === 0) {
    return jsonError(400, "EMPTY_FILE", "The uploaded file is empty.");
  }
  if (file.size > MAX_BYTES) {
    return jsonError(413, "FILE_TOO_LARGE", "File exceeds the 25 MB limit.");
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return jsonError(
      400,
      "UNSUPPORTED_TYPE",
      `Unsupported file type: ${file.type}.`,
    );
  }

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, file.name);

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}/sources/${sourceId}/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      body: upstreamForm,
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

  // Pass the JSON envelope (202 success or error) straight through.
  const text = await upstream.text();
  return new Response(text || "{}", {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
