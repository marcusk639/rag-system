import type { NextConfig } from "next";

/**
 * A GLBA/§7216-relevant authenticated chat UI with no security headers at all
 * (confirmed in docs/RAG-SYSTEM-EVALUATION-2026-07-13.md P1-5) — no CSP, no
 * clickjacking protection, no HSTS. Applied to every route via the catch-all
 * source pattern; Next.js merges these with any route-specific headers a
 * page/route handler sets, it does not require every route to redeclare them.
 *
 * Content-Security-Policy is NOT here: it moved to src/middleware.ts. A
 * static CSP (script-src 'self' with no nonce/unsafe-inline) breaks App
 * Router hydration — Next.js 15 injects un-nonce'd inline <script> tags to
 * deliver the RSC/flight payload, and browsers refuse to run them under such
 * a policy. The nonce that fixes this must be generated fresh per request,
 * which this static headers() array cannot do; middleware can. See
 * middleware.ts's buildCspHeader for the actual policy, which follows
 * Next.js's own documented App Router CSP guide.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
