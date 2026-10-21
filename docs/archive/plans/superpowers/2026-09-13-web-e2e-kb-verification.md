# Web E2E KB Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Playwright suite that proves, through the real web UI, that the KB retrieves, that rendered citations resolve to real documents, and that a refusal renders as a refusal.

**Architecture:** A new `tests/web-e2e` workspace package boots four processes — docker (Postgres + parser), a listening `apps/api`, `next start`, and Playwright — seeds a two-document fixture corpus with the local ONNX embedder, mints an Auth.js session cookie, and asserts invariants only. The fixtures are their own oracle, so no golden corpus is needed.

**Tech Stack:** Playwright, TypeScript, pnpm workspaces, Ollama (OpenAI-compatible generation), ONNX local embeddings, Postgres + pgvector.

**Spec:** `docs/superpowers/specs/2026-09-13-web-e2e-kb-verification-design.md`

## Global Constraints

- Package name `@rag/web-e2e`, at `tests/web-e2e`. It exposes `test:browser`, **never** `test` — `.husky/pre-push:15` runs `pnpm -r --filter '!@rag/e2e' run test`, and a `test` script would boot docker and download models on every push.
- Do **not** import from `@rag/e2e`: it has no `main`, no `exports`, no build script, and Playwright's TS transform does not reach into `node_modules`. Copy the ~40 lines needed.
- `EMBEDDING_PROVIDER=local`, `EMBEDDING_MODEL=Xenova/bge-base-en-v1.5`, `EMBEDDING_DIMENSIONS=768` on both the seeding and querying sides. A mismatch degrades retrieval to the sparse channel **silently**.
- Pass `{ chunkSize: 512 }` to `runOneIngestion` explicitly. The env var does not reach it — it takes `overrides?.chunkSize ?? 800`.
- `GENERATION_PROVIDER=openai` (never `gemini` with a base URL — it throws at startup), `GENERATION_MODEL=llama3.1:8b`, `GENERATION_BASE_URL=http://127.0.0.1:11434/v1`, `EGRESS_ALLOWED_HOSTS=127.0.0.1`, `GENERATION_TRI_POLICY=warn`. Leave `GENERATION_API_KEY` unset.
- `API_TOKENS` must be non-empty or `apps/api` exits before listening. `API_PORT=3100` and web `PORT=3200` — both default to 3000 and would collide.
- `INTERNAL_SCOPE_JWT_SECRET` (web, singular) **and** `INTERNAL_SCOPE_JWT_SECRETS` (API, plural) must both be set to the same ≥64-char value.
- `AUTH_URL=http://localhost:3200` — under `next start`, `NODE_ENV=production` makes `trustHost` false and `auth()` errors on every navigation.
- Start `apps/api` with `start` (compiled `dist/`), never `dev` — `dev` loads the developer's real `.env`.
- Fixture text must not contain `1099`/`W2` near an amount. The generation gate scans the whole assembled top-k.
- Every citation assertion asserts a **non-empty** chip set first. Otherwise `[].every(...)` is vacuously true and the assertion fails open.

## Prerequisites (before Task 1)

Ollama must be running with the model pulled, or Task 5 onward cannot answer.
Per `docs/LOCAL-GENERATION.md`:

```bash
brew install ollama          # macOS; see ollama.com for Linux/CI
ollama serve &               # listens on 127.0.0.1:11434
ollama pull llama3.1:8b      # ~4.7GB — the slow step; CI caches this

# verify the OpenAI-compatible surface answers, not just that the port is open
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.1:8b","messages":[{"role":"user","content":"reply with OK"}]}'
```

Measured behaviour this plan relies on: 8/8 answerable questions emitted a
parseable `[N]` citation, 6/6 out-of-corpus questions produced the exact refusal
sentence **and carried a citation**, at ~5s per call.

---

## File Structure

| File                                                        | Responsibility                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `tests/web-e2e/package.json`                                | Package manifest; `test:browser` script                                    |
| `tests/web-e2e/playwright.config.ts`                        | Runner config, `globalSetup`, two `webServer` entries                      |
| `tests/web-e2e/src/env.ts`                                  | One place defining every env var the four processes need                   |
| `tests/web-e2e/src/setup/stack.ts`                          | Copied docker-wait + `applyMigrations`                                     |
| `tests/web-e2e/src/setup/seed.ts`                           | Fixture corpus, ingestion, access grant, coherence + compliance assertions |
| `tests/web-e2e/src/setup/global-setup.ts`                   | Orchestrates stack → seed → preconditions                                  |
| `tests/web-e2e/src/fixtures/auth.ts`                        | Playwright fixture minting the Auth.js session cookie                      |
| `tests/web-e2e/src/fixtures/sse.ts`                         | `tee()`-based SSE capture init script                                      |
| `tests/web-e2e/src/specs/*.spec.ts`                         | The five assertions                                                        |
| `apps/web/src/components/chat-interface/chat-interface.tsx` | `data-testid` hooks; error rendering lifted into its own element           |

---

## Task 1: Scaffold the package and prove Playwright runs

**Files:**

- Create: `tests/web-e2e/package.json`, `tests/web-e2e/tsconfig.json`, `tests/web-e2e/playwright.config.ts`
- Create test: `tests/web-e2e/src/specs/smoke.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: the `@rag/web-e2e` package and `pnpm --filter @rag/web-e2e test:browser`.

- [ ] **Step 1: Write the failing test**

`tests/web-e2e/src/specs/smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("playwright runs in this package", async () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/web-e2e test:browser`
Expected: FAIL — the package does not exist yet.

- [ ] **Step 3: Create the package**

`tests/web-e2e/package.json`:

```json
{
  "name": "@rag/web-e2e",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test:browser": "playwright test",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0"
  },
  "dependencies": {
    "@rag/db": "workspace:*",
    "@rag/core": "workspace:*",
    "@rag/rag": "workspace:*",
    "@rag/ingestion": "workspace:*",
    "@rag/test-fixtures": "workspace:*",
    "next-auth": "5.0.0-beta.31",
    "pg": "^8.13.1",
    "undici": "^7.2.0",
    "pino": "^9.5.0"
  }
}
```

`tests/web-e2e/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src/**/*", "playwright.config.ts"]
}
```

`tests/web-e2e/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/specs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: { baseURL: "http://localhost:3200", trace: "retain-on-failure" },
});
```

- [ ] **Step 4: Install and run**

```bash
pnpm install
pnpm --filter @rag/web-e2e exec playwright install chromium
pnpm --filter @rag/web-e2e test:browser
```

Expected: PASS, 1 test.

- [ ] **Step 5: Verify the pre-push hook ignores it**

Run: `pnpm -r --filter '!@rag/e2e' run test --if-present 2>&1 | grep -c web-e2e || true`
Expected: `0` — the package has no `test` script, so pnpm skips it.

- [ ] **Step 6: Commit**

```bash
git add tests/web-e2e pnpm-lock.yaml
git commit -m "test(web-e2e): scaffold the browser e2e package"
```

---

## Task 2: Central env module and the copied stack boot

**Files:**

- Create: `tests/web-e2e/src/env.ts`, `tests/web-e2e/src/setup/stack.ts`
- Test: `tests/web-e2e/src/specs/stack.spec.ts`

**Interfaces:**

- Consumes: Task 1's package.
- Produces: `E2E_ENV` (a `Record<string, string>` of every var the four processes need), `API_PORT`/`WEB_PORT` constants, and `ensureStackReady(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/web-e2e/src/specs/stack.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../env.js";

test("migrations have been applied to the e2e database", async () => {
  const client = new pg.Client({ connectionString: E2E_ENV.DATABASE_URL });
  await client.connect();
  const r = await client.query("select to_regclass('public.chunks') as t");
  await client.end();
  expect(r.rows[0].t).toBe("chunks");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/web-e2e test:browser src/specs/stack.spec.ts`
Expected: FAIL — `../env.js` does not exist.

- [ ] **Step 3: Write `src/env.ts`**

```ts
export const API_PORT = 3100;
export const WEB_PORT = 3200;

const SECRET64 = "e".repeat(64);

/**
 * Every variable the four processes need, in one place.
 *
 * ⚠ Harness-only and production-hostile. EGRESS_ALLOWED_HOSTS REPLACES rather
 * than merges, so copying this to a deployed service drops
 * generativelanguage.googleapis.com and stops ingestion and answering alike.
 */
export const E2E_ENV: Record<string, string> = {
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag",
  PARSER_URL: process.env.E2E_PARSER_URL ?? "http://localhost:8000",

  EMBEDDING_PROVIDER: "local",
  EMBEDDING_MODEL: "Xenova/bge-base-en-v1.5",
  EMBEDDING_DIMENSIONS: "768",
  CHUNK_SIZE: "512",

  GENERATION_PROVIDER: "openai",
  GENERATION_MODEL: "llama3.1:8b",
  GENERATION_BASE_URL: "http://127.0.0.1:11434/v1",
  EGRESS_ALLOWED_HOSTS: "127.0.0.1",
  GENERATION_TRI_POLICY: "warn",

  API_PORT: String(API_PORT),
  API_TOKENS: "web-e2e-token",
  INTERNAL_SCOPE_JWT_SECRETS: SECRET64,

  PORT: String(WEB_PORT),
  RAG_API_URL: `http://localhost:${API_PORT}`,
  INTERNAL_SCOPE_JWT_SECRET: SECRET64,
  AUTH_SECRET: "web-e2e-auth-secret-at-least-32-chars-long",
  AUTH_URL: `http://localhost:${WEB_PORT}`,
  AUTH_ENTRA_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
  AUTH_ENTRA_CLIENT_SECRET: "dummy",
  AUTH_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  WEB_AUTH_MODE: "entra",
};
```

- [ ] **Step 4: Write `src/setup/stack.ts`**

Copied from `tests/e2e/src/setup/global-setup.ts` rather than imported, per Global Constraints.

```ts
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
```

- [ ] **Step 5: Wire globalSetup and run**

`tests/web-e2e/src/setup/global-setup.ts`:

```ts
import { ensureStackReady } from "./stack.js";

export default async function globalSetup(): Promise<void> {
  await ensureStackReady();
}
```

Add `globalSetup: "./src/setup/global-setup.ts"` to `playwright.config.ts`.

Run: `pnpm --filter @rag/web-e2e test:browser src/specs/stack.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/web-e2e
git commit -m "test(web-e2e): boot the docker stack and apply migrations"
```

---

## Task 3: Seed the fixture corpus with the local embedder

**Files:**

- Create: `tests/web-e2e/src/fixtures/corpus.ts`, `tests/web-e2e/src/setup/seed.ts`
- Modify: `tests/web-e2e/src/setup/global-setup.ts`
- Test: `tests/web-e2e/src/specs/seed.spec.ts`

**Interfaces:**

- Consumes: `ensureStackReady`, `E2E_ENV`.
- Produces: `FIXTURE_SOURCE_NAME`, `NONCE_A`, `NONCE_B`, and `seedCorpus(): Promise<{ sourceId: string }>`.

- [ ] **Step 1: Write the failing test**

`tests/web-e2e/src/specs/seed.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../env.js";

test("every chunk was embedded by the local provider", async () => {
  const client = new pg.Client({ connectionString: E2E_ENV.DATABASE_URL });
  await client.connect();
  const r = await client.query(
    "select distinct embedding_provider, embedding_model from chunks",
  );
  await client.end();
  expect(r.rowCount).toBe(1);
  expect(r.rows[0].embedding_provider).toBe("local");
  expect(r.rows[0].embedding_model).toBe("Xenova/bge-base-en-v1.5");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/web-e2e test:browser src/specs/seed.spec.ts`
Expected: FAIL — `rowCount` is 0; nothing is seeded.

- [ ] **Step 3: Write the fixture corpus**

`tests/web-e2e/src/fixtures/corpus.ts`. Nonces are unique strings so retrieval has an exact oracle. No `1099`/`W2` near amounts.

```ts
import { markdownDoc } from "@rag/test-fixtures";

export const FIXTURE_SOURCE_NAME = "web-e2e-fixture-source";
export const NONCE_A = "zephyrine-quokka";
export const NONCE_B = "marmalade-thistledown";

export const FIXTURE_DOCS = [
  markdownDoc({
    externalId: "web-e2e-onboarding",
    title: "Admin - SOP - New Client Onboarding",
    markdown: [
      "# New Client Onboarding",
      "",
      `The first step is to open a Karbon work item named "Client Intake".`,
      `Completing the ${NONCE_A} checklist is mandatory before any engagement`,
      "letter is countersigned.",
    ].join("\n"),
  }),
  markdownDoc({
    externalId: "web-e2e-facilities",
    title: "Admin - Note - Office Equipment",
    markdown: [
      "# Office Equipment",
      "",
      "Printers are serviced quarterly by the facilities vendor.",
      `Toner is ordered against the ${NONCE_B} purchase code.`,
    ].join("\n"),
  }),
];
```

- [ ] **Step 4: Write the seeder**

`tests/web-e2e/src/setup/seed.ts`:

```ts
import { FakeConnector } from "@rag/test-fixtures";
// NOTE: LocalEmbeddingProvider is NOT exported from @rag/rag — only the factory
// is. Do not reach for a deep dist path; use createEmbeddingProvider.
import { createEmbeddingProvider } from "@rag/rag";
import { createDb } from "@rag/db";
import { runOneIngestion } from "./ingestion.js";
import { E2E_ENV } from "../env.js";
import { FIXTURE_DOCS, FIXTURE_SOURCE_NAME } from "../fixtures/corpus.js";

export async function seedCorpus(): Promise<{ sourceId: string }> {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    const sourceId = await createFixtureSource(db);
    await runOneIngestion(db, sourceId, new FakeConnector(FIXTURE_DOCS), {
      // MUST be passed explicitly — runOneIngestion never reads env and would
      // otherwise chunk at 800, exceeding the local model's 512-token limit.
      chunkSize: 512,
      embedder: createEmbeddingProvider({
        provider: "local",
        model: E2E_ENV.EMBEDDING_MODEL,
        dimensions: 768,
      } as Config["embedding"]),
    });
    return { sourceId };
  } finally {
    await close();
  }
}
```

Per the copy-don't-import constraint, write `tests/web-e2e/src/setup/ingestion.ts` in full rather than importing from `@rag/e2e`:

```ts
import pino from "pino";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { runIngestion, type PipelineRunResult } from "@rag/ingestion";
import {
  loadPack,
  type Connector,
  type EmbeddingProvider,
  type LoadedPack,
} from "@rag/core";
import { createSource, type Db } from "@rag/db";
import { join } from "node:path";
import { E2E_ENV } from "../env.js";
import { FIXTURE_SOURCE_NAME } from "../fixtures/corpus.js";

// The pipeline refuses to run without a scanner pack; wire the real one.
const CPA_PACK: LoadedPack = loadPack(
  join(process.cwd(), "..", "..", "packs", "cpa"),
);

export async function createFixtureSource(db: Db): Promise<string> {
  const row = await createSource(db, {
    kind: "custom",
    name: FIXTURE_SOURCE_NAME,
    config: {},
  });
  return row.id;
}

export async function runOneIngestion(
  db: Db,
  sourceId: string,
  connector: Connector,
  overrides: { chunkSize: number; embedder: EmbeddingProvider },
): Promise<PipelineRunResult> {
  const logger = pino({ level: "silent" });
  const parser = new HttpParserClient(E2E_ENV.PARSER_URL, 60_000, undefined);
  const chunker = new CompositeChunker({
    markdown: { chunkSize: overrides.chunkSize, chunkOverlap: 120 },
    table: { chunkSize: overrides.chunkSize, rowOverlap: 2 },
  });

  return runIngestion(
    sourceId,
    connector,
    null, // cursor
    { concurrency: 2, pageSize: 50 },
    {
      db,
      parser,
      chunker,
      embedder: overrides.embedder,
      logger,
      // An undeclared source class fails CLOSED to "D" and quarantines every
      // document. Fixtures are synthetic public content — declare Class A.
      sourceDocClass: "A",
      pack: CPA_PACK,
    },
  );
}
```

Note `overrides` is required here, not optional as in the `@rag/e2e` original: the whole point is that `chunkSize` and `embedder` must never fall back to their defaults (800 and `FakeEmbedder`).

- [ ] **Step 5: Call it from globalSetup and run**

Add to `global-setup.ts` after `ensureStackReady()`:

```ts
const { sourceId } = await seedCorpus();
process.env.E2E_SOURCE_ID = sourceId;
```

Run: `pnpm --filter @rag/web-e2e test:browser src/specs/seed.spec.ts`
Expected: PASS. First run downloads ~430 MB of ONNX weights.

- [ ] **Step 6: Verify the coherence assertion actually fires**

Temporarily drop the `embedder` option so `runOneIngestion` falls back to `FakeEmbedder`, re-run, and confirm the test FAILS with `fake-bow-768`. Restore the option.

- [ ] **Step 7: Commit**

```bash
git add tests/web-e2e
git commit -m "test(web-e2e): seed a fixture corpus with the local embedder"
```

---

## Task 4: Access grant — the fail-open guard

**Files:**

- Modify: `tests/web-e2e/src/setup/seed.ts`, `tests/web-e2e/src/setup/global-setup.ts`
- Test: `tests/web-e2e/src/specs/grant.spec.ts`

**Interfaces:**

- Consumes: `seedCorpus`.
- Produces: `FIXTURE_OID` and `grantFixtureAccess(sourceId: string): Promise<void>`.

Without this, `resolveSourceIdsForUser` returns `[]`, retrieval is fail-closed to zero rows, and the refusal assertion passes for entirely the wrong reason.

- [ ] **Step 1: Write the failing test**

`tests/web-e2e/src/specs/grant.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createDb, resolveSourceIdsForUser } from "@rag/db";
import { E2E_ENV } from "../env.js";
import { FIXTURE_OID } from "../setup/seed.js";

test("the fixture user is scoped to at least one source", async () => {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    const ids = await resolveSourceIdsForUser(db, FIXTURE_OID);
    expect(ids.length).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/web-e2e test:browser src/specs/grant.spec.ts`
Expected: FAIL — `ids.length` is 0.

- [ ] **Step 3: Add the grant**

In `seed.ts`:

```ts
import { grantSourceAccess } from "@rag/db";

export const FIXTURE_OID = "web-e2e-fixture-user-oid";

export async function grantFixtureAccess(sourceId: string): Promise<void> {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    await grantSourceAccess(db, {
      userId: FIXTURE_OID,
      sourceId,
      grantedBy: "web-e2e-setup",
    });
    const ids = await resolveSourceIdsForUser(db, FIXTURE_OID);
    if (ids.length === 0) {
      throw new Error(
        "[web-e2e] access grant did not resolve — every retrieval assertion would pass for the wrong reason.",
      );
    }
  } finally {
    await close();
  }
}
```

- [ ] **Step 4: Call it from globalSetup and run**

Add `await grantFixtureAccess(sourceId);` after `seedCorpus()`.

Run: `pnpm --filter @rag/web-e2e test:browser src/specs/grant.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/web-e2e
git commit -m "test(web-e2e): seed and assert the fixture access grant"
```

---

## Task 5: Boot the API and web app, and gate on model compliance

**Files:**

- Modify: `tests/web-e2e/playwright.config.ts`, `tests/web-e2e/src/setup/global-setup.ts`
- Test: `tests/web-e2e/src/specs/compliance.spec.ts`

**Interfaces:**

- Consumes: `E2E_ENV`, `API_PORT`, `WEB_PORT`.
- Produces: two running servers and `assertModelEmitsCitations(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/web-e2e/src/specs/compliance.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { E2E_ENV, API_PORT } from "../env.js";

test("the API answers with at least one citation", async ({ request }) => {
  const res = await request.post(`http://localhost:${API_PORT}/ask`, {
    headers: { authorization: `Bearer ${E2E_ENV.API_TOKENS}` },
    data: { question: "What is the first step to onboard a new client?" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.citations.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/web-e2e test:browser src/specs/compliance.spec.ts`
Expected: FAIL — connection refused; no API is listening.

- [ ] **Step 3: Add both servers to the config**

In `playwright.config.ts`. `start`, never `dev` — `dev` would load the developer's real `.env`.

```ts
import { E2E_ENV, API_PORT, WEB_PORT } from "./src/env.js";

// inside defineConfig:
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
```

- [ ] **Step 4: Build first, then run**

```bash
pnpm -r build
pnpm --filter @rag/web-e2e test:browser src/specs/compliance.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Add the precondition to globalSetup**

So a non-compliant model fails once and loudly, rather than as one red and two false-green assertions.

```ts
const res = await fetch(`http://localhost:${API_PORT}/ask`, {/* as above */});
const body = await res.json();
if (!body.citations?.length) {
  throw new Error(
    "[web-e2e] the configured generation model did not emit [N] markers — citation assertions cannot be trusted.",
  );
}
```

Note this runs before `webServer` in Playwright's ordering, so instead call it from the first spec's `beforeAll` or keep it as `compliance.spec.ts` ordered first via filename. Prefer the spec: it reports as a normal failure.

- [ ] **Step 6: Commit**

```bash
git add tests/web-e2e
git commit -m "test(web-e2e): boot api+web and gate on citation-marker compliance"
```

---

## Task 6: Production testids, including the error/refusal split

**Files:**

- Modify: `apps/web/src/components/chat-interface/chat-interface.tsx`
- Test: `apps/web/src/components/chat-interface/chat-interface.test.tsx`

**Interfaces:**

- Consumes: nothing.
- Produces: `data-testid` values `assistant-message`, `citation-chip`, `refusal`, `stream-error`.

Two of these are attributes; two are real changes. There is no error element today — the error path appends into `message.content`, so a stream error and a refusal are the same DOM node.

- [ ] **Step 1: Write the failing test**

```tsx
it("renders a stream error in its own element, not in the message body", () => {
  render(
    <ChatInterface
      messages={[{ id: "1", role: "assistant", content: "", error: "boom" }]}
    />,
  );
  expect(screen.getByTestId("stream-error")).toHaveTextContent("boom");
  expect(screen.getByTestId("assistant-message")).not.toHaveTextContent("boom");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/web test -- chat-interface`
Expected: FAIL — no `stream-error` testid exists.

- [ ] **Step 3: Implement**

Add `error?: string` to the message type. Change `onError` to set it rather than append:

```tsx
onError: (message) => updateMessage(assistantId, { error: message }),
```

Render it separately, and tag the existing nodes:

```tsx
<div
  data-testid="assistant-message"
  className="prose prose-sm max-w-none break-words"
>
  <ReactMarkdown>{message.content || "…"}</ReactMarkdown>
</div>;
{
  message.error && (
    <div data-testid="stream-error" className="mt-2 text-xs text-red-700">
      {message.error}
    </div>
  );
}
{
  message.content.includes(EMPTY_ANSWER) && <span data-testid="refusal" />;
}
```

Add `data-testid="citation-chip"` to the existing `<button>`.

**`EMPTY_ANSWER` is currently un-exported** — it is a module-private const at `packages/services/src/ask.ts:73`. Do not duplicate the sentence into the web app; a refusal string that drifts between service and UI is exactly the silent failure this suite exists to catch. Export it as a sub-step:

```ts
// packages/services/src/ask.ts:73 — change `const EMPTY_ANSWER =` to:
export const EMPTY_ANSWER =
// packages/services/src/index.ts — add EMPTY_ANSWER to the existing ./ask.js export block
```

Then `import { EMPTY_ANSWER } from "@rag/services";` in the component, adding `"@rag/services": "workspace:*"` to `apps/web/package.json` if absent.

Use `.includes()`, not `===`: branch C appends `Closest related material: <title> [N]` after the sentence, so equality would classify a real refusal as a non-refusal. Classifying by "zero citations" would be circular, and is wrong anyway — measured refusals carry a citation.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @rag/web test -- chat-interface`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): give errors their own element and add test hooks"
```

---

## Task 7: Auth fixture and the SSE tee

**Files:**

- Create: `tests/web-e2e/src/fixtures/auth.ts`, `tests/web-e2e/src/fixtures/sse.ts`
- Test: `tests/web-e2e/src/specs/auth.spec.ts`

**Interfaces:**

- Consumes: `E2E_ENV`, `FIXTURE_OID`.
- Produces: a `test` export with an authenticated `page`, and `captureSse(page)` / `readSse(page)`.

- [ ] **Step 1: Write the failing test**

`tests/web-e2e/src/specs/auth.spec.ts`:

```ts
import { test, expect } from "../fixtures/auth.js";

import { FIXTURE_SOURCE_NAME } from "../fixtures/corpus.js";

test("the minted cookie reaches a gated route and sees the fixture source", async ({
  page,
}) => {
  const res = await page.goto("/api/sources");
  expect(res?.status()).toBe(200);
  // Not just 200: listPublicSources is scope-filtered, so a missing access
  // grant would return 200 with an empty list. This is assertion 0.
  expect(await res!.text()).toContain(FIXTURE_SOURCE_NAME);
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — `../fixtures/auth.js` does not exist.

- [ ] **Step 3: Write the auth fixture**

The token is JWE-encrypted, salted with the cookie name, so use `encode` — never a hand-rolled JWT. `salt` has no default.

```ts
import { test as base } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { E2E_ENV, WEB_PORT } from "../env.js";
import { FIXTURE_OID } from "../setup/seed.js";

const COOKIE_NAME = "authjs.session-token"; // no __Secure- prefix on http

export const test = base.extend({
  page: async ({ page, context }, use) => {
    const token = await encode({
      token: {
        oid: FIXTURE_OID,
        name: "Web E2E",
        email: "web-e2e@example.com",
      },
      secret: E2E_ENV.AUTH_SECRET,
      salt: COOKIE_NAME,
    });
    await context.addCookies([
      {
        name: COOKIE_NAME,
        value: token,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await use(page);
  },
});

export { expect } from "@playwright/test";
```

- [ ] **Step 4: Write the SSE tee**

`page.route()` would buffer the body and destroy the streaming under test. `tee()` keeps the app's branch unbuffered. The test branch must be drained or it buffers without bound.

```ts
import type { Page } from "@playwright/test";

export async function captureSse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__sse = [];
    const orig = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await orig(...args);
      const url =
        typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
      if (!url.includes("/api/chat") || !res.body) return res;
      const [appBranch, testBranch] = res.body.tee();
      void (async () => {
        const reader = testBranch.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          (window as any).__sse.push(decoder.decode(value, { stream: true }));
        }
      })();
      return new Response(appBranch, {
        status: res.status,
        headers: res.headers,
      });
    };
  });
}

export async function readSse(page: Page): Promise<string> {
  return page.evaluate(() => ((window as any).__sse as string[]).join(""));
}
```

- [ ] **Step 5: Run**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/web-e2e
git commit -m "test(web-e2e): mint a session cookie and tee the SSE stream"
```

---

## Task 8: The four UI assertions

**Files:**

- Create: `tests/web-e2e/src/specs/kb.spec.ts`

**Interfaces:**

- Consumes: the auth fixture, `captureSse`/`readSse`, `NONCE_A`.
- Produces: the suite's actual coverage.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from "../fixtures/auth.js";
import { captureSse, readSse } from "../fixtures/sse.js";
import { NONCE_A } from "../fixtures/corpus.js";

const REFUSAL =
  "The available documents do not contain enough information to answer that.";

async function ask(page, question: string) {
  await page.goto("/");
  await page.getByRole("textbox").fill(question);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assistant-message")).toBeVisible({
    timeout: 90_000,
  });
}

test("citations resolve to real documents", async ({ page, request }) => {
  await ask(page, `What does the ${NONCE_A} checklist gate?`);
  const chips = page.getByTestId("citation-chip");
  await expect(chips).not.toHaveCount(0); // non-vacuous: [].every() is true
  for (const chip of await chips.all()) {
    const title = (await chip.textContent())!.replace(/^\[\d+\]\s*/, "");
    const res = await request.get(
      `/api/documents/${await chip.getAttribute("data-doc-id")}`,
    );
    expect(res.status()).toBe(200);
    expect((await res.json()).title).toBe(title);
  }
});

test("self-retrieval: the nonce document is cited", async ({ page }) => {
  await ask(page, `What does the ${NONCE_A} checklist gate?`);
  await expect(page.getByTestId("citation-chip").first()).toContainText(
    "New Client Onboarding",
  );
});

test("an out-of-corpus question is refused, not confabulated", async ({
  page,
}) => {
  await ask(
    page,
    "What is our policy on controlled foreign corporation transfer pricing?",
  );
  await expect(page.getByTestId("assistant-message")).toContainText(REFUSAL);
  // Citations ARE permitted: branch C appends "Closest related material: <title> [N]".
  await expect(page.getByTestId("stream-error")).toHaveCount(0);
});

test("rendered chips equal the citations the BFF returned", async ({
  page,
}) => {
  await captureSse(page);
  await ask(page, `What does the ${NONCE_A} checklist gate?`);
  const chips = page.getByTestId("citation-chip");
  await expect(chips).not.toHaveCount(0);
  const frame = (await readSse(page))
    .split("\n")
    .find((l) => l.startsWith("data:") && l.includes("citations"));
  const payload = JSON.parse(frame!.slice(5));
  expect(await chips.count()).toBe(payload.citations.length);
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — `data-doc-id` is not yet on the chip.

- [ ] **Step 3: Add the document id to the chip**

In `chat-interface.tsx`, add `data-doc-id={c.documentId}` to the citation button.

- [ ] **Step 4: Run**

Run: `pnpm --filter @rag/web-e2e test:browser`
Expected: all PASS.

- [ ] **Step 5: Mutation-check each assertion**

Each must fail under its own mutation, or it is not pinning what it claims:

| Mutation                                                    | Must fail                                |
| ----------------------------------------------------------- | ---------------------------------------- |
| Delete the citation-rendering block in `chat-interface.tsx` | citations-resolve, chips-equal-citations |
| Remove `grantFixtureAccess` from globalSetup                | grant spec, self-retrieval               |
| Drop the `embedder` option in `seed.ts`                     | seed coherence spec                      |

Restore after each.

- [ ] **Step 6: Commit**

```bash
git add tests/web-e2e apps/web
git commit -m "test(web-e2e): assert citation resolution, self-retrieval, refusal and UI faithfulness"
```

---

## Task 9: CI job and pre-push guard

**Files:**

- Create: `.github/workflows/web-e2e.yml`
- Modify: `.husky/pre-push`

- [ ] **Step 1: Widen the pre-push filter**

`.husky/pre-push:15` — change `'!@rag/e2e'` to `'!@rag/*e2e'`. Belt-and-braces: the real protection is that the package exposes `test:browser`, and pnpm skips packages without the named script.

- [ ] **Step 2: Verify it excludes the package**

Run: `pnpm -r --filter '!@rag/*e2e' list --depth -1 | grep -c web-e2e || true`
Expected: `0`.

- [ ] **Step 3: Add the workflow**

No secrets — generation and embedding are both local. Caches, not secrets:

```yaml
name: Web E2E
on: [pull_request]
jobs:
  web-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: actions/cache@v4
        with:
          path: ~/.cache/huggingface
          key: hf-${{ runner.os }}-bge-base-en-v1.5
      - uses: actions/cache@v4
        with:
          path: ~/.ollama
          key: ollama-${{ runner.os }}-llama3.1-8b
      - run: curl -fsSL https://ollama.com/install.sh | sh
      - run: ollama serve &
      - run: ollama pull llama3.1:8b
      - run: pnpm -r build
      - run: pnpm --filter @rag/web-e2e exec playwright install --with-deps chromium
      - run: pnpm --filter @rag/web-e2e test:browser
```

- [ ] **Step 4: Record the measured wall clock**

Run the suite twice. Put the cold and warm numbers into the Acceptance criteria section of the spec, replacing the instruction to measure them. If warm exceeds ~10 minutes, the lever is a smaller generation model — not dropping assertions, and not a hosted key.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/web-e2e.yml .husky/pre-push docs/superpowers/specs/2026-09-13-web-e2e-kb-verification-design.md
git commit -m "ci(web-e2e): run the browser suite without secrets"
```
