import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { request } from "undici";
import pg from "pg";
import { applyMigrations } from "@rag/db";
import { env } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root from tests/e2e/src/setup/
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Vitest globalSetup: ensure Postgres + parser-py are reachable, then apply
 * the DB migrations once. Tests truncate between runs so a single migrated
 * schema is reused for the whole suite.
 *
 * Honors `E2E_SKIP_DOCKER_UP=1` for CI environments where services are already
 * provisioned (workflow `services:` block). On a developer laptop, the default
 * is to bring docker-compose up if it isn't already running.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  process.stdout.write("\n[e2e] starting global setup\n");

  if (process.env.E2E_SKIP_DOCKER_UP !== "1") {
    await ensureDockerStackUp();
  }

  await waitForPostgres(env.databaseUrl, 60_000);
  await waitForParser(env.parserUrl, 60_000);

  // Delegates to the SAME two-phase logic `pnpm db:migrate` uses (bootstrap
  // `0000_init.sql`, then Drizzle's real migrator for every subsequent
  // journal-tracked file) — see `packages/db/src/migrate.ts`. A previous
  // version of this function only ran the bootstrap phase, which silently
  // left every column/table added since `0000_init.sql` missing in CI's
  // byte-fresh Postgres service container (masked in local dev, where a
  // persistent docker volume usually already has everything applied from a
  // prior manual `pnpm db:migrate`).
  await applyMigrations(env.databaseUrl);
  process.stdout.write("[e2e] migrations applied\n");

  process.stdout.write("[e2e] global setup complete\n");

  return async () => {
    // Nothing to tear down: leave docker running so the next `pnpm e2e`
    // starts fast. CI uses ephemeral runners so this is moot.
    process.stdout.write("[e2e] global teardown complete\n");
  };
}

async function ensureDockerStackUp(): Promise<void> {
  // The repo's `pnpm docker:up` uses `docker compose -f` which is broken on
  // some older Docker CLIs (build-verification-gotchas memo). Prefer the
  // hyphenated `docker-compose` binary when available; fall back to
  // `docker compose` otherwise.
  const composeFile = join(REPO_ROOT, "docker", "docker-compose.yml");
  const candidates: Array<[string, string[]]> = [
    ["docker-compose", ["-f", composeFile, "up", "-d"]],
    ["docker", ["compose", "-f", composeFile, "up", "-d"]],
  ];

  for (const [bin, args] of candidates) {
    const result = spawnSync(bin, args, { stdio: "inherit" });
    if (result.status === 0) {
      process.stdout.write(`[e2e] docker stack up via ${bin}\n`);
      return;
    }
    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      continue;
    }
    // Non-zero exit but binary existed — give the user a useful error.
    throw new Error(
      `[e2e] ${bin} ${args.join(" ")} exited with status ${result.status}`,
    );
  }

  throw new Error(
    "[e2e] no working docker compose binary found. Install Docker, or set E2E_SKIP_DOCKER_UP=1 if services are already running.",
  );
}

async function waitForPostgres(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      process.stdout.write("[e2e] postgres ready\n");
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      await wait(500);
    }
  }
  throw new Error(
    `[e2e] postgres did not become ready within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

async function waitForParser(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await request(`${url}/health`);
      if (res.statusCode === 200) {
        await res.body.dump();
        process.stdout.write("[e2e] parser ready\n");
        return;
      }
      await res.body.dump();
    } catch (err) {
      lastError = err;
    }
    await wait(500);
  }
  throw new Error(
    `[e2e] parser did not become ready within ${timeoutMs}ms: ${String(lastError)}`,
  );
}
