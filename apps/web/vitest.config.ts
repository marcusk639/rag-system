import path from "node:path";
import { defineConfig } from "vitest/config";

// Web-app unit tests mostly cover server-only lib functions (scope
// resolution, admin gating, Graph client) — no DOM/React rendering needed
// there, so a plain node environment is the default. Full page/user-flow
// behavior is still covered by the e2e suite (tests/web-e2e), not here —
// but a handful of `.test.tsx` files render a single component in isolation
// (jsdom, via `environmentMatchGlobs` below) to pin down markup contracts
// (e.g. `data-testid` hooks) that are cheap to assert without booting a
// browser.
export default defineConfig({
  // Matches Next.js's own JSX handling (automatic runtime, no manual React
  // import required in .tsx files) so component tests don't need an
  // `import React` that production components under the App Router don't
  // carry either.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path mapping. Tests that
    // vi.mock() every "@/..." import never need this (the mock intercepts
    // the specifier before resolution), but middleware.test.ts imports the
    // real middleware.ts, which imports "@/lib/auth" for real — Vite needs
    // this alias to resolve it without a bundler-level tsconfig plugin.
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["src/**/*.test.tsx", "jsdom"]],
    setupFiles: ["./vitest.setup.ts"],
    env: {
      // auth.ts calls NextAuth(authConfig) at module-import time, and
      // next-auth's non-lazy-config branch calls setEnvDefaults() (reading
      // process.env.AUTH_SECRET) synchronously as part of that call — before
      // any test body runs, and before a `process.env.AUTH_SECRET = ...`
      // statement inside a test file would take effect (import statements
      // are hoisted ahead of any other module-level code, so by the time
      // that assignment runs, auth.ts has already been evaluated with
      // whatever AUTH_SECRET existed at process start). `test.env` is
      // applied before vitest loads any test file, so this is the one place
      // that's early enough. Only middleware.test.ts needs this — a
      // fail-loud MissingSecret error from a misconfigured module-load-time
      // read is a fine failure mode for real Next.js deployments, but here
      // it would surface as e.g. a redirect test seeing a 500 error page
      // (still not-307, i.e. a false pass) instead of a real assertion.
      AUTH_SECRET: "test-secret-at-least-32-bytes-long-here",
    },
    server: {
      deps: {
        // next-auth (ESM) does `import { NextRequest } from "next/server"` with
        // no extension. "next" has no package.json "exports" map, so when
        // vitest treats next-auth as an externalized SSR dep (loaded via
        // Node's native import(), bypassing Vite's resolver/aliases entirely),
        // that extensionless subpath import fails to resolve — it only works
        // in real Next.js apps because their bundler (webpack/Turbopack)
        // handles it. Forcing both packages to be inlined routes them through
        // Vite's own resolution instead, which tolerates the missing extension.
        inline: ["next-auth", "next"],
      },
    },
  },
});
