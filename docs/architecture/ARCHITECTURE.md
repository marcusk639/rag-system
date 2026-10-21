---
title: Architecture
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: How the RAG system is built — packages, runtime surfaces, ingestion and queue semantics, schema and migrations, parser, auth layers, startup gates, worker lifecycle, and how each part fails. Retrieval and /ask are in RETRIEVAL.md.
read_when: Before changing ingestion, the queue, the schema, retrieval, /ask, or auth; or when you need the mechanism behind a behaviour you are debugging.
supersedes:
  [
    RAG-ARCHITECTURE-GUIDE.md,
    QUEUE-ARCHITECTURE-REVIEW.md,
    PLAN-PER-PAGE-REENQUEUE.md,
  ]
code:
  [
    packages/ingestion/src/pipeline.ts,
    packages/ingestion/src/queue.ts,
    apps/worker/src/handlers/sync-source.ts,
    packages/db/src/schema.ts,
    packages/db/src/migrate.ts,
    packages/core/src/access-control.ts,
  ]
---

# Architecture

This is the canonical description of how the system works. One Postgres database (with pgvector)
holds documents, chunks, embeddings, the full-text index and the pg-boss job queue. Connectors feed
an asynchronous, per-page ingestion pipeline run by a worker. A single SQL statement does hybrid
retrieval: dense HNSW search and sparse full-text search, fused with weighted Reciprocal Rank
Fusion. Two thin adapters, the HTTP API and the MCP server, sit over one transport-agnostic service
layer, and every retrieval call carries a fail-closed authorization scope.

What this file does not repeat:

- The ground rules, commands and gotchas live in the root [`CLAUDE.md`](../../CLAUDE.md). That
  covers layering rules, "ingestion is always async", the `COMPLIANCE_MODE=client-data` boot
  checks, the `CHUNK_SIZE` cap, the Railway image divergence and the add-a-provider checklists.
- Why each design was chosen, and what was rejected, is in [`DECISIONS.md`](./DECISIONS.md).
- Endpoint, tool and error-code tables are in [`../reference/API.md`](../reference/API.md) and
  [`../reference/MCP.md`](../reference/MCP.md). Connector specifics are in
  [`../reference/CONNECTORS.md`](../reference/CONNECTORS.md).
- The content-safety gates (redaction, semantic scan, classification) are in
  [`../compliance/CONTENT-SAFETY-DESIGN.md`](../compliance/CONTENT-SAFETY-DESIGN.md).
- Hybrid search, reranking, the `/ask` stages, chunking and embeddings are in
  [`RETRIEVAL.md`](./RETRIEVAL.md), split out for size.

If this file disagrees with the code, the code wins. Fix this file.

## System at a glance

```
 Connectors ──► worker (pg-boss job, ≤5 pages) ──► parser sidecar ──► safety gates ──► chunker ──► embedder ──► Postgres
 SharePoint, Drive,   per-page continuation         MarkItDown →        Layer 2/1/1.5/3   markdown /   gemini /     chunks: HNSW +
 Gmail, Outlook,      jobs, singleton per source    Unstructured                          table        local/openai  tsvector + GIN
 git-markdown, eCFR,
 custom (uploads)

 web (BFF) / teams-bot ──► apps/api ─┐
 MCP clients ──────────► apps/mcp ──┴► @rag/services ──► Retriever ──► hybridSearch (one SQL statement, RRF)
                                                    └──► /ask: screen → condense → retrieve → assemble → screen → generate → cite
```

## Packages and layering

Each cross-cutting concern has exactly one owner. Apps are thin input/output adapters.

| Package           | Owns                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rag/core`       | Contracts only: interfaces, the env-validated `Config` (`config.ts`, `config-schema.ts`), validation (`validation.ts`), error classes, auth providers, `Principal` and `AuthorizationScope` (`access-control.ts`), parser types generated from the sidecar's OpenAPI. |
| `@rag/db`         | Every SQL statement: `schema.ts`, `queries.ts`, `hybrid-search.ts`, `hnsw.ts`, `required-indexes.ts`, `embedding-dimensions.ts`, `migrate.ts`, `manage-access.ts`.                                                                                                    |
| `@rag/rag`        | Chunkers, embedding providers, the `Retriever`, the reranker, the generator and prompt building.                                                                                                                                                                      |
| `@rag/connectors` | Source adapters. The four OAuth connectors share `util/paginate.ts` and `util/cursor.ts` (one cursor codec, one `done` definition) instead of a base class.                                                                                                           |
| `@rag/ingestion`  | The pipeline (`pipeline.ts`), content-safety gates (`ingest-gates.ts`, `classify-document.ts`), and the queue (`queue.ts`).                                                                                                                                           |
| `@rag/services`   | Transport-agnostic business logic. The function list is in [`CLAUDE.md`](../../CLAUDE.md). `triggerSync` is the only code that creates `ingestion_jobs` rows.                                                                                                         |
| `@rag/runtime`    | The composition root. `buildCoreDeps(config, logger)` wires the DB pool, embedder, retriever (with optional reranker), queue, optional generator and an idempotent `close()`. `buildAuthProvider` builds the `AuthProvider`. `captureException` reports to Sentry.    |

## Runtime surfaces

| Surface              | Role                                                                                                                                                       | Talks to                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/api` (Fastify) | HTTP API: search, ask (JSON and SSE stream), documents and downloads, sources, sync, purge, uploads, feedback. Bearer auth on every non-public route.      | `CoreDeps`                                                                                             |
| `apps/mcp`           | Agent-facing MCP server: six tools plus a `documents://{id}` resource, over stdio or Streamable HTTP.                                                      | `CoreDeps`                                                                                             |
| `apps/worker`        | pg-boss consumer for `rag.sync_source`, plus two scheduled jobs: `rag.docs_gap_digest` and `rag.ship_audit_log`.                                           | `CoreDeps` plus parser, chunker, connectors, scanner pack                                              |
| `apps/web` (Next.js) | Chat UI with a server-side BFF. It signs a 60-second per-user scope-assertion JWT and calls the API. See [`apps/web/CLAUDE.md`](../../apps/web/CLAUDE.md). | API over HTTP; reads `@rag/db` only to resolve grants (`resolveSourceIdsForUser`) and for the admin UI |
| `apps/teams-bot`     | Teams bot with Entra SSO and Adaptive Cards. Single instance only (`MemoryStorage`).                                                                       | API over HTTP; reads `@rag/db` only to resolve grants                                                  |
| `services/parser-py` | FastAPI sidecar that converts any format to markdown plus tables. The only Python in the system.                                                           | Called by the worker (`HttpParserClient`)                                                              |
| `services/backup`    | Nightly `pg_dump` cron service (`backup.sh`). See [`../operations/BACKUP-AND-RECOVERY.md`](../operations/BACKUP-AND-RECOVERY.md).                          | Postgres                                                                                               |
| Postgres + pgvector  | All state, including the `pgboss` schema, which pg-boss creates on first connect.                                                                          | —                                                                                                      |

The API and MCP enqueue syncs but never run them. The worker never serves queries.

## Ingestion pipeline

### Trigger and history row

1. `POST /sources/:id/sync` or the MCP `trigger_sync` tool calls `triggerSync()`
   (`packages/services/src/sources.ts`). It creates one `ingestion_jobs` row with status `pending`,
   then calls `enqueueSync` with that row's id as `ingestionId`.
2. If the enqueue fails, `triggerSync` deletes the row (on `SyncAlreadyRunningError`) or marks it
   `failed` (any other error), so no row is left stuck in `pending`.
3. The worker only moves that row through its lifecycle: `running`, then `completed` or `failed`.
   It never creates one, and continuation jobs reuse the same `ingestionId`. One logical sync is
   one history row.

### What one job does

`handleSyncSource` (`apps/worker/src/handlers/sync-source.ts`) runs these steps:

1. Load the source. If it was deleted after the enqueue, mark the row `failed` with "source not
   found" and return. Otherwise pg-boss would mark the job complete and the row would stay
   `pending` forever.
2. On the first job of a sync only: set the row to `running` with `startedAt`, and call
   `connector.validate()`. Continuations skip both, so a long sync doesn't multiply Microsoft
   Graph auth calls against the shared Graph quota.
3. Pick the start cursor. `mode: "full"` starts at `null` on the first job only. Every
   continuation resumes from the persisted `sources.cursor`, even for a full sync.
4. Call `runIngestion` with `pageSize: 50` and `maxPagesPerRun: PAGES_PER_RUN` (5), which is about
   250 documents per job. On the first job, `retryFailed: true` re-attempts documents that failed
   on earlier syncs. A document stops being retried after `MAX_INGEST_ATTEMPTS` (5, in
   `packages/ingestion/src/failed-documents.ts`).
5. Add this job's counts to the history row with `incrementIngestionJobCounters`.
6. Decide the outcome:
   - If any document was quarantined because a safety gate could not reach a verdict, mark the row
     `failed`, report to Sentry, and return without throwing. A retry can't help while the gate is
     down.
   - If `result.done`, call `markSourceSynced` (stamps `sources.lastSyncedAt`) and mark the row
     `completed`.
   - Otherwise, enqueue a continuation as the last step. See
     [Queue semantics](#queue-semantics-pg-boss).
7. On any thrown error, mark the row `failed`, log `marker: "ingest.sync.failed"` and re-throw so
   pg-boss applies its retry policy. Sentry is only notified on the final attempt
   (`retryCount >= retryLimit`).

### Inside `runIngestion`, per page

`packages/ingestion/src/pipeline.ts`:

- The run refuses to start without an identifier-scanner pack that has at least one scanner.
- The loop ends on the connector's `page.done` or when the page budget runs out. **An empty page is
  not end-of-feed**: a feed that yields only drafts or deletions must not end the walk early.
- Documents on a page are ingested concurrently (`pLimit(concurrency)`, `Promise.allSettled`). A
  failed document is recorded for retry and does not fail the page.
- Deletion tombstones remove the document and its chunks (FK cascade), plus the stored original.
  If any tombstone fails, the page throws `DeletionReconciliationError` **before** the cursor is
  saved, so the deletion is retried rather than lost.
- After each page, `updateSourceCursor` persists the cursor only. It does not touch
  `lastSyncedAt`.

### Inside `ingestOne`, per document

1. **Layer 2, path exclusion.** Excluded paths are never parsed. This reads `metadata.path`, which
   only the SharePoint connector sets. On other connectors the check logs that it could not run.
2. **Parse** through the sidecar. See [Parser sidecar](#parser-sidecar).
3. **Layer 1, identifier redaction** over the markdown, tables and title, before anything is
   embedded or stored.
4. **Layer 1.5, semantic scan** for client-identifying context (off unless a scanner is
   configured).
5. **Layer 3, classification.** The source's class is a ceiling. Evidence in the document can only
   make it stricter. A quarantined document gets a durable `ingest_log` row and is purged. Class C
   and D sources throw `ClassBlockedError`.
6. **Hash.** SHA-256 of `v${CONTENT_PROCESSING_VERSION}\n` plus the redacted markdown. Bumping
   `CONTENT_PROCESSING_VERSION` (currently `2`) forces every document to re-chunk and re-embed on
   the next sync.
7. **Upsert** on `(source_id, external_id)`. One statement snapshots the previous `content_hash`
   and runs `INSERT ... ON CONFLICT`. `xmax = 0` identifies a fresh insert, so "content changed" is
   race-safe (`packages/db/src/queries.ts` `upsertDocument`). An `ingest_log` row is written, and a
   TRI scan adds an audit event without blocking.
8. **Store the original** in the object store, unless the document was redacted. A redacted
   document keeps no original, and any earlier one is deleted.
9. **Short-circuit** if the hash is unchanged **and** chunks already exist for the active embedding
   provider and model. If the hash matches but no chunks exist (for example, an earlier embed hit a
   429), the document is re-embedded.
10. **Chunk**, then **embed** all chunks in one `embedBatch` call. A count mismatch throws
    `EmbeddingError`.
11. **Replace chunks** in one transaction: delete the old ones, insert the new ones in batches of
    200 (`replaceChunks`). A document is never left half-indexed.

Re-ingesting an unchanged corpus costs a parse and a hash per document. The gate details, and why
redaction must come before embedding, are in
[`../compliance/CONTENT-SAFETY-DESIGN.md`](../compliance/CONTENT-SAFETY-DESIGN.md).

## Queue semantics (pg-boss)

pg-boss runs in the same Postgres. `^10.1.6` is declared; the lockfile resolves `10.4.2`. Queues
are created at boot by `createQueue` (`packages/ingestion/src/queue.ts`) in every process that
builds `CoreDeps`.

| Setting        | Value                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Job name       | `rag.sync_source`. Payload: `{ sourceId, mode, ingestionId, continuation?, continuationCount? }`                           |
| Queue policy   | `singleton`, applied with `boss.updateQueue` on every boot                                                                 |
| `singletonKey` | `sync:${sourceId}`                                                                                                         |
| Retries        | `retryLimit: 3`, `retryDelay: 60`, `retryBackoff: true`                                                                    |
| Expiry         | `expireInSeconds: SYNC_EXPIRE_SECONDS` (1800). This is per job, which means per page budget, not per sync.                 |
| Archive        | `archiveCompletedAfterSeconds: 86400`                                                                                      |
| Worker knobs   | `WORKER_CONCURRENCY` (default 4) sets `batchSize`. `WORKER_POLL_INTERVAL_MS` (default 2000) sets `pollingIntervalSeconds`. |

**`singletonKey` alone does nothing.** pg-boss's uniqueness indexes are gated on the queue's
policy. Under the default `standard` policy, a `singletonKey` without `singletonSeconds` gives no
deduplication and no serialization. This was confirmed in the pg-boss 10.4.2 source and by a spike
on 2026-06-19. Under `singleton`, at most one job per key is **active**, and later jobs with the
same key queue behind it. That is what stops two jobs racing on `sources.cursor`.

- **`createQueue` can't change a policy.** It is `ON CONFLICT DO NOTHING`. `updateQueue` changes it
  in place, idempotently and reversibly, with no drop and recreate. A policy change applies to
  newly inserted jobs; in-flight jobs finish under their old policy.
- **A duplicate external trigger queues; it isn't rejected.** `boss.send` returns an id for the
  queued job, so `enqueueSync` throws `SyncAlreadyRunningError` (HTTP 409) only if pg-boss refuses
  the insert outright. Whether to restore a hard "reject duplicate" contract with an app-level
  guard on a `running` row is undecided. It is tracked in [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).
- **Continuation.** When a job ends with `done === false`, the worker first checks that the cursor
  advanced, then calls `enqueueContinuation` (same `ingestionId`, `continuation: true`,
  `continuationCount + 1`). A `null` return is treated as an error. The continuation queues behind
  the still-active job.
- **Loop bounds.** A job aborts if the cursor did not advance while `done` is false, or if
  `continuationCount` exceeds `MAX_SYNC_CONTINUATIONS` (100,000).
- **Counters are approximate.** Additive counters can double-count a page that is retried after a
  crash. Treat them as observability. For exact numbers, run `COUNT` over `documents` and `chunks`.
- **`lastSyncedAt` means "the last sync finished".** It advances only on the terminal job. The MCP
  `trigger_sync` tool tells callers to poll it.
- **Mixed-fleet deploys are safe.** A payload without `continuation` is treated as a first job. An
  older worker that receives a continuation drains from `source.cursor`, which is coarse but
  correct.
- **Failure visibility** comes from the `failed` history row, the `ingest.sync.failed` log marker
  and Sentry (when `SENTRY_DSN` is set). There is no dead-letter queue and no health endpoint that
  lists failed syncs.

The reason for keeping pg-boss rather than moving to BullMQ, Graphile Worker, Temporal or a cloud
queue, and the conditions that would reopen that question, are in [`DECISIONS.md`](./DECISIONS.md).

## Database

### Tables

All 13 tables are defined in `packages/db/src/schema.ts`. pg-boss keeps its own tables in the
`pgboss` schema, and Drizzle records applied migrations in `drizzle.__drizzle_migrations`.

| Table                       | What one row is                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`                   | A configured external system: `kind`, connector `config`, `cursor`, `last_synced_at`, `data_class`.                                                                  |
| `documents`                 | One ingested document. Unique on `(source_id, external_id)`. Holds `content_hash`, `metadata` (GIN-indexed), storage columns, `lifecycle_status` and `content_type`. |
| `chunks`                    | One embedded slice: `text`, `hash`, `ordinal`, `heading_path`, `embedding vector(768)`, `embedding_provider`, `embedding_model`, `tsv`.                              |
| `ingestion_jobs`            | Human-readable history of one logical sync: status, mode, counters (including quarantine counts), error. pg-boss holds the job state itself.                         |
| `pending_uploads`           | Browser-uploaded files waiting for the `custom` connector to pick them up on the next sync.                                                                          |
| `ingest_log`                | One row per document ingestion attempt: ingested, blocked, quarantined or failed. The durable per-document audit trail.                                              |
| `audit_log`                 | One row per ask, ask-stream or search call. Holds the question **hash**, chunk ids, top score and `principal_subject`. Raw text only under `AUDIT_LOG_CONTENT=full`. |
| `answer_feedback`           | One helpful or not-helpful vote per `(answer_id, principal_subject)`. The last vote wins. No foreign key to `audit_log`.                                             |
| `staff_client_assignments`  | User-to-client grant. Soft-delete only (`revoked_at`). Unique on `(user_id, client_id)`.                                                                             |
| `source_client_assignments` | Source-to-client mapping. Joined with the table above by `resolveSourceIdsForUser`.                                                                                  |
| `staff_source_assignments`  | Direct user-to-source grant for firm-internal sources that have no client. Soft-delete only.                                                                         |
| `docs_gap_digest_runs`      | One run of the scheduled docs-gap digest. Aggregate counts only.                                                                                                     |
| `audit_log_shipper_state`   | A single-row watermark for shipping `audit_log` off-host.                                                                                                            |

Enums: `source_kind` (`sharepoint`, `gdrive`, `gmail`, `outlook`, `custom`, `git-markdown`,
`ecfr-part4`); `ingestion_status`; `data_class` (`general`, `research`, `sop`,
`client_confidential`), a source-level setting that maps onto document classes A to D; and
`content_type`, a librarian taxonomy kept separate from `data_class`. Grant management is covered
in [`../operations/ACCESS-CONTROL.md`](../operations/ACCESS-CONTROL.md).

### Search objects Drizzle can't see

`0000_init.sql` owns three objects that Drizzle's model cannot express:

- `chunks_embedding_hnsw_idx`: HNSW with `vector_cosine_ops`.
- `chunks_tsv_idx`: GIN on `tsv`.
- `chunks_tsv_update`: the plpgsql trigger that fills `tsv` from `text`.

A stray `drizzle-kit generate` emits `DROP` statements for them. If they are dropped, dense search
falls back to sequential scans and sparse search matches nothing, with no error. Three defences
exist:

- schema comments;
- the startup assert `assertRequiredIndexes` (`packages/db/src/required-indexes.ts`, lists
  `REQUIRED_SEARCH_INDEXES` and `REQUIRED_CHUNK_TRIGGERS`);
- `packages/db/src/migration-guard.test.ts` in CI.

`0000_init.sql` also holds the commented statements for changing the embedding dimension
(re-type the column, then drop and rebuild the HNSW index).

### Two-phase migrations

`applyMigrations` (`packages/db/src/migrate.ts`) is the single migration path. It is used by
`pnpm db:migrate`, the Railway pre-deploy command and the e2e global setup.

1. **Bootstrap.** `0000_init.sql` runs in one transaction on every migrate. It is idempotent
   (`IF NOT EXISTS`, `DO` blocks) and **deliberately not in the journal**, because Drizzle's
   statement-breakpoint parser cannot split its `DO $$` blocks and triggers. Its absence from the
   journal is not a bug. The journal therefore starts at `0001`, so a journal entry's `idx` is its
   file number minus one.
2. **Journal.** Drizzle's migrator applies `drizzle/meta/_journal.json` entries `0001` to `0021`.

**The journal's `when` must be strictly increasing.** Drizzle runs entries in array order, but it
runs an entry only if `MAX(created_at)` in `__drizzle_migrations` is less than that entry's `when`
(`folderMillis`). This was checked in `drizzle-orm` 0.45.4 `pg-core/dialect.js`. A `when` lower
than an already-applied one is skipped silently, forever.

- `drizzle-kit generate` stamps `Date.now()`, so this bug only comes from hand-editing, typically
  a merge resolution.
- Before adding a migration, check the journal tail on `origin/main`.
- A migration applied by hand must record `hash` as the SHA-256 of the raw `.sql` file and
  `created_at` equal to the journal `when` (that is what Drizzle's `readMigrationFiles` computes).
  The procedure is in
  [`../operations/BACKUP-AND-RECOVERY.md`](../operations/BACKUP-AND-RECOVERY.md).
- Primary keys use `uuid_generate_v4()` from the `uuid-ossp` extension that `0000_init.sql`
  enables. Follow that convention in new migrations.

Who runs migrations on deploy, and in what order services deploy, is in [`CLAUDE.md`](../../CLAUDE.md).

## Retrieval and the `/ask` pipeline

Hybrid search, the retriever and reranking, the `/ask` stages, chunking and embeddings are in
[`RETRIEVAL.md`](./RETRIEVAL.md). The short version:

- One SQL statement fuses an HNSW dense arm and an OR-semantics `ts_rank_cd` sparse arm with
  weighted RRF (`k = 60`, 0.7 / 0.3), over a pool of `topK × 8` capped at 1000.
- The ACL and the withdrawal gate run inside both candidate CTEs; caller filters run after fusion.
- `/ask` screens the question before embedding, condenses follow-ups for retrieval only,
  over-fetches, collapses duplicates, caps per document, applies an optional relevance floor,
  expands neighbours, screens context, then generates with `[N]` citations and a server-set draft
  label.

## Parser sidecar

`services/parser-py/app/` (FastAPI):

- **`POST /parse`** takes multipart `file`, plus optional `filename` and `mime_type`. Payloads
  over `PARSER_MAX_UPLOAD_BYTES` (default 100 MB) get `413`. Responses are camelCase (Pydantic
  alias generator). **`GET /health`** never requires auth.
- **General formats** go to MarkItDown first: fast, broad, no OCR. Unstructured is the fallback
  (lazy-imported, about 500 MB of models). It tries `strategy="fast"` first and uses OCR only when
  a PDF or image yields no text.
- **OCR is bounded.** A semaphore allows `PARSER_MAX_CONCURRENT_OCR` (default 1) concurrent OCR
  runs. A request that waits longer than `PARSER_OCR_WAIT_SECONDS` (default 120) gets `503`
  "parser busy".
- **Spreadsheets.** XLSX, XLS, CSV and TSV skip MarkItDown and parse from memory. XLSX is loaded
  twice with `openpyxl`: computed values (`data_only=True`) and formulas. A deterministic
  classifier labels each sheet `tabular`, `narrative`, `financial_model` (formula density ≥ 0.20)
  or `freeform`, and emits one `ParsedTable` per sheet.
- **Auth.** This is opt-in. When `PARSER_SECRET` is set, `X-Parser-Token` must match it. The
  comparison uses `hmac.compare_digest`, the secret is read per request (so rotation needs no
  restart), and duplicated headers are split on commas, with any match accepted. If
  `PARSER_SECRET` is empty outside `NODE_ENV=development`, the sidecar logs a startup warning. The
  worker and the sidecar must agree on the secret, or every parse returns `401`.

## Authentication and authorization

There are two separate layers. Don't merge them.

### Authentication: `AuthProvider`

`authenticate(credential) → Promise<Principal | null>` (`packages/core/src/auth.ts`). It is built
once by `buildAuthProvider(config, logger)` in `@rag/runtime` and selected by `AUTH_PROVIDER`.

| Strategy              | What it accepts                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static-token`        | Constant-time match against `API_TOKENS` (admin) and `API_PRINCIPALS` (scoped, or `isAdmin`). With `API_ENFORCE_SCOPING=true`, a plain `API_TOKENS` token authenticates but resolves to **deny-all**; admin must then be an explicit `isAdmin` principal. |
| `oidc`                | A JWT verified against the issuer's JWKS, `iss`, `aud` and `exp`. Claims map to sources through config (`scopeMap`, `adminClaims`). The code is IdP-neutral.                                                                                              |
| `internal-scope`      | The HS256 scope-assertion JWT that the web BFF (and the Teams bot) mints after resolving the user's grants. It lives 60 seconds, needs a secret of at least 64 hex characters, and carries `allowedSourceIds` and `sub`.                                  |
| `composite` (default) | Tries static-token first, then OIDC (if `OIDC_*` is set), then internal-scope (if `INTERNAL_SCOPE_JWT_SECRETS` is set).                                                                                                                                   |

- Every provider fails closed. A credential it can't positively verify returns `null` and never
  throws.
- Misconfiguration throws at startup.
- If `composite` resolves to static-token only, `buildAuthProvider` logs a warning. The API reads
  `INTERNAL_SCOPE_JWT_SECRETS` (plural); only `apps/web` reads the singular
  `INTERNAL_SCOPE_JWT_SECRET`.
- Operator setup is in [`../operations/ACCESS-CONTROL.md`](../operations/ACCESS-CONTROL.md).

### Authorization: `Principal` to scope

`Principal` (`packages/core/src/access-control.ts`) is either `{ kind: "admin" }` or
`{ kind: "scoped", allowedSourceIds, subject? }`. `subject` is the verified Entra `oid`, taken from
the internal-scope JWT's `sub`. It exists only to attribute `audit_log` rows; it never affects
access. `principalToScope` turns a principal into an `AuthorizationScope`:

| `enforcedSourceIds` | Meaning                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `null`              | Admin. No restriction.                                              |
| `[]`                | Deny-all (`DENY_ALL_SCOPE`). Retrieval returns `[]` before any SQL. |
| `[...]`             | Results must come from these sources. Enforced inside the SQL CTEs. |

**Per surface:**

- **API.** An `onRequest` hook authenticates once per request and sets `request.principal`. A
  missing or malformed Bearer header, or a `null` principal, gets `401`. Scope is derived per
  request.
- **MCP over HTTP.** Express with `StreamableHTTPServerTransport`. Scope is resolved from the
  Bearer token **once per session**, at `initialize`, and bound to that session's server; a failed
  resolution gives `DENY_ALL_SCOPE`.
  - When the session map reaches `MCP_MAX_SESSIONS` (default 1000), new sessions get `503`.
  - The `MCP_ALLOWED_ORIGINS` allow-list rejects browser Origins, which guards against DNS
    rebinding.
  - `normalizeSessionId` collapses duplicate `mcp-session-id` headers.
- **MCP over stdio.** Gets `ADMIN_SCOPE`. This is the only sanctioned unscoped path: a trusted,
  local, single-user channel. Logs must go to stderr, because stdout carries JSON-RPC.
- **All six MCP tools are scope-aware.** `list_sources` filters by scope. `trigger_sync` and
  `purge_source` refuse sources outside the scope. Per-route admin rules for the API are in
  [`../reference/API.md`](../reference/API.md).
- **Web and Teams.** The BFF resolves grants from `staff_client_assignments`,
  `source_client_assignments` and `staff_source_assignments`, then mints the internal-scope JWT.
  - The browser never holds a backend credential.
  - Group membership is checked with `POST /users/{id}/checkMemberGroups`. This is the Entra
    groups-overage fallback, in `apps/web/src/lib/graph-client.ts`. A
    `GET /groups/{id}/members/{id}/$ref` existence check is not a documented Graph operation.

**Identical not-found.** A document in a forbidden source and a missing id throw the same
`NotFoundError` everywhere that could leak existence:

- `GET /documents/:id`
- `GET /documents/:id/download`
- the MCP `get_document` tool
- the MCP `documents://{id}` resource

## Startup gates

Each of these refuses to start rather than run in a degraded state.

| Gate                                                     | Where                                      | Catches                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadConfig` validation                                  | every app                                  | Bad env values; `AUTH_PROVIDER=oidc` without issuer or audience; an empty token allow-list; the `COMPLIANCE_MODE=client-data` checks listed in [`CLAUDE.md`](../../CLAUDE.md). |
| `assertEmbeddingDimensions(config.embedding.dimensions)` | api, mcp and worker, before deps are built | A configured dimension that doesn't match the `chunks.embedding` column. Without it, this only shows at the first INSERT, after embedding credits are spent.                   |
| `assertRequiredIndexes`                                  | api, mcp and worker, after deps are built  | A missing HNSW index, GIN index or `chunks_tsv_update` trigger. The worker's gate matters most: without the trigger it would write chunks with a NULL `tsv`.                   |
| Missing or empty scanner pack                            | `runIngestion`                             | Ingestion with no redaction possible.                                                                                                                                          |

The migrate entrypoint runs none of these, so it can run against a database that hasn't been
migrated yet.

## Worker process

`apps/worker/src/main.ts` starts up in this order:

1. `loadConfig`.
2. `assertEmbeddingDimensions`.
3. Build deps: `CoreDeps` plus the parser client, chunker, connector factory, scanner pack and
   optional semantic scanner.
4. `assertRequiredIndexes`.
5. Register the workers: `rag.sync_source` with `batchSize = WORKER_CONCURRENCY`, and the two
   scheduled jobs with `batchSize: 1`. Their cron schedules are `DOCS_GAP_DIGEST_CRON` and
   `AUDIT_SINK_CRON`.
6. Wait for `SIGTERM` or `SIGINT`, then `deps.close()`. That calls
   `queue.stop({ graceful: true })` and closes the pool. `unhandledRejection` and
   `uncaughtException` are logged as fatal and exit with code 1.

**Batches run one job at a time on purpose.** The pipeline already runs documents concurrently
within a page, so adding job-level concurrency on top would multiply load on the parser and the
embedding API.

**Scaling** means running more worker copies against the same Postgres. pg-boss row locks hand
each job to exactly one worker, and the singleton policy keeps each source to one active job.

## Test harness boundaries

The e2e suite (`tests/e2e/`) runs against real Postgres and the real parser.

- Migrations are applied with `applyMigrations`.
- Each test truncates with `RESTART IDENTITY CASCADE`.
- `buildTestApi` builds the Fastify app in-process (requests go through `inject()`). It uses fake
  embedder, connector and generator, a real `Retriever`, and a **pg-boss stub with only `stop()`**.
- `runOneIngestion` drives the real pipeline directly.

So **e2e never exercises enqueue and dequeue.** The queue and worker logic is covered by unit tests
(`packages/ingestion/src/queue.test.ts`, `apps/worker/src/handlers/sync-source.test.ts`).

`FakeEmbedder`'s bag-of-words dense signal mirrors BM25, so weight sweeps under it prove only that
the fusion machinery works. Evaluation is covered in
[`../evaluation/EVALUATION.md`](../evaluation/EVALUATION.md).

## Failure modes

| Failure                             | What happens                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector token expired             | `validate()` or `list()` throws `ConnectorAuthError`. The row is marked `failed` and the job is retried up to 3 times, with backoff from 60 s. Sentry is notified on the last attempt. Rotate the secret and re-trigger.        |
| Source rate-limits (429)            | The connector retries with backoff (SharePoint and Outlook share one Graph quota). If it still fails, `ConnectorTransientError` triggers a job retry. Each job's page budget limits the exposure.                               |
| Parser down, or OCR saturated       | That document fails (`ParserError`, or `503` "parser busy") and is recorded for retry on the next sync. The page continues.                                                                                                     |
| Embedding quota or 429              | Backoff and pacing inside the provider. A document that still fails is recorded for retry, up to 5 attempts across syncs.                                                                                                       |
| Worker crashes mid-page             | The cursor for that page was never saved. After 1800 s pg-boss reclaims the job and retries it. Content-hash idempotency makes re-processed documents no-ops, and the singleton policy stops the retry racing a continuation.   |
| Tombstone deletion fails            | `DeletionReconciliationError` fails the page before the cursor advances, so the deletion is retried rather than lost.                                                                                                           |
| A safety gate can't reach a verdict | The document is quarantined as `gate-failure:` in `ingest_log`. The sync row is marked `failed` with counts only (never file names), Sentry is notified, and nothing is retried. Fix the gate, then re-run with `mode: "full"`. |
| Two triggers for one source         | The second job queues behind the first (singleton policy) instead of running concurrently.                                                                                                                                      |
| Connector never ends its feed       | The job aborts when the cursor doesn't advance, or after 100,000 continuations.                                                                                                                                                 |
| Source deleted after enqueue        | The row is marked `failed` with "source not found".                                                                                                                                                                             |
| Search index or trigger dropped     | The api, mcp and worker refuse to start.                                                                                                                                                                                        |
| Embedding dimension changed         | Startup fails. Re-type the column, rebuild HNSW and re-embed.                                                                                                                                                                   |
| Reranker errors                     | The query returns plain RRF order and a warning is logged.                                                                                                                                                                      |
| Condensation fails                  | Retrieval uses the original question, with a `ask.condensation_failed` or `ask.condensation_blocked` log marker.                                                                                                                |

## Invariants — don't break

These were hard-won and are easy to break by accident. Each is enforced in the place named.

| Invariant                                                                                                        | Where                                                           |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Scope can't be bypassed: `authz` is required, an empty scope returns before SQL, and caller filters only narrow. | `Retriever.search`, `hybridSearch`                              |
| The ACL and the withdrawal gate run inside both candidate CTEs.                                                  | `hybrid-search.ts` `mandatoryPreFilter`                         |
| Dense search only compares chunks from the same embedding provider and model.                                    | `hybrid-search.ts` `dense_hits`                                 |
| OR-semantics sparse query with `quote_literal`-wrapped lexemes.                                                  | `hybrid-search.ts` `params`                                     |
| Documents are escaped as untrusted data in the prompt; `modified=` is shape-validated.                           | `packages/rag/src/generation/prompt-context.ts`, `generator.ts` |
| Only cited indices survive, and grouped citation forms are parsed.                                               | `filterCitationsToAnswer`                                       |
| The question is screened before embedding; context is screened before generation.                                | `ask.ts` `retrievalQuery`, `screenForGeneration`                |
| The draft label is a typed field set server-side, so no transport can drop it.                                   | `ask.ts` `REVIEW_STATUS`, `ANSWER_DISCLAIMER`                   |
| A missing scanner pack blocks ingestion, the source class is a ceiling, and quarantine writes an audit row.      | `pipeline.ts`, `classify-document.ts`                           |
| An unchanged hash skips work, except the "hash matches but no chunks" case.                                      | `pipeline.ts` `ingestOne`                                       |
| `triggerSync` is the only code that creates `ingestion_jobs` rows.                                               | `packages/services/src/sources.ts`                              |
| One active job per source, a stuck-cursor backstop, and bounded pages per job.                                   | `queue.ts`, `sync-source.ts`                                    |
| Boot fails without the HNSW index, the GIN index or the tsv trigger.                                             | `required-indexes.ts`                                           |
| The audit log stores the question hash, never raw text (unless `AUDIT_LOG_CONTENT=full`).                        | `audit_log`, `packages/core/src/audit-content.ts`               |

## What this system is not

- **Not a chat platform.** It offers search and grounded Q&A. `/ask` accepts bounded client-held
  `history`, used only to rewrite the retrieval query. There are no server-side sessions.
- **Not a document-level ACL system.** Scope is per source. There is no per-document SharePoint
  permission enforcement; that gap is tracked in [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md). For
  finer-grained authorization, wrap retrieval in your own layer.
- **Not an agent or generation framework.** `/ask` is single-shot. Query decomposition, multi-hop
  reasoning and tool use belong in the consuming app, built on `/search`.
- **Not a reranking system by default.** Reranking is built and configured off.
- **Not a high-throughput queue.** One job covers up to five pages of one source. The point at which
  pg-boss would be outgrown is recorded in [`DECISIONS.md`](./DECISIONS.md).
