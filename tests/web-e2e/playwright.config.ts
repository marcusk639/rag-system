import { defineConfig } from "@playwright/test";
import { E2E_ENV, API_PORT, WEB_PORT } from "./src/env.js";

export default defineConfig({
  testDir: "./src/specs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  globalSetup: "./src/setup/global-setup.ts",
  use: { baseURL: "http://localhost:3200", trace: "retain-on-failure" },
  // `start`, never `dev` — `dev` loads the developer's real .env
  // (--env-file-if-exists) into a suite whose whole premise is hermeticity.
  webServer: [
    {
      command: "pnpm --filter @rag/api start",
      url: `http://localhost:${API_PORT}/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @rag/web start",
      url: `http://localhost:${WEB_PORT}/api/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
