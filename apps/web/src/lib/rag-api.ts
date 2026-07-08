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

/** Minimal shape of the Auth.js session this module needs — kept structural
 * (rather than importing the `next-auth` `Session` type) so this file has no
 * hard dependency on Auth.js/NextAuth wiring and stays easy to unit test. */
export interface SessionLike {
  oid?: string | null;
}

/** Either a resolved bearer token, or a ready-to-return error `Response`. */
export type BearerTokenResolution =
  | { token: string; errorResponse?: undefined }
  | { token?: undefined; errorResponse: Response };

/**
 * Resolves the bearer token the BFF forwards to Fastify for this request,
 * AND decides whether a session is required at all — both auth modes live
 * here so every route handler gates identically instead of each
 * independently checking `session?.oid` before ever considering
 * `WEB_AUTH_MODE`.
 *
 * - Default ("entra"): requires `getSession()` to return a session with an
 *   `oid` (fails with 401 otherwise), then mints a per-user scope-assertion
 *   token via `getScopeToken(oid)`. Identical to the pre-existing behavior.
 * - `WEB_AUTH_MODE=static-fallback`: a deliberately TEMPORARY emergency
 *   override for when Entra ID sign-in is broken in production
 *   (misconfigured redirect URI, expired client secret, tenant issue) —
 *   including the case where Entra ID cannot produce a session at all. In
 *   that mode `getSession`/`getScopeToken` are never called: every request
 *   is served the one shared static token so the app stays usable while the
 *   Entra ID issue is fixed. Remove this flag (and
 *   RAG_API_STATIC_FALLBACK_TOKEN) once a rollout has been stable for a
 *   defined period; it is not a permanent dual-mode feature.
 *
 * If `RAG_API_STATIC_FALLBACK_TOKEN` is unset while the mode is active, this
 * returns a structured 500 `CONFIG_ERROR` response (rather than throwing)
 * so callers can `return` it directly — a route's surrounding
 * try/catch-around-fetch never gets a chance to mislabel a config error as
 * "RAG API is unreachable", and routes that have no such try/catch never let
 * an unstructured exception propagate.
 *
 * Every request actually served via the fallback path is logged with
 * `console.warn` (this app has no logging library — see other files under
 * `apps/web/src`) so ops has an audit trail of when the emergency bypass was
 * in use, not just when it was configured.
 */
export async function resolveRequestBearerToken(
  getSession: () => Promise<SessionLike | null>,
  getScopeToken: (oid: string) => Promise<string>,
): Promise<BearerTokenResolution> {
  if (process.env.WEB_AUTH_MODE === "static-fallback") {
    const fallback = process.env.RAG_API_STATIC_FALLBACK_TOKEN;
    if (!fallback) {
      return {
        errorResponse: jsonError(
          500,
          "CONFIG_ERROR",
          "WEB_AUTH_MODE=static-fallback requires RAG_API_STATIC_FALLBACK_TOKEN to be set.",
        ),
      };
    }
    console.warn(
      "[rag-api] Serving request via WEB_AUTH_MODE=static-fallback — the shared static fallback token is authorizing this request instead of a per-user scope token (Entra ID sign-in bypass active).",
    );
    return { token: fallback };
  }

  const session = await getSession();
  if (!session?.oid) {
    return {
      errorResponse: jsonError(401, "UNAUTHENTICATED", "Sign-in required."),
    };
  }
  const token = await getScopeToken(session.oid);
  return { token };
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
