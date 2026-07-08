import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import type { JWT } from "next-auth/jwt";
import middleware from "./middleware.js";
import { authConfig } from "./lib/auth.js";

/**
 * Integration-level coverage for middleware.ts + auth.ts's jwt/session
 * callbacks. Invokes the *real* Auth.js v5 `auth()`-wrapped middleware
 * against hand-constructed NextRequest objects — no mocking of next-auth,
 * no server boot, no Playwright. See .superpowers/sdd/task-5-report.md for
 * the full spike write-up (what worked, what didn't, and why).
 *
 * Empirically-confirmed details this file depends on:
 *
 *  - The session cookie name for a non-HTTPS request is the unprefixed
 *    "authjs.session-token" — the "__Secure-" prefix only applies when
 *    @auth/core determines the request is HTTPS.
 *  - The salt @auth/core uses to decode/encode that cookie's JWE is the
 *    cookie's own name, not a fixed string — see @auth/core's
 *    lib/utils/session.js and lib/actions/callback/index.js, both of which
 *    set `const salt = options.cookies.sessionToken.name`.
 *  - Auth.js's internal session lookup (triggered by the `auth()` wrapper)
 *    issues its own sub-request built from `req.headers`, and determines
 *    "is this HTTPS" from the `x-forwarded-proto` header alone (falling back
 *    to "https" when absent — see @auth/core's `createActionURL`). A real
 *    Next.js server always sets this header; a hand-built NextRequest in a
 *    test does not, so without it every request is treated as HTTPS and the
 *    middleware looks for a "__Secure-"-prefixed cookie that was never set,
 *    silently failing to recognize a valid, unprefixed session cookie. Every
 *    request below sets `x-forwarded-proto: http` to match the plain-HTTP
 *    origin used in these tests.
 */

// AUTH_SECRET is provided by vitest.config.ts's `test.env` (not set here):
// auth.ts calls NextAuth(authConfig) at *module-import* time, and next-auth
// reads process.env.AUTH_SECRET synchronously as part of that call — before
// any statement below this line would run, since import statements are
// hoisted ahead of all other module-level code. A `process.env.AUTH_SECRET =
// ...` assignment placed here would be too late and would silently mask
// itself as a false pass (a thrown MissingSecret error surfaces as some
// non-307 status, which `expect(status).not.toBe(307)` would wrongly accept).
const SESSION_COOKIE_NAME = "authjs.session-token";
const AUTH_SECRET = process.env.AUTH_SECRET!;

async function mintSessionCookie(oid: string): Promise<string> {
  return encode({
    token: { oid, sub: oid },
    secret: AUTH_SECRET,
    salt: SESSION_COOKIE_NAME,
  });
}

function makeRequest(url: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {
    "x-forwarded-proto": "http",
    host: "localhost:3000",
  };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(url, { headers });
}

function invoke(req: NextRequest) {
  // middleware's type signature (inherited from auth()'s wrapper) requires a
  // second NextFetchEvent-shaped argument; Next.js's real middleware runtime
  // always supplies one, but nothing in this codepath reads it, so an empty
  // object stands in for it here.
  return middleware(
    req as unknown as Parameters<typeof middleware>[0],
    {} as Parameters<typeof middleware>[1],
  );
}

describe("middleware", () => {
  it("redirects to /api/auth/signin when there is no session cookie", async () => {
    const req = makeRequest("http://localhost:3000/");
    const res = await invoke(req);
    expect(res?.status).toBe(307);
    expect(res?.headers.get("location")).toContain("/api/auth/signin");
  });

  it("passes through when a valid session cookie is present", async () => {
    const cookie = await mintSessionCookie("test-oid-123");
    const req = makeRequest(
      "http://localhost:3000/",
      `${SESSION_COOKIE_NAME}=${cookie}`,
    );
    const res = await invoke(req);
    expect(res?.status).toBe(200);
  });

  it("exempts /api/auth and its sub-paths from the session gate", async () => {
    const req = makeRequest("http://localhost:3000/api/auth/signin");
    const res = await invoke(req);
    expect(res?.status).toBe(200);
  });

  it("does NOT exempt a path that merely starts with /api/auth-adjacent-lookalike", async () => {
    const req = makeRequest(
      "http://localhost:3000/api/authorize-something-else",
    );
    const res = await invoke(req);
    // Still redirects — proves the exemption is an exact-or-child-path match
    // ("/api/auth" or "/api/auth/*"), not a naive startsWith("/api/auth").
    expect(res?.status).toBe(307);
  });
});

describe("auth.ts jwt callback", () => {
  // Driving this through a real Entra ID sign-in would require a full OAuth
  // authorization-code exchange (PKCE/state cookies plus a mocked token
  // endpoint) — impractical for a hand-built NextRequest. Testing the
  // callback directly (exported via authConfig for this purpose) verifies
  // the fail-closed behavior without any of that machinery.
  it("throws when the Entra ID profile is missing the oid claim", async () => {
    const jwtCallback = authConfig.callbacks!.jwt!;
    await expect(
      jwtCallback({
        token: {} as JWT,
        profile: { sub: "no-oid-here" },
      } as unknown as Parameters<typeof jwtCallback>[0]),
    ).rejects.toThrow(/oid/);
  });

  it("accepts a profile with a valid oid claim", async () => {
    const jwtCallback = authConfig.callbacks!.jwt!;
    const token = await jwtCallback({
      token: {} as JWT,
      profile: { oid: "entra-oid-456" },
    } as unknown as Parameters<typeof jwtCallback>[0]);
    expect(token?.oid).toBe("entra-oid-456");
  });
});
