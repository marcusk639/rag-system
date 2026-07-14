import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");

/**
 * Regression test for the "silent no-op" bug discovered 2026-07-14: the CLI
 * auto-run guard at the bottom of migrate.ts compared `import.meta.url`
 * against the entry script's path as literally typed on the command line.
 * Node resolves `import.meta.url` to the module's REAL (symlink-resolved)
 * path, but `process.argv[1]` stays exactly as typed — so the naive
 * comparison silently fails whenever the entry script is reached through a
 * symlink, which is exactly pnpm's `node_modules` layout and exactly what
 * `pnpm deploy --prod` produces for the Railway runtime image that actually
 * runs this as a `preDeployCommand`. A first fix attempt (`pathToFileURL`
 * alone, no `realpath`) looked plausible in review but did NOT actually
 * close the gap — `pathToFileURL` only reformats a string into a URL, it
 * doesn't resolve symlinks. Both are required together.
 *
 * A plain "run it with a relative/absolute path" test does NOT reproduce
 * this — on a real filesystem with no symlink involved, `import.meta.url`
 * and `process.argv[1]` already point at the same real path either way, so
 * such a test passes identically whether the guard is fixed or still buggy
 * (confirmed by hand while developing this fix: the naive-comparison
 * version passed a same-directory-only test 3/3). This test instead
 * symlinks the whole package directory to a temp location and invokes the
 * compiled entrypoint THROUGH that symlink, which is the actual mechanism
 * that broke on Railway.
 *
 * Requires `pnpm --filter @rag/db build` to have run first so `dist/`
 * exists — the guard only fires on the compiled CLI entrypoint, not on
 * `tsx`-run source (which doesn't go through `pnpm deploy --prod`).
 */
describe("migrate.ts CLI auto-run guard", () => {
  const symlinkPaths: string[] = [];

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(symlinkPaths.map((p) => rm(p, { force: true })));
  });

  async function makeSymlinkedEntry(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rag-db-guard-test-"));
    const linkPath = join(dir, "db-symlink");
    await symlink(PACKAGE_ROOT, linkPath, "dir");
    symlinkPaths.push(linkPath);
    return join(linkPath, "dist", "migrate.js");
  }

  it("runs main() when the entrypoint is reached through a symlink (the actual pnpm/Railway layout)", async () => {
    const entry = await makeSymlinkedEntry();
    await expect(
      execFileAsync("node", [entry], {
        env: { ...process.env, DATABASE_URL: "" },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("DATABASE_URL is not set"),
    });
  });

  it("runs main() when invoked with a plain relative path (baseline sanity check)", async () => {
    await expect(
      execFileAsync("node", [join("dist", "migrate.js")], {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, DATABASE_URL: "" },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("DATABASE_URL is not set"),
    });
  });

  it("does NOT auto-run when imported as a library (tests/e2e's usage)", async () => {
    const { applyMigrations } = await import("./migrate.js");
    // Importing must not have called process.exit or thrown — if the guard
    // were inverted (always-run), this test file itself would already have
    // crashed before reaching this assertion.
    expect(typeof applyMigrations).toBe("function");
  });
});
