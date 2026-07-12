import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

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
 */
export default auth((req) => {
  const isAuthRoute =
    req.nextUrl.pathname === "/api/auth" ||
    req.nextUrl.pathname.startsWith("/api/auth/");
  if (isAuthRoute) return NextResponse.next();

  // Unauthenticated liveness check — must succeed before anyone has signed in.
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();

  if (process.env.WEB_AUTH_MODE === "static-fallback") {
    return NextResponse.next();
  }

  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
