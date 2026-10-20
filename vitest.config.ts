import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * One project per package/app, rooted in its own directory (tests rely on
 * that cwd). A package with its own vitest config uses it; the rest extend
 * this file so they inherit the dist/ exclude below.
 */
function unitProjects() {
  return ["packages", "apps"]
    .flatMap((group) =>
      readdirSync(path.join(import.meta.dirname, group)).map((name) =>
        path.join(group, name),
      ),
    )
    .filter((dir) =>
      existsSync(path.join(import.meta.dirname, dir, "package.json")),
    )
    .map((dir) =>
      existsSync(path.join(import.meta.dirname, dir, "vitest.config.ts"))
        ? dir
        : { extends: true as const, test: { name: dir, root: dir } },
    );
}

export default defineConfig({
  test: {
    // Unit-test projects for a repo-root run (`pnpm test:coverage`). tests/e2e
    // is excluded (requires Docker) and runs via `pnpm e2e`; examples/ are not
    // part of the quality gate. Replaces vitest.workspace.ts (removed in
    // Vitest 4). Vitest also finds this file from inside each package, where
    // these root-relative globs match nothing and are a startup error — so
    // they apply only when running at the root.
    ...(process.cwd() === import.meta.dirname
      ? { projects: unitProjects() }
      : {}),
    // Vitest 4 no longer excludes dist/ by default, and compiled copies of the
    // test files live there.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.generated.ts",
        "**/dist/**",
      ],
      // Thresholds are the measured baseline minus a small buffer, ratcheted
      // up over time. They exist to prevent regression, not to claim the 80%
      // target is met.
      // Re-baselined 2026-10-19 on the Vitest 4 upgrade (123 files / 1341
      // tests): Stmts 60.86% / Branch 57.94% / Funcs 57.56% / Lines 61.69%.
      // Vitest 4's v8 provider remaps coverage onto the source AST, which
      // counts branches differently from v2 (2026-07-15 baseline: Branch
      // 76.85%, Lines 45.86%), so the old numbers are not comparable.
      // Thresholds below are floor(measured - 5) per metric.
      thresholds: {
        lines: 56,
        functions: 52,
        branches: 52,
        statements: 55,
      },
    },
  },
});
