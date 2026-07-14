import type { NextConfig } from "next";

/**
 * A GLBA/§7216-relevant authenticated chat UI with no security headers at all
 * (confirmed in docs/RAG-SYSTEM-EVALUATION-2026-07-13.md P1-5) — no CSP, no
 * clickjacking protection, no HSTS. Applied to every route via the catch-all
 * source pattern; Next.js merges these with any route-specific headers a
 * page/route handler sets, it does not require every route to redeclare them.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    // 'unsafe-inline' on style-src only: Next.js injects inline styles for
    // its own CSS-in-JS/font optimization; script-src has no 'unsafe-inline'
    // or 'unsafe-eval' — this is the actual XSS defense-in-depth layer.
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
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
