# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A generic Retrieval-Augmented Generation (RAG) service. The mental model:

1. **Connectors** pull files/messages from external sources (SharePoint, Google Drive, Gmail, Outlook, a local git markdown clone, and the eCFR bulk-XML mirror).
2. The **Python parser sidecar** converts every format (`.docx`, `.pdf`, `.xlsx`, `.html`, `.md`, `.doc`, etc.) to clean markdown + structured metadata.
3. The **chunker** splits markdown into ~800-token chunks respecting headings/lists/code blocks.
4. The **embedder** generates 768-dim vectors (Gemini `gemini-embedding-001` by default; `local` ONNX and OpenAI also ship). ⚠ `text-embedding-004` is **retired** — never configure it.
5. **Postgres + pgvector** stores chunks, embeddings, and a tsvector index for hybrid (dense + sparse) retrieval.
6. The **API** and **MCP server** expose search/ask endpoints. The MCP server is the agent-facing surface.
7. The **worker** runs ingestion asynchronously via `pg-boss` jobs.

## Common commands

```bash
pnpm install                  # bootstrap workspace
pnpm docker:up                # boot Postgres + Python parser locally
pnpm docker:down              # stop the local stack
pnpm docker:logs              # tail Postgres + parser logs
pnpm db:generate              # generate Drizzle SQL from schema changes
pnpm db:migrate               # apply migrations
pnpm db:studio                # open Drizzle Studio
pnpm dev:api                  # run HTTP API (port 3000)
pnpm dev:mcp                  # run MCP server (stdio by default)
pnpm dev:worker               # run ingestion worker
pnpm build                    # build all packages + apps
pnpm lint                     # workspace-wide lint
pnpm format:check             # prettier --check . (what the pre-commit hook enforces)
pnpm typecheck                # workspace-wide tsc --noEmit
pnpm test                     # workspace-wide vitest
pnpm test:fresh               # build then unit-test (e2e excluded) — REQUIRED on a fresh clone (tests resolve workspace deps via dist/)
pnpm e2e                      # end-to-end tests (@rag/e2e, in tests/e2e/)
pnpm eval                     # retrieval evaluation harness (@rag/e2e)
pnpm eval:real                # eval harness against real providers (needs API keys)
pnpm eval:gold                # eval against the curated gold set (docs/evaluation/EVAL-GOLD-SET-GUIDE.md)
pnpm gen:parser-types         # regenerate parser TS types from the live parser's OpenAPI schema
pnpm --filter @rag/<pkg> test -- <name>   # single test in one package
pnpm --filter @rag/web dev    # web UI — there is NO root `dev:web` script
```

One-off scripts that have no package.json entry:

```bash
HF_CACHE_DIR=<path> EMBEDDING_MODEL=<model> node_modules/.bin/tsx scripts/warm-model.ts   # pre-download local ONNX weights
npx tsx scripts/reembed-chunks.ts                                          # re-embed after an embedding-model change
./scripts/reembed-and-stream.sh                                            # re-embed + watch progress
```

## Architectural ground rules

- **TypeScript is primary.** Python lives only in `services/parser-py/` because the document-parsing ecosystem there is materially better. Do not creep Python into other services.
- **All cross-package contracts live in `@rag/core`.** Connectors, parsers, embedders, and chunkers all implement interfaces defined there. Adding a provider = implement the interface, register it in the factory.
- **Business logic is transport-agnostic in `@rag/services`.** The service functions take a structural `ServiceDeps` and are shared by both the HTTP API and the MCP server — never duplicate search/ask logic in a route or tool. The full surface (`packages/services/src/index.ts`): `searchDocuments`; `askQuestion` / `askQuestionStream`; `triggerSync` / `listPublicSources` / `purgeSource`; `getDocumentById` / `getDocumentDownload`; `submitAnswerFeedback`.
- **The shared dependency graph is built once via `@rag/runtime`.** `buildCoreDeps(config, logger)` wires the DB pool, embedder, retriever, queue, and optional generator (plus a hardened idempotent `close()`). The three backend apps (api/mcp/worker) build `CoreDeps` from it. The other two apps consume the HTTP API instead and never touch `CoreDeps`: `apps/web` (Next.js frontend — see `apps/web/CLAUDE.md`) and `apps/teams-bot` (Microsoft Teams bot, Entra SSO + Adaptive Cards, single-instance only because it uses `MemoryStorage` for the SSO exchange).
- **Database access goes through `@rag/db`.** Apps and packages never import `pg`/`drizzle-orm` directly — they import typed query functions.
- **Authentication is a pluggable `AuthProvider` in `@rag/core`.** Apps don't hand-roll token checks — they call `buildAuthProvider(config, logger)` (`@rag/runtime`), which returns an `AuthProvider` (`authenticate(credential) → Principal | null`). Strategies: `static-token`, `oidc`, `composite` (default; static tried first, then OIDC), selected via `AUTH_PROVIDER`. The downstream authorization contract (`Principal` → `AuthorizationScope` → scope-threaded retrieval) is unchanged — this sits in front of `resolvePrincipal`, it does not replace the scope machinery. The core has zero IdP-specific (e.g. Entra) code.
- **Ingestion is always async via `pg-boss`.** The API enqueues jobs; the worker executes them. Never run a full source sync inside an HTTP request.
- **Embeddings are immutable per (provider, model, dimensions).** If you change the embedding model, you must re-embed. The `chunks` table records the model used so mixed-model collections are detectable.
- **Idempotency by content hash.** Documents are keyed by `(source_id, external_id)`; chunks store a SHA-256 of their text. Re-ingesting an unchanged file is a no-op.

## Where to find things

| Concern                   | Location                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Shared types/interfaces   | `packages/core/src/`                                                                                                                     |
| Shared service layer      | `packages/services/src/` (search/ask/sources/documents)                                                                                  |
| Shared runtime dep graph  | `packages/runtime/src/index.ts` (`buildCoreDeps`)                                                                                        |
| Auth providers (contract) | `packages/core/src/{auth,oidc-auth,auth-provider-factory}.ts`                                                                            |
| Auth provider wiring      | `packages/runtime/src/index.ts` (`buildAuthProvider`); `apps/api/src/auth.ts`                                                            |
| DB schema + migrations    | `packages/db/src/schema.ts`, `packages/db/drizzle/`                                                                                      |
| Embedding providers       | `packages/rag/src/embeddings/`                                                                                                           |
| Chunking strategies       | `packages/rag/src/chunking/`                                                                                                             |
| Hybrid retrieval (RRF)    | `packages/rag/src/retrieval/`                                                                                                            |
| Connector implementations | `packages/connectors/src/{sharepoint,gdrive,gmail,outlook,git-markdown,ecfr-part4,custom}/`                                              |
| Reranking (optional)      | `packages/rag/src/retrieval/reranker.ts` — off by default (`RERANK_PROVIDER=none`)                                                       |
| Neighbor expansion        | `packages/rag/src/retrieval/contextualize.ts`                                                                                            |
| Model prompts             | `packages/rag/src/prompts/*.md` — exact model input: Prettier-ignored, copied to `dist/` by the build (rebuild `@rag/rag` after editing) |
| Ingestion pipeline        | `packages/ingestion/src/pipeline.ts`                                                                                                     |
| HTTP routes               | `apps/api/src/routes/`                                                                                                                   |
| MCP tools                 | `apps/mcp/src/tools/`                                                                                                                    |
| Worker job handlers       | `apps/worker/src/handlers/`                                                                                                              |
| Python parser             | `services/parser-py/app/main.py`                                                                                                         |
| Web chat UI (Next.js)     | `apps/web/` — see `apps/web/CLAUDE.md` for auth model and server-only credential rules                                                   |
| Teams bot                 | `apps/teams-bot/` — single-instance only (`MemoryStorage` for the SSO exchange)                                                          |
| E2E suites                | `tests/e2e/` (`@rag/e2e`, also hosts the eval harness) and `tests/web-e2e/`                                                              |
| Shared test fixtures      | `packages/test-fixtures/`                                                                                                                |
| Postgres backup sidecar   | `services/backup/` (`backup.sh` + Dockerfile + `railway.json`)                                                                           |

## Adding a provider (connector, embedding model, auth strategy)

All three follow the same shape: implement the interface from `@rag/core`, register it in the factory, document env in `env.example`. A new connector also needs a `sourceKindEnum` value **plus** its migration; `custom` is the one kind `createConnector` deliberately rejects. Auth providers must fail closed (return `null`, never throw) and keep env parsing out of core. The full step lists are in `.claude/rules/adding-{connector,embedding-provider,auth-provider}.md`; they load automatically when you touch those directories. The `rag-add-provider` skill walks through the same steps.

## Things that will trip you up

- **`pnpm test` fails on a fresh clone.** Tests resolve workspace packages via their built `dist/` entry points, so an unbuilt checkout errors with `Failed to resolve entry for package "@rag/core"`. Run `pnpm test:fresh` (or `pnpm -r build` first). CI builds before testing, so this only bites locally.
- **Migrations auto-run on Railway deploy.** The `rag-worker` service has a `preDeployCommand` (`node node_modules/@rag/db/dist/migrate.js`, see `apps/worker/railway.json:8`) — it's the single migration owner. That works because the pre-deploy command is a separate process running only the migrate entrypoint, so it never boots the worker app and never reaches the startup index-assert; all three apps, worker included, do assert and crash-loop on a not-yet-migrated DB. On a schema-changing release, deploy `rag-worker` first, then api/mcp. Don't add the same command to api/mcp (concurrent `0000_init` bootstrap contends). See `docs/operations/DEPLOYMENT.md`.
- **pgvector dimension mismatch.** The `chunks.embedding` column is `vector(768)` to match Gemini. If you switch to OpenAI 1536-dim, change the column AND drop/rebuild the HNSW index. The migration script in `packages/db/drizzle/` handles this if you regenerate.
- **`COMPLIANCE_MODE=client-data` changes boot behavior in four coupled places**, each a hard startup failure rather than a degraded mode. It (1) refuses `CONTENT_SCAN_PROVIDER=none`; (2) refuses runtime HuggingFace weight downloads, so `local` is the only permitted embedding provider and its weights must be pre-warmed at image-build time (`scripts/warm-model.ts`); (3) therefore requires `HF_CACHE_DIR` to name a durable path — `LocalEmbeddingProvider`'s **constructor** throws without it (`packages/rag/src/embeddings/local.ts`), so an empty-string compose override is as bad as unset; and (4) requires a DPA on record, with `EGRESS_ALLOWED_HOSTS` left blank unless a signed DPA covers each listed host (`docs/compliance/`). The authoritative annotations are in `env.example` — read it before changing any embedding or scanning env var.
- **`CHUNK_SIZE` is silently capped at 512 when `EMBEDDING_PROVIDER=local`.** `Xenova/bge-base-en-v1.5` hard-truncates at 512 tokens, so a larger configured value is capped automatically with a startup warning. Don't route around the cap — chunks above it were previously embedded with invisible retrieval-quality loss.
- **`scripts/` is a workspace package on purpose.** It ships no code; it's listed in `pnpm-workspace.yaml` only so `pnpm -r run test` picks up the Docker build-gate test in `scripts/warm-model-verified.test.ts`.
- **Railway Postgres runs `postgres-ssl:16.14`, not `pgvector/pgvector:pg16` — intentional.** Local, single-VM, and CI stay on `pgvector/pgvector:pg16`; don't "fix" the divergence. Automated PITR is broken on Railway volumes (manual restore only), and `archive_mode=on` plus the `postgres` superuser role must survive or backups stop silently. See `docs/operations/BACKUP-AND-RECOVERY.md`.
- **`railway connect rag-postgres` matches on the image name** (an image without a DB keyword fails) and needs a `DATABASE_URL` on the DB service itself. See `docs/operations/DEPLOYMENT.md`.
- **After any Postgres image change, `REINDEX DATABASE` every connectable DB _before_ the image's automatic `REFRESH COLLATION VERSION` hides a glibc move.** Procedure in `docs/operations/DEPLOYMENT.md`.
- **The Python parser is a separate process.** If parsing fails locally, the first thing to check is whether the `parser` container is up (`docker ps`) and reachable at `PARSER_URL`.
- **pg-boss schema.** It auto-creates the `pgboss` schema on first connect. If you nuke the DB, the worker re-creates it — no manual migration needed.
- **Microsoft Graph throttling.** SharePoint and Outlook share the same Graph quota. The connector retries with backoff on 429 responses, but bulk re-syncs of huge libraries should be staged.
- **Parser shared-secret auth is opt-in.** Set `PARSER_SECRET` (in `env.example`) to require the `X-Parser-Token` header on the parser sidecar's `/parse` endpoint. Empty/unset = auth disabled. If set, the worker's `HttpParserClient` and the parser service must agree, or every parse 401s.
- **Client auth config fails loud by design.** `AUTH_PROVIDER=oidc` with no `OIDC_ISSUER`/`OIDC_AUDIENCE` throws at startup. `composite` (the default) tries static tokens first, then OIDC; with no `OIDC_*` set it behaves exactly like the legacy static-token setup. An empty token allow-list throws at construction — a misconfigured deployment never silently accepts everything.

## Conventions enforced mechanically

Repo-committed (every contributor gets these via `pnpm install` → husky):

- Pre-commit: prettier + eslint on staged files (lint-staged), secret scan (`scripts/check-secrets.mjs`), 800-line file cap (`scripts/check-file-sizes.mjs`).
- Pre-push: `pnpm -r build && pnpm -r --filter '!@rag/*e2e' run test` (both `@rag/e2e` and `@rag/web-e2e` are excluded — it needs Docker and runs via `pnpm e2e` / CI instead), skipped when `.test-passed` matches HEAD.
- Do not edit `.env` files — the template lives at `env.example`.
- Do not edit `pnpm-lock.yaml` by hand — run `pnpm install` to update.

---

## Effort calibration for this repo

Which changes need the most care. The general model-routing policy lives in
user-level config, not here — this section only records what is
_repo-specifically_ risky.

Highest care (cross-cutting, security-relevant, or expensive to get wrong):

- Retrieval pipeline architecture changes (RRF weights, embedding strategy)
- Auth provider changes (OIDC, JWT, composite) and anything touching `access-control.ts`
- The ingestion sensitivity gate (`pipeline.ts` `dataClass` / `ClassBlockedError`) — the enum collapses Class C and D, so any change that lets C through lets D through
- pg-boss job handler orchestration
- Cross-package API contract changes (`@rag/core` types)
- Drizzle migration authoring — migrations are **forward-only** and the journal's `when` must be strictly monotonic (this repo has hit a non-monotonic-timestamp bug before)

Standard care (clear pattern to follow, real judgment calls):

- New connector implementation (follow the connector/ pattern; see the 6-step list above)
- New MCP tool (follow the tools/ pattern)
- Vitest e2e spec authoring

Mechanical (a sibling exists to copy):

- Zod schema boilerplate for new entities
- Pino log statement additions
- New Fastify route (copy from routes/ pattern)
- Python parser endpoint expansion (copy from parse endpoint pattern)
