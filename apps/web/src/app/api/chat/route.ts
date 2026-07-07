import { auth } from "@/lib/auth";
import { getScopeAssertionToken } from "@/lib/scope-token";
import { getRagApiConfig, jsonError } from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF streaming proxy: pipes POST /ask/stream from the RAG API straight back to
 * the same-origin browser client as SSE. The bearer token is a per-request
 * scope-assertion token minted here, server-side, from the signed-in user's
 * session; it is never visible to the client.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.oid) {
    return jsonError(401, "UNAUTHENTICATED", "Sign-in required.");
  }

  let config;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_BODY", "Request body must be JSON.");
  }

  const token = await getScopeAssertionToken(session.oid);

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}/ask/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

  // Non-streaming failure (e.g. 401/403/503): surface the JSON error envelope.
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(text || "{}", {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
