# Implementation Plan: SharePoint Readiness — Ingest Everything, Answer Substantively, Download Citations

> **Goal (user's words):** "ensure the system is prepared to ingest all SharePoint files and is able to
> adequately provide full, substantive answers to questions along with citations that the user can view by
> downloading the cited document."
>
> **Status:** Ready to execute. Each phase is self-contained for a fresh chat context.
> **Date authored:** 2026-06-21
> **Tooling:** This repo uses **Serena** for code reads/edits — `get_symbols_overview` → `find_symbol`
> (`include_body=true`) → `replace_symbol_body` / `insert_*` / `replace_content`. Use plain Read/Edit only for
> markdown/JSON/SQL. After each phase: `pnpm typecheck` + the package's `vitest`. Commit per phase.
>
> **Decisions locked (2026-06-21):**
>
> 1. **Download** → Store original file bytes at ingest in an S3-compatible object store + add an
>    auth-scoped `GET /documents/:id/download` route. Works without the user having SharePoint access.
> 2. **Answer quality** → tuning + per-document diversity cap + max-output-tokens + completeness-oriented
>    prompt **and** a reranking stage over the candidate pool.
> 3. **Ingestion** → correctness fixes **and** scale reliability (per-page self-re-enqueue).

---

## How to execute this plan

- Phases are ordered by dependency but **A, C, E are independent** and can be parallelized across sessions.
  **D depends on C. F depends on E.** **B** is a separate existing plan (see below).
- Each phase lists **what to implement** (framed to COPY existing patterns), **authoritative references**
  (`file:line` — re-verify before editing; code may have moved), a **verification checklist**, and
  **anti-pattern guards**.
- Re-read this repo's ground rules in `CLAUDE.md` before editing: cross-package contracts live in
  `@rag/core`; DB access only via `@rag/db`; business logic transport-agnostic in `@rag/services`; deps wired
  once in `@rag/runtime`; ingestion is always async via pg-boss; embeddings immutable per
  (provider, model, dimensions); idempotency by content hash.

---

## Phase 0 — Documentation Discovery (consolidated; READ FIRST)

Completed during planning via four parallel codebase audits. Facts below are verified against live code.
**Re-verify line ranges before editing.**

### 0.1 SharePoint ingestion — current state

| Fact                                                                                                                                                                                       | Evidence                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Connector `validate`/`list`/`fetch`; `list` delegates to a shared `paginate()` with `maxItems`.                                                                                            | `packages/connectors/src/sharepoint/index.ts:105-189`; `packages/connectors/src/util/paginate.ts:47-59` |
| Enumeration uses Microsoft Graph **delta API** per drive (`/drives/{id}/root/delta`) — recurses all folders/files server-side.                                                             | `index.ts:142-160, 220-234`                                                                             |
| If no `driveId` configured, enumerates all document libraries via `GET /sites/{siteId}/drives`, filtering to `driveType==="documentLibrary"`.                                              | `index.ts:199-218`                                                                                      |
| **BUG: `/sites/{siteId}/drives` is fetched once — NOT paginated.** Sites with many libraries silently drop drives beyond the first Graph page.                                             | `index.ts:205`                                                                                          |
| **No file-type allow/deny list** anywhere (connector, pipeline, parser client). All types attempted.                                                                                       | (negative finding across connector + `packages/ingestion/src/pipeline.ts`)                              |
| File size cap `maxFileBytes` (default **50 MB**) silently skips large files (logs warning, no metric).                                                                                     | `config.ts:25-29`; `index.ts:251-260`                                                                   |
| **Deleted items are skipped at ingest but their chunks are NOT removed** → stale chunks stay searchable.                                                                                   | `index.ts:246-248`                                                                                      |
| Cursor = base64(JSON) `{ drives, current, deltas }`; persisted to `sources.cursor` per page.                                                                                               | `index.ts:59-79`; `pipeline.ts` cursor persist                                                          |
| 429/5xx/network → `ConnectorTransientError` (extracts `Retry-After`); retried at pg-boss job level (`retryLimit:3, retryDelay:60, retryBackoff`). No connector-level retry loop.           | `packages/connectors/src/util/errors.ts:60-96`; `packages/ingestion/src/queue.ts:67-69`                 |
| Per-source config: `{ siteId (req), driveId?, folderPath?, maxFileBytes? }`. Creds: `MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET` (app-only).                                               | `config.ts`; `env.example:128-130`; `factory.ts:46-53`                                                  |
| Connector captures Graph `item.webUrl`, `path`, and `extra.{siteId,driveId,itemId}` into `document.metadata`. **Original bytes are downloaded for parsing then discarded.**                | `index.ts:280-297`                                                                                      |
| **No SharePoint connector unit tests exist.**                                                                                                                                              | (negative finding)                                                                                      |
| Per-page self-re-enqueue is **partially built**: `runIngestion` supports `maxPagesPerRun` (defaults unbounded); worker does NOT yet re-enqueue. Phases 1–2 of the dedicated plan are DONE. | `docs/PLAN-PER-PAGE-REENQUEUE.md` (Phase 2 results, Phase 1 results)                                    |

### 0.2 Parser / chunk / embed — current state (healthy)

| Fact                                                                                                                                                                                                                           | Evidence                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Parser two-tier: MarkItDown (25+ formats: pdf/docx/doc/pptx/xlsx/html/md/csv…) → Unstructured fallback (OCR, exotic). Dedicated xlsx/csv paths. Re-sniffs generic MIME with libmagic (critical for SharePoint `octet-stream`). | `services/parser-py/app/main.py:148-340, 346-479, 183-196`                                               |
| Parser HTTP codes: 400 empty, 413 >100 MB, **422 unsupported/no-content**, 500 internal. Auth via `X-Parser-Token`/`PARSER_SECRET`.                                                                                            | `main.py:54, 121-137, 309-340`                                                                           |
| TS `HttpParserClient.parse()` throws `ParserError` on any ≥400 or schema-mismatch; pipeline records the doc as failed and continues (`Promise.allSettled`).                                                                    | `packages/rag/src/parser/parser-client.ts:46-65`; `pipeline.ts:115-125, 169`                             |
| Chunking: heading-aware markdown chunker + spreadsheet row-grouping (`CompositeChunker`). Target 800 tokens; hard clamp **1700 tokens** before embed (`token-clamp.ts`).                                                       | `packages/rag/src/chunking/*`                                                                            |
| Embeddings: default `gemini-embedding-001`, **768-dim**; asymmetric `RETRIEVAL_DOCUMENT` (corpus) vs `RETRIEVAL_QUERY` (query, via `embedQuery()`). Retry w/ jitter, `maxRetries:5`. Startup dimension guard.                  | `packages/rag/src/embeddings/{gemini.ts,retry.ts,factory.ts}`; `packages/db/src/embedding-dimensions.ts` |
| Idempotency: doc key `(sourceId, externalId)`; chunk hash `sha256(headingPath::text)`; content hash `sha256(parsed.markdown)`. Unchanged re-ingest = no-op; zero-chunk doc with matching hash re-embeds (failure recovery).    | `pipeline.ts:156-260`; `schema.ts:80-117, 127-192`                                                       |

### 0.3 Citation + download — current state (the headline gap)

| Fact                                                                                                                                                               | Evidence                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `buildCitations(context)` → `{ index, documentId, title, url?, chunkId, score }`. `url` comes from `RetrievalResult.document.url`.                                 | `packages/rag/src/generation/generator.ts:78-89`                           |
| `RetrievalResult.document` carries `{ id, title, sourceId, sourceKind, url?, metadata }`; `url` is read from `metadata.url` in the hybrid query.                   | `packages/core/src/types.ts:206-231`; `packages/db/src/queries.ts:448-471` |
| `documents` table stores parsed `markdown` + `metadata` (JSONB) — **NOT original bytes.** No `download`/content route; `GET /documents/:id` returns markdown only. | `schema.ts:80-117`; `apps/api/src/routes/documents.ts:18-31`               |
| Web UI citation modal renders an XSS-validated (`http(s)` only) "Open source document" link to `webUrl`; falls back to showing the document id.                    | `apps/web/src/components/knowledge-base/knowledge-base.tsx:105-151`        |
| **VIEW works (SharePoint webUrl). DOWNLOAD-the-original does not exist** — bytes are discarded at ingest; no storage, no route.                                    | (synthesis)                                                                |

### 0.4 Answer quality — current state

| Fact                                                                                                                                                                                                                           | Evidence                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `askQuestion` → retrieve (`topK` default **8**) → empty short-circuit → `generator.answer(question, retrieved)` → citations. Streaming variant derives citations from final context.                                           | `packages/services/src/ask.ts:48-92, 116-162`; `packages/core/src/config.ts:91`   |
| Hybrid RRF: dense (HNSW cosine) + sparse (`ts_rank_cd`) fused with `k=60`; candidate pool = `candidatePoolMultiplier`(8)×topK ≈ 64, filtered AFTER fusion, truncated to topK. Weights 0.7/0.3. **No reranking** (placeholder). | `packages/db/src/queries.ts:271-472`; `retriever.ts:14, 43-74`; `config.ts:88-94` |
| System prompt: grounded, cite `[N]`, refuse when answer absent, "quote sparingly." **Does NOT push for completeness/synthesis. No `max_output_tokens` set** on Gemini/OpenAI. Temp 0.2.                                        | `generator.ts:43-56, 62-76, 94-187`                                               |
| Auth scope is mandatory + fail-closed (`enforcedSourceIds === []` → 0 rows before DB).                                                                                                                                         | `retriever.ts:43-74`; `queries.ts:282-289`                                        |
| Documented gaps (own doc): no rerank (H1), metadata filter unindexed (H2), no per-doc diversity cap (M-N3), prompt not completeness-oriented, no output budget.                                                                | `docs/ISSUES-AND-OPTIMIZATIONS.md`                                                |

### 0.5 Anti-patterns / APIs that DO NOT exist (global guards)

- ❌ Do not invent Microsoft Graph endpoints. Real ones used: `GET /sites/{siteId}`, `GET /sites/{siteId}/drives`
  (paginated via `@odata.nextLink`), `GET /drives/{id}/root/delta` (and `/root:/{path}:/delta`),
  `GET /drives/{driveId}/items/{itemId}/content` (download bytes). Verify against the client wrapper
  `packages/connectors/src/sharepoint/client.ts` before use.
- ❌ Do not add a file-type allow/deny list to "fix" ingestion — the design is "attempt everything, let the
  parser 422 the unsupported." Unsupported files should be **recorded as failed**, not silently filtered.
- ❌ Do not store original bytes in Postgres `bytea` (the locked decision is **object storage**). Keep large
  blobs out of the primary DB.
- ❌ Do not defeat the HNSW/GIN indexes: keep filters as post-fusion `WHERE` (see `queries.ts:414-438`).
- ❌ Do not bypass `AuthorizationScope` on the new download route — reuse the same scope check as
  `getDocumentById`.
- ❌ Do not mutate objects in place (repo immutability rule) — return new copies.
- ❌ Do not change the embedding column dimension or model casually — that forces a full re-embed
  (`CLAUDE.md` "Things that will trip you up").

---

## Phase A — Ingestion correctness: enumerate ALL drives, reconcile deletions, observe skips, test the connector

**Goal:** Guarantee every SharePoint file in scope is actually discovered and that the corpus stays truthful
over time. **Independent — can run first or in parallel with C/E.**

### What to implement

1. **Fix drive-list pagination (copy the existing nextLink pattern).** `bootstrapCursor()` calls
   `GET /sites/{siteId}/drives` once (`index.ts:205`). Make it follow `@odata.nextLink` until exhausted —
   **copy the exact paging idiom already used for delta pages** at `index.ts:153-160` (the `nextLink` walk).
   Extract a small `getAllPages(url)` helper in `client.ts` if cleaner; otherwise loop in `bootstrapCursor`.
   Keep the `documentLibrary` filter (`index.ts:210`).
2. **Reconcile deletions.** Graph delta returns tombstones (`item.deleted?.state`), currently skipped at
   `index.ts:246-248`. Surface them instead of dropping:
   - Have `toSourceDocument` (or the page mapper) emit deletions as a distinct signal (e.g. a
     `SourceDeletion { externalId }` list on the page result), OR add a `deleted: true` flag on the returned
     document. Choose the smaller change against the `Connector`/page contract in
     `packages/core/src/interfaces.ts` and `paginate.ts`.
   - In the pipeline (`pipeline.ts`), for each deletion, delete the document by `(sourceId, externalId)`; the
     `chunks` FK is `onDelete: "cascade"` (`schema.ts`), so chunk removal is automatic. Add a `@rag/db` helper
     `deleteDocumentByExternalId(db, sourceId, externalId)` next to the existing doc upsert helpers — **never
     import `pg`/drizzle outside `@rag/db`**.
3. **Ingestion observability (no new infra).** Today oversized/parse-failed files vanish silently. Add a
   structured per-run summary to the existing pipeline result + a greppable `logger.info`:
   counts of `documentsProcessed`, `documentsFailed`, `documentsSkippedOversize`, `documentsDeleted`.
   Thread `skippedOversize` from the connector (it already logs the warning at `index.ts:251-260` — turn that
   into a counted signal on the page result). Surface the summary on whatever health/admin surface
   `apps/api/src/routes/` already exposes (extend, don't add a service).
4. **SharePoint connector unit tests (first tests for this connector).** Add
   `packages/connectors/src/sharepoint/index.test.ts` with a faked Graph client. Cover: multi-page
   `/drives` enumeration (the bug fix), delta pagination via `nextLink`, folder-scope-on-initial-only,
   oversized-skip, deletion tombstone emission, `webUrl`/`extra` metadata capture. Mirror existing connector
   test harness style if any exists; otherwise inject a fake `GraphClient`.

### Authoritative references

- Drive enumeration to fix: `index.ts:199-218` (bug at `:205`); copy paging from `index.ts:153-160`.
- Deletion skip to convert: `index.ts:240-300` (tombstone `:246-248`).
- Oversize skip to count: `index.ts:251-260`.
- Pipeline mapping + counters: `packages/ingestion/src/pipeline.ts:80-154`.
- DB helper neighbors: `packages/db/src/queries.ts` (doc upsert + `updateSourceCursor` region).
- Connector contract: `packages/core/src/interfaces.ts`; page util `packages/connectors/src/util/paginate.ts`.

### Verification checklist

- [ ] A faked site with **two pages of drives** enumerates ALL libraries (regression test for the bug).
- [ ] A delta tombstone deletes the document AND its chunks (assert chunk count → 0 for that doc).
- [ ] Run summary reports nonzero `documentsSkippedOversize` when a >`maxFileBytes` file is present.
- [ ] `pnpm --filter @rag/connectors test` + `@rag/ingestion` tests green; `pnpm typecheck` green.
- [ ] `grep` confirms no `pg`/`drizzle-orm` import added outside `@rag/db`.

### Anti-pattern guards

- Do NOT infer "done" from `documents.length === 0` — only the connector's `done`/`nextLink` ends a feed.
- Do NOT delete by title or fuzzy match — only by `(sourceId, externalId)`.
- Do NOT silently drop oversized/failed files without counting them (the whole point of this phase).

### Phase A results (COMPLETE — 2026-06-21)

Implemented and green (`pnpm typecheck` all 13 projects; `@rag/connectors` 20 tests, `@rag/ingestion` 10,
`@rag/db` 16, `@rag/core` 84, `@rag/rag` 31, `@rag/services` 11, `apps/api` 9 — all pass):

- **Drive-list pagination fix.** `bootstrapCursor` follows `@odata.nextLink` across all
  `/sites/{siteId}/drives` pages (`packages/connectors/src/sharepoint/index.ts`), so sites with many
  document libraries no longer silently drop drives past page one. `DrivesResponse` gained `"@odata.nextLink"?`.
- **Deletion reconciliation.** New `deletions?: string[]` + `skippedOversize?: number` channels on
  `ConnectorPage` (paginate) and `ConnectorListResult` (`@rag/core`). SharePoint `fetchPage` classifies items:
  tombstones (`item.deleted.state`) → `deletions` (collected regardless of doc budget); oversize → counted;
  folders/non-files skipped. New `@rag/db` helper `deleteDocumentByExternalId(db, sourceId, externalId)`
  removes the document (chunks cascade). The pipeline reconciles `page.deletions` per page (a failed delete is
  logged, never aborts the run).
- **Observability.** `PipelineRunResult` gained `documentsDeleted` + `documentsSkippedOversize`; summary log
  carries `marker: "ingest.run.summary"` and oversize-skip log `marker: "ingest.skip.oversize"`. These flow
  through the worker's existing `log.info(result, …)`.
- **Testability + tests.** Added `GraphReader` interface in `client.ts` (GraphClient implements it) + optional
  4th constructor arg so the connector is unit-testable with a fake. New `sharepoint/index.test.ts` (7 tests):
  paginated drive enumeration, delta nextLink, folderPath-on-target-drive-only, oversize skip+count, tombstone
  emission, webUrl/`extra` metadata, validate probe. Extended `pipeline.test.ts` (+3) for deletion
  reconciliation, count-only-actual-removals, failed-delete-doesn't-abort.

**Known follow-up (NOT done — flagged):** a latent pre-existing overflow — a single Graph delta page larger
than the per-`list()` doc budget (`pageSize`, 50) advances the cursor to `@odata.nextLink` and drops the
un-downloaded tail of that Graph page. Deletions are now collected across the whole page (improvement), but
file-item loss under a >50-item single delta page remains. Proper fix needs a `$top`/page-boundary change to
the shared `paginate` contract — out of Phase A scope; address alongside Phase B with a scale test.

---

## Phase B — Ingestion scale reliability (per-page self-re-enqueue)

**This work is already specified.** Execute the remaining phases of **`docs/PLAN-PER-PAGE-REENQUEUE.md`**:

- Phase 1 (spike) and Phase 2 (single-page `runIngestion`) are **COMPLETE** (see that doc's "results" sections).
- **Remaining: Phase 3** (worker self-re-enqueues until `done`, one history row, `policy:"singleton"` via
  `boss.updateQueue` per the Phase 1 finding), **Phase 4** (expiry sizing + dead-letter visibility),
  **Phase 5** (docs + final verification).

Do not re-author it here. When picking `maxPagesPerRun` for SharePoint, heed that plan's **Phase 3 step 7**:
Graph connectors share a throttled quota and re-run `validate()` per continuation — default a **coarser**
`maxPagesPerRun` for SharePoint (e.g. several pages per job) and/or skip `validate()` on continuations.

> **Sequencing note:** Phase A changes the connector's page-result shape (deletions, skip counts). If A and B
> run close together, land A first (or rebase B onto A) so the page contract is stable before the worker's
> continuation logic depends on it.

### Phase B results (COMPLETE — 2026-06-21)

Per-page self-re-enqueue implemented (the meat of "ingestion at scale"). See
`docs/PLAN-PER-PAGE-REENQUEUE.md` → **Phase 3 results** for detail. Summary: `rag.sync_source` set to
`policy: "singleton"` via `updateQueue` (idempotent/reversible); the worker processes 5 pages/job then
`enqueueContinuation`s (same history row, accumulated counters, cursor-resumed, validate/running only on the
first job); cursor-progress + `MAX_SYNC_CONTINUATIONS` loop guards; expiry tightened to 1800s; greppable
failure marker. Green: `@rag/ingestion` 19 tests (new `queue.test.ts`), NEW `apps/worker` vitest harness with
`sync-source.test.ts` 7 tests, full build + 13/13 typecheck.

**Still open from Phase A's flagged follow-up (NOT done):** the single-Graph-delta-page > `pageSize` overflow
(a delta page with >50 file-items drops the tail when the cursor advances to `@odata.nextLink`). Per-page
re-enqueue does NOT fix this — each `list()` still caps at `pageSize`. The proper fix is a `$top`/page-boundary
change to the shared `paginate` contract; recommend a dedicated follow-up with a scale test before declaring
"ingest ALL files" fully closed at very high per-sync churn.

---

## Phase C — Persist original documents to object storage

**Goal:** Stop discarding the bytes we already download, so citations can serve the real file later.
**Depends on nothing; blocks Phase D.**

### What to implement

1. **Define an `ObjectStore` contract in `@rag/core`** (pluggable provider, mirroring how
   `EmbeddingProvider`/`Connector`/`AuthProvider` are defined): `put(key, bytes, contentType): Promise<void>`,
   `get(key): Promise<{ body: Readable|Buffer, contentType?: string }>`, `delete(key): Promise<void>`,
   optional `presignGetUrl(key, ttl)`. Put the interface in `packages/core/src/` and export it.
2. **Implement an S3-compatible provider** (`packages/rag/src/storage/s3-object-store.ts` or a new
   `@rag/storage` package if cleaner) using the AWS SDK v3 S3 client. S3-compatible endpoints cover
   **Railway buckets / AWS S3 / MinIO / GCS-in-S3-mode**, so config is endpoint+bucket+key/secret+region.
   Add a `createObjectStore(config)` factory mirroring `packages/rag/src/embeddings/factory.ts`.
3. **Wire it into `@rag/runtime`** `buildCoreDeps` so api/worker/mcp share one instance, and add env parsing in
   the runtime/app config layer (NOT in core). Env vars (document in `env.example`):
   `OBJECT_STORE_PROVIDER` (`s3`|`none`), `OBJECT_STORE_BUCKET`, `OBJECT_STORE_ENDPOINT`,
   `OBJECT_STORE_REGION`, `OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY`. `none` = feature off
   (download route returns 404 gracefully) so local/dev without a bucket still runs.
4. **Schema: record where the original lives.** Add nullable columns to `documents` (Drizzle —
   `packages/db/src/schema.ts`): `storageKey text`, `storageBucket text`, `originalSizeBytes bigint`. Run
   `pnpm db:generate` then `pnpm db:migrate`. Nullable so existing rows and `none`-provider deployments are
   valid. (Per `CLAUDE.md`, never hand-edit migrations to fight the generator.)
5. **Capture bytes in ingestion (they're already in hand).** The connector returns `source.content` (the
   downloaded bytes) which today is used only for parsing (`pipeline.ts:169`-ish). In `ingestOne`, after a
   successful parse + **before/with** `upsertDocument`, `put` the original bytes under a deterministic key
   `sources/{sourceId}/{externalId-hash}` and store `storageKey`/`storageBucket`/`originalSizeBytes` on the
   document row. Gate on `objectStore` being configured (`none` → skip, leave columns null).
   - **Idempotency:** key by `(sourceId, externalId)`; only re-upload when the document content hash changed
     (reuse the existing `contentChanged` signal at `pipeline.ts:156-260`). Unchanged re-ingest = no re-upload.
   - **Failure isolation:** an object-store `put` failure must NOT fail the whole document's text ingestion —
     log + count it (reuse Phase A's summary), leave columns null, continue. The doc is still searchable; it
     just won't be downloadable until the next successful sync.
6. **Deletion + cascade:** extend Phase A's `deleteDocumentByExternalId` to also `objectStore.delete(storageKey)`
   when present, so reconciled deletions don't orphan blobs.

### Authoritative references

- Provider/factory pattern to copy: `packages/rag/src/embeddings/factory.ts`; interface style
  `packages/core/src/interfaces.ts`.
- Runtime wiring: `packages/runtime/src/index.ts` (`buildCoreDeps`).
- Ingestion insertion point: `packages/ingestion/src/pipeline.ts:156-260` (`ingestOne`, `upsertDocument`,
  `contentChanged`).
- Schema + migration: `packages/db/src/schema.ts:80-117`; `pnpm db:generate`/`db:migrate`.
- Bytes source: connector `index.ts:264-297` (`content: bytes`).

### Verification checklist

- [ ] With `OBJECT_STORE_PROVIDER=s3` (MinIO in docker for tests), ingesting a doc writes the blob and
      populates `storageKey`/`storageBucket`/`originalSizeBytes`.
- [ ] Re-ingesting an unchanged doc does NOT re-upload (assert `put` not called again).
- [ ] `put` failure leaves the document searchable with null storage columns and a counted error (no throw).
- [ ] With `OBJECT_STORE_PROVIDER=none`, ingestion succeeds and storage columns stay null.
- [ ] Migration applies cleanly; `pnpm typecheck` green across core/rag/db/ingestion/runtime.

### Anti-pattern guards

- Do NOT store bytes in Postgres `bytea`.
- Do NOT let a storage failure abort text ingestion (search must not regress because download storage hiccuped).
- Do NOT parse env vars inside `@rag/core` (config parsing lives in runtime/app layer).
- Do NOT re-upload unchanged content (respect `contentChanged`).

---

## Phase D — Download route + citation download wiring (API → MCP → Web)

**Goal:** A user reading an answer can click a citation and download the original file. **Depends on Phase C.**

### What to implement

1. **API `GET /documents/:id/download` (copy the auth+scope pattern from the existing documents route).**
   New `apps/api/src/routes/download.ts`. Resolve the document via the **same scope check** used by
   `getDocumentById` (`apps/api/src/routes/documents.ts:18-31` + `packages/services/src/` documents service) —
   404 (not 403) when out of scope to avoid leaking existence. If `storageKey` is null → 404 with a clear
   "original not stored" body. Otherwise stream `objectStore.get(storageKey)`:
   set `Content-Type` from `documents.mimeType`, `Content-Disposition: attachment; filename="<sanitized
title + ext>"`. Sanitize the filename (strip CR/LF/quotes — mirror the CRLF hygiene in
   `parser-client.ts:88-91`). Register it in `apps/api/src/server.ts` next to the other routes.
2. **Add a `getDocumentDownload` service function in `@rag/services`** (transport-agnostic, takes
   `ServiceDeps` + scope) so both the API route and any future MCP/web BFF share one scope-checked path —
   per `CLAUDE.md`, never duplicate retrieval/doc logic in a route. It returns the stream + content metadata
   (or a typed not-found/not-stored result).
3. **Mark citations as downloadable.** Extend `buildCitations` output
   (`packages/rag/src/generation/generator.ts:78-89`) with `downloadable: boolean` derived from whether the
   document has a `storageKey` (thread a `hasOriginal` flag through `RetrievalResult.document` — populate it in
   the hybrid query `queries.ts:448-471` from the new column). The client builds the URL from `documentId`;
   no need to embed a raw URL in the payload.
4. **MCP `ask` tool:** alongside the existing `url` line (`apps/mcp/src/tools/ask.ts:49`), when `downloadable`,
   include a download reference (e.g. `download: /documents/{id}/download`) in the structured citation so an
   agent surface can fetch the original. Keep the existing `webUrl` line for "view in source."
5. **Web client:** in the citation modal (`apps/web/src/components/knowledge-base/knowledge-base.tsx:105-151`),
   add a **"Download original"** button when `citation.downloadable`, alongside the existing
   XSS-validated "Open source document" link. It hits a **BFF proxy** route in `apps/web` (mirror the existing
   BFF proxy pattern used for other API calls) that forwards auth to `GET /documents/:id/download` and streams
   the file back — do NOT call the API directly from the browser with a bearer token. Keep the existing
   `http(s)`-only validation for the webUrl link untouched.

### Authoritative references

- Scope-checked doc fetch to copy: `apps/api/src/routes/documents.ts:18-31`; documents service in
  `packages/services/src/`.
- Route registration: `apps/api/src/server.ts`.
- Citation builder: `packages/rag/src/generation/generator.ts:78-89`; result threading
  `packages/db/src/queries.ts:448-471`; type `packages/core/src/types.ts:206-231`.
- MCP ask tool citation rendering: `apps/mcp/src/tools/ask.ts:37-108` (link at `:49`).
- Web citation modal: `apps/web/src/components/knowledge-base/knowledge-base.tsx:105-151`; existing BFF proxy
  routes under `apps/web/src/app/api/` (find the pattern there).

### Verification checklist

- [ ] In-scope download returns the original bytes with correct `Content-Type` + attachment filename.
- [ ] Out-of-scope id returns **404** (no existence leak); null `storageKey` returns 404 "not stored."
- [ ] Citations expose `downloadable` correctly (true only when `storageKey` present).
- [ ] Web "Download original" button appears only when downloadable and downloads via the BFF proxy.
- [ ] Filename is sanitized (no header injection); `pnpm typecheck` green; api tests green.

### Anti-pattern guards

- Do NOT skip the scope check or return 403 (leaks existence) — match `getDocumentById` semantics.
- Do NOT stream from SharePoint here (the locked decision is serve-from-object-store).
- Do NOT expose the object-store bucket/keys to the browser; always proxy through API/BFF.
- Do NOT duplicate the document-fetch logic in the route — go through the `@rag/services` function.

### Phase C + D results (COMPLETE — 2026-06-21)

Implemented and green: `pnpm build` (all 13 projects, incl. the new `/api/documents/[id]/download` web
route), `pnpm typecheck` all 13, and unit suites — core 84, connectors 20, db 16, rag 31, ingestion 14,
services 16 (+5 new download tests), api 9.

**Phase C — originals storage:**

- `ObjectStore` interface + `ObjectStoreGetResult` in `@rag/core`; S3-compatible `S3ObjectStore` +
  `createObjectStore` factory + deterministic `documentStorageKey(sourceId, externalId)` in `@rag/rag`
  (`@aws-sdk/client-s3`; works with AWS S3 / Railway buckets / MinIO via `forcePathStyle` + custom endpoint).
- `objectStore` config block in `@rag/core` config + `loadConfig` (`OBJECT_STORE_*` env); wired into
  `buildCoreDeps` → `CoreDeps.objectStore` and threaded to the worker → `PipelineDeps`.
- `documents` gained nullable `storage_key` / `storage_bucket` / `original_size_bytes` (schema + **hand-authored**
  migration `0002_documents_original_storage.sql` + journal entry — NOT `drizzle generate`, which would drop
  the HNSW/GIN indexes). New `@rag/db` `setDocumentStorage`; `deleteDocumentByExternalId` now returns
  `{ deleted, storageKey }`.
- `ingestOne` uploads the original on content change (idempotent — unchanged re-ingest skips), records the
  location via `setDocumentStorage`, and **never fails text ingestion on a storage error** (logged, doc stays
  searchable). Tombstone reconciliation also best-effort deletes the blob. `provider: none` disables it all.
- `env.example` documents every `OBJECT_STORE_*` var (default `none`).

**Phase D — download + citation wiring:**

- `getDocumentDownload(deps, id, scope)` in `@rag/services` — same scope check as `getDocumentById`
  (forbidden / missing / not-stored all → `NotFoundError` → 404), streams from the object store, sanitizes the
  attachment filename (strips CR/LF/quotes/path separators). `ServiceDeps`/API `Deps` gained `objectStore`.
- API `GET /documents/:id/download` route (streams the original as an attachment).
- `RetrievalResult.document.hasOriginal` threaded from `hybridSearch` (`storage_key IS NOT NULL`);
  `buildCitations` now sets `downloadable`; `GenerationResult.citations[].downloadable` flows through `/ask`,
  `/ask/stream`, MCP `ask` (text + structured), and the e2e `FakeGenerator`.
- Web: `Citation.downloadable`, a same-origin BFF `proxyDownload` + `GET /api/documents/[id]/download` route
  (forwards auth server-side, streams bytes, propagates Content-Type/Disposition/Length), and a **"Download
  original"** link in the citation modal shown only when `downloadable`.

**Operational notes for go-live:** set `OBJECT_STORE_PROVIDER=s3` + bucket/creds, run `pnpm db:migrate` (applies
0002), then **re-sync sources** — originals are only captured on content change, so existing documents become
downloadable after their next sync. `storage_bucket` is recorded per doc but downloads serve from the
currently-configured store's bucket (single-bucket assumption).

---

## Phase E — Fuller, more substantive answers (tuning + diversity + budget + prompt)

**Goal:** Make answers thorough and well-grounded without changing retrieval architecture.
**Independent; blocks Phase F.**

### What to implement

1. **Raise + make-tunable the retrieval depth.** `topK` defaults to 8 (`config.ts:91`). Increase the default
   (e.g. 12–20) and keep it config-driven. The candidate pool is already `8×topK` so the SQL needs no change;
   verify the larger context still fits the generator's window (see #3).
2. **Per-document diversity cap (M-N3).** After retrieval, before building the prompt, cap how many chunks any
   single document contributes (e.g. ≤3), so one long file can't crowd out other sources. Implement as a pure
   post-processing step over `RetrievalResult[]` in the retriever or in `askQuestion`
   (`packages/services/src/ask.ts:77-86`) — return a new array (immutability), don't mutate. Make the cap a
   config value.
3. **Set an explicit `max_output_tokens`** on both generators (`generator.ts:94-187`) — generous (e.g. 1500– 2048) so substantive answers aren't truncated at provider defaults, and tunable via config. Keep temp 0.2.
4. **Rewrite the system prompt for completeness + synthesis** (`generator.ts:43-56`) while **keeping every
   existing safety rule** (untrusted-content handling, `[N]` citations, refuse-when-absent, injection guards).
   Add directives to: use ALL relevant context, synthesize across multiple documents, be thorough and
   structured (not terse), and explicitly note partial answers when context is incomplete rather than
   over-claiming. Do NOT weaken rule 1 (only use provided context) or the injection defenses.
5. **(Optional, low-risk) close the opening-`<document>` injection gap (M-N5):** also escape opening
   `<document` tags in `buildContext` (`generator.ts:62-76`), not just the closing tag.

### Authoritative references

- Config defaults: `packages/core/src/config.ts:88-94`.
- Ask orchestration (where to apply the diversity cap): `packages/services/src/ask.ts:48-92`.
- Retriever: `packages/rag/src/retrieval/retriever.ts:43-74`.
- Generators + prompt + context builder: `packages/rag/src/generation/generator.ts:43-76, 94-187`.
- Documented gaps to close: `docs/ISSUES-AND-OPTIMIZATIONS.md` (H1/M-N3/M-N5).

### Verification checklist

- [ ] `askQuestion` retrieves the new default `topK` and the diversity cap limits per-document chunks (unit test
      with a fake retriever returning 6 chunks from one doc → capped).
- [ ] Generators pass `max_output_tokens`; a long-answer prompt is not truncated at the old default.
- [ ] Prompt still contains all safety rules (grep for the untrusted-content + `[N]` + refusal clauses).
- [ ] `pnpm --filter @rag/services test` + rag tests green; `pnpm typecheck` green.
- [ ] Eval harness (`pnpm eval`) baseline guards still pass (recall@5≥0.8 etc.) — see Phase G.

### Anti-pattern guards

- Do NOT weaken grounding/injection rules in the prompt rewrite.
- Do NOT mutate the retrieved array in place for the diversity cap.
- Do NOT raise `topK` so high it blows the generator context window — pair with #3 and re-check.

---

## Phase F — Reranking stage over the candidate pool

**Goal:** Re-order the over-fetched candidate pool by true query relevance before the generator sees it — the
#1 documented retrieval-quality gap (H1). **Depends on Phase E.**

### What to implement

1. **Define a `Reranker` contract in `@rag/core`:** `rerank(query: string, candidates: RetrievalResult[],
topK: number): Promise<RetrievalResult[]>`. Pluggable like the other providers.
2. **Implement at least one provider** (`packages/rag/src/retrieval/`):
   - **Hosted cross-encoder rerank API** (Cohere Rerank or Jina Reranker) — strongest quality, one API call,
     a new key/dependency; OR
   - **LLM-based rerank** reusing the existing Gemini/OpenAI client (prompt the model to score/order candidates)
     — no new vendor, but extra latency/cost.
     Add a `createReranker(config)` factory mirroring the embeddings factory. Make the provider configurable and
     include a `none` pass-through (returns the input truncated to topK) so the feature is toggleable.
3. **Expose the full candidate pool to the reranker.** Today `hybridSearch` truncates to `topK` after RRF
   (`queries.ts:414-438`). Have the retriever request the **pool** (`candidatePoolMultiplier × topK` ≈ 64),
   rerank it, then return the top `topK`. Keep the post-fusion `WHERE`/scope filters intact (do not defeat
   HNSW/GIN). Wire the rerank step into `Retriever.search` (`retriever.ts:43-74`) after `hybridSearch`,
   before returning — and before Phase E's diversity cap (rerank for relevance, then cap for diversity).
4. **Wire into `@rag/runtime`** `buildCoreDeps` and env config. Env: `RERANK_PROVIDER`
   (`none`|`cohere`|`jina`|`llm`), `RERANK_MODEL`, provider key. Default `none` so deployments opt in.
5. **Resilience:** a reranker error must fall back to the RRF order (log + continue), never fail the query.

### Authoritative references

- Retriever integration point: `packages/rag/src/retrieval/retriever.ts:14 (placeholder comment), 43-74`.
- Pool sizing in SQL: `packages/db/src/queries.ts:271-472` (`candidatePoolMultiplier` ~`:294`).
- Provider/factory + runtime wiring patterns: `packages/rag/src/embeddings/factory.ts`;
  `packages/runtime/src/index.ts`.
- Result type: `packages/core/src/types.ts:206-231`.

### Verification checklist

- [ ] With `RERANK_PROVIDER=none`, behavior is identical to today (pass-through, truncate to topK).
- [ ] With a fake reranker that reverses order, `Retriever.search` returns the reranked top-k (unit test).
- [ ] Reranker exception falls back to RRF order (assert no throw, RRF order returned).
- [ ] Eval harness shows nDCG@5 / recall@5 not regressed (ideally improved) vs the Phase E baseline.
- [ ] `pnpm typecheck` + rag/services tests green.

### Anti-pattern guards

- Do NOT move filters/scope before fusion (keeps indexes effective; preserves fail-closed ACL).
- Do NOT let rerank latency/errors block answers — always degrade to RRF.
- Do NOT rerank AFTER the diversity cap (cap operates on the reranked, relevance-ordered set).

---

## Phase G — Final verification (whole feature)

### What to verify

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` green workspace-wide; `pnpm e2e` green.
- [ ] **End-to-end happy path:** create a SharePoint source → sync → ask a question → answer is substantive,
      multi-source, cites `[N]` → a citation is `downloadable` → `GET /documents/:id/download` returns the
      original file bytes (scope-checked) → web "Download original" button works via BFF.
- [ ] **Ingest-everything:** a faked multi-library, multi-page, multi-format site ingests all libraries
      (drive pagination fix), records skips/failures in the run summary, and reconciles a deletion (chunks gone).
- [ ] **Scale reliability:** the per-page re-enqueue chain (Phase B / `PLAN-PER-PAGE-REENQUEUE.md` Phase 3–5)
      completes a multi-page sync as one history row with `singleton` serialization.
- [ ] `pnpm eval` retrieval baselines hold or improve (recall@5≥0.8, recall@3≥0.7, nDCG@5≥0.6, MRR≥0.6).
- [ ] **Anti-pattern greps return nothing bad:**
  - no `pg`/`drizzle-orm` import outside `packages/db`;
  - no `bytea` column for originals;
  - download route goes through the `@rag/services` scope-checked function (not ad-hoc DB read in the route);
  - prompt still contains untrusted-content + `[N]` + refusal clauses;
  - reranker/object-store/rerank all have a working `none`/disabled mode.
- [ ] `env.example` documents all new vars (`OBJECT_STORE_*`, `RERANK_*`) and `docs/ARCHITECTURE.md` +
      `docs/ISSUES-AND-OPTIMIZATIONS.md` updated (mark H1 rerank + M-N3 diversity + download capability done).
- [ ] Security pass (per repo rules): download route authz, filename header-injection, object-store creds not
      exposed to the browser, SSRF/path-traversal on `storageKey` not attacker-controllable (it's derived
      server-side, never from the request).

### Anti-pattern guards

- Do NOT mark complete while any provider's disabled (`none`) path is broken — local/dev must run without a
  bucket or rerank vendor.
- Do NOT let docs drift — capability changes must land in `env.example` + architecture docs.

---

## Suggested execution order across sessions

1. **Phase A** (correctness — unblocks trustworthy ingest; stabilizes the page contract for B).
2. **Phase C** (object storage) → **Phase D** (download) — delivers the headline "download cited document."
3. **Phase E** (substantive answers) → **Phase F** (reranking).
4. **Phase B** (`PLAN-PER-PAGE-REENQUEUE.md` Phases 3–5) — can run any time after A; needed for huge libraries.
5. **Phase G** (final verification).

A, C→D, and E→F are mutually independent and can be parallelized across fresh contexts; each is self-contained.
