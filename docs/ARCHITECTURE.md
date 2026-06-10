# Architecture

This document explains how the RAG system fits together, why each piece exists, and the design tradeoffs that shape it.

## System diagram

```
                         ┌──────────────────────┐
                         │  Connectors          │
                         │  ─────────────       │
                         │  • SharePoint        │
External       ────────► │  • Google Drive      │ ──────┐
sources                  │  • Gmail             │       │
                         │  • Outlook           │       │
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
6. **Chunker slices.** `MarkdownChunker.chunk()` walks the markdown by headings, splits long sections by paragraph then sentence, prepends each chunk with its heading path, and computes a per-chunk SHA-256 hash.
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

For `/ask`, the retrieved chunks become numbered context blocks in a prompt to Gemini/OpenAI; the model is instructed to cite via `[N]` markers and to admit ignorance rather than hallucinate.

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

### Gemini text-embedding-004 as default

Free tier, 768 dimensions, MTEB scores within a few points of `text-embedding-3-small`. The architecture is provider-agnostic — swap to OpenAI/Voyage/local with one env var change (and a column-type migration if dimensions change).

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

- **Not a chat platform.** It exposes search and grounded Q&A. Conversation memory, multi-turn refinement, and tool use beyond retrieval live in the consuming agent.
- **Not a permission/ACL system.** All documents in the corpus are searchable by anyone with an API token. If you need per-user access control, wrap retrieval with your own authz layer that filters `sourceIds` based on the calling user.
- **Not a reranker by default.** A cross-encoder reranking step would improve precision-at-k; the architecture has a clear extension point (in `Retriever.search`) but no shipped implementation. Add Cohere Rerank or `cross-encoder/ms-marco-MiniLM` when you need it.
- **Not a generation framework.** The `/ask` endpoint does a single-shot RAG generation. For chain-of-thought, query decomposition, agentic tool use, or multi-hop reasoning, build that in your app on top of `/search`.
