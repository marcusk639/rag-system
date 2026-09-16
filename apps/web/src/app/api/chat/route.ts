import { auth } from "@/lib/auth";
import { buildUpstreamAskBody } from "@/lib/chat-request";
import {
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UPSTREAM_IDLE_TIMEOUT_MS,
  withIdleTimeout,
} from "@/lib/sse-proxy";
import { getScopeAssertionToken } from "@/lib/scope-token";
import {
  getRagApiConfig,
  jsonError,
  resolveRequestBearerToken,
} from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF streaming proxy: pipes POST /ask/stream from the RAG API straight back to
 * the same-origin browser client as SSE. The bearer token is a per-request
 * scope-assertion token minted here, server-side, from the signed-in user's
 * session; it is never visible to the client.
 */
export async function POST(request: Request): Promise<Response> {
  // Resolved (and, if it fails, returned) before the fetch try/catch below so
  // a missing RAG_API_STATIC_FALLBACK_TOKEN config error can never be
  // mislabeled as an upstream connectivity failure.
  const resolved = await resolveRequestBearerToken(
    auth,
    getScopeAssertionToken,
  );
  if (resolved.errorResponse) return resolved.errorResponse;

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

  // One controller for the whole upstream request: aborted if the browser
  // disconnects, if the API does not answer with headers in time, or if the
  // stream goes idle (below). Without it a closed tab left the API generating.
  const upstreamAbort = new AbortController();
  request.signal.addEventListener("abort", () => upstreamAbort.abort(), {
    once: true,
  });
  // The listener does not fire for a signal that aborted during the awaits
  // above (auth, config, body parsing).
  if (request.signal.aborted) upstreamAbort.abort();
  let connectTimedOut = false;
  const connectTimer = setTimeout(() => {
    connectTimedOut = true;
    upstreamAbort.abort();
  }, UPSTREAM_CONNECT_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}/ask/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildUpstreamAskBody(body)),
      signal: upstreamAbort.signal,
    });
  } catch {
    return connectTimedOut
      ? jsonError(504, "UPSTREAM_TIMEOUT", "RAG API did not respond in time.")
      : jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  } finally {
    clearTimeout(connectTimer);
  }

  // Non-streaming failure (e.g. 401/403/503): surface the JSON error envelope.
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(text || "{}", {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = withIdleTimeout(upstream.body, UPSTREAM_IDLE_TIMEOUT_MS, () =>
    upstreamAbort.abort(),
  );
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
