/**
 * Server-only helpers for talking to the RAG HTTP API from BFF route handlers.
 * Reads RAG_API_URL (server env, never NEXT_PUBLIC_). The bearer token is now
 * a per-request scope-assertion token (see getScopeAssertionToken) minted
 * fresh from the signed-in user's session — never a shared static token.
 * The browser only ever calls same-origin /api/* routes; the bearer token
 * stays on the server.
 */

export interface RagApiConfig {
  url: string;
}

export function getRagApiConfig(): RagApiConfig {
  const url = process.env.RAG_API_URL;
  if (!url) {
    throw new Error("RAG_API_URL must be set (server env, not NEXT_PUBLIC_).");
  }
  return { url: url.replace(/\/+$/, "") };
}

/**
 * Resolves which bearer token the BFF forwards to Fastify. Defaults to the
 * per-user scope-assertion token. `WEB_AUTH_MODE=static-fallback` is a
 * deliberately TEMPORARY emergency override for when Entra ID sign-in is
 * broken in production (misconfigured redirect URI, expired client secret,
 * tenant issue) — it reverts every user to one shared static token so the
 * app stays usable while the Entra ID issue is fixed. Remove this flag (and
 * RAG_API_STATIC_FALLBACK_TOKEN) once a rollout has been stable for a
 * defined period; it is not a permanent dual-mode feature.
 */
export function resolveBearerToken(opts: { scopeToken: string }): string {
  const mode = process.env.WEB_AUTH_MODE ?? "entra";
  if (mode === "static-fallback") {
    const fallback = process.env.RAG_API_STATIC_FALLBACK_TOKEN;
    if (!fallback) {
      throw new Error(
        "WEB_AUTH_MODE=static-fallback requires RAG_API_STATIC_FALLBACK_TOKEN to be set.",
      );
    }
    return fallback;
  }
  return opts.scopeToken;
}

/** Proxy a JSON GET to the RAG API, returning a same-origin JSON Response. */
export async function proxyJsonGet(
  path: string,
  bearerToken: string,
): Promise<Response> {
  let config: RagApiConfig;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}${path}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
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
 * per-request scope-assertion token, streams the bytes back, and propagates
 * the Content-Type / Content-Disposition / Content-Length headers so the
 * browser downloads the original file.
 */
export async function proxyDownload(
  path: string,
  bearerToken: string,
): Promise<Response> {
  let config: RagApiConfig;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}${path}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

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
