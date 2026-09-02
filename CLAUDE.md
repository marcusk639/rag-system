# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A generic Retrieval-Augmented Generation (RAG) service. The mental model:

1. **Connectors** pull files/messages from external sources (SharePoint, Google Drive, Gmail, Outlook).
2. The **Python parser sidecar** converts every format (`.docx`, `.pdf`, `.xlsx`, `.html`, `.md`, `.doc`, etc.) to clean markdown + structured metadata.
3. The **chunker** splits markdown into ~800-token chunks respecting headings/lists/code blocks.
4. The **embedder** generates 768-dim vectors (Gemini `text-embedding-004` by default).
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
pnpm typecheck                # workspace-wide tsc --noEmit
pnpm test                     # workspace-wide vitest
pnpm test:fresh               # build then unit-test (e2e excluded) — REQUIRED on a fresh clone (tests resolve workspace deps via dist/)
pnpm e2e                      # end-to-end tests (@rag/e2e)
pnpm eval                     # retrieval evaluation harness (@rag/e2e)
pnpm eval:real                # eval harness against real providers (needs API keys)
pnpm gen:parser-types         # regenerate parser TS types from the live parser's OpenAPI schema
pnpm --filter @rag/<pkg> test -- <name>   # single test in one package
```

## Architectural ground rules

- **TypeScript is primary.** Python lives only in `services/parser-py/` because the document-parsing ecosystem there is materially better. Do not creep Python into other services.
- **All cross-package contracts live in `@rag/core`.** Connectors, parsers, embedders, and chunkers all implement interfaces defined there. Adding a provider = implement the interface, register it in the factory.
- **Business logic is transport-agnostic in `@rag/services`.** The five service functions (`searchDocuments`, `askQuestion`, `triggerSync`, `listPublicSources`, `getDocumentById`) take a structural `ServiceDeps` and are shared by both the HTTP API and the MCP server — never duplicate search/ask logic in a route or tool.
- **The shared dependency graph is built once via `@rag/runtime`.** `buildCoreDeps(config, logger)` wires the DB pool, embedder, retriever, queue, and optional generator (plus a hardened idempotent `close()`). The three backend apps (api/mcp/worker) build `CoreDeps` from it. The fourth app, `apps/web`, is a Next.js frontend that consumes the HTTP API instead — it never touches `CoreDeps`; see `apps/web/CLAUDE.md`.
- **Database access goes through `@rag/db`.** Apps and packages never import `pg`/`drizzle-orm` directly — they import typed query functions.
- **Authentication is a pluggable `AuthProvider` in `@rag/core`.** Apps don't hand-roll token checks — they call `buildAuthProvider(config, logger)` (`@rag/runtime`), which returns an `AuthProvider` (`authenticate(credential) → Principal | null`). Strategies: `static-token`, `oidc`, `composite` (default; static tried first, then OIDC), selected via `AUTH_PROVIDER`. The downstream authorization contract (`Principal` → `AuthorizationScope` → scope-threaded retrieval) is unchanged — this sits in front of `resolvePrincipal`, it does not replace the scope machinery. The core has zero IdP-specific (e.g. Entra) code.
- **Ingestion is always async via `pg-boss`.** The API enqueues jobs; the worker executes them. Never run a full source sync inside an HTTP request.
- **Embeddings are immutable per (provider, model, dimensions).** If you change the embedding model, you must re-embed. The `chunks` table records the model used so mixed-model collections are detectable.
- **Idempotency by content hash.** Documents are keyed by `(source_id, external_id)`; chunks store a SHA-256 of their text. Re-ingesting an unchanged file is a no-op.

## Where to find things

| Concern                   | Location                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Shared types/interfaces   | `packages/core/src/`                                                                   |
| Shared service layer      | `packages/services/src/` (search/ask/sources/documents)                                |
| Shared runtime dep graph  | `packages/runtime/src/index.ts` (`buildCoreDeps`)                                      |
| Auth providers (contract) | `packages/core/src/{auth,oidc-auth,auth-provider-factory}.ts`                          |
| Auth provider wiring      | `packages/runtime/src/index.ts` (`buildAuthProvider`); `apps/api/src/auth.ts`          |
| DB schema + migrations    | `packages/db/src/schema.ts`, `packages/db/drizzle/`                                    |
| Embedding providers       | `packages/rag/src/embeddings/`                                                         |
| Chunking strategies       | `packages/rag/src/chunking/`                                                           |
| Hybrid retrieval (RRF)    | `packages/rag/src/retrieval/`                                                          |
| Connector implementations | `packages/connectors/src/{sharepoint,gdrive,gmail,outlook}/`                           |
| Ingestion pipeline        | `packages/ingestion/src/pipeline.ts`                                                   |
| HTTP routes               | `apps/api/src/routes/`                                                                 |
| MCP tools                 | `apps/mcp/src/tools/`                                                                  |
| Worker job handlers       | `apps/worker/src/handlers/`                                                            |
| Python parser             | `services/parser-py/app/main.py`                                                       |
| Web chat UI (Next.js)     | `apps/web/` — see `apps/web/CLAUDE.md` for auth model and server-only credential rules |

## Adding a new connector

1. Implement the `Connector` interface from `@rag/core` (`validate`, `list`, `fetch` methods; delta sync is driven by the `cursor` passed to `list()`, not a separate method).
2. Add a subdirectory under `packages/connectors/src/<name>/`.
3. Register it in `packages/connectors/src/index.ts`.
4. Document OAuth/credential setup in `docs/CONNECTORS.md`.
5. Add env vars to `env.example`.

## Adding a new embedding provider

1. Implement `EmbeddingProvider` in `packages/rag/src/embeddings/<name>.ts`.
2. Register it in `packages/rag/src/embeddings/factory.ts`.
3. Document the model + dimensions in `env.example` and `docs/ARCHITECTURE.md`.

## Adding a new auth provider

1. Implement `AuthProvider` (`authenticate(credential) → Promise<Principal | null>`) in `packages/core/src/`. Fail closed: return `null` for anything you can't positively authenticate; never throw for a bad credential.
2. Add its config shape to `AuthProviderConfig` and a `case` in `createAuthProvider` (`packages/core/src/auth-provider-factory.ts`). Keep env parsing OUT of core — it lives in the runtime/app config layer.
3. Wire env → config in `buildAuthProvider` (`packages/runtime/src/index.ts`).
4. Document the env vars in `env.example`.

## Things that will trip you up

- **`pnpm test` fails on a fresh clone.** Tests resolve workspace packages via their built `dist/` entry points, so an unbuilt checkout errors with `Failed to resolve entry for package "@rag/core"`. Run `pnpm test:fresh` (or `pnpm -r build` first). CI builds before testing, so this only bites locally.
- **Migrations auto-run on Railway deploy.** The `rag-worker` service has a `preDeployCommand` (`pnpm --filter @rag/db migrate`) — it's the single migration owner (it boots without the index-assert that crash-loops api/mcp). On a schema-changing release, deploy `rag-worker` first, then api/mcp. Don't add the same command to api/mcp (concurrent `0000_init` bootstrap contends). See `docs/DEPLOYMENT.md`.
- **pgvector dimension mismatch.** The `chunks.embedding` column is `vector(768)` to match Gemini. If you switch to OpenAI 1536-dim, change the column AND drop/rebuild the HNSW index. The migration script in `packages/db/drizzle/` handles this if you regenerate.
- **Railway Postgres is a different image than local/CI, on purpose.** Production `rag-postgres` runs `ghcr.io/railwayapp-templates/postgres-ssl:16.14` (Railway's official image: bundles pgvector, self-signed SSL, and pgBackRest — WAL archiving to the `rag-documents` bucket is live, so `archive_mode=on` and a `postgres` superuser role must keep existing or backups stop silently). Local dev (`docker/docker-compose.yml`), the single-VM stack (`docker/compose.prod.yml`), and CI (`.github/workflows/e2e.yml`) still use `pgvector/pgvector:pg16` — that divergence is intentional, don't "fix" it. The image also hard-requires the volume at exactly `/var/lib/postgresql/data` with `PGDATA=/var/lib/postgresql/data/pgdata`; its entrypoint refuses to boot otherwise.
- **`railway connect rag-postgres` detects the DB from the image NAME.** The CLI reads `serviceInstance.source.image` and matches it against a keyword list (`postgres`, `mysql`, `redis`, `mongo`, `postgis`, `timescale`, `mariadb`, `memcached`, `valkey`). Any image lacking one of those — `pgvector/pgvector:pg16` included — fails with `No supported database found in service` no matter how it's configured. It also needs a `DATABASE_URL` on the **database** service itself (not just on `rag-api`), which is why `rag-postgres` carries one.
- **A Postgres image bump can silently invalidate every text index.** `postgres-ssl` tags track Debian, so a rebuild at the same PG minor can still move glibc (16.14 went bookworm/glibc 2.36 → trixie/glibc 2.41), making all text btree indexes suspect. The image's boot script then runs `ALTER DATABASE ... REFRESH COLLATION VERSION` on every database **without reindexing** — silencing the warning and erasing the only evidence that a rebuild is needed. After any Postgres image change: check `select version()` for a changed `pgdgNN`, and if it moved, run `REINDEX DATABASE <db>` **before** the refresh, for every connectable database (`rag`, `postgres`, `template1`, plus any `rag_premigration_*` leftovers) — not just `rag`.
- **The Python parser is a separate process.** If parsing fails locally, the first thing to check is whether the `parser` container is up (`docker ps`) and reachable at `PARSER_URL`.
- **pg-boss schema.** It auto-creates the `pgboss` schema on first connect. If you nuke the DB, the worker re-creates it — no manual migration needed.
- **Microsoft Graph throttling.** SharePoint and Outlook share the same Graph quota. The connector retries with backoff on 429 responses, but bulk re-syncs of huge libraries should be staged.
- **Parser shared-secret auth is opt-in.** Set `PARSER_SECRET` (in `env.example`) to require the `X-Parser-Token` header on the parser sidecar's `/parse` endpoint. Empty/unset = auth disabled. If set, the worker's `HttpParserClient` and the parser service must agree, or every parse 401s.
- **Client auth config fails loud by design.** `AUTH_PROVIDER=oidc` with no `OIDC_ISSUER`/`OIDC_AUDIENCE` throws at startup. `composite` (the default) tries static tokens first, then OIDC; with no `OIDC_*` set it behaves exactly like the legacy static-token setup. An empty token allow-list throws at construction — a misconfigured deployment never silently accepts everything.

## Conventions enforced mechanically

Repo-committed (every contributor gets these via `pnpm install` → husky):

- Pre-commit: prettier + eslint on staged files (lint-staged), secret scan (`scripts/check-secrets.mjs`), 800-line file cap (`scripts/check-file-sizes.mjs`).
- Pre-push: `pnpm -r build && pnpm -r --filter '!@rag/e2e' run test` (e2e is excluded — it needs Docker and runs via `pnpm e2e` / CI instead), skipped when `.test-passed` matches HEAD.
- Do not edit `.env` files — the template lives at `env.example`.
- Do not edit `pnpm-lock.yaml` by hand — run `pnpm install` to update.

---

## Model Tier Policy (80/15/5 Rule)

### Tier A — Reasoning (5% of tasks) — Claude Opus / Sonnet full context

Use ONLY for:

- Cross-product architectural decisions affecting multiple modules
- Security-critical code (auth, token handling, PII flows)
- Complex bugs requiring deep multi-file causal reasoning
- Final review of client-facing or legally sensitive output
- Anything requiring genuine architectural judgment

### Tier B — Planning (15% of tasks) — Claude Sonnet or OpenRouter Auto

Use for:

- Single-module feature implementation
- Database schema changes and migrations
- Code reviews of non-trivial PRs
- Research synthesis and strategy document drafting
- Debugging with a clear hypothesis

### Tier C — Execution (80% of tasks) — OpenRouter DeepSeek V4 Flash or Haiku

Use for:

- Test stub generation and boilerplate
- Repetitive file patches and linting fixes
- Type annotation passes
- Document reformatting and collateral variations
- Firebase function scaffolding from established patterns
- Content calendar generation, email drafts, standard templates

### Anti-pattern guard

NEVER use Tier A for tasks completable by Tier C.
When in doubt, start at Tier C and escalate if output quality is insufficient.

## RAG System Tier Calibration

Tier A tasks:

- Retrieval pipeline architecture changes (RRF weights, embedding strategy)
- Auth provider changes (OIDC, JWT, composite)
- pg-boss job handler orchestration
- Cross-package API contract changes (@rag/core types)

Tier B tasks:

- New connector implementation (follow connector/ pattern)
- New MCP tool (follow tools/ pattern)
- Drizzle migration authoring
- Vitest e2e spec authoring

Tier C tasks:

- Zod schema boilerplate for new entities
- Pino log statement additions
- New Fastify route (copy from routes/ pattern)
- Python parser endpoint expansion (copy from parse endpoint pattern)
