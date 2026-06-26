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
pnpm e2e                      # end-to-end tests (@rag/e2e)
pnpm eval                     # retrieval evaluation harness (@rag/e2e)
pnpm gen:parser-types         # regenerate parser TS types from the live parser's OpenAPI schema
pnpm --filter @rag/<pkg> test -- <name>   # single test in one package
```

## Architectural ground rules

- **TypeScript is primary.** Python lives only in `services/parser-py/` because the document-parsing ecosystem there is materially better. Do not creep Python into other services.
- **All cross-package contracts live in `@rag/core`.** Connectors, parsers, embedders, and chunkers all implement interfaces defined there. Adding a provider = implement the interface, register it in the factory.
- **Business logic is transport-agnostic in `@rag/services`.** The five service functions (`searchDocuments`, `askQuestion`, `triggerSync`, `listPublicSources`, `getDocumentById`) take a structural `ServiceDeps` and are shared by both the HTTP API and the MCP server — never duplicate search/ask logic in a route or tool.
- **The shared dependency graph is built once via `@rag/runtime`.** `buildCoreDeps(config, logger)` wires the DB pool, embedder, retriever, queue, and optional generator (plus a hardened idempotent `close()`). All three apps (api/mcp/worker) build `CoreDeps` from it and layer transport-specific extras on top.
- **Database access goes through `@rag/db`.** Apps and packages never import `pg`/`drizzle-orm` directly — they import typed query functions.
- **Authentication is a pluggable `AuthProvider` in `@rag/core`.** Apps don't hand-roll token checks — they call `buildAuthProvider(config, logger)` (`@rag/runtime`), which returns an `AuthProvider` (`authenticate(credential) → Principal | null`). Strategies: `static-token`, `oidc`, `composite` (default; static tried first, then OIDC), selected via `AUTH_PROVIDER`. The downstream authorization contract (`Principal` → `AuthorizationScope` → scope-threaded retrieval) is unchanged — this sits in front of `resolvePrincipal`, it does not replace the scope machinery. The core has zero IdP-specific (e.g. Entra) code.
- **Ingestion is always async via `pg-boss`.** The API enqueues jobs; the worker executes them. Never run a full source sync inside an HTTP request.
- **Embeddings are immutable per (provider, model, dimensions).** If you change the embedding model, you must re-embed. The `chunks` table records the model used so mixed-model collections are detectable.
- **Idempotency by content hash.** Documents are keyed by `(source_id, external_id)`; chunks store a SHA-256 of their text. Re-ingesting an unchanged file is a no-op.

## Where to find things

| Concern                   | Location                                                                      |
| ------------------------- | ----------------------------------------------------------------------------- |
| Shared types/interfaces   | `packages/core/src/`                                                          |
| Shared service layer      | `packages/services/src/` (search/ask/sources/documents)                       |
| Shared runtime dep graph  | `packages/runtime/src/index.ts` (`buildCoreDeps`)                             |
| Auth providers (contract) | `packages/core/src/{auth,oidc-auth,auth-provider-factory}.ts`                 |
| Auth provider wiring      | `packages/runtime/src/index.ts` (`buildAuthProvider`); `apps/api/src/auth.ts` |
| DB schema + migrations    | `packages/db/src/schema.ts`, `packages/db/drizzle/`                           |
| Embedding providers       | `packages/rag/src/embeddings/`                                                |
| Chunking strategies       | `packages/rag/src/chunking/`                                                  |
| Hybrid retrieval (RRF)    | `packages/rag/src/retrieval/`                                                 |
| Connector implementations | `packages/connectors/src/{sharepoint,gdrive,gmail,outlook}/`                  |
| Ingestion pipeline        | `packages/ingestion/src/pipeline.ts`                                          |
| HTTP routes               | `apps/api/src/routes/`                                                        |
| MCP tools                 | `apps/mcp/src/tools/`                                                         |
| Worker job handlers       | `apps/worker/src/handlers/`                                                   |
| Python parser             | `services/parser-py/app/main.py`                                              |

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

- **Migrations auto-run on Railway deploy.** The `rag-worker` service has a `preDeployCommand` (`pnpm --filter @rag/db migrate`) — it's the single migration owner (it boots without the index-assert that crash-loops api/mcp). On a schema-changing release, deploy `rag-worker` first, then api/mcp. Don't add the same command to api/mcp (concurrent `0000_init` bootstrap contends). See `docs/DEPLOYMENT.md`.
- **pgvector dimension mismatch.** The `chunks.embedding` column is `vector(768)` to match Gemini. If you switch to OpenAI 1536-dim, change the column AND drop/rebuild the HNSW index. The migration script in `packages/db/drizzle/` handles this if you regenerate.
- **The Python parser is a separate process.** If parsing fails locally, the first thing to check is whether the `parser` container is up (`docker ps`) and reachable at `PARSER_URL`.
- **pg-boss schema.** It auto-creates the `pgboss` schema on first connect. If you nuke the DB, the worker re-creates it — no manual migration needed.
- **Microsoft Graph throttling.** SharePoint and Outlook share the same Graph quota. The connector retries with backoff on 429 responses, but bulk re-syncs of huge libraries should be staged.
- **Parser shared-secret auth is opt-in.** Set `PARSER_SECRET` (in `env.example`) to require the `X-Parser-Token` header on the parser sidecar's `/parse` endpoint. Empty/unset = auth disabled. If set, the worker's `HttpParserClient` and the parser service must agree, or every parse 401s.
- **Client auth config fails loud by design.** `AUTH_PROVIDER=oidc` with no `OIDC_ISSUER`/`OIDC_AUDIENCE` throws at startup. `composite` (the default) tries static tokens first, then OIDC; with no `OIDC_*` set it behaves exactly like the legacy static-token setup. An empty token allow-list throws at construction — a misconfigured deployment never silently accepts everything.

## Conventions enforced by hooks (parent repo)

- Prettier auto-formats `.ts/.tsx/.js/.json/.md` on every Edit/Write.
- Do not edit `.env` files — they're blocked at the hook layer. The template lives at `env.example`.
- Do not edit `pnpm-lock.yaml` — it's blocked. Run `pnpm install` to update.
