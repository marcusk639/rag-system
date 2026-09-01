import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./migrate.js";

/**
 * The migration CLI's self-detection.
 *
 * The original guard was `import.meta.url === ` + "`file://${process.argv[1]}`"
 * + `. Two things break it in the deployed image, and both fail SILENTLY —
 * `main()` simply never runs, the process exits 0, and the deploy reports a
 * successful migration that never happened:
 *
 *   1. `process.argv[1]` is whatever the caller typed. A relative path yields
 *      `file://node_modules/...`, which never equals the absolute
 *      `import.meta.url`.
 *   2. pnpm symlinks workspace packages into `node_modules/.pnpm/`. Node
 *      resolves `import.meta.url` through the symlink to the REAL path, while
 *      argv keeps the symlink path. Measured in the production image:
 *        argv    file:///app/node_modules/@rag/db/dist/migrate.js
 *        real    file:///app/node_modules/.pnpm/@rag+db@.../dist/migrate.js
 *      They can never match, so the guard is always false there.
 *
 * Silence is the danger. A migration that throws is recoverable; one that
 * quietly does nothing while the deploy goes green is not.
 */
describe("isMainModule", () => {
  it("recognises this module when given its own real path", () => {
    const self = realpathSync(new URL(import.meta.url).pathname);
    expect(isMainModule(import.meta.url, self)).toBe(true);
  });

  it("recognises it through a relative path", () => {
    // `node dist/migrate.js` — argv[1] is not absolute.
    const self = realpathSync(new URL(import.meta.url).pathname);
    const rel = self.replace(`${process.cwd()}/`, "");
    expect(isMainModule(import.meta.url, rel)).toBe(true);
  });

  it("recognises it through a symlink, as pnpm produces", () => {
    // The real-path resolution on BOTH sides is what makes this work; comparing
    // the raw strings is what failed in production.
    const self = realpathSync(new URL(import.meta.url).pathname);
    expect(isMainModule(pathToFileURL(self).href, self)).toBe(true);
  });

  it("returns false when a different file is the entrypoint", () => {
    // Importing this module as a library must NOT trigger a CLI run against
    // process.env.DATABASE_URL — the reason the guard exists at all.
    expect(isMainModule(import.meta.url, "/some/other/entry.js")).toBe(false);
  });

  it("returns false rather than throwing when argv[1] is missing", () => {
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
  });
});
