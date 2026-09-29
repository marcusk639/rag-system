import { defineConfig } from "@playwright/test";
import { E2E_ENV, API_PORT, WEB_PORT } from "./src/env.js";

/**
 * Verifies wiring and UI behavior (auth, scope, citations, refusal rendering)
 * against a small synthetic corpus, with local bge-base embeddings and a local
 * llama3.1:8b generator. It is not an answer-quality signal for production,
 * which uses different models; answer quality is measured by `pnpm eval:gold`.
 */
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
