import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/specs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: { baseURL: "http://localhost:3200", trace: "retain-on-failure" },
});
