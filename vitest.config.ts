import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**", "packages/*/src/**"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.generated.ts",
        "**/dist/**",
      ],
      // Thresholds are set to the measured baseline (Step 5) minus a small
      // buffer, then ratcheted up over time. They exist to prevent regression,
      // not to claim the 80% target is met today.
      // Measured baseline (2026-07-15, 58 test files / 502 tests, all green):
      // Stmts 45.86% / Branch 76.85% / Funcs 59.58% / Lines 45.86%.
      // Thresholds below are floor(measured - 5) per metric.
      thresholds: {
        lines: 40,
        functions: 54,
        branches: 71,
        statements: 40,
      },
    },
  },
});
