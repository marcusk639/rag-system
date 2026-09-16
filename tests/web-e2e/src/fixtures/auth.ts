import { test as base } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { E2E_ENV, WEB_PORT } from "../env.js";
import { FIXTURE_OID } from "../setup/seed.js";

/**
 * Auth.js v5 session cookie. No `__Secure-` prefix: that appears only when
 * the app is served over https, and `AUTH_URL` (env.ts) points at plain
 * http://localhost for this suite. Also note the `authjs.` prefix — NextAuth
 * v4 used `next-auth.session-token`, which this app does not.
 */
const COOKIE_NAME = "authjs.session-token";

/**
 * Mints the app's own session cookie for the synthetic fixture identity
 * instead of driving the Microsoft sign-in UI (tenant account + MFA screens
 * are out of reach here). This exercises the app's real middleware and its
 * per-identity scope-token path — only the external IdP handshake is
 * skipped, and that code is Microsoft's, not ours.
 *
 * The token MUST be minted with `encode` from `next-auth/jwt`, never
 * hand-rolled: the cookie is JWE-encrypted (alg `dir`, enc `A256CBC-HS512`)
 * with a key HKDF-derived from `AUTH_SECRET` and salted with the cookie
 * name — `salt` has no default and must be passed explicitly, or the app's
 * decoder (salted identically) will fail to decrypt it.
 */
export const test = base.extend({
  page: async ({ page, context }, use) => {
    const token = await encode({
      token: {
        // The BFF reads `session?.oid` (see apps/web/src/lib/auth.ts's
        // `session` callback) — without this claim every scoped route
        // resolves to an empty grant regardless of what was seeded.
        oid: FIXTURE_OID,
        name: "Web E2E",
        email: "web-e2e@example.com",
      },
      secret: E2E_ENV.AUTH_SECRET,
      salt: COOKIE_NAME,
    });
    await context.addCookies([
      {
        name: COOKIE_NAME,
        value: token,
        url: `http://localhost:${WEB_PORT}`,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await use(page);
  },
});

export { expect } from "@playwright/test";
