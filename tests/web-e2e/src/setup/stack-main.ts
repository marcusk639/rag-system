import { ensureStackReady } from "./stack.js";

/**
 * Standalone entry for `ensureStackReady()`, run as the first half of the API
 * `webServer` command in playwright.config.ts.
 *
 * Why not globalSetup: Playwright launches `webServer` BEFORE `globalSetup`.
 * The API refuses to boot without a reachable, migrated database (its startup
 * index assertion), so bootstrapping from globalSetup meant the suite could
 * only pass on a machine where the stack was already up and migrated — and
 * failed on every clean CI runner before a single test ran.
 */
ensureStackReady()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[web-e2e] stack bootstrap failed:", err);
    process.exit(1);
  });
