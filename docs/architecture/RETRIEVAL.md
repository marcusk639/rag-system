---
title: Retrieval and the /ask pipeline
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: How hybrid search ranks and filters chunks, how the retriever and optional reranker work, the /ask stages in order, and how chunking and embeddings shape what retrieval sees.
read_when: Changing hybrid search, RRF weights, pool sizes, reranking, /ask context assembly, chunking or the embedding provider; or debugging a missing or wrong answer.
supersedes: [RAG-ARCHITECTURE-GUIDE.md]
code:
  [
    packages/db/src/hybrid-search.ts,
    packages/db/src/hnsw.ts,
    packages/rag/src/retrieval/retriever.ts,
    packages/rag/src/retrieval/reranker.ts,
    packages/services/src/ask.ts,
    packages/rag/src/embeddings/local.ts,
  ]
---

# Retrieval and the `/ask` pipeline

Retrieval is one SQL statement. It fuses an HNSW dense arm with an OR-semantics full-text sparse
arm using weighted Reciprocal Rank Fusion (`k = 60`, dense 0.7, sparse 0.3). The access-control
list and the withdrawal gate are applied inside both candidate arms, so a chunk the caller can't
read never takes a slot. `/ask` wraps that in a fixed sequence:

1. screen the question;
2. condense follow-ups (for retrieval only);
3. over-fetch;
4. collapse duplicates;
5. cap chunks per document;
6. apply the optional relevance floor;
7. expand neighbours;
8. screen the context;
9. generate, with `[N]` citations and a draft label set server-side.

This file is the retrieval half of [`ARCHITECTURE.md`](./ARCHITECTURE.md), split out for size. The
reasons behind the design are in [`DECISIONS.md`](./DECISIONS.md). Measured retrieval quality is in
[`../evaluation/EVALUATION.md`](../evaluation/EVALUATION.md). Any change here needs `pnpm eval` before
it ships (see `.claude/rules/tdd.md`).

## Hybrid search

`hybridSearch` (`packages/db/src/hybrid-search.ts`) is one statement with these CTEs:

- **`params`** holds the query embedding and an OR-semantics `tsquery`.
  - The query is lexed with `tsvector_to_array(to_tsvector('english', q))`, each lexeme is wrapped
    with `quote_literal`, and the lexemes are joined with `|` inside `to_tsquery('english', ...)`.
  - Pasted URLs and operator characters can't break the parse.
  - A query made only of stop words falls back to a tsquery that never matches.
- **`dense_hits`** keeps only chunks whose `embedding_provider` and `embedding_model` match the
  active embedder, so vectors from different models are never compared. It orders them by `<=>`
  with `LIMIT pool`. The score is `1 - cosine distance`.
- **`sparse_hits`** matches `tsv @@ q`, ranks by `ts_rank_cd` and applies `LIMIT pool`. Its scores
  are not normalized.
- **`fused`** is a `FULL OUTER JOIN` on chunk id.
  - Each chunk scores `wDense/(k + denseRank) + wSparse/(k + sparseRank)`, with `k = 60`. A missing
    rank counts as 1,000,000.
  - The weights default to `HYBRID_DENSE_WEIGHT` (0.7) and `HYBRID_SPARSE_WEIGHT` (0.3), and a
    query can override them.
  - Final scores are divided by the maximum, so the best result scores 1.0.
  - `keyword_coverage`, the share of query lexemes a chunk contains, is computed for the final rows
    only.

### Filter placement

Two filters are mandatory. They run **inside both candidate CTEs**, before `LIMIT pool`, as an
`EXISTS` subquery on `documents` (`mandatoryPreFilter`):

- `lifecycle_status = 'active'`, the withdrawal gate;
- the enforced source-id list, which is the ACL.

So a chunk the principal can't read, or one from a withdrawn document, never takes a candidate
slot. The final `SELECT` applies both again as a backstop.

This replaced the earlier "filters only in the final SELECT" design on 2026-10-03. The cost is that
the filtered dense arm may no longer be served purely by the HNSW index, so the planner may choose
a sequential scan. At the current corpus size that is the faster plan.

pgvector 0.8 added `hnsw.iterative_scan` for exactly this tradeoff. Adopting it waits on confirming
which pgvector version runs in production. UNVERIFIED: the pgvector version in the production
`postgres-ssl` image (settle with `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
on `rag-postgres`).

The optional caller filters still run after fusion. These are `sourceIds` and the metadata
filter. Metadata filters are rewritten as `@>` containment, built with `jsonb_build_object`, so
the GIN index on `documents.metadata` can serve them.

If a filtered query returns fewer than `topK` rows, it retries once at the maximum pool. A query
with no caller filter never retries.

### Pool and `ef_search`

From `packages/db/src/hnsw.ts`:

- `resolveCandidatePool(topK, multiplier)` returns `max(topK, min(topK × 8, 1000))`. The default
  multiplier is `candidatePoolMultiplier` 8.
- `resolveEfSearch(pool, override)` returns `min(1000, max(40, override ?? 100, pool))`. It is
  applied with `SET LOCAL hnsw.ef_search` inside the query's transaction.
- `ef_search` must be at least the pool size. An HNSW scan returns at most `ef_search` rows, so a
  smaller value would silently cut the dense arm short.

### Guards

- A non-finite (`NaN`/`Infinity`) query embedding throws a clear error instead of pgvector's opaque
  syntax error.
- An empty enforced scope returns `[]` before any SQL runs.

## Retriever and reranking

`Retriever.search(query, authz)` (`packages/rag/src/retrieval/retriever.ts`):

- `authz` is a required positional argument. The caller's optional `sourceIds` is intersected with
  the enforced set (`effectiveSourceFilter` in `@rag/core`), so a caller filter can only narrow.
- The query is embedded with `embedQuery` when the provider supports it, which applies the
  query-side task type or prefix. Otherwise it falls back to `embed`.
- It calls `hybridSearch` with the result.

**Reranking ships but is off.** `RERANK_PROVIDER` defaults to `none`.

- The supported providers are `cohere` (default model `rerank-v3.5`) and `jina` (default model
  `jina-reranker-v2-base-multilingual`). Both go through `HttpCrossEncoderReranker`. Setting `llm`
  throws "not yet implemented".
- With a reranker on, the retriever fetches `RERANK_POOL_MULTIPLIER × topK` candidates (default 5)
  and returns the reranked top `topK`.
- The provider's score is carried as `rerankScore`, and the RRF `score` is kept.
- Jina is sent `return_documents: false`.
- If the reranker errors, the query returns plain RRF order and logs a warning. It does not fail.
- `createReranker` refuses every hosted reranker under `COMPLIANCE_MODE=client-data`, because the
  reranker would send document text to a vendor.

Turning reranking on needs a vendor and DPA decision and a measured gain on the gold set. Both are
open in [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).

## The `/ask` pipeline

`askQuestion` and `askQuestionStream` (`packages/services/src/ask.ts`) run these stages in order:

1. **Screen the question.** `generator.screen(question, [])` runs under the TRI policy **before**
   anything is embedded, so a question carrying an identifier never reaches the embedding API. A
   blocking match throws `ComplianceError`.
2. **Condense follow-ups.** This happens only when `history` is present. History is limited to
   `MAX_HISTORY_TURNS` (12) turns of `MAX_HISTORY_TURN_CHARS` (4000) each
   (`packages/core/src/validation.ts`).
   - `contextualizeQuestion` rewrites the follow-up as a standalone query, and the rewrite is
     screened again.
   - If the rewrite fails or is blocked, retrieval uses the original question.
   - The rewrite is used **for retrieval only**. Generation always answers the original question.
3. **Retrieve with over-fetch.** Call `Retriever.search` with `topK × 3`
   (`CAP_OVERFETCH_MULTIPLIER`). `topK` defaults to `DEFAULT_TOP_K` (12).
4. **Collapse duplicates.** `dropDuplicateChunks` keeps the best-ranked copy of identical chunk
   bodies. It ignores the `# Title › heading` first line and normalizes whitespace and case,
   because the same SOP is often stored as several files.
5. **Cap per document.** `capChunksPerDocument` keeps at most `MAX_CHUNKS_PER_DOCUMENT` chunks
   from each document (default 3), then cuts the list to `topK`.
6. **Apply the relevance floor (optional).** `applyRelevanceFloor` drops a chunk whose dense
   similarity is below `RETRIEVAL_MIN_DENSE_SIMILARITY` (unset means the floor is off). A chunk is
   kept anyway if its keyword coverage is at least `MIN_KEYWORD_COVERAGE` (0.5), because
   identifiers and form numbers score low on cosine similarity by nature.
7. **Expand neighbours.** `expandWithNeighbors` adds up to `NEIGHBOR_EXPANSION_CHUNKS` (4) adjacent
   chunks for each of the top `NEIGHBOR_EXPANSION_DOCUMENTS` (2) documents, so a procedure split
   across chunks reaches the model whole.
   - Added chunks carry zero scores.
   - Only documents already in scope are expanded.
   - If expansion fails, the unexpanded results are used.
8. **Screen the context.** `generator.screen(question, retrieved)` removes context that the TRI
   policy forbids sending. Everything after this step uses the screened list, so each `[N]` the
   model writes points at a document it was actually shown.
9. **Short-circuit when empty.** If nothing is left, return the fixed `EMPTY_ANSWER` without
   calling the model.
10. **Generate.** Chunks become numbered `<document>` blocks, escaped as untrusted data
    (`packages/rag/src/generation/prompt-context.ts`).
    - `modified=` is a date that is shape-checked, not escaped.
    - The model must cite with `[N]`.
    - If the model stops at its output-token limit, the answer ends with a visible truncation
      notice.
11. **Build citations.** `buildCitations` makes one citation per document. `chunkIds` lists every
    chunk in that document's block, in reading order. `filterCitationsToAnswer` keeps only the
    indices the answer actually cites, and understands grouped forms such as `[1, 2]` and `[1-3]`.
12. **Label the answer.** `reviewStatus` (`draft_requires_practitioner_review`), `disclaimer` and a
    fresh `answerId` are set by the server. The API route writes the `audit_log` row asynchronously.
    Feedback refers to the answer by `answerId`.

`/ask` is single-shot RAG. Prompt rules and the TRI policy values (`block`, `warn`, `off`) are in
[`../compliance/CONTENT-SAFETY-DESIGN.md`](../compliance/CONTENT-SAFETY-DESIGN.md). Request limits
and the streaming event contract are in [`../reference/API.md`](../reference/API.md).

## Chunking

`CompositeChunker` (`packages/rag/src/chunking/`) sends prose to `MarkdownChunker` and sheets to
`TableChunker`.

- **Sizes.** The defaults are `CHUNK_SIZE` 800 tokens and `CHUNK_OVERLAP` 120. With the local
  provider the size is capped (see [`CLAUDE.md`](../../CLAUDE.md)).
- **Markdown.**
  - Text is split by heading hierarchy, then by paragraph, then by sentence.
  - Code blocks stay whole when they fit.
  - Every chunk starts with `# Title › heading path`. The overlap is applied to the body before that
    line is added, so each chunk opens with its heading.
  - Markdown tables inside prose are split on whole rows, and the header row is repeated.
- **Tables.**
  - Row groups repeat the header row.
  - `financial_model` sheets stay whole.
  - `freeform` sheets fall back to markdown.
  - The sheet types come from the parser's classifier (see
    [`ARCHITECTURE.md`](./ARCHITECTURE.md#parser-sidecar)).

## Embeddings

`EMBEDDING_PROVIDER` selects a provider from `packages/rag/src/embeddings/factory.ts`.

| Provider | Default model                    | Dims | Notes                                                                                                                                      |
| -------- | -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `gemini` | `gemini-embedding-001`           | 768  | The code default. Up to 100 inputs per batch. Uses separate query and document task types. `text-embedding-004` is retired.                |
| `local`  | `Xenova/bge-base-en-v1.5` (ONNX) | 768  | Runs in-process, so inference has no egress. The only provider allowed under `COMPLIANCE_MODE=client-data`. Mean-pooled and L2-normalised. |
| `openai` | `text-embedding-3-small`         | 1536 | Up to 2048 inputs per batch. Needs the `vector(768)` column changed, or `EMBEDDING_DIMENSIONS=768`.                                        |

- `defaultEmbeddingModel(provider)` in `packages/core/src/config.ts` is shared by `loadConfig` and
  `scripts/warm-model.ts`, so a warmed cache always matches the model the runtime requests.
- The Gemini and OpenAI providers retry 429 responses with bounded exponential backoff (`retry.ts`).
  The backoff honours both `Retry-After` and Google's `RetryInfo` error detail.
- Requests are paced with a fixed minimum interval (`throttle.ts`), so a large document's batch
  calls don't trip a per-minute limit.

### Local provider

From `packages/rag/src/embeddings/local.ts`:

- **Query prefix.** `embedQuery` prepends
  `Represent this sentence for searching relevant passages: `.
- **Model download is egress.** Loading the weights (~430 MB) is an outbound call to
  huggingface.co. `EgressPolicy` can't intercept it, because the library calls the global `fetch`
  itself. So under `client-data` the provider sets `env.allowRemoteModels = false`, and a cold
  cache fails loudly instead of downloading.
- **The `HF_CACHE_DIR` gotcha.** If `HF_CACHE_DIR` is unset, the library caches inside its own
  installed package directory. Under pnpm that is below `node_modules/.pnpm/`, not
  `~/.cache/huggingface`. That cache does not survive a multi-stage image copy or a
  production-only reinstall. Under `client-data` the constructor throws unless `HF_CACHE_DIR`
  names a durable path.
- **Warm cache in images.**
  - The api, mcp and worker Dockerfiles `COPY` a pre-warmed cache from the `rag-warm-base` image,
    pinned by digest.
  - That image is built from `docker/Dockerfile.warm-base` by `.github/workflows/warm-base.yml`.
  - Its build fails unless `scripts/warm-model-verified.sh` leaves a populated cache.
  - Only non-Docker or mounted-volume deployments need to warm the cache by hand. The command is
    in [`CLAUDE.md`](../../CLAUDE.md).

### Changing the model

Embeddings can't be reused across a change of provider, model or dimension.

1. If the dimension changes, re-type the `chunks.embedding` column and drop and rebuild the HNSW
   index. The commented statements are in `0000_init.sql`.
2. Re-embed every chunk (`scripts/reembed-chunks.ts`).

Done when: `assertEmbeddingDimensions` passes at startup, and dense search returns results for the
new model. It blocks startup whenever the configured dimension doesn't match the column.
