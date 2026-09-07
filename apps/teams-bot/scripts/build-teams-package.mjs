#!/usr/bin/env node
/**
 * Builds the uploadable Teams app package (manifest.json + icons, zipped).
 *
 * Usage (from the repo root, after `pnpm --filter @rag/teams-bot build`):
 *   MICROSOFT_APP_ID=... BOT_ENTRA_SSO_SCOPE=... DEVELOPER_NAME=... \
 *   DEVELOPER_WEBSITE_URL=... DEVELOPER_PRIVACY_URL=... DEVELOPER_TERMS_OF_USE_URL=... \
 *   node apps/teams-bot/scripts/build-teams-package.mjs
 *
 * Output: apps/teams-bot/manifest/dist/teams-app-<version>.zip
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderManifest } from "../dist/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifestDir = join(here, "..", "manifest");
const outDir = join(manifestDir, "dist");

const template = readFileSync(join(manifestDir, "manifest.json"), "utf8");
const rendered = renderManifest(template, process.env);

const parsed = JSON.parse(rendered);
const zipPath = join(outDir, `teams-app-${parsed.version}.zip`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "manifest.json"), rendered);

// -j flattens paths: Teams requires manifest.json and the icons at the zip root.
try {
  execFileSync(
    "zip",
    ["-j", "-q", zipPath, join(outDir, "manifest.json"), join(manifestDir, "color.png"), join(manifestDir, "outline.png")],
    { stdio: "inherit" },
  );
} catch (err) {
  if (err.code === "ENOENT") {
    throw new Error(
      "The 'zip' CLI is not on PATH. Install it (macOS: preinstalled; Debian/Ubuntu: " +
        "'apt-get install zip'; Alpine: 'apk add zip') and re-run.",
    );
  }
  throw err;
}

console.log(`Teams app package: ${zipPath}`);
console.log(`  app id:    ${parsed.id}`);
console.log(`  sso scope: ${parsed.webApplicationInfo.resource}`);
console.log(`Upload via Teams → Apps → Manage your apps → Upload an app.`);
