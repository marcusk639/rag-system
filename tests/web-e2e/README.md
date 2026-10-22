# @rag/web-e2e

A Playwright suite that drives the real web UI against a seeded two-document fixture corpus. It proves the
wiring: Auth.js session to scope token to scope-threaded retrieval, rendered citations that resolve to
real documents, and a refusal that renders as a refusal. It is not an answer-quality signal. Its models
(local `bge-base` embeddings, local `llama3.1:8b`) are not production's. Answer quality belongs to
`pnpm eval:gold`; see [docs/evaluation/EVALUATION.md](../../docs/evaluation/EVALUATION.md).

## What runs where

| Spec                 | Checks                                                                                                       | Tag               | CI  |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------- | --- |
| `stack.spec.ts`      | Migrations applied to the e2e database                                                                       |                   | Yes |
| `seed.spec.ts`       | Every chunk was embedded by the `local` provider                                                             |                   | Yes |
| `grant.spec.ts`      | The fixture user resolves to a non-empty scope; an unassigned user resolves to empty                         |                   | Yes |
| `auth.spec.ts`       | The minted cookie reaches a gated route and lists the fixture source                                         |                   | Yes |
| `compliance.spec.ts` | The API answers with at least one citation, so the model emits `[N]` markers                                 | `@needs-8b-model` | No  |
| `kb.spec.ts`         | Citations resolve, self-retrieval of the nonce document, out-of-corpus refusal, chips equal the `done` frame | `@needs-8b-model` | No  |

CI (`.github/workflows/web-e2e.yml`) runs `test:browser:ci`, which is `--grep-invert @needs-8b-model`. A
GitHub runner is CPU-only. There, one `llama3.1:8b` answer takes longer than the 120-second test budget,
and the first timeout starves the rest. The smaller models measured worse: `llama3.2:3b` confabulated
instead of refusing (9/10), and `llama3.2:1b` emitted no citations (5/10). Run the generation specs
locally.

## Running it locally

The suite **truncates `chunks`, `documents`, `ingestion_jobs` and `sources`** in its database on every run.
Its copy of `truncateAll` (`src/setup/ingestion.ts`) has no non-local-host guard, unlike
`tests/e2e/src/helpers/db.ts`. `E2E_DATABASE_URL` defaults to the local compose database. Never point it
at anything you want to keep.

1. Start Postgres and the parser: `docker compose -f docker/docker-compose.yml up -d`.
2. Start Ollama with the model pulled: `ollama serve &` then `ollama pull llama3.1:8b` (about 4.7 GB).
   Setup details are in [docs/operations/LOCAL-GENERATION.md](../../docs/operations/LOCAL-GENERATION.md).
3. Build the workspace: `pnpm -r build`. The suite starts `apps/api` and `apps/web` with `start`, which
   serves whatever is already in `dist/` and `.next/`. A stale build gives green runs against old code.
4. Migrate: `pnpm db:migrate`. The API checks its required indexes at boot, and Playwright starts the web
   servers before `globalSetup` gets to migrate.
5. Run: `E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/web-e2e test:browser`. Without the flag, `globalSetup`
   runs `docker compose up -d` itself.

Done when all 10 tests pass. A warm run takes about 20 seconds. The first run also downloads the ONNX
embedder (about 430 MB) into the Hugging Face cache.

The package exposes `test:browser`, never `test`. The pre-push hook runs `pnpm -r --filter '!@rag/*e2e' run
test`, and a `test` script here would boot docker and download models on every push.

## The four processes

1. **Docker:** Postgres with pgvector, plus the parser (`src/setup/stack.ts`).
2. **`apps/api`:** listening on port 3100, started by Playwright's `webServer`.
3. **`apps/web`:** `next start` on port 3200, with its BFF calling the API at `RAG_API_URL`.
4. **Playwright:** drives Chromium.

`globalSetup` (`src/setup/global-setup.ts`) does this in order:

1. Brings the stack up and migrates.
2. Seeds the corpus in a child process. `onnxruntime-node` aborts with SIGABRT during teardown, so the
   child's exit code 134 is tolerated, and success is re-verified from the database.
3. Asserts that every chunk carries exactly one `(embedding_provider, embedding_model)` pair, and that it is
   `local` / `Xenova/bge-base-en-v1.5`.
4. Grants the fixture `oid` access to the fixture source, after the truncate so the CASCADE doesn't remove
   the grant.

## Invariants the specs rely on

- **Assert only invariants, never prose.** The generator is nondeterministic, so no spec matches answer
  text. The fixtures carry nonce phrases and are their own oracle.
- **Assert a non-empty chip set before any per-chip check.** With zero `[N]` markers, `[].every(...)` is
  vacuously true, and the assertion would pass while checking nothing.
- **A correct refusal carries a citation.** Coverage branch C of the generation prompt appends "Closest
  related material: \<title\> [N]". The refusal spec asserts the `refusal` testid and the absence of
  `stream-error`, never zero citations. The `stream-error` check is what separates a refusal from a TRI
  block or a stream failure.
- **The access grant is mandatory.** `resolveSourceIdsForUser` reads only the staff assignment tables, and
  an empty scope is fail-closed. Without the grant, retrieval returns zero rows, and the refusal spec passes
  for the wrong reason.
- **Use the production testids:** `assistant-message`, `citation-chip` (with `data-doc-id`), `refusal` and
  `stream-error` in `apps/web/src/components/chat-interface/chat-interface.tsx`.

## Gotchas

All harness variables live in `src/env.ts`. They are harness-only and production-hostile:
`EGRESS_ALLOWED_HOSTS` replaces rather than merges, so copying this set to a deployed service drops the
embedding provider's host and stops ingestion and answering alike.

| Gotcha                                | Why                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedder coherence                    | Seeding and querying must both use `local` / `Xenova/bge-base-en-v1.5` / 768. A mismatch fails silently: hybrid retrieval still matches on the sparse arm. `EMBEDDING_PROVIDER=local` alone leaves the Gemini model id in place |
| `CHUNK_SIZE` doesn't reach the seeder | `runOneIngestion` never reads env and defaults to 800. `seed.ts` passes `{ chunkSize: 512 }` explicitly, matching the local model's 512-token limit                                                                             |
| Scope secret, singular vs plural      | The web BFF reads `INTERNAL_SCOPE_JWT_SECRET`; the API reads `INTERNAL_SCOPE_JWT_SECRETS`, a comma-separated list. Set both to the same value of 64 or more characters                                                          |
| `API_TOKENS` non-empty                | The config schema requires at least one token, or `apps/api` exits before listening. `compliance.spec.ts` uses it as an admin bearer, which holds only while `API_ENFORCE_SCOPING` is unset                                     |
| Port 3000 collision                   | The API and `next start` both default to 3000. The suite pins `API_PORT=3100` and `PORT=3200`                                                                                                                                   |
| `AUTH_URL` under `next start`         | `NODE_ENV=production` makes Auth.js `trustHost` false, and `auth()` errors on every navigation unless `AUTH_URL` (or `AUTH_TRUST_HOST`) is set. The suite sets `AUTH_URL=http://localhost:3200`                                 |
| `start`, never `dev`                  | `apps/api`'s `dev` script loads the repo `.env` (`--env-file-if-exists`), which would put real keys and a real `DATABASE_URL` into the suite                                                                                    |
| Session cookie                        | Mint it with `encode` from `next-auth/jwt`. It is JWE, with a key derived by HKDF from `AUTH_SECRET` and salted with the cookie name `authjs.session-token`. The payload needs `oid` (`src/fixtures/auth.ts`)                   |
| Generation provider                   | `GENERATION_PROVIDER=openai` with `GENERATION_BASE_URL=http://127.0.0.1:11434/v1`. `gemini` plus a base URL throws at startup. Leave `GENERATION_API_KEY` unset; a placeholder is sent                                          |
| TRI policy                            | `GENERATION_TRI_POLICY=warn` matches production. Under `block`, a TRI hit is indistinguishable from a refusal                                                                                                                   |
| Fixture TRI avoidance                 | Fixture text must not put `1099` or `W2` near an amount. The generation pre-flight scans the whole assembled top-k                                                                                                              |
| `EMPTY_ANSWER` is duplicated          | `chat-interface.tsx` keeps its own copy of the refusal sentence. Importing it from `@rag/services` pulls `onnxruntime-node` into the client bundle and breaks `next build`. Keep the two strings identical                      |
| Don't import `@rag/e2e`               | It has no `main`, `exports` or build, and Playwright's TypeScript transform doesn't reach into `node_modules`. The needed helpers are copied into `src/setup/`                                                                  |
| HF cache in CI                        | `HF_CACHE_DIR` must be an absolute path. An `env:` value containing `~` is passed literally, and creates a directory named `~`                                                                                                  |

Verify generation is really local by removing `127.0.0.1` from `EGRESS_ALLOWED_HOSTS` and asking a
question. It must fail with `EGRESS_BLOCKED` (503). Model downloads from Hugging Face and the Ollama
registry bypass `EgressPolicy`, so this proves the generation call is local, not that the suite is
hermetic.

Out of scope: admin pages, upload through the UI, multi-user scope isolation (that is `tests/e2e`'s job;
this suite authenticates as one principal), and runs against the deployed KB.
