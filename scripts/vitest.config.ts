import { defineConfig } from "vitest/config";

/**
 * Local config so this package does not inherit the repo-root
 * `vitest.workspace.ts`. That file lists project GLOBS (`packages/*`,
 * `apps/*`), which resolve relative to whichever directory vitest runs in —
 * harmless when they match nothing, but a literal `scripts` entry there
 * resolves to `scripts/scripts` and is a hard startup error. Keeping this
 * package out of the workspace list and configuring it directly avoids that.
 */
export default defineConfig({
  test: {
    include: ["*.test.ts"],
    root: import.meta.dirname,
  },
});
