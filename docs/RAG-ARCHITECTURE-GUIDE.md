# Generic RAG System — Architecture & Engineering Guide

**Status:** Current (engineering companion) · **Updated:** 2026-08-03

> An engineering-depth companion covering repo layout, conventions, and the
> non-obvious things to know before changing the code.
>
> **[`ARCHITECTURE.md`](./ARCHITECTURE.md) is the canonical architecture
> reference** — read it first for the system model, data flow, and design
> tradeoffs. Where the two disagree, that file wins. Where either disagrees with
> the code, **the code wins**; the package interfaces in `@rag/core` and the root
> `CLAUDE.md` are the other authoritative sources.

---

## 1. What this system is

A **provider-neutral RAG service**. You point it at one or more external content sources,
it ingests and indexes their documents, and it exposes `search` and `ask` over an HTTP API
and an MCP server. Nothing in the core is tied to a specific document type, IdP, embedding
model, or content domain — every external dependency sits behind an interface in `@rag/core`
and is chosen by a factory + configuration. That is what makes it a _generic_ knowledge-base
engine rather than a single-purpose app.

### The mental model (end to end)

1. **Connectors** pull files/messages from external sources (SharePoint, Google Drive, Gmail, Outlook, git-markdown, eCFR Part 4).
2. The **Python parser sidecar** converts every format (`.docx`, `.pdf`, `.xlsx`, `.html`, `.md`, `.doc`, …) to clean Markdown + structured metadata.
3. The **chunker** splits Markdown into ~800-token chunks that respect headings, lists, code blocks, and tables.
4. The **embedder** generates dense vectors (768-dim Gemini `gemini-embedding-001` by default; `local` ONNX and OpenAI also ship). ⚠ `text-embedding-004` is **retired**.
5. **Postgres + pgvector** stores chunks, embeddings, and a `tsvector` index for hybrid (dense + sparse) retrieval.
6. The **API** and **MCP server** expose `search`/`ask`. The MCP server is the agent-facing surface.
7. The **worker** runs ingestion asynchronously via `pg-boss` jobs.

```
┌────────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────┐   ┌─────────────────────┐
│ Connectors │──▶│ Parser (py)  │──▶│ Chunker  │──▶│ Embedder │──▶│ Postgres + pgvector │
│ SP/GDrive/ │   │ → Markdown + │   │ ~800 tok │   │ 768-dim  │   │ chunks + embedding  │
│ Gmail/Otlk │   │   metadata   │   │ structure│   │ Gemini   │   │ + tsvector (hybrid) │
└────────────┘   └──────────────┘   └──────────┘   └──────────┘   └─────────┬───────────┘
      ▲                                                                       │
      │ async pg-boss jobs                                          ┌─────────┴───────────┐
┌─────┴──────┐                                                      │  @rag/services      │
│  Worker    │                                                      │ search / ask / sync │
└────────────┘                                                      │ sources / documents │
                                                                    └────┬───────────┬────┘
                                                                  ┌──────┴───┐   ┌───┴──────┐
                                                                  │ HTTP API │   │ MCP srv  │
                                                                  │ Fastify  │   │ stdio +  │
                                                                  │          │   │ HTTP     │
                                                                  └──────────┘   └──────────┘
```

---

## 2. Repository layout

A pnpm + TypeScript monorepo (~13.7k lines / ~137 source files). **TypeScript is primary;**
Python exists _only_ in `services/parser-py` because the document-parsing ecosystem there is
materially better. Do not creep Python into other services.

| Area                      | Path                                                                                 | Role                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Shared types/interfaces   | `packages/core/src/`                                                                 | Every cross-package contract (Connector, EmbeddingProvider, Chunker, AuthProvider, Principal/Scope) |
| Shared service layer      | `packages/services/src/`                                                             | Transport-agnostic business logic: search / ask / sources / documents                               |
| Shared runtime graph      | `packages/runtime/src/index.ts`                                                      | `buildCoreDeps()` wires DB pool, embedder, retriever, queue, optional generator                     |
| Auth providers (contract) | `packages/core/src/{auth,oidc-auth,auth-provider-factory}.ts`                        | Pluggable `AuthProvider`                                                                            |
| Auth provider wiring      | `packages/runtime/src/index.ts` (`buildAuthProvider`); `apps/api/src/auth.ts`        | env → config → provider                                                                             |
| DB schema + migrations    | `packages/db/src/schema.ts`, `packages/db/drizzle/`                                  | Typed queries; bootstrap + Drizzle migrations                                                       |
| Embedding providers       | `packages/rag/src/embeddings/`                                                       | Gemini and others; chosen by factory                                                                |
| Chunking strategies       | `packages/rag/src/chunking/`                                                         | CompositeChunker + per-content strategies                                                           |
| Hybrid retrieval (RRF)    | `packages/rag/src/retrieval/`                                                        | Dense + sparse, reciprocal-rank fusion                                                              |
| Connectors                | `packages/connectors/src/{sharepoint,gdrive,gmail,outlook,git-markdown,ecfr-part4}/` | External source adapters                                                                            |
| Ingestion pipeline        | `packages/ingestion/src/pipeline.ts`                                                 | parse → hash → chunk → embed → store                                                                |
| HTTP routes               | `apps/api/src/routes/`                                                               | Fastify v5 endpoints                                                                                |
| MCP tools                 | `apps/mcp/src/tools/`                                                                | Agent-facing tools                                                                                  |
| Worker job handlers       | `apps/worker/src/handlers/`                                                          | pg-boss consumers                                                                                   |
| Python parser             | `services/parser-py/app/main.py`                                                     | FastAPI parsing sidecar                                                                             |
| E2E + eval harness        | `tests/e2e/`                                                                         | End-to-end specs + retrieval evaluation                                                             |

---

## 3. Architectural ground rules (the load-bearing invariants)

These are the rules that keep the system generic and correct. Violating one is how subtle
bugs and security regressions get in.

- **All cross-package contracts live in `@rag/core`.** Connectors, parsers, embedders, and
  chunkers implement interfaces defined there. **Adding a provider = implement the interface,
  register it in the factory.** No exceptions.
- **Business logic is transport-agnostic in `@rag/services`.** The five service functions
  (`searchDocuments`, `askQuestion`, `triggerSync`, `listPublicSources`, `getDocumentById`)
  take a structural `ServiceDeps` and are shared by both the HTTP API and the MCP server.
  Never duplicate search/ask logic in a route or a tool — confidentiality scoping and PII
  metadata allow-listing are enforced _once_, here, so the two surfaces can't diverge.
- **The dependency graph is built once via `@rag/runtime`.** `buildCoreDeps(config, logger)`
  wires the DB pool, embedder, retriever, queue, and an optional generator, plus a hardened
  idempotent `close()`. All three apps (api/mcp/worker) build `CoreDeps` from it and layer
  transport-specific extras on top.
- **Database access goes through `@rag/db`.** Apps/packages never import `pg`/`drizzle-orm`
  directly — they import typed query functions.
- **Authentication is a pluggable `AuthProvider` in `@rag/core`.** Apps don't hand-roll token
  checks. The core has zero IdP-specific code.
- **Ingestion is always async via `pg-boss`.** The API enqueues jobs; the worker executes.
  Never run a full source sync inside an HTTP request.
- **Embeddings are immutable per `(provider, model, dimensions)`.** If you change the embedding
  model, you must re-embed. The `chunks` table records the model used so mixed-model
  collections are detectable.
- **Idempotency by content hash.** Documents are keyed by `(source_id, external_id)`; chunks
  store a SHA-256 of their text. Re-ingesting an unchanged file is a no-op.

---

## 4. The ingestion pipeline

`packages/ingestion/src/pipeline.ts`. The pipeline is **atomic per document** and
**crash-safe across pages**.

1. **List** documents from the connector, paginated. The cursor is persisted after _each page_
   before continuing, so a crash resumes where it left off. An empty page is **not** treated as
   end-of-feed — termination is driven by the connector's explicit `page.done` flag (feeds that
   yield only drafts/deletions must not terminate the walk early).
2. **Parse** each document's raw bytes via the Python sidecar → clean Markdown + metadata.
3. **Hash** the parsed Markdown (SHA-256).
4. **Upsert** keyed by `(source_id, external_id)`. A race-safe CTE snapshots the prior
   `content_hash` before `INSERT ... ON CONFLICT`, detecting both fresh inserts (`xmax=0`) and
   genuine content changes.
5. **Short-circuit** if the content hash is unchanged — this is the idempotency boundary. No
   chunking, no embedding, no writes.
6. **Chunk** the Markdown (only if content changed).
7. **Embed** the chunks in batches.
8. **Replace** chunks atomically in a transaction: delete old chunks, insert new ones in
   batches (≈200), all-or-nothing.

The result is that re-ingesting an unchanged corpus costs only parse + hash, and any document
update is reflected atomically with no window where a document has half its chunks.

---

## 5. Storage & retrieval (Postgres + pgvector)

### Schema

Four tables: `sources`, `documents`, `chunks`, `ingestion_jobs`.

- `chunks.embedding` is `vector(768)` (Gemini `gemini-embedding-001`, or the 768-d `local` ONNX model).
- A **GIN** index on metadata + a **`tsvector`** column power sparse/full-text search.
- An **HNSW** index (`chunks_embedding_hnsw_idx`) powers dense cosine-similarity search.
- A trigger (`chunks_tsv_update`) populates the `tsvector` on write (callers may optionally
  precompute the tsvector to avoid N sync ops).
- A unique constraint on `(source_id, external_id)` plus a `content_hash` column enforce
  document-level idempotency.

### Two-phase migrations (important)

- **`0000_init.sql` is a bootstrap migration outside the Drizzle journal.** It is idempotent
  and runs on every `db:migrate`. It owns the things Drizzle _cannot express_: HNSW opclass
  options, the GIN-on-custom-tsvector index, and the plpgsql trigger.
- **Drizzle-managed migrations (`0001+`)** follow and are tracked in `__drizzle_migrations__`.

### Hybrid retrieval (RRF)

`packages/rag/src/retrieval/retriever.ts` (the `Retriever` class) embeds the query and delegates
to `hybridSearch` in `@rag/db`. Retrieval runs two CTEs and fuses them with **Reciprocal Rank
Fusion**. Verified mechanics (`packages/db/src/queries.ts`):

- **Dense CTE**: pure ANN — `ORDER BY embedding <=> q LIMIT pool`, no joins/filters, so the HNSW
  index is actually used. Score reported as `1 - cosine_distance`.
- **Sparse CTE**: `ts_rank_cd(tsv, plainto_tsquery('english', query))` over the GIN index, also
  pool-limited with no joins.
- **Fusion**: a `FULL OUTER JOIN` on `chunk_id`, scored
  `wDense·(1/(k + denseRank)) + wSparse·(1/(k + sparseRank))` with the RRF constant **`k = 60`**
  (from the original RRF paper); a missing rank is treated as `1_000_000`. Default weights are
  **dense `0.7` / sparse `0.3`** (injected into the `Retriever`; overridable per query). Final
  RRF scores are normalized to `[0,1]` by dividing by the max.
- **Filters run in the FINAL `SELECT`, not inside the CTEs** — putting an ACL/metadata filter
  inside the dense CTE would force a distance computation per matching row and defeat HNSW. To
  keep recall high after post-filtering, the candidate **pool is widened to `topK × 8`**
  (`candidatePoolMultiplier`, default 8).
- **Per-query recall tuning**: `SET LOCAL hnsw.ef_search = max(40, efSearch ?? 100)` inside the
  search transaction.
- **Safety**: a non-finite (`NaN`/`Infinity`) query embedding throws a clear error rather than
  letting pgvector emit an opaque "invalid input syntax for type vector".

### Access control is fail-closed

ACL enforcement lives in the hybrid-search query and is **fail-closed**:

- `enforcedSourceIds = null` → admin / unscoped (all sources).
- `enforcedSourceIds = []` → returns `[]` **before** the DB is even queried.
- `enforcedSourceIds = [...]` → `AND source_id IN (...)`.

This is the lowest layer of the authorization story (see §8).

---

## 6. The parser sidecar (`services/parser-py`)

A FastAPI service — the **only** Python in the system. It exists because MarkItDown +
Unstructured are materially better than the JS document-parsing ecosystem.

- **`POST /parse`** — multipart form-data (`file`, optional `filename`/`mime_type`). Rejects
  empty/oversized payloads (100 MB default → `413`). Responses are camelCase-serialized
  (snake_case internally via a Pydantic `alias_generator`).
- **`GET /health`** — never guarded by auth (probe-friendly).
- **Routing:** general formats write to a temp file and try **MarkItDown first** (fast, 25+
  formats, no OCR; returns `None`/empty on failure), then fall back to **Unstructured**
  (lazy-imported, ~500 MB models, OCR, handles scanned PDFs / images / malformed files).
- **Spreadsheet fast path:** XLSX/XLS/CSV/TSV bypass MarkItDown and parse from memory. XLSX
  does two `openpyxl` loads (`data_only=True` for computed values, `data_only=False` to count
  formula density for the classifier). A deterministic classifier labels each sheet
  `tabular | narrative | financial_model (≥0.20 formula density) | freeform` and emits one
  `ParsedTable` per sheet (headers, rows, counts, GFM markdown).
- **Auth (opt-in):** set `PARSER_SECRET` to require an `X-Parser-Token` header. Comparison is
  constant-time (`hmac.compare_digest`); the secret is read _per request_ (easy rotation);
  duplicated headers are split on comma and accepted if any candidate matches. Empty/unset
  secret = auth disabled.

> **Operational note:** the parser is a separate process. If parsing fails locally, first check
> the container is up (`docker ps`) and reachable at `PARSER_URL`.

---

## 7. The two surfaces: HTTP API & MCP server

Both surfaces are **thin validate-then-delegate adapters** over `@rag/services`. They share
the same scoping and confidentiality guarantees because the logic lives in one place.

### HTTP API (`apps/api`, Fastify v5)

- Routes: `/health` (public), `/ready` (public DB liveness, scrubbed errors), `/search`,
  `/ask`, `/documents/:id`, `/sources` (POST create, GET list, GET `:id`),
  `/sources/:id/sync` (returns `202` + `jobId`/`ingestionId`).
- Bearer auth on every non-public path via `AuthProvider.authenticate(credential)`, run once
  per request in an `onRequest` hook that decorates `request.principal`. Missing/malformed
  Bearer → `401`; a `null` principal (provider rejected) → fail-closed `401`.
- Error-code → HTTP mapping: `VALIDATION → 400`, `NOT_FOUND → 404`,
  `SYNC_ALREADY_RUNNING → 409`, `GENERATION_NOT_CONFIGURED → 503`, `CONNECTOR_* → 502/503`,
  `ZodError → 400`, unknown → `500`.
- **No CORS** (browser cross-origin is unsupported by design). **No token streaming** — `/ask`
  returns a complete JSON response.

### MCP server (`apps/mcp`, dual transport)

- Five tools: `search_documents` / `ask` / `get_document` are **scoped** (respect the session's
  token-derived authorization scope); `list_sources` / `trigger_sync` are **unscoped**. Plus a
  `documents://{id}` resource (`text/markdown`).
- **stdio transport:** spawned locally, granted `ADMIN_SCOPE` — the only sanctioned unscoped
  path. `pino` must log to **stderr** because stdout is the JSON-RPC channel.
- **HTTP transport:** Express + `StreamableHTTPServerTransport`. Scope is derived **per session**
  at `initialize` from the Bearer token and bound to that session's server; fails closed to
  `DENY_ALL_SCOPE`. A capacity-bounded session map (`MCP_MAX_SESSIONS`, default 1000) returns
  `503` when full; an Origin allow-list guards against browser DNS-rebinding;
  `normalizeSessionId` collapses duplicate `mcp-session-id` headers.

### Shared startup gates (both apps)

Before listening, both `main.ts` run guards that prevent silent degradation:

- `assertEmbeddingDimensions()` — fail fast if the configured embedding dimension ≠ the
  `chunks.embedding` column (768).
- `assertRequiredIndexes()` — fail to start if the HNSW / GIN / tsv trigger were dropped (they
  are invisible to Drizzle and thus vulnerable to an accidental `drizzle-kit` `DROP`).

---

## 8. Authentication & authorization

Two distinct layers — don't conflate them.

### Authentication: pluggable `AuthProvider`

`AuthProvider.authenticate(credential) → Promise<Principal | null>`, defined in `@rag/core`,
built once via `buildAuthProvider(config, logger)` from `@rag/runtime`.

- **Strategies** (selected by `AUTH_PROVIDER`): `static-token`, `oidc`, and `composite`
  (default — tries static tokens first, then OIDC).
- **Fail-loud configuration by design:** `AUTH_PROVIDER=oidc` with no `OIDC_ISSUER`/
  `OIDC_AUDIENCE` throws at startup. An empty token allow-list throws at construction. A
  misconfigured deployment never silently accepts everything.
- The core contains **zero IdP-specific code** (e.g. no Entra). `composite` with no `OIDC_*`
  set behaves exactly like the legacy static-token setup, giving a zero-breaking-change
  migration path.

### Authorization: Principal → Scope → scope-threaded retrieval

The `AuthProvider` sits **in front of** the existing authorization machinery; it does not
replace it. The unchanged contract is:

`Principal` → `AuthorizationScope` → scope threaded into `hybridSearch` (the fail-closed
`enforcedSourceIds` from §5).

- The API derives scope **per request** (`scopeFromRequest(request.principal)`); MCP HTTP
  derives it **per session** at `initialize`. Both fail closed to `DENY_ALL_SCOPE`.
- **Confidentiality invariant (P1b):** a forbidden source and a missing id throw an
  _identical_ "not found" in all three places that can leak existence — API `/documents/:id`,
  MCP `get_document`, and the MCP `documents://` resource. Existence is never leaked.

### Adding a new auth provider

1. Implement `AuthProvider` in `packages/core/src/`. **Fail closed:** return `null` for
   anything you can't positively authenticate; never throw for a bad credential.
2. Add the config shape to `AuthProviderConfig` and a `case` in `createAuthProvider`
   (`auth-provider-factory.ts`). Keep env parsing OUT of core.
3. Wire env → config in `buildAuthProvider` (`@rag/runtime`).
4. Document the env vars in `env.example`.

---

## 9. Applying this to a knowledge base of _any_ kind

The system is domain-agnostic. "A knowledge base" is just: a set of **sources** + a
**connector** that can list/fetch them + formats the **parser** can handle. To stand up a new
knowledge base:

1. **Pick or build a connector.** If your content lives in SharePoint / Google Drive / Gmail /
   Outlook, it's already supported. Otherwise implement the `Connector` interface
   (`validate`, `list`, `fetch`; delta sync is driven by the `cursor` passed to `list()`),
   add it under `packages/connectors/src/<name>/`, register it in the connectors `index.ts`,
   document credentials in `docs/CONNECTORS.md`, and add env vars to `env.example`.
2. **Confirm the parser covers your formats.** MarkItDown + Unstructured handle the long tail
   of office/PDF/HTML/image formats already. Structured spreadsheets get first-class table
   extraction. New exotic formats are a parser-sidecar change, not a core change.
3. **Decide the embedding model.** Default is Gemini 768-dim. To switch (e.g. OpenAI 1536-dim),
   implement `EmbeddingProvider` in `packages/rag/src/embeddings/<name>.ts`, register it in the
   factory, **change the `chunks.embedding` column dimension and rebuild the HNSW index**, and
   re-embed (embeddings are immutable per provider/model/dimensions).
4. **Register sources & sync.** Create sources via `/sources`, trigger ingestion via
   `/sources/:id/sync` (async). The worker ingests; idempotency means re-syncs are cheap.
5. **Choose your auth posture.** Dev: a static token. Production: OIDC against your IdP via
   `AUTH_PROVIDER=oidc`. Multi-tenant: scope each token's `sourceIds` so retrieval is
   physically constrained per principal — the fail-closed ACL guarantees isolation.
6. **Consume via API or MCP.** Apps call the HTTP API; agents use the MCP server (the
   agent-facing surface). Both honor the same scoping.

Because every axis of variation (source, format, embedding model, IdP, content domain) is a
plug-in behind a `@rag/core` interface, adapting to a new use case is _configuration +
interface implementation_, never a rewrite of the retrieval or service core.

---

## 10. Things that will trip you up

- **Search-index drift is the #1 footgun.** HNSW / GIN / the tsv trigger are owned by
  `0000_init.sql` and invisible to Drizzle. A stray `drizzle-kit generate` will emit `DROP`s
  for them. If dropped, dense search silently falls back to seq scans and sparse search
  returns empty — _no error_. Three layers defend: schema comments, the runtime
  `assertRequiredIndexes()` startup gate, and a static `migration-guard.test.ts` that fails CI.
- **pgvector dimension mismatch.** The column is `vector(768)` for Gemini. Switching to a
  different-dimension model means changing the column **and** dropping/rebuilding the HNSW index
  **and** re-embedding. The hardcoded column only errors on first INSERT (after you've spent
  embedding credits); `assertEmbeddingDimensions()` catches it at startup instead.
- **The Python parser is a separate process.** Parsing failures locally are usually a down or
  unreachable `parser` container (`docker ps`, `PARSER_URL`).
- **pg-boss schema auto-creates.** It builds the `pgboss` schema on first connect; nuking the DB
  needs no manual migration.
- **Microsoft Graph throttling.** SharePoint and Outlook **share one Graph quota**. Bulk
  re-syncs of huge libraries should be staged or they hit `429` faster.
- **Parser shared-secret auth is opt-in.** If `PARSER_SECRET` is set, the worker's
  `HttpParserClient` and the parser service must agree or every parse `401`s. Empty/unset =
  disabled.
- **Client auth config fails loud by design.** `AUTH_PROVIDER=oidc` with no `OIDC_*` throws at
  startup; an empty token allow-list throws at construction. `composite` (default) with no
  `OIDC_*` is exactly the legacy static-token behavior.
- **MCP stdio: log to stderr.** stdout is the JSON-RPC channel; `pino` writing there corrupts it.
- **Connector delta cursors are fragile.** GDrive/Gmail fall back to a full re-scan (warn-log
  only) if cursor state is incomplete. GDrive folder scope is non-recursive. SSRF defense in the
  Graph client is a hardcoded absolute-URL allow-list — keep it intact.
- **Migrations in the e2e harness load `0000_init.sql` directly,** not via `pnpm db:migrate`.
  If migrations are later split across files, the harness would silently miss them.
- **`FakeEmbedder` masks RRF weight differences** in the eval harness (its bag-of-words dense
  signal mirrors BM25). Conclusions about production dense/sparse balance require _real_
  embeddings.

---

## 11. Common commands

```bash
pnpm install            # bootstrap workspace
pnpm docker:up          # boot Postgres + Python parser locally
pnpm docker:down        # stop the local stack
pnpm db:generate        # generate Drizzle SQL from schema changes
pnpm db:migrate         # apply migrations
pnpm dev:api            # run HTTP API (port 3000)
pnpm dev:mcp            # run MCP server (stdio by default)
pnpm dev:worker         # run ingestion worker
pnpm build              # build all packages + apps
pnpm typecheck          # workspace-wide tsc --noEmit
pnpm test               # workspace-wide vitest
pnpm e2e                # end-to-end tests (@rag/e2e)
pnpm eval               # retrieval evaluation harness
pnpm gen:parser-types   # regenerate parser TS types from the parser's OpenAPI schema
```

---

## 12. Extension checklists (quick reference)

**New connector:** implement `Connector` (`validate`/`list`/`fetch`, cursor-driven delta) →
add `packages/connectors/src/<name>/` → register in connectors `index.ts` → document in
`docs/CONNECTORS.md` → add env to `env.example`.

**New embedding provider:** implement `EmbeddingProvider` in `packages/rag/src/embeddings/<name>.ts`
→ register in `embeddings/factory.ts` → document model + dimensions in `env.example` and
`docs/ARCHITECTURE.md` → adjust the `vector(N)` column + HNSW index if dimensions differ → re-embed.

**New auth provider:** implement `AuthProvider` (fail closed) in `packages/core/src/` → add to
`AuthProviderConfig` + a `case` in `createAuthProvider` → wire env in `buildAuthProvider`
(`@rag/runtime`) → document env in `env.example`.

**New service capability:** add it to `@rag/services` against `ServiceDeps` so both the API and
MCP inherit it with identical scoping — never in a route or tool.

---

## 13. The worker process & job lifecycle

`apps/worker/` is the third app. It is a long-running pg-boss consumer — the asynchronous half
of "ingestion is always async" (§3).

### Lifecycle (`apps/worker/src/main.ts`)

1. `loadConfig()` from env, then `assertEmbeddingDimensions(config.embedding.dimensions)` **before
   building deps or embedding anything** — a mismatch otherwise only surfaces at the first INSERT,
   mid-sync, after embedding credits are spent.
2. `buildDeps(config, logger)` constructs long-lived deps (DB pool, parser client, chunker,
   embedder, queue, connector factory).
3. `assertRequiredIndexes(...)` — **refuse to start** if the HNSW/GIN indexes were dropped, rather
   than serve silently-degraded (seq-scan) retrieval.
4. Register a pg-boss worker for `JOB_NAMES.syncSource`.
5. Wait for `SIGTERM`/`SIGINT`, then `deps.close()` (drains pg-boss + closes the DB pool).
   `unhandledRejection`/`uncaughtException` are fatal-logged and trigger shutdown with exit code 1.

### Concurrency & scaling

- **Horizontal scaling:** run N copies of the worker against the same Postgres. pg-boss uses
  row-level locks, so each job is dispatched to exactly one worker.
- pg-boss v10 knobs: `batchSize = config.worker.concurrency` (jobs pulled per poll; renamed from
  `teamSize`) and `pollingIntervalSeconds = max(1, round(pollIntervalMs/1000))`.
- The batch handler processes jobs **serially** on purpose: the ingestion pipeline already
  parallelizes _documents within a single sync_ via its own `concurrency`, so stacking both would
  multiply load on the parser sidecar and the embedding API.

### The `syncSource` handler (`apps/worker/src/handlers/sync-source.ts`)

1. Resolve the source row. **If it was deleted between enqueue and execution**, mark the
   `ingestion_jobs` history row `failed` ("source not found") and return — otherwise pg-boss marks
   the job completed and the history row would sit `pending` forever.
2. Transition the history row to `running` (with `startedAt`). Note: `triggerSync` is the **sole
   writer** that _creates_ `ingestion_jobs` rows; the worker only moves them through their lifecycle.
3. Build the connector via the factory, `validate()` it, choose the start cursor
   (`mode === "full"` → `null` for a full re-scan, otherwise resume from `source.cursor`), and call
   `runIngestion(...)` with `{ concurrency, pageSize: 50 }`.
4. On success, mark the row `completed` with counts (`documentsProcessed`, `documentsFailed`,
   `chunksCreated`). **On error, mark it `failed` and re-throw** — the throw is intentional so
   pg-boss records the failure and applies its retry policy.

### Enqueue side (recap)

The API's `triggerSync` enqueues with `singletonKey: sync:{sourceId}` (one in-flight sync per
source), 3 retries, 60s retry delay, 6h expiry. A falsy `sourceId` throws
`SyncAlreadyRunningError` → `409`.

---

## 14. Testing & evaluation harness (`tests/e2e/`)

A vitest + TypeScript suite (~2.2k lines) that exercises the real pipeline against a real Postgres,
plus a retrieval-quality eval subsystem.

### Test infrastructure

- **Global setup** ensures the docker stack is up (prefers the `docker-compose` binary), polls
  Postgres + parser `/health` (60s each), and applies `0000_init.sql` in a single transaction.
- **Per-spec isolation:** each spec opens a pooled Drizzle handle; every test runs
  `TRUNCATE ... RESTART IDENTITY CASCADE`.
- **`buildTestApi`** builds an in-process Fastify app (no port binding — all requests via
  `inject()`) wired with `FakeEmbedder`, `FakeConnector`, `FakeGenerator`, a **real** `Retriever`
  over the test DB, and a pg-boss **stub** (only `stop()`).
- **`runOneIngestion`** drives the real pipeline synchronously (live `HttpParserClient` + real
  `CompositeChunker` + `FakeEmbedder`), bypassing pg-boss so the result is awaitable.

> **Coverage caveat:** because the queue is stubbed, the pg-boss enqueue/dequeue path is **not**
> exercised by e2e — tests verify DB end-state, not async job dispatch. (The worker handler logic
> above is covered by reading/inspection + unit-level checks, not the live queue.)

### What's covered

- **HTTP API:** bearer validation, public `/health`, `/sources` CRUD with config sanitization,
  `/search` RRF ranking + topK validation, `/ask` early-exit on empty retrieval (generator never
  called).
- **Ingestion end-state:** token counts, contiguous ordinals, SHA-256 hashes, cursor persistence.
- **Idempotency:** unchanged content → 0 new chunks; changed content → atomic replacement.
- **Retrieval:** topical ranking margin (>20%), dense+sparse component scoring, `sourceIds`
  filtering, principal-scope fail-closed enforcement, empty-match safety.
- **Spreadsheets:** CSV → `TableChunker` with header repetition and `sheetName → headingPath`
  (CSV is used as a cheap XLSX proxy to avoid an `xlsx` test dependency).

### Eval subsystem (`pnpm eval`)

- **Corpus:** 14 keyword-distinctive documents (Postgres / RAG / unrelated distractors) plus 17
  golden questions (3 multi-doc) with labeled relevant sets. The corpus is designed so
  `FakeEmbedder`'s deterministic 768-dim SHA-256 bag-of-words signal tracks keyword overlap.
- **Metrics:** `recall@k`, `precision@k`, `nDCG@k`, `reciprocalRank` at `k = [1,3,5,10]`.
- **Regression trip-wires:** `recall@5 ≥ 0.8`, `recall@3 ≥ 0.7`, `nDCG@5 ≥ 0.6`, `MRR ≥ 0.6`, plus
  a monotonicity check. `sweepWeights` evaluates five dense/sparse configurations.
- **Important limitation:** `FakeEmbedder`'s bag-of-words dense signal mirrors BM25 sparse, so the
  weight sweep proves the _fusion machinery_ works but **masks real dense/sparse balance** — any
  conclusion about the production `0.7/0.3` split requires real embeddings.
