import { defineConfig } from "vitest/config";

// E2E suite tuning:
//   - sequential file execution: every spec talks to one shared Postgres, so
//     parallel files would race on schema state. Within a file, tests stay
//     sequential too because they share a single ingested corpus per spec.
//   - long timeouts: docker-compose + parser cold-start dominate the first
//     spec's wall clock; subsequent specs are fast.
//   - globalSetup boots the stack once and tears it down at the very end.
export default defineConfig({
  test: {
    include: ["src/specs/**/*.spec.ts"],
    globals: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    globalSetup: ["./src/setup/global-setup.ts"],
    reporters: ["default"],
  },
});
