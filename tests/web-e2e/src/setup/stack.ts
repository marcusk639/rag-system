import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { request } from "undici";
import pg from "pg";
import { applyMigrations } from "@rag/db";
import { E2E_ENV } from "../env.js";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

export async function ensureStackReady(): Promise<void> {
  if (process.env.E2E_SKIP_DOCKER_UP !== "1") ensureDockerStackUp();
  await waitForPostgres(E2E_ENV.DATABASE_URL, 60_000);
  await waitForParser(E2E_ENV.PARSER_URL, 60_000);
  await applyMigrations(E2E_ENV.DATABASE_URL);
}

function ensureDockerStackUp(): void {
  const composeFile = join(REPO_ROOT, "docker", "docker-compose.yml");
  const candidates: [string, string[]][] = [
    ["docker-compose", ["-f", composeFile, "up", "-d"]],
    ["docker", ["compose", "-f", composeFile, "up", "-d"]],
  ];
  for (const [bin, args] of candidates) {
    const r = spawnSync(bin, args, { stdio: "inherit" });
    if (r.status === 0) return;
  }
  throw new Error(
    "[web-e2e] no working docker compose binary found. Install Docker, or set E2E_SKIP_DOCKER_UP=1 if services are already running.",
  );
}

async function waitForPostgres(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline)
        throw new Error(`[web-e2e] Postgres not ready: ${String(err)}`);
      await wait(1000);
    }
  }
}

async function waitForParser(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await request(`${url}/health`);
      if (res.statusCode === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("[web-e2e] parser not ready");
    await wait(1000);
  }
}
