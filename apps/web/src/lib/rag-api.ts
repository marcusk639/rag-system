/**
 * Server-only helpers for talking to the RAG HTTP API from BFF route handlers.
 * Reads server env (RAG_API_URL, RAG_API_TOKEN) — these must NEVER be exposed to
 * the browser (no NEXT_PUBLIC_ prefix). The browser only ever calls same-origin
 * /api/* routes; the bearer token stays on the server.
 */

export interface RagApiConfig {
  url: string;
  token: string;
}

export function getRagApiConfig(): RagApiConfig {
  const url = process.env.RAG_API_URL;
  const token = process.env.RAG_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "RAG_API_URL and RAG_API_TOKEN must be set (server env, not NEXT_PUBLIC_).",
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

/** Proxy a JSON GET to the RAG API, returning a same-origin JSON Response. */
export async function proxyJsonGet(path: string): Promise<Response> {
  let config: RagApiConfig;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}${path}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}


/**
 * BFF proxy for a binary download (GET /documents/:id/download). Forwards the
 * server-side bearer token, streams the bytes back, and propagates the
 * Content-Type / Content-Disposition / Content-Length headers so the browser
 * downloads the original file. The bearer token never reaches the browser.
 */
export async function proxyDownload(path: string): Promise<Response> {
  let config: RagApiConfig;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}${path}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

  // On any non-2xx (404 not-found / not-stored, 403, etc.) pass the status and
  // body through as-is rather than streaming a non-existent file.
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || null, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) headers.set("Content-Disposition", disposition);
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  return new Response(upstream.body, { status: 200, headers });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
