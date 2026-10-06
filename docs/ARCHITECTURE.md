# Architecture

**Status:** Current · **Updated:** 2026-08-03

This document explains how the RAG system fits together, why each piece exists, and the design tradeoffs that shape it. **It is the canonical architecture reference.**

> [`RAG-ARCHITECTURE-GUIDE.md`](./RAG-ARCHITECTURE-GUIDE.md) covers overlapping
> ground at greater length (repo layout, conventions, and non-obvious gotchas for
> someone changing the code). Where the two disagree, **this file wins** — and
> where either disagrees with the code, the code wins.

## System diagram

```
                         ┌──────────────────────┐
                         │  Connectors          │
                         │  ─────────────       │
                         │  • SharePoint        │
                         │  • Google Drive      │
External       ────────► │  • Gmail             │ ──────┐
sources                  │  • Outlook           │       │
                         │  • git-markdown      │       │
                         │  • eCFR Part 4       │       │
                         └──────────────────────┘       │
                                                        ▼
                                            ┌────────────────────────┐
                                            │  Ingestion pipeline    │
                                            │  ───────────────────   │
                                            │  fetch → parse →       │
                                            │  chunk → embed → store │
                                            └────────────────────────┘
                                              │            │
                                ┌─────────────┘            └────────────┐
                                ▼                                        ▼
                  ┌──────────────────────────┐         ┌────────────────────────┐
                  │  Python parser sidecar   │         │  Embedding provider     │
                  │  (FastAPI)               │         │  Gemini / OpenAI / local│
                  │  MarkItDown + Unstructured│         └────────────────────────┘
                  └──────────────────────────┘                       │
                                                                     ▼
                                                       ┌─────────────────────────┐
                                                       │  Postgres + pgvector    │
                                                       │  ─────────────────      │
                                                       │  sources, documents,    │
                                                       │  chunks (HNSW + tsv),   │
                                                       │  ingestion_jobs,        │
                                                       │  pg-boss queue          │
                                                       └─────────────────────────┘
                                                            ▲                 ▲
                              ┌─────────────────────────────┘                 │
                              │                                               │
                ┌───────────────────────────┐               ┌─────────────────────────────────┐
                │ apps/api (Fastify)        │               │ apps/mcp (Model Context Protocol)│
                │ ─────────────────────     │               │ ────────────────────────────     │
                │ HTTP: /sources /search    │               │ Tools: search_documents,         │
                │       /ask /documents     │               │        ask, list_sources, ...    │
                │ Bearer token auth         │               │ stdio + HTTP transports          │
                └───────────────────────────┘               └─────────────────────────────────┘
                              ▲                                                 ▲
                              │                                                 │
              ┌────────────────────────────┐                  ┌────────────────────────────────┐
              │ Human callers / your app   │                  │ Claude Desktop / IDE agents /  │
              │ (REST, OpenAPI clients)    │                  │ any MCP-capable client          │
              └────────────────────────────┘                  └────────────────────────────────┘

                                            ┌────────────────────────┐
                                            │ apps/worker            │
                                            │ ──────────             │
                                            │ pg-boss consumer       │
                                            │ runs runIngestion()    │
                                            └────────────────────────┘
                                                        ▲
                                                        │
                                              enqueued by apps/api
                                              or apps/mcp trigger_sync
```

## Internal package layers

Beyond the runnable `apps/*`, the workspace is layered so each cross-cutting concern has exactly one owner:

- **`@rag/core`** — contracts only: interfaces, the env-validated `Config`, shared validation (`filterSchema` + DoS caps), the constant-time token verifier, and the parser types **generated** from the Python sidecar's OpenAPI schema (`parser-types.generated.ts`, via `pnpm gen:parser-types`). Depends on nothing else in the workspace.
- **`@rag/runtime`** — the single composition root. `buildCoreDeps(config, logger)` wires `{ db, embedder, retriever, queue, generator, close }` once; all three apps call it and layer only their own extras (the worker adds parser/chunker/connector-factory). `close()` is the hardened, idempotent shutdown path shared by every surface.
- **`@rag/services`** — transport-agnostic business logic for the five operations (`searchDocuments`, `askQuestion`, `triggerSync`, `getDocumentById`, `listPublicSources`). HTTP routes and MCP tools are thin adapters that parse input, call a service, and format the response. `triggerSync` is the **sole writer** of `ingestion_jobs`.
- **`@rag/connectors`** — the four connectors share a `paginate()` loop + `makeCursorCodec()` (one base64-JSON cursor codec, one `done`-flag definition) instead of a base class.

This keeps the apps as thin I/O adapters and makes each invariant — one `ingestion_jobs` writer, one filter schema, one token verifier, one cursor codec — impossible to drift.

## Data flow: one document, end to end

1. **Trigger.** A `POST /sources/:id/sync` call or an MCP `trigger_sync` invokes `triggerSync()` in `@rag/services` — the **sole writer** of the `ingestion_jobs` history row. It creates exactly one `pending` row and enqueues a `rag.sync_source` job in pg-boss carrying that row's `ingestionId`. The worker only _transitions_ that row (`running` → `completed`/`failed`); it never creates one.
2. **Worker picks up.** A worker process running `apps/worker` polls pg-boss, claims the job, and constructs the right connector via `createConnector(source, env)`.
3. **Connector enumerates.** `connector.list({ cursor: source.cursor })` returns a page of `SourceDocument`s plus the next cursor. For Microsoft Graph this is a delta link; for Drive it's a page token; for Gmail it's a history id.
4. **Parser converts.** For each document, the TS worker POSTs the raw bytes to the Python sidecar's `/parse` endpoint. The sidecar tries MarkItDown first (fast, broad format support), falls back to Unstructured (slower, OCR-capable) on failure. Returns `{ markdown, title, tables, metadata }`.
5. **Hash check.** The worker SHA-256s the parsed markdown. If a row already exists for `(source_id, external_id)` with the same hash, ingestion short-circuits — no re-chunking, no re-embedding.
6. **Chunker slices.** `MarkdownChunker.chunk()` walks the markdown by headings, splits long sections by paragraph then sentence, and prepends each chunk with `# Title › heading path` (e.g., `# Budget › 2026 › Q1 Forecast`). Overlap is applied to the section body before the heading line is added, so every chunk opens with its heading. Markdown tables in prose documents split by whole rows under a repeated header. Computes a per-chunk SHA-256 hash.
7. **Embedder batches.** All chunks for the document go in one `embedder.embedBatch()` call. Gemini accepts up to 100 inputs per request; OpenAI up to 2048.
8. **Storage.** A transaction deletes existing chunks for the document and inserts the new set. A trigger on `chunks.text` populates the `tsvector` for BM25 search.
9. **Cursor commit.** After the whole page is processed, the worker persists the new cursor on the source row. A mid-page crash means re-processing that page (idempotent — see step 5), not losing it.

## Retrieval flow

```
POST /search { query, topK, filter }
                │
                ▼
   Retriever.search()
                │
                ▼
   embedder.embed(query)         ── one provider call
                │
                ▼
   hybridSearch(db, ...)         ── one SQL round-trip
   ┌──────────────────────┐
   │ WITH dense_hits AS   │      ── ANN on pgvector (HNSW)
   │ ( ... <=> ... )      │
   │ , sparse_hits AS     │      ── BM25-ish via ts_rank_cd
   │ ( ... @@ ... )       │
   │ , fused AS           │      ── Reciprocal Rank Fusion
   │ ( weights+ranks )    │
   │ SELECT ... LIMIT topK│
   └──────────────────────┘
                │
                ▼
   RetrievalResult[] with citations
```

For `/ask` (in `packages/services/src/ask.ts`), the pipeline stages are:

1. **Question screening** — TRI-screened before embedding (to avoid sending identifiers to embedding providers).
2. **Condensation** — If `history` is provided, a follow-up is rewritten into a standalone retrieval query via `contextualizeQuestion`; falls back to the original on any error.
3. **Retrieval** — Hybrid search with over-fetch to account for deduplication and per-document capping.
4. **Duplicate collapse** — Identical chunk bodies (ignoring heading lines) retained only once, preserving best rank.
5. **Per-document cap** — At most `N` chunks from any single source, for diversity.
6. **Relevance floor** (optional) — Chunks below `RETRIEVAL_MIN_DENSE_SIMILARITY` (off by default) are dropped; if none remain, a fixed refusal is returned without a model call.
7. **Neighbor expansion** — For the top documents, adjacent chunks are fetched to complete fragmented procedures.
8. **Per-chunk screening** — `Generator.screen()` removes context per TRI policy before generation sees it.
9. **Prompt + generation** — Retrieved chunks become numbered context blocks; the model is instructed to cite via `[N]` markers and to admit ignorance rather than hallucinate.
10. **Citations** — One `<document>` block and one citation per source document, carrying `chunkIds` (all chunks used), `modifiedAt` (if available), and other metadata. If the model stops at its output-token limit, the answer ends with a visible truncation notice.

`hybridSearch` retries a filtered query at the maximum pool size when it returns fewer than `topK` rows.

## Why these specific choices

### Postgres + pgvector for everything

We could have run a dedicated vector store (Pinecone, Weaviate, Qdrant, Milvus). We didn't, because:

- **One database.** Embeddings, documents, sources, ingestion history, and the job queue all live in the same Postgres instance. Backups, point-in-time recovery, and access controls are uniform.
- **SQL semantics on the vector store.** Want "all chunks from documents written by alice@example.com in the last 30 days"? It's a regular `WHERE` clause, not a vector-DB filter expression you have to read the docs for every time.
- **HNSW is enough.** pgvector's HNSW indexing is competitive with dedicated stores up to several million vectors. Past that, IVFFlat or moving the vector column to a separate read replica is a one-line change.

### pg-boss instead of BullMQ

The only reason to add Redis here would be the queue. pg-boss runs entirely on the same Postgres instance, supports at-least-once delivery, retries with backoff, singleton keys (dedupe), and cron. It's slower than BullMQ at thousands of jobs/second, but ingestion is bounded by the parser and embedding API, not by job throughput.

### Python sidecar for parsing

TypeScript has reasonable PDF/DOCX libraries (`pdf-parse`, `mammoth`), but the long tail — legacy `.doc`, scanned PDFs with OCR, complex Excel sheets with formulas — is materially better in Python. MarkItDown (Microsoft) and Unstructured cover the universe; reimplementing them in TS would be a year of work and inferior output. The sidecar runs in its own container, so heavy deps (LibreOffice, Tesseract, Poppler) don't bloat the TS runtime.

### Embedding provider — local ONNX (CPA default) or hosted APIs

The embedding layer is provider-agnostic: `EMBEDDING_PROVIDER` selects the backend; all providers return the same `number[]` type to the rest of the pipeline.

**`local` — `@huggingface/transformers` (ONNX runtime)**
Not the code default (`gemini` is), but **required** for any deployment handling regulated data — it is forced on under `COMPLIANCE_MODE=client-data`. All embedding computation runs on-process with zero network egress, which is what satisfies controls **CR-1** (no taxpayer-return-information disclosure) and **CR-3** (US-located vendor) in [`CPA-COMPLIANCE-REQUIREMENTS.md`](./CPA-COMPLIANCE-REQUIREMENTS.md#control-matrix-requirement--control--verify).

That guarantee covers **inference**, not model loading. Fetching the weights is an outbound call to huggingface.co; no document text is part of it (only the public model id), but it is egress, and `EgressPolicy` cannot police it — `@huggingface/transformers` calls the global `fetch` itself and accepts no custom one. Under `COMPLIANCE_MODE=client-data` the provider therefore sets the library's own `env.allowRemoteModels = false`, so a cold cache fails loudly instead of downloading. The cache must be pre-warmed.

- Default model: `Xenova/bge-base-en-v1.5` — 768-d, MTEB competitive, ~430 MB on first startup.
- Lazy-initialise: the ONNX pipeline downloads the model on first call and caches it to `HF_CACHE_DIR` (defaults to `~/.cache/huggingface`). Subsequent restarts read the cache; no download.
- First-startup warm-up: run `npx tsx scripts/warm-model.ts` during the Docker image build step to pre-warm the cache so the first live query doesn't time out. Under `COMPLIANCE_MODE=client-data` this is **mandatory, not an optimisation** — without a warm cache the first `embed()` fails rather than downloading.
- `embedQuery()` prepends the BGE query instruction prefix (`Represent this sentence for searching relevant passages:`) before encoding, which improves retrieval quality for asymmetric semantic search.
- Batch processing via `pipeline("feature-extraction")` — mean-pool + L2-normalise per chunk.

**`gemini` — Gemini Embedding API**
`gemini-embedding-001`, 768-d, US-region API. Requires `GEMINI_API_KEY`. _(Note: `text-embedding-004` is retired — always use `gemini-embedding-001`.)_

**`openai` — OpenAI text-embedding-3-small**
1536-d. Requires `OPENAI_API_KEY` and a column/index migration if switching from the 768-d default.

Swapping providers requires only an env var change (same dimensions) or a column-type migration + HNSW rebuild (dimension change). The `data_class` column tags every document at ingest so the compliance team can audit which provider touched which data class.

### Reciprocal Rank Fusion for hybrid search

Dense embeddings excel at semantic queries ("how do I cancel my subscription?"); sparse BM25 excels at keyword queries ("invoice 12345"). Pure dense misses identifiers, pure sparse misses paraphrases. RRF combines them by rank, not raw score, which means it's robust to the scale differences between cosine similarity (0–1) and `ts_rank_cd` (unbounded). The default mix is 70% dense / 30% sparse, tunable per query.

### Markdown-aware chunking

A naive recursive splitter happily slices through code fences and table rows. The markdown chunker:

- Splits by heading hierarchy into sections.
- Preserves code blocks as atomic units when they fit.
- Splits paragraphs only at blank lines.
- Prepends each chunk with its heading path (`# Configuration › Network › Timeouts`) so retrieved chunks carry the structural context the vector lost.

## Failure modes and what happens

| Failure                              | What the system does                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector token expired              | `ConnectorAuthError` thrown → job fails → pg-boss retries 3× with backoff → ingestion_jobs row marked failed. Operator rotates secret in env and re-enqueues.               |
| Source rate-limits (429)             | Connector throws `ConnectorTransientError` → job retried with backoff. Worker concurrency limits exposure.                                                                  |
| Parser sidecar down                  | `ParserError` thrown for every document on the page → job fails → retries. Restart sidecar, retry succeeds.                                                                 |
| Embedding API quota exceeded         | `EmbeddingError` thrown → job retried → eventually fails after `retryLimit: 3`. Operator either waits for quota reset or swaps providers.                                   |
| Worker crashes mid-page              | The page's cursor was not committed → next worker run re-enumerates the page. Content-hash dedupe means already-processed documents are no-ops.                             |
| Multiple workers process same source | pg-boss `singletonKey: sync:${sourceId}` prevents enqueuing duplicate sync jobs.                                                                                            |
| Embedding model dimensions change    | Required: re-type the `chunks.embedding` column, drop and rebuild the HNSW index, re-enqueue full sync for every source. Documented in `packages/db/drizzle/0000_init.sql`. |

## What this system is NOT

- **Not a chat platform.** It exposes search and grounded Q&A. Conversation memory, multi-turn refinement, and tool use beyond retrieval live in the consuming agent. (As of decision B0, `/ask` accepts bounded client-held `history` [max 12 turns, 4000 chars each] used only to rewrite a follow-up into a standalone retrieval query; generation still uses the original question. Server-side sessions remain future work.)
- **Source-scoped, but not a full ACL system.** Retrieval enforces a per-token **sourceId** access boundary (see `@rag/core` `access-control.ts`): a plain `API_TOKENS` token is an admin/all-access principal, while a token in `API_PRINCIPALS` is enforced to only its `allowedSourceIds` (empty set ⇒ zero results, fail-closed). Enforcement is mandatory inside `Retriever.search`/`hybridSearch` and cannot be bypassed from the route layer; the optional caller `sourceIds` filter can only narrow _within_ the enforced scope. This is coarse-grained (per-source), not per-document or per-field — for finer-grained or per-end-user authz, wrap retrieval with your own layer.
- **Reranking ships, but is off by default.** Prerequisites A2–A4 are complete: Jina requests send `return_documents: false` (A2), the provider score is carried as `rerankScore` (A3), and a hosted reranker is refused under `COMPLIANCE_MODE=client-data` (A4). `Retriever.search` takes an optional `rerank` option: it over-fetches `poolMultiplier × topK` candidates, hands them to a `Reranker`, and degrades to plain RRF order (without failing the query) if the reranker errors. `HttpCrossEncoderReranker` speaks the Cohere/Jina REST shape. It is disabled by configuration — `RERANK_PROVIDER` defaults to `none` — **not absent**. Enabling requires a vendor/DPA decision and a gold-set gain measurement. Enable it with `RERANK_PROVIDER`/`RERANK_MODEL`/`RERANK_API_KEY` rather than building one.
- **Not a generation framework.** The `/ask` endpoint does a single-shot RAG generation. For chain-of-thought, query decomposition, agentic tool use, or multi-hop reasoning, build that in your app on top of `/search`.
