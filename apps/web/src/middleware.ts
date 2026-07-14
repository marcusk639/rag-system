import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

/**
 * Builds the Content-Security-Policy header value for a single request,
 * given that request's nonce. Directives mirror what Task 3 (commit
 * 50d8ec3) established in next.config.ts, with script-src and style-src
 * upgraded from a static allowlist to a per-request nonce — this follows
 * Next.js's own documented App Router CSP guide
 * (https://nextjs.org/docs/app/guides/content-security-policy), which
 * recommends 'nonce-<value>' on style-src in production (not
 * 'unsafe-inline' — that guide only falls back to 'unsafe-inline' on
 * style-src in development, where React's eval-based debugging conflicts
 * with a nonce-only policy).
 */
function buildCspHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Protects every route except the Auth.js handler itself. An unauthenticated
 * request to any /api/* route (chat, sources, upload, documents/*) or any
 * page gets redirected to sign-in rather than silently falling back to any
 * shared/admin credential — there is no fallback path here by design.
 *
 * WEB_AUTH_MODE=static-fallback is a deliberately TEMPORARY emergency
 * override (see resolveRequestBearerToken in lib/rag-api.ts): when Entra ID
 * sign-in is broken in production, ops can revert every user to one shared
 * static token. In that mode there is no per-user session to require, so
 * the redirect-to-sign-in check is skipped and requests are let through —
 * the fallback static token is what authorizes them downstream. Each BFF
 * route handler independently re-checks WEB_AUTH_MODE (via
 * resolveRequestBearerToken) before its own session gate, so this bypass
 * still works even when Entra ID cannot produce a session at all — this
 * middleware redirect is not the only place the mode is honored.
 *
 * Every branch below also attaches a per-request CSP nonce (see
 * buildCspHeader) — generated ONCE per request and reused for both the
 * forwarded x-nonce request header (read by app/layout.tsx via
 * next/headers, so Next.js's own script-injection machinery can apply it to
 * framework-injected inline scripts) and the outgoing
 * Content-Security-Policy response header. Using a single `nonce` value for
 * both is load-bearing: two independently generated nonces would make the
 * browser reject the very scripts the nonce is meant to allow.
 */
export default auth((req) => {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const cspHeader = buildCspHeader(nonce);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspHeader);

  const passThrough = () => {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set("Content-Security-Policy", cspHeader);
    return response;
  };

  const isAuthRoute =
    req.nextUrl.pathname === "/api/auth" ||
    req.nextUrl.pathname.startsWith("/api/auth/");
  if (isAuthRoute) return passThrough();

  if (process.env.WEB_AUTH_MODE === "static-fallback") {
    return passThrough();
  }

  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    const response = NextResponse.redirect(signInUrl);
    response.headers.set("Content-Security-Policy", cspHeader);
    return response;
  }
  return passThrough();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
