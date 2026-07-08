import { defineConfig } from "vitest/config";

// Web-app unit tests cover server-only lib functions (scope resolution,
// admin gating, Graph client) — no DOM/React rendering needed here, so a
// plain node environment is sufficient. Component/page-level behavior is
// covered by the e2e suite (tests/e2e), not by this config.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
