# RAG System — Prioritized Issues & Optimization Opportunities

**Date:** 2026-06-07
**Scope:** whole repo, with a deliberate emphasis on **connector extensibility (esp. SharePoint), chunking strategy, pipeline efficiency, and RAG retrieval quality**
**Relationship to `CODEBASE-REVIEW.md`:** That document is a security/correctness audit (6 parallel specialists) and already enumerated and partially fixed the security-grade findings. **This document does not repeat its fixed items.** It (a) tracks the still-open Critical/High decisions from that review, and (b) adds the architecture / RAG-quality / extensibility analysis that the audit only lightly touched. Where an item originates in the audit it is tagged e.g. `[review:H2]`.
**Grounding:** Recommendations apply RAG best practices (hybrid search + reranking, query transformation, contextual retrieval, embedding selection, retrieval evaluation). Citations to code use `path:line`.

---

## How to read this

| Tag             | Meaning                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **CRITICAL** | Silent data loss, security exposure, or retrieval-breaking. Fix before any networked/prod deploy.                               |
| 🟠 **HIGH**     | Materially degrades correctness, retrieval quality, or operability. Schedule next.                                              |
| 🟡 **MEDIUM**   | Real but bounded; fix opportunistically.                                                                                        |
| ⚪ **LOW**      | Polish / hardening.                                                                                                             |
| 🟢 **OPT**      | Optimization opportunity (not a defect) — these are the connector / chunking / pipeline / RAG-quality wins the brief asked for. |

A consolidated, effort-ranked roadmap is at the end ([§11](#11-prioritized-roadmap)). **CPA-deployment blockers (PII / access control / §7216) are in [§9](#9-pii-access-control--7216-compliance-cpa-firm-blockers); ingestion operator-experience is in [§10](#10-opt-e--ingestion-ux--operator-experience).**

---

## 1. Critical (open decisions)

### 🔴 C1 — HNSW + tsvector GIN indexes are invisible to Drizzle `[review:H2]`

`packages/db/src/schema.ts:125` defines the `chunks` table with only `documentIdx`, `documentOrdinalIdx`, `hashIdx`. The two indexes that **make retrieval work** — `chunks_embedding_hnsw_idx` (HNSW `vector_cosine_ops`) and `chunks_tsv_idx` (GIN) — plus the `tsv` trigger live only in hand-authored SQL (`packages/db/drizzle/0000_init.sql:97-122`). The next `drizzle-kit generate` will diff them as "removed" and emit `DROP INDEX`, collapsing both dense and sparse search to sequential scans with **no error and no test failure**.

**Why it's still Critical:** it is latent and silent. Everything works until someone regenerates migrations.
**Fix (pick one):**

1. Express both indexes in `schema.ts` using Drizzle's raw-SQL index escape so the model is the source of truth, **or**
2. Add them to a `drizzle-kit` ignore list and put a loud comment in `schema.ts` that `0000_init.sql` owns them.
   **Add a regression guard regardless:** a startup/CI assertion that `chunks_embedding_hnsw_idx` and `chunks_tsv_idx` exist in `pg_indexes`. This is the cheapest insurance against the whole class of "index silently dropped" bugs.

### 🔴 C2 — Python parser sidecar still has no authentication `[review:C2 — partially fixed]`

Port is now bound to `127.0.0.1` (good), but `POST /parse` (`services/parser-py/app/main.py:107`) accepts arbitrary binaries into MarkItDown/LibreOffice/Unstructured/Tesseract with no auth. Loopback binding is adequate for single-host dev; **any networked deployment (separate parser container/host, k8s) re-exposes it.**
**Fix:** shared-secret header (`X-Parser-Token` from `PARSER_SECRET`) checked by FastAPI middleware; `HttpParserClient` (`packages/rag/src/parser/parser-client.ts`) sends it. Touches Python + Node client + env — needs explicit approval, hence still open.

---

## 2. High

### 🟠 H1 — No reranking stage (largest retrieval-quality gap)

`Retriever.search` (`packages/rag/src/retrieval/retriever.ts:29`) returns the RRF-fused top-K **directly** to the generator. Hybrid RRF is a strong _candidate generator_, but the single highest-ROI improvement in modern RAG is a **rerank** pass over the candidate pool before it reaches the LLM. The infrastructure is already shaped for it: `hybridSearch` over-fetches an 8× pool (`packages/db/src/queries.ts:221`) and then truncates to `topK` by RRF score — that pool is exactly what a reranker should consume.

**Recommendation:** add a `Reranker` interface in `@rag/core` and an optional rerank step:

- Retrieve `poolK` (e.g. 50–100) via hybrid search → rerank → keep top `topK` (e.g. 5–8).
- Provider options: **Cohere Rerank 3**, **Voyage rerank-2** (Anthropic-ecosystem aligned), or a local cross-encoder (`ms-marco-MiniLM`) for the no-API-cost path — mirror the existing `EmbeddingProvider` factory pattern so it's swappable.
- Expected effect: cross-encoder reranking typically lifts answer-relevant precision substantially over fusion-only pipelines; it is the standard "next step" after hybrid search.
  **Effort:** M. **Value:** very high. This is the #1 RAG-quality win.

### 🟠 H2 — Metadata filter is a guaranteed full scan `[review:H3]`

The metadata post-filter builds `doc.metadata->>'key' IN (...)` (`packages/db/src/queries.ts:252`). The shipped GIN `jsonb_ops` index (`0001_documents_metadata_gin.sql`) only accelerates `?`/`@>`/`@@` — **not** `->>` text equality — so every metadata-filtered query scans all documents. As the corpus grows this dominates query latency, and it interacts badly with the 8× candidate pool.
**Fix:** either B-tree expression indexes on the actual filterable keys (`CREATE INDEX ... ON documents ((metadata->>'path'))`), or rewrite the filter to `metadata @> '{"key":"value"}'::jsonb` with a `jsonb_path_ops` GIN index. The latter is generic and matches the existing index intent.

### 🟠 H3 — No startup guard that embedding dimensions match the `vector(768)` column `[review:M7 — promoted]`

`chunks.embedding` is hardcoded `vector(768)` for Gemini (`schema.ts:151`). Switching `EMBEDDING_PROVIDER=openai` (1536-dim) without altering the column fails **only at first insert — after embedding credits are already spent** and a sync is half-done. The system is explicitly "provider-pluggable," which makes this trap easy to hit.
**Fix:** at startup assert `config.embedding.dimensions === <column dimensions>` (read from a constant or `information_schema`). Promoting from the audit's Medium because the pluggability is a headline feature and the failure mode wastes money + leaves partial state.

### 🟠 H4 — Unvalidated external-boundary casts `[review:H5/H6/H7]`

Three casts turn runtime data into lies the type system believes:

- `parser-client.ts:48` — `(await res.body.json()) as ParsedDocument`; a malformed sidecar response silently corrupts every downstream chunk. Define `ParsedDocumentSchema` in `@rag/core` and `.parse()` it. (This also hardens the TS↔Python contract — see [§5 OPT-C].)
- `apps/worker/src/deps.ts:88` — `source.kind as never` defeats the factory's exhaustiveness check; a new `SourceKind` compiles and crashes at runtime. Use `SourceKind.parse(source.kind)`.
- `apps/mcp/src/transports/http.ts:110,182` — `mcp-session-id as string | undefined` drops the `string[]` case, so a repeated header makes every request look like a new session. `Array.isArray(raw) ? raw[0] : raw`.

### 🟠 H5 — No rate limiting on API or MCP `[review:H9]`

`POST /ask` triggers an embedding + LLM call per request; an unbounded loop from any valid token drains quota and saturates the DB pool. Add `@fastify/rate-limit` (stricter on `/ask` and `/sources/:id/sync`) and limit the MCP HTTP transport.

### 🟠 H6 — `express@4` runtime with `@types/express@5` types (MCP) `[review:H4]`

`apps/mcp` runs Express 4 but type-checks against Express 5 signatures — runtime mismatches in `http.ts` won't be caught by `tsc`. Align both to one major.

---

## 3. Medium (condensed)

The audit's Medium list (`CODEBASE-REVIEW.md` M1–M21) stands — notably **M3** (upsert "inserted" detection via `xmax=0` is fragile on PG15+ and `content_changed` may arrive as `'t'`/`'f'` string), **M6** (`deleteDocumentsByExternalIds` unbounded `IN` list can exceed the 65k bind-param limit on large delta syncs — batch or use `= ANY($1::text[])`), **M17** (`chunks.tsv` nullable → a NULL tsv is silently excluded from sparse retrieval), and **M19** (Gmail never bootstraps a baseline `historyId`, so changes during the initial scan can be missed). New Medium items this pass:

| #    | Area                 | File                                      | Issue                                                                                                                                                                                                                                                                                                                                                        |
| ---- | -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-N1 | Chunking / embedding | `markdown-chunker.ts`, `table-chunker.ts` | No hard token clamp before `embedBatch`. Token counts use the GPT `o200k` tokenizer (`markdown-chunker.ts:236`) as a proxy for Gemini; a ±10–20% under-count on a wide table row or huge code block can push a chunk past Gemini's 2048-token embedding input limit → opaque provider error mid-sync. Clamp every chunk to a safe hard max before embedding. |
| M-N2 | Chunking quality     | `markdown-chunker.ts:228`                 | Overlap is approximated by slicing `prevTokens.length * 4` **characters**, not by decoding tokens. For code and CJK this cuts mid-token/mid-word and the overlap size drifts. Slightly degrades retrieval at chunk boundaries (the audit's L9). Decode the actual token tail, or overlap by whole sentences/rows.                                            |
| M-N3 | Retrieval diversity  | `queries.ts:hybridSearch`                 | No per-document cap / MMR. A single long document can occupy most of top-K, starving the LLM of diverse evidence. Add a per-`document_id` cap or an MMR re-order over the pool (pairs naturally with the H1 reranker).                                                                                                                                       |
| M-N4 | Pipeline efficiency  | `pipeline.ts:ingestOne`                   | Content hash is computed on `parsed.markdown` (`pipeline.ts:142`), so the **parse always runs** even for unchanged documents. On a full re-sync this re-downloads + re-parses everything before discovering nothing changed. See [§6 OPT-D2].                                                                                                                |
| M-N5 | Generation           | `generation/generator.ts:61`              | Prompt-injection guard only escapes `</document>`; a chunk can still inject a fake `<document index=…>` open tag (`review:M13`). Escape both boundaries or use a non-textual delimiter.                                                                                                                                                                      |

---

## 4. Low (condensed)

Audit L1–L9 stand. Most relevant here: **L7** — the shared `GraphClient` labels errors `"sharepoint:"` even when Outlook is the caller (`sharepoint/client.ts`), which will mislead connector debugging; **L9** — the fixed 4-chars/token overlap ratio (covered under M-N2). Plus: the `custom` connector path throws "construct directly" with no registration mechanism ([§5 OPT-A2]); `documents://{id}` MCP resource skips the UUID check the tool enforces (`review:L1`).

---

## 5. 🟢 OPT-A — Connector extensibility & ease of adding new sources

This is the brief's headline concern. The current design is clean and consistent — every connector implements the same `Connector` interface (`validate/list/fetch`, cursor-driven delta) and is registered in one factory. But **adding a source today is more work than it should be**, and the friction is structural.

### What adding a connector costs today

To add (say) Confluence you must touch **six** places:

1. `packages/core/src/types.ts:7` — add `"confluence"` to the closed `SourceKind` zod enum.
2. `packages/connectors/src/confluence/{client,config,index}.ts` — three new files; `index.ts` re-implements the full cursor encode/decode + pagination loop + size-skip + metadata mapping (SharePoint's version is ~220 lines, `sharepoint/index.ts:85-302`).
3. `packages/connectors/src/factory.ts:45` — add a `case`, **and** if the provider needs a new credential type, extend `ConnectorEnv` (`factory.ts:12`) and the credential-branching logic.
4. `packages/connectors/src/index.ts` — export it.
5. `apps/worker/src/deps.ts` — the `source.kind as never` cast (H4) means the worker compiles even if you forget to wire it.
6. `env.example` + `docs/CONNECTORS.md`.

Steps 1, 3, 5 are **edit-points in shared files** that a new connector author shouldn't need to touch, and the `as never` cast removes the compiler's help.

### 🟢 OPT-A1 — Replace the factory `switch` with a connector registry

Swap the hardcoded `switch` (`factory.ts:38`) for a registry:

```ts
type ConnectorFactory = (cfg: unknown, env: ConnectorEnv, log: Logger) => Connector;
const REGISTRY = new Map<string, { credential: "microsoft" | "google" | "none"; build: ConnectorFactory }>();
export function registerConnector(kind: string, entry: ...) { REGISTRY.set(kind, entry); }
```

Each connector self-registers in its own module; `createConnector` looks up the map and resolves credentials by the declared `credential` tag. Adding a connector becomes **"add a folder + one `registerConnector` call"** — no shared `switch` edit, and the credential-resolution boilerplate (the repeated `if (!creds) throw` blocks) collapses into one place. This also lets `custom` connectors register at runtime instead of throwing (`factory.ts:82`).

### 🟡 OPT-A2 — Extract a `BaseConnector` to kill the per-connector boilerplate

> **✅ Partially shipped (five-systems unification):** the `paginate()` helper + `makeCursorCodec()` now live in `packages/connectors/src/util/{paginate,cursor}.ts`, and all four connectors implement only a per-page `fetchPage`. The abstract `BaseConnector` was **deliberately not** introduced — composition via those two utilities removes the boilerplate without an inheritance tree. Registry (A1) and creation-time config validation (A4) remain open.

The four connectors repeat the same scaffolding: parse config via Zod in the constructor, encode/decode an opaque cursor, run a "while documents < maxItems, page through a delta feed" loop, skip folders/deletes/oversize, and map provider fields → `DocumentMetadata`. SharePoint's `list()` (`sharepoint/index.ts:115-167`) is almost entirely generic queue-walking; only `initialDeltaUrl`, `toSourceDocument`, and the cursor shape are provider-specific.

Provide an abstract `BaseConnector` (or a `paginate()` helper + a `CursorCodec`) that owns the loop, the size/folder/delete skips, and the `maxItems` accounting. A new connector then implements only:

- `configSchema` (Zod),
- `listPage(cursor) → { items, nextCursor, done }`,
- `mapItem(raw) → SourceDocument | null`.

This would cut a new connector from ~220 lines to ~60 and make the "skip deleted/oversize" and "persist cursor before returning" invariants impossible to get wrong (the latter is a subtle correctness rule enforced today only by convention in `runIngestion`, `pipeline.ts:96`).

### 🟢 OPT-A3 — Open the `SourceKind` enum for custom kinds

`SourceKind` is a closed enum (`types.ts:7`), so every new source requires editing `@rag/core`. With the registry (A1), validate `kind` against the registry's keys at runtime instead, and let `SourceKind` be `z.string()` for `"custom"`-class sources. Keeps the core package stable as connectors proliferate.

### 🟢 OPT-A4 — Validate connector config at source-creation time `[review:M14]`

`POST /sources` stores `config` as `z.record(z.unknown())` and only validates it when a sync runs (`routes/sources.ts:43`). A typo'd SharePoint `siteId` is accepted now and fails hours later in the worker. With the registry, look up the connector's `configSchema` and validate at creation — fail fast, in the request, where the operator can fix it.

---

## 6. 🟢 OPT-B — SharePoint connector optimizations

### 🟢 OPT-B1 — Decouple enumeration from content download (biggest SharePoint win)

`SharePointConnector.list()` downloads **full file bytes inline** for every item via `getBytes` (`sharepoint/index.ts:230`), serially, inside the enumeration loop. So `list()` latency = sum of serial downloads, and a page that happens to contain several large files blocks the whole page. Meanwhile `runIngestion` already has a concurrency limiter (`pipeline.ts:82`) that only parallelizes parse/embed — **not** the downloads.

**Recommendation:** have `list()` return lightweight document _references_ (id + metadata + a fetch handle), and let the pipeline pull content concurrently via the existing `fetch(externalId)` (`sharepoint/index.ts:168`, already implemented). This moves downloads under the concurrency limiter and lets enumeration stream ahead of content fetch. It's also the natural shape for OPT-D1 (modified-time skip) and OPT-D3 (cross-document embedding batches).

### 🟢 OPT-B2 — `$select` the delta payload

The delta call (`initialDeltaUrl`, `sharepoint/index.ts:158`) pulls full `driveItem` objects. Append `?$select=id,name,file,folder,deleted,size,webUrl,lastModifiedDateTime,parentReference,...` to shrink each page's payload (the code only reads a handful of fields in `toSourceDocument`). Lower bandwidth, faster paging, less Graph throttling pressure.

### 🟢 OPT-B3 — Use Graph `$batch` for downloads/metadata

Microsoft Graph supports `$batch` (up to 20 sub-requests). Combined with B1, content downloads (or HEAD-like metadata probes) can be issued 20-at-a-time instead of one-by-one, dramatically reducing round-trips on large libraries. The shared `GraphClient` already centralizes 429 backoff, so batching belongs there and benefits Outlook too.

### 🟢 OPT-B4 — Surface SharePoint managed-metadata columns

SharePoint document libraries carry rich column metadata (content type, department, retention label). Promoting selected columns into `DocumentMetadata.extra` would make the metadata filter (once H2 is fixed) genuinely useful for the CPA knowledge base (e.g. filter by client, engagement, year) without re-deriving it from the document body.

---

## 7. 🟢 OPT-C — Chunking strategy

The current chunker is well-built: heading-aware recursive splitting with a heading breadcrumb prepended for self-containment (`markdown-chunker.ts:55`), code-block-safe boundaries, and a dedicated table/spreadsheet path with sheet-type routing (`composite-chunker.ts:40`, `table-chunker.ts`). The financial-model "embed the whole sheet's computed values" path (`table-chunker.ts:62`) is genuinely smart for the CPA domain. Improvements, in value order:

### 🟢 OPT-C1 — Add **Contextual Retrieval** (Anthropic) as an optional chunk transform

The biggest known lever for heterogeneous knowledge bases: before embedding, prepend each chunk with a 1–2 sentence, LLM-generated description of how the chunk fits its parent document ("This chunk is from the FY2024 engagement letter for Acme Corp, section on scope of audit…"). Anthropic reports this cuts failed retrievals materially (combined with hybrid search + rerank). It slots in cleanly after parse, before `chunker.chunk()`, and is cache-friendly (prompt-cache the document body). Make it optional/per-source given the extra LLM cost. **This pairs with H1 (rerank) as the two highest-value RAG-quality upgrades.**

### 🟢 OPT-C2 — Don't bloat BM25 with the repeated heading breadcrumb

Every chunk gets `# A › B\n\n` prepended (`markdown-chunker.ts:56,71,84`). Good for the embedding's self-containment, but the literal breadcrumb text is also stored in `chunks.text`, which feeds the `tsv` (`0000_init.sql:115`). Repeating the same heading words across dozens of chunks skews `ts_rank_cd` toward documents with many chunks under that heading. Consider storing the breadcrumb in a separate column used only for the embedding input + citation, keeping `text` (and thus `tsv`) as the raw body. Minor, but it's a free sparse-retrieval quality gain.

### 🟢 OPT-C3 — Consider semantic / late chunking for narrative docs

Fixed ~800-token windows split mid-argument in long prose. Two options the architecture can accommodate as alternative `Chunker` implementations (the interface already supports it): **semantic chunking** (embed sentences, cut at similarity troughs) for narrative sources, or **late chunking** (embed the whole doc with a long-context embedder, then pool per chunk) to preserve cross-chunk context. Gate by source type so spreadsheets keep their tuned path.

### 🟢 OPT-C4 — Parent-document / small-to-big retrieval

Embed small precise chunks but return the surrounding section to the LLM. Cheap to add given chunks already carry `ordinal` + `documentId`: after retrieval, expand each hit to its neighbor ordinals (or its heading section) before generation. Improves answer completeness without hurting retrieval precision.

---

## 8. 🟢 OPT-D — Pipeline efficiency

### 🟢 OPT-D1 — Skip unchanged documents **before** download/parse

Today the only idempotency gate is the content hash computed _after_ parse (`pipeline.ts:142`), and for SharePoint the bytes are already downloaded during `list()` (B1). So a full re-sync re-downloads + re-parses every file just to discover the hash is unchanged. Store `source_modified_at` (already persisted, `pipeline.ts:148`) and compare the source's reported `modifiedAt`/etag **before** fetching content; only download+parse when it moved. Delta syncs already avoid this (the API returns only changes), but full re-syncs and reprocess flows pay the full cost. Big win on large, mostly-static libraries.

### 🟢 OPT-D2 — Batch embeddings across documents

`ingestOne` calls `embedBatch` once per document (`pipeline.ts:170`). A page of many small documents → many small embed requests, each under-filling the provider batch (Gemini allows large batches per call). Introduce an embedding queue that coalesces chunks across concurrently-processing documents into provider-max batches. Fewer round-trips, higher throughput, lower rate-limit pressure. Keep the per-document length-equality guard (`pipeline.ts:177`) by tracking offsets.

### 🟢 OPT-D3 — Re-enqueue per page instead of one long job

`runIngestion` loops _all_ pages to completion in a single job (`pipeline.ts:72`, `while (!pageDone)`). The cursor is persisted after each page (good, `pipeline.ts:96`), so the building blocks for resumability exist — but a crash mid-run restarts the whole loop, and one giant library = one long-running, unparallelizable job. Have the handler process one page then re-enqueue with the new cursor (the code comment at `pipeline.ts:69` already anticipates this). Yields natural checkpointing, even load, and lets multiple workers share a large sync.

### 🟢 OPT-D4 — Persist failed documents for targeted reprocess

`runIngestion` counts `documentsFailed` but discards which ones (`pipeline.ts:88`). Since `fetch(externalId)` exists for exactly this, write failed `externalId`s (with the error) to a small table or the job result so a reprocess job can retry just those, instead of re-running the whole source. Turns transient parse/Graph failures into a cheap retry instead of a full re-sync.

### 🟢 OPT-D5 — Coalesce per-document DB round-trips

`ingestOne` does `upsertDocument` then `replaceChunks` as separate calls (`pipeline.ts:145,164`). For high-throughput ingestion, batching chunk inserts (multi-row `INSERT … ON CONFLICT`) and reusing prepared statements reduces per-document latency. Lower priority than D1–D3.

---

## 9. 🔴 PII, access control & §7216 compliance (CPA-firm blockers)

This system is being stood up over a **CPA firm's** corpus — SharePoint engagement files, and Gmail/Outlook mailboxes that contain client tax data. That changes the risk profile entirely: the documents being embedded are **taxpayer return information** and client-confidential records, and the people who can query them are not all entitled to see every client. None of the controls that context requires exist yet. These are not hypothetical hardening items; for this deployment they are go/no-go blockers.

### 🔴 P1 — No access control: any API token reads the entire corpus

`ARCHITECTURE.md:160` states it plainly — _"Not a permission/ACL system. All documents in the corpus are searchable by anyone with an API token."_ For a generic internal wiki that is a defensible scope cut. For a CPA firm it is not: staff are routinely walled off from clients they don't work (and partners from each other's books), and a single shared bearer token flattens all of that. There is no per-user identity on `/search` or `/ask` (`apps/api/src/routes/search.ts:45`, `ask.ts:35`), no notion of which clients/sources a caller may see, and `SearchQuery` only supports a caller-supplied `sourceIds`/metadata filter (`packages/core/src/types.ts:164`) — a _convenience_ filter the caller chooses, not an _enforced_ boundary.

**Why it's Critical here:** the first time someone asks "_what's Acme Corp's projected tax liability?_" and gets a grounded answer sourced from another partner's client folder, the firm has an internal-confidentiality incident.
**Fix (minimum viable):** introduce a caller identity (per-user/role token), attach an allowed-`sourceId` (or client/engagement tag) set to it, and **enforce** that set inside `Retriever.search` / `hybridSearch` as a mandatory `WHERE`, not the optional filter. The architecture note already prescribes exactly this ("wrap retrieval with your own authz layer that filters `sourceIds`") — it just hasn't been built. Pairs with OPT-B4 (surface SharePoint client/engagement columns) so the filter has something firm-meaningful to key on.

### 🔴 P2 — Sender/recipient/subject PII flows to every caller and into the vector store

`DocumentMetadata` carries `author`, `from`, `to[]`, `subject` (`packages/core/src/types.ts:37,46–48`); the Gmail/Outlook connectors populate them from message headers (`gmail/index.ts:294–313,420–436`); and `RetrievalResult.document.metadata` returns the **whole metadata object** on every hit (`types.ts:172–188`). So any token-holder doing a search gets back real names, email addresses, and subject lines — taxpayer-identifying information — even before reading a chunk body. There is **no redaction, masking, or field-level allowlist anywhere in the codebase** (a repo-wide grep for `redact|mask|anonymi|pii` returns nothing in code).

**Fix:** decide a metadata-exposure policy explicitly. At minimum, allowlist which metadata fields cross the API boundary (mirror the `sanitizeSource` pattern already used for source `config` in `routes/sources.ts:26`), and consider hashing/tokenizing `from`/`to` if they're needed for filtering but not for display. Email bodies themselves are chunked and embedded verbatim — see P3.

### 🔴 P3 — Embedding/generation ships client tax data to third-party LLM providers (IRC §7216 / Circular 230)

Every parsed document is embedded via Gemini/OpenAI (`ARCHITECTURE.md:128`, data-flow step 7) and `/ask` sends retrieved chunks to Gemini/OpenAI for generation (`ARCHITECTURE.md:108`). When the corpus is client tax records, **sending that content to an outside API is a disclosure of taxpayer return information** — the exact thing **IRC §7216** regulates (criminal/civil penalties for unauthorized disclosure by a return preparer) and **Circular 230 §10.22** touches on diligence. This is also called out as a mandatory epistemic constraint in the consulting workspace's own `CLAUDE.md` (constraint #2). The code today has no provider data-processing agreement gating, no per-source "may leave the building" flag, and no audit trail of what content was sent to which provider.

**Why it's Critical:** this is a regulatory exposure for the firm's owners personally, not just a technical risk. It must be a conscious, documented decision before any real client data is ingested.
**Fix / decisions required (not all code):**

- Confirm a **signed data-processing/BAA-equivalent** with each LLM provider and that the chosen tier contractually excludes training-on-data; or run a **self-hosted / on-tenant embedding+generation** path (the provider-pluggable design already allows a local embedder — `ARCHITECTURE.md:130`).
- Add a per-source `dataClass` (e.g. `public | internal | client-confidential`) and **block** client-confidential sources from any provider not covered by an agreement — fail at ingestion, not after.
- Log a minimal **disclosure audit trail** (what source, when, which provider) to satisfy the §10.22 recordkeeping expectation.

### 🔴 P4 — No encryption-at-rest story for the corpus, and no data-retention/deletion path

Everything — document bodies, chunk text, embeddings, and email metadata — lands in one Postgres instance (`ARCHITECTURE.md:116`). There is no application-level encryption of sensitive columns and **no retention or right-to-delete mechanism**: ingestion only ever upserts. When a client engagement ends (or a client invokes a deletion request), there is no "purge everything for source/client X" operation — `deleteDocumentsByExternalIds` exists for _delta_ removals but nothing purges a whole client, and embeddings derived from their data linger in the HNSW index.

**Fix:** (a) rely on disk/volume encryption at minimum and document it; evaluate column-level encryption for `documents.content`/`chunks.text` if the threat model needs it. (b) Add a `DELETE /sources/:id` (and a `purgeSource`) that removes the source, its documents, its chunks, and triggers an index cleanup — both for offboarding and for honoring deletion requests. This is the disposal half of a retention policy the firm will need on paper anyway.

> **Sequencing note for §11 roadmap:** P1–P4 are CPA-deployment blockers but several are _decisions_ (provider agreements, data classification, retention policy) as much as code. They gate ingesting **real** client data; they do **not** gate building/evaluating the pipeline on synthetic or public data. Do the eval-harness and RAG-quality work (§11) on non-sensitive data in parallel, and close P1–P4 before the first real client source is connected.

---

## 10. 🟢 OPT-E — Ingestion UX & operator experience

The brief's other half: how hard is it to actually _set up and run_ a source? Today the answer is "you need to be the developer who wrote it." Everything is raw HTTP against `apps/api`; there is **no web UI and no CLI** (`apps/` contains only `api`, `mcp`, `worker`). For a 20-person firm where the operator is a non-CPA consultant and the decision-makers are partners, that friction is itself an adoption risk.

### 🟢 OPT-E1 — Source creation is hand-built opaque JSON with no validation feedback

`POST /sources` takes `config: z.record(z.unknown())` (`routes/sources.ts:43`) and stores it unvalidated; the connector's real schema (`SharePointConfigSchema`, etc.) isn't consulted until a sync runs hours later in the worker. So the operator hand-authors connector-specific JSON with **no field hints, no enum of valid kinds surfaced at the field level, and no error until much later.** This is the UX face of OPT-A4 (validate at creation) — but beyond validation, the operator needs to _know what to type_. Worse, the required identifiers are themselves obscure: finding a SharePoint `siteId` means hand-running a Graph API call (`CONNECTORS.md:51`); Drive needs a raw `folderId`; Gmail needs label _IDs_, not names.

**Fix (layered, cheapest first):**

1. Validate `config` against the connector's `configSchema` at creation (OPT-A4) so the operator gets an immediate, field-level error.
2. Expose the connector config schemas (they're Zod → JSON Schema is one call) via a `GET /connectors` endpoint so a UI/form can render labeled fields and descriptions (the schemas already have good doc-comments).
3. Add resolver helpers / a small wizard for the obscure IDs (e.g. "list document libraries for this site", "list Gmail labels") so operators pick from a list instead of pasting Graph composite IDs.

### 🟢 OPT-E2 — No "test connection" / dry-run before committing a source

There is no way to confirm credentials and scope are right before the first real sync. The operator creates a source, kicks a sync, and waits to see if it worked. The `Connector` interface already has `validate()` (`CONNECTORS.md:9`) — it just isn't reachable from the API.

**Fix:** a `POST /sources/:id/test` (or a pre-create `POST /connectors/:kind/validate`) that runs `connector.validate()` + a 1-page `list()` and returns a sample of what _would_ be ingested (counts, a few titles) without persisting. Turns "create and pray" into "preview and confirm" — and is the natural place to catch a wrong `siteId` or an under-scoped OAuth grant.

### 🟢 OPT-E3 — Sync is fire-and-forget with no status to poll

`POST /sources/:id/sync` returns a `jobId` + `ingestionId` and a 202 (`routes/sources.ts:128–132`), but **there is no endpoint to retrieve either** — no `GET /sources/:id/ingestions`, no `GET /ingestions/:id`. The `ingestion_jobs` history table is written (`routes/sources.ts:114`) but only readable via direct DB access. The operator cannot see progress, success/failure counts, or _why_ a sync failed without SSH-ing to the database.

**Fix:** add `GET /sources/:id/ingestions` (recent runs with status/counts/duration) and `GET /ingestions/:id` (one run, including the per-document failures from OPT-D4 once that exists). This is the minimum observability for anyone operating the system who isn't its author, and it's what any status UI would consume.

### 🟢 OPT-E4 — Credentials are global env vars → no clean multi-client setup

All connector credentials live in shared env (`ConnectorEnv`, `factory.ts:12`): one Microsoft tenant app, one Google service account. Per the factory, every SharePoint/Outlook source reuses `MS_*` and every Drive/Gmail source reuses the one Google credential (`factory.ts:50–77`). A firm onboarding multiple clients with separate Microsoft tenants or Google orgs can't express that without redeploying with different env — and it collides with P3 (no per-source data-class/credential boundary).

**Fix:** allow per-source credential references (a `credentialId` on the source pointing at a secret store entry) so different sources can use different tenant apps/accounts. Pairs with the OPT-A1 registry (resolve `credential` by tag) and is a prerequisite for the firm serving more than one client org from one deployment.

> These are graded 🟢 (UX optimizations, not defects) **except** where they overlap a real correctness/compliance gap: OPT-E1's validation half is OPT-A4, and OPT-E4 is entangled with the P3/P1 access boundary. Sequenced in §11.

---

## 11. Prioritized roadmap

Ordered by **(value ÷ effort)**, grouped by intent. Effort: S < ½ day, M ≈ 1–2 days, L > 2 days.

### Fix first — latent breakage & money traps

| Item                                                                              | Sev | Effort |
| --------------------------------------------------------------------------------- | --- | ------ |
| C1 — index-drift guard + Drizzle ownership decision                               | 🔴  | S–M    |
| H3 — startup embedding-dimension assertion                                        | 🟠  | S      |
| H4 — boundary validation (`ParsedDocumentSchema`, `SourceKind.parse`, session-id) | 🟠  | S–M    |
| M-N1 — hard token clamp before embedding                                          | 🟡  | S      |
| C2 — parser shared-secret auth (before any networked deploy)                      | 🔴  | M      |

### Highest-ROI RAG-quality upgrades

| Item                                                     | Sev   | Effort |
| -------------------------------------------------------- | ----- | ------ |
| H1 — reranking stage over the existing 8× pool           | 🟠/🟢 | M      |
| OPT-C1 — contextual retrieval (optional chunk transform) | 🟢    | M      |
| H2 — make metadata filtering index-backed                | 🟠    | S–M    |
| M-N3 — per-document cap / MMR diversity                  | 🟡    | S      |
| **Build a small retrieval eval set first** (see §12)     | —     | M      |

### Connector extensibility (the "easy to add sources" goal)

| Item                                                                                   | Effort |
| -------------------------------------------------------------------------------------- | ------ |
| OPT-A1 — connector registry (kills the `switch`)                                       | M      |
| OPT-A2 — ✅ `paginate()` + cursor codec shipped; `BaseConnector` intentionally skipped | —      |
| OPT-A4 — validate config at source creation                                            | S      |
| OPT-A3 — open `SourceKind` for custom kinds                                            | S      |

### SharePoint & pipeline throughput

| Item                                           | Effort |
| ---------------------------------------------- | ------ |
| OPT-B1 — decouple enumeration from download    | M      |
| OPT-D1 — modified-time skip before parse       | S–M    |
| OPT-D3 — re-enqueue per page                   | M      |
| OPT-B2 / B3 — `$select` + `$batch` Graph calls | S / M  |
| OPT-D2 — cross-document embedding batches      | M      |

### Operability hardening

| Item                                      | Sev | Effort |
| ----------------------------------------- | --- | ------ |
| H5 — rate limiting (`/ask`, `/sync`, MCP) | 🟠  | S      |
| H6 — express major alignment              | 🟠  | S      |
| M3, M6, M17, M19 (from audit)             | 🟡  | S each |

### CPA-deployment blockers — close before ingesting real client data (§9)

| Item                                                                  | Sev | Effort              |
| --------------------------------------------------------------------- | --- | ------------------- |
| P3 — LLM-provider disclosure decision (§7216): agreement or self-host | 🔴  | M (mostly decision) |
| P1 — enforced per-user/role `sourceId` access control in retrieval    | 🔴  | M–L                 |
| P2 — metadata-exposure allowlist (sender/subject) at the API boundary | 🔴  | S                   |
| P4 — `DELETE`/purge-source + encryption-at-rest + retention policy    | 🔴  | M                   |

### Ingestion operator-experience (§10) — needed for a non-developer operator

| Item                                                             | Effort |
| ---------------------------------------------------------------- | ------ |
| OPT-E1 — validate config at creation + `GET /connectors` schemas | S–M    |
| OPT-E3 — `GET /sources/:id/ingestions` + `GET /ingestions/:id`   | S      |
| OPT-E2 — `POST /sources/:id/test` (validate + dry-run preview)   | S–M    |
| OPT-E4 — per-source credential references (multi-client)         | M      |

---

### ✅ Completed — five-systems unification (2026-06)

A consolidation pass landed in `refactor/five-systems-unification`, collapsing duplicated logic into single owners (prefer deletion over abstraction; one path over configurable paths):

- **C2a — duplicate `ingestion_jobs` write fixed.** `triggerSync` (`@rag/services`) is now the sole creator of the history row; the worker only transitions it (`running` → `completed`/`failed`). Verified structurally (`grep` finds `createIngestionJob` only in `@rag/db` + its single `@rag/services` caller, none in the worker) and at runtime (one sync → exactly one row).
- **`@rag/services`** — the five operations are transport-agnostic; HTTP routes + MCP tools are thin adapters.
- **`@rag/runtime`** — one `buildCoreDeps()` composition root + one hardened idempotent `close()`; all three apps boot and shut down through it (verified live).
- **Validation/security single-sourced** — one `filterSchema` + DoS caps, one constant-time token verifier, one `toPublicSource` stripper. MCP Origin allowlist + zero-token refusal kept.
- **Connector utilities** — shared `paginate()` + `makeCursorCodec()` (see OPT-A2).
- **Parser types generated** — Pydantic → OpenAPI → `parser-types.generated.ts`; the hand-written `ParsedTable`/`ParsedDocument` drift is gone.

**Follow-ups surfaced during verification — both resolved 2026-06-10:**

- ✅ **Orphaned `pending` on duplicate trigger.** `triggerSync` (`@rag/services`) now wraps `enqueueSync` in a try/catch: if the hand-off fails (most commonly a duplicate rejected by pg-boss's singleton guard, `SyncAlreadyRunningError`), it deletes the `pending` row it just created via the new `deleteIngestionJob` (`@rag/db`) and rethrows — so a rejected duplicate leaves no trace and the in-flight sync's row is untouched. Covered by `packages/services/src/sources.test.ts`.
- ✅ **`ParsedDocument.metadata` typed as `Record<string, never>`.** The Pydantic field now sets `json_schema_extra={"additionalProperties": True}`, so the parser's OpenAPI emits `additionalProperties: true` and the regenerated `parser-types.generated.ts` types `metadata` as `{ [key: string]: unknown }` instead of empty-object.

## 12. A note on measuring any of this

Several recommendations (rerank vs no-rerank, dense/sparse weights at `queries.ts:223`, chunk size, contextual retrieval) are **tuning decisions you cannot make blind.** Before investing in H1/OPT-C, stand up a minimal **retrieval evaluation harness**: 30–50 representative questions from the CPA knowledge base, each labeled with the document(s) that should answer it, scored on **recall@k** and **nDCG@k**, plus an LLM-judge on final-answer faithfulness/citation. That turns every item above from "sounds better" into a measurable delta and lets you tune the existing RRF weights empirically (the hybrid-search best practice is explicitly "tune weights on your data, A/B test, don't assume one size fits all"). It is the cheapest way to avoid optimizing the wrong thing.

---

### Appendix — what's already good (don't regress it)

Worth stating so these aren't "optimized away": the RRF query keeps filters out of the dense/sparse CTEs so HNSW/GIN actually fire (`queries.ts:228`), per-query `hnsw.ef_search` tuning in a scoped transaction, content-hash idempotency, the connector interface's clean cursor-driven delta model, the sheet-type-aware chunking router, and the non-finite-embedding guard (`queries.ts:215`). The bones are strong — most of this document is about raising an already-disciplined system to production RAG quality.
