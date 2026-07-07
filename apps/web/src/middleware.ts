import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

/**
 * Protects every route except the Auth.js handler itself. An unauthenticated
 * request to any /api/* route (chat, sources, upload, documents/*) or any
 * page gets redirected to sign-in rather than silently falling back to any
 * shared/admin credential — there is no fallback path here by design.
 */
export default auth((req) => {
  const isAuthRoute = req.nextUrl.pathname.startsWith("/api/auth");
  if (isAuthRoute) return NextResponse.next();

  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
