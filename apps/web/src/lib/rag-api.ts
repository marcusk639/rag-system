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
