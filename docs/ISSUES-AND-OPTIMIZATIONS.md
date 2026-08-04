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

### ✅ C2 — Python parser sidecar shared-secret authentication `[resolved 2026-06-13]`

Port is bound to `127.0.0.1` (good), but `POST /parse` accepted arbitrary binaries into MarkItDown/LibreOffice/Unstructured/Tesseract with no auth. Loopback binding is adequate for single-host dev; **any networked deployment (separate parser container/host, k8s) re-exposed it.**
**Fix shipped:** opt-in shared-secret auth keyed on `PARSER_SECRET`.

- `require_parser_token` FastAPI dependency (`services/parser-py/app/main.py`) guards `/parse`: when `PARSER_SECRET` is set, every request must carry a matching `X-Parser-Token` header (constant-time `hmac.compare_digest`); when unset/blank, no auth is enforced (loopback-only dev). `/health` stays open for probes.
- `HttpParserClient` (`packages/rag/src/parser/parser-client.ts`) takes an optional `secret` and sends the header when configured.
- Threaded through `config.parser.secret` (`@rag/core` Zod schema ← `PARSER_SECRET`) into both construction sites (`apps/worker/src/deps.ts`, `tests/e2e/src/helpers/ingestion.ts`).
- Wired into `env.example`, `docker/docker-compose.yml` (`PARSER_SECRET: ${PARSER_SECRET:-}`), and the e2e config.
- Tests: 6 pytest cases (`services/parser-py/tests/test_auth.py`, run in-container) covering unset/blank-secret bypass, missing/wrong/correct token, and `/health` always-open; 3 vitest cases (`parser-client.test.ts`) asserting the client's header behavior. Dev-only test deps in `requirements-dev.txt`.

---

## 2. High

### 🔴 C3 — `run-real-eval.ts` truncates the database; a TWK gold-set runner must not be copied from it

**Raised 2026-08-01.** `tests/e2e/src/eval/run-real-eval.ts:108` calls
`truncateAll(db)`, which executes
`TRUNCATE TABLE chunks, documents, ingestion_jobs, sources RESTART IDENTITY CASCADE`
(`tests/e2e/src/helpers/db.ts:21`).

**That is correct where it is.** The runner seeds its own synthetic corpus and
needs a clean slate. **The hazard is what happens next:** the TWK gold-set runner
(C4 below) must query the **real, already-indexed** corpus — and the obvious way
to write it is to copy the only existing real-embedder runner and change the
question source. **Doing that and pointing it at production destroys the index**
(currently ~858 documents), and the failure is silent until someone asks a
question and gets nothing.

**Recommendation:** a TWK runner must never truncate, never seed, and should open
a **read-only** connection so the mistake is impossible rather than merely
discouraged. Add an explicit guard — refuse to run if the target database is not
the test database — and a comment on `truncateAll` naming this hazard at the
definition site, not just at the call site. **Effort:** S. **Value:** high — this
is a data-loss class, not a quality one.

### 🔴 C4 — `pnpm eval:twk` is documented but does not exist

**Raised 2026-08-01.** `tests/e2e/src/eval/twk-gold-set.ts:32` instructs the
reader: _"Append entries below. Nothing else in the harness changes — `pnpm
eval:twk` picks them up automatically and refuses to run while the set is
empty."_ **No such script is defined in any `package.json`.** The only eval
scripts are `eval` (vitest specs, FakeEmbedder) and `eval:real`
(`run-real-eval.ts`, synthetic corpus).

**Why it matters more than a missing npm alias normally would.** That sentence is
the handoff instruction at the end of a carefully-built gold-set schema. Whoever
completes the CPA gold-set session will follow it, find nothing, and either give
up or — worse — reach for `eval:real`, which measures a **different, synthetic
corpus** and would report healthy numbers that say nothing about the real KB.

**What it must do:** load `TWK_GOLD_QUESTIONS`, run `validateGoldSet` and refuse
on any issue, refuse on an empty set, query the **production** index read-only
(see C3), score retrieval (`metrics.ts`) plus faithfulness (`faithfulness.ts`) for
`tier1-automatable` questions, and **report `tier2-cpa-verified` questions as
routed-for-review rather than scoring them**. **Effort:** M.

### 🟠 H1b — No corpus enumeration helper (blocks corpus-grounded eval)

**Raised 2026-08-01.** `packages/db/src/queries.ts` has `getDocument` (by id) but
no `listDocuments`. There is no way to walk the indexed corpus, which the
corpus-grounded ground-truth design (`docs/EVAL-CORPUS-GROUND-TRUTH.md`) needs:
it reads `external_id, title, source_modified_at, content` across documents to
extract checkable claims.

**Small, but it must be read-only.** See **C3** — the only existing real-embedder
runner truncates the database, so anything written against production needs a
read-only connection and no `truncateAll`/`seedEvalCorpus` anywhere near it.

**Value beyond the eval:** the same pass is the client-identifier review ISS-05
calls "the real gate" — confirming none of the ~858 indexed documents carries
client-identifying material. That is currently classified internal-only _by
default, not because anyone checked_. Build the screen into the first pass;
retrofitting it costs a second full read of the corpus. **Effort:** S.

### 🟠 H0 — Citations carry no last-modified date (blocks the TWK "index as-is" decision)

**Raised 2026-08-01**, when TWK decided to index its SharePoint knowledge base **as it currently exists** rather than wait for a cleanup pass with no owner and no date. That decision is sound — the bot's retrieval and gap logs become a far better cleanup queue than working through folders alphabetically — but it puts **superseded documents in the index alongside current ones**, and the system has no way to distinguish them.

**Why the citation is the right place to fix it.** A person browsing SharePoint sees the folder, the modified date, and the near-duplicates beside a file, and hesitates. A citation reads as authoritative. Under Circular 230 §10.35 the citation is the entire basis of the defensibility argument, so a citation to a 2019 procedure is worse than no answer — it manufactures confidence instead of prompting a check.

**This is nearly free, which is the point.** Everything needed is already in place:

- The SharePoint connector already captures `lastModifiedDateTime` and `lastModifiedBy` into document metadata (`packages/connectors/src/sharepoint/index.ts:335-337`), and `documents.source_modified_at` is a column.
- `hybridSearch` already selects `doc.metadata` (`packages/db/src/queries.ts:587`), so it already travels with every `RetrievalResult` — `RetrievalResult.document.metadata` is typed `DocumentMetadata`.
- **The only gap is `buildCitations`** (`packages/rag/src/generation/generator.ts:101-108`), which projects each result down to `{index, title, url}` and drops everything else.

**Recommendation:** widen the citation shape to carry `modifiedAt` (and `modifiedBy` where present), surface it in the API/MCP citation payload, and render it in the chat UI. Consider also passing the date into the `<document>` context block so the model can say "note this procedure is from 2019" in the answer body — but **do not** let the model infer currency or suppress older documents on its own: that silently hides documents that may be the right answer, and it cannot be defended when it gets one wrong. **A visible date beats a clever guess.**

**Effort:** S. **Value:** high — it is the difference between a dated KB being usable and being a liability.

**Related, same decision, config-only:** scope the TWK source to named `driveId`/`folderPath` values rather than the whole site. Both config keys already exist in the SharePoint connector.

### 🟠 H1 — No reranking stage (largest retrieval-quality gap) ⚠ **likely stale — verify before actioning**

> **2026-08-01:** this entry appears to predate the reranking implementation. `packages/rag/src/retrieval/reranker.ts` now ships `HttpCrossEncoderReranker` (Cohere/Jina-shaped REST), and `Retriever` takes an optional `rerank` option that over-fetches `poolMultiplier × topK` and degrades to RRF order on reranker failure — which is what this entry asks for. Confirm and close rather than re-implementing.

`Retriever.search` (`packages/rag/src/retrieval/retriever.ts:29`) returns the RRF-fused top-K **directly** to the generator. Hybrid RRF is a strong _candidate generator_, but the single highest-ROI improvement in modern RAG is a **rerank** pass over the candidate pool before it reaches the LLM. The infrastructure is already shaped for it: `hybridSearch` over-fetches an 8× pool (`packages/db/src/queries.ts:221`) and then truncates to `topK` by RRF score — that pool is exactly what a reranker should consume.

**Recommendation:** add a `Reranker` interface in `@rag/core` and an optional rerank step:

- Retrieve `poolK` (e.g. 50–100) via hybrid search → rerank → keep top `topK` (e.g. 5–8).
- Provider options: **Cohere Rerank 3**, **Voyage rerank-2** (Anthropic-ecosystem aligned), or a local cross-encoder (`ms-marco-MiniLM`) for the no-API-cost path — mirror the existing `EmbeddingProvider` factory pattern so it's swappable.
- Expected effect: cross-encoder reranking typically lifts answer-relevant precision substantially over fusion-only pipelines; it is the standard "next step" after hybrid search.
  **Effort:** M. **Value:** very high. This is the #1 RAG-quality win.

### ✅ H2 — Metadata filter is a guaranteed full scan (RESOLVED) `[review:H3]`

**Original concern:** the metadata post-filter built `doc.metadata->>'key' IN (...)`. The shipped GIN `jsonb_ops` index (`0001_documents_metadata_gin.sql`) only accelerates `?`/`@>`/`@@` — **not** `->>` text equality — so every metadata-filtered query scanned all documents.

**Current state (2026-07-09):** `hybridSearch` (`packages/db/src/queries.ts`) now builds `metadata @> jsonb_build_object(key, value)` containment conditions instead, which the existing GIN index does accelerate — confirmed via `EXPLAIN ANALYZE` with `enable_seqscan=off`: the old `->>` shape produced a forced `Seq Scan` with no viable index path at all, the new `@>` shape produces a `Bitmap Index Scan` on `documents_metadata_gin_idx`. Also fixed a real correctness edge case introduced by the rewrite: `@>` is type-sensitive (`{"k":"5"}` doesn't contain `{"k":5}`), so a caller filtering on a numeric metadata field (e.g. `sizeBytes`) by its string form — which the old `->>` text-coercion matched — would silently stop matching; the fix tries the filter value as both a string and (when it parses as one) a JSON number, still fully index-backed via Postgres's `BitmapOr`. `metadataFilter` previously had zero test coverage anywhere in the repo; added `tests/e2e/src/specs/metadata-filter.spec.ts` covering single-value, multi-value (OR), multi-key (AND), no-match, and the numeric edge case.

### 🟠 H3 — No startup guard that embedding dimensions match the `vector(768)` column `[review:M7 — promoted]`

`chunks.embedding` is hardcoded `vector(768)` for Gemini (`schema.ts:151`). Switching `EMBEDDING_PROVIDER=openai` (1536-dim) without altering the column fails **only at first insert — after embedding credits are already spent** and a sync is half-done. The system is explicitly "provider-pluggable," which makes this trap easy to hit.
**Fix:** at startup assert `config.embedding.dimensions === <column dimensions>` (read from a constant or `information_schema`). Promoting from the audit's Medium because the pluggability is a headline feature and the failure mode wastes money + leaves partial state.

### ✅ H4 — Unvalidated external-boundary casts (RESOLVED)

**Original concern:** three casts turned runtime data into lies the type system believed — a malformed parser response, a `source.kind as never` defeating exhaustiveness, and a `mcp-session-id` header cast dropping the `string[]` case.

**Current state:** all three now validate instead of cast. `packages/rag/src/parser/parser-client.ts:60` uses `ParsedDocumentSchema.safeParse(raw)`, throwing a `ParserError` on a malformed sidecar response instead of trusting it. `apps/worker/src/deps.ts:123` uses `SourceKind.parse(source.kind)`. `apps/mcp/src/transports/http.ts`'s `normalizeSessionId` does `Array.isArray(raw) ? raw[0] : raw`, with a code comment explaining exactly why the cast was wrong.

### ✅ H5 — No rate limiting on API or MCP (RESOLVED) `[review:H9]`

**Original concern:** `POST /ask` triggers an embedding + LLM call per request; an unbounded loop from any valid token drains quota and saturates the DB pool.

**Current state:** `@fastify/rate-limit` is registered globally in `apps/api/src/server.ts`, with tighter per-route limits on `/ask` (10/min) and `/sources/:id/sync`/`DELETE` (6/min). See §9 for the full CPA-blocker write-up.

### ✅ H6 — `express@4`/`@types/express@5` mismatch (RESOLVED) `[review:H4]`

**Original concern:** `apps/mcp` ran Express 4 at runtime but type-checked against Express 5 signatures — runtime mismatches in `http.ts` wouldn't be caught by `tsc`.

**Current state:** `apps/mcp/package.json` now pins `express@^5.2.1` and `@types/express@^5.0.0` — both major version 5, confirmed against the resolved lockfile version, not just the package.json range.

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

> **Process note:** this section is a point-in-time audit, not a static snapshot — revisit it whenever a PR referenced below merges or a listed item's real-world status changes (e.g. a DPA gets signed/renewed). The 2026-06-07 version of this section described P1/P2/H5 as unresolved for weeks after the code that resolved them had already shipped; that gap is exactly the confusion this note exists to prevent.
>
> ⚠ **Broken citation, corrected 2026-08-03.** This note previously cited `docs/RAG-VALIDATION-REPORT.md` (2026-07-06) as "the verification pass that caught the drift." **That file has never existed in this repository** — `git log --all` finds no trace of it. The drift it describes is real and is independently documented in [`TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md`](./TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md) §3, which should be read instead.

This system is being stood up over a **CPA firm's** corpus — SharePoint engagement files, and Gmail/Outlook mailboxes that contain client tax data. That changes the risk profile entirely: the documents being embedded are **taxpayer return information** and client-confidential records, and the people who can query them are not all entitled to see every client. These were originally written as go/no-go blockers with none of the required controls in place; as of 2026-07-08, P1/P2/H5 are resolved and P3/P4 are partially resolved — see each item below for what's still open.

### ✅ P1 — Access control (RESOLVED)

**Original concern:** any API token could read the entire corpus (`ARCHITECTURE.md:160`'s "not a permission/ACL system"), with no per-user identity or enforced `sourceId` boundary on `/search`/`/ask`.

**Current state:** `hybridSearch`'s `WHERE` clause enforces `enforcedSourceIds` as a mandatory condition (not the optional caller-supplied filter) — the code's own comment calls it out as "MANDATORY ACL filter... load-bearing correctness, not just a convenience." `AuthorizationScope`/`Principal` exist in `@rag/core` and are threaded through every retrieval call; any authentication ambiguity fails closed (deny-all), never admin. The web app also now has real per-user authentication (Entra ID via `InternalScopeAuthProvider`, PR #31) resolving per-user `sourceId` scope through `resolveSourceIdsForUser`, closing the gap this item's fix left open for the browser UI specifically.

### ✅ P2 — Metadata PII exposure (RESOLVED)

**Original concern:** `DocumentMetadata`'s `author`/`from`/`to[]`/`subject` fields flowed to every caller on every retrieval hit with no redaction.

**Current state:** `packages/core/src/metadata-policy.ts`'s `sanitizeMetadata`/`sanitizeRetrievalResult` strip PII-risky fields before any response crosses the API boundary.

### ✅ P3 — Third-party LLM disclosure (IRC §7216 / Circular 230) — RESOLVED

**Original concern:** embedding/generation sends client tax-return content to third-party providers (Gemini/OpenAI) with no gating, classification, or audit trail — a §7216 disclosure exposure.

**Current state:**

- **A signed data-processing agreement is now in place with the LLM provider** — the operational precondition this item was gating on.
- `COMPLIANCE_MODE=client-data` refuses to boot without a signed DPA file on disk — the code-level gate has teeth, not just a doc comment.
- `EGRESS_ALLOWED_HOSTS` can block all external embedding/generation calls entirely, making the on-device `EMBEDDING_PROVIDER=local` path a real, exercised option.
- A per-source `dataClass` (`general | research | sop | client_confidential`) gates ingestion: `client_confidential` sources are mapped to the pipeline's Class D and **blocked outright** by `ClassBlockedError` (`packages/ingestion/src/classify-source.ts`, wired into `handleSyncSource` as of 2026-07-08 — this enforcement wiring was itself a gap until this session).
- **Disclosure audit trail for §10.22 recordkeeping (2026-07-09):** `audit_log` now has `embedding_provider`/`embedding_model` columns, populated on every `/ask` and `/search` call (both endpoints always embed the query — `/search` has no generation model but still discloses the query text to the embedding provider, which the old `model`-only field never captured). `apps/api/src/deps.ts` and `apps/mcp/src/deps.ts` both expose `embedder` from `CoreDeps` for this.
- **A larger, previously-undiscovered gap closed in the same pass:** MCP's `ask`/`search_documents` tools — the "agent-facing surface" per root CLAUDE.md, and per `docs/CPA_Firm_Operations_Consultant_Briefing.md` likely the dominant real-usage channel (Teams bot) — wrote **no `audit_log` row at all**, not just an incomplete one. Both tools now call the same `logAskEvent` the HTTP routes use, with `channel: "mcp"`. Known remaining limitation: `AuthorizationScope` (unlike the HTTP route's `Principal`) doesn't carry `subject`, so MCP rows have `principal_subject: null` — wiring per-user subject through the MCP transport layer (`http.ts`'s `scopeForRequest` currently discards the resolved `Principal` down to just an `AuthorizationScope` before it reaches tool handlers) is a separate, larger change than adding the audit trail itself; worth a follow-up.

### 🟡 P4 — Encryption-at-rest & retention/deletion (PARTIALLY RESOLVED, remainder deliberately deferred)

**Original concern:** no application-level encryption of sensitive columns, and ingestion only ever upserts with no way to purge a client's data.

**Current state:** `DELETE /sources/:id` + `purgeSource` now exist and cascade through documents/chunks/jobs/embeddings — the disposal half of a retention policy.

**Deliberately deferred (2026-07-09), not silently skipped:**

- **Column-level encryption for `documents.content`/`chunks.text`:** relies on the managed Postgres provider's disk/volume encryption (`docs/DEPLOYMENT.md` recommends Neon/Supabase/RDS — verify encryption-at-rest is actually enabled for whichever one a given deployment uses; this is an operational setting the code can't assert). Application-level column encryption was evaluated and explicitly NOT pursued this pass: it would break `hybridSearch`'s full-text (`tsvector`/GIN) search on encrypted content without a much larger redesign (searchable encryption, or decrypt-then-search which defeats the point), plus real key-management/rotation infrastructure this repo has no precedent for. Worth a dedicated design pass if a client's threat model specifically requires it, not a quick addition.
- **`audit_log` retention policy (deferred 2026-07-31 — explicit decision, "get something working first"):** distinct from the source/document purge above, which does **not** touch `audit_log`. Nothing deletes audit rows, so the Circular 230 §10.22 requirement that the trail _exist_ is satisfied by construction — the gap is that "how long do you keep it?" currently answers "forever, because nothing removes it," which is an implementation accident rather than a stated policy. **The build is small and the schema is already right for it:** `audit_log.created_at` exists with `audit_log_created_idx` on it, so a windowed purge is one indexed `DELETE` plus a scheduler entry (pg-boss is already the job runner) plus a guard against premature deletion.
  **What must be decided before building, not during:** (a) the window itself — a number counsel gives us, not one we pick; and (b) whether `principal_subject` should age out on a _shorter_ clock than the rest of the row. That second one is the real design question: the same table is simultaneously a **compliance record**, where indefinite retention is the safe default, and a **per-user identity log** (it stores the raw AAD oid, deliberately unhashed), where indefinite retention is the unsafe default. A single retention number cannot be correct for both. Splitting the clocks — purge or null the subject early, keep the rest for the compliance window — is probably the answer, but it should be a decision with counsel's number attached, not a guess baked into a migration.
  **Not blocking the TWK Phase 1 pilot:** the log holds internal Class A/B SOP questions from ~3 pilot users and no client data by design, so indefinite retention costs nothing and risks little at this scale. Revisit when Phase 2 brings client data near the log, or when accumulated staff-identity history becomes material — whichever comes first.
- **Finer-grained deletion (single-client within a multi-client source):** discovered to be blocked on a missing schema concept, not just a missing query — `documents`/`chunks` have no per-document `clientId` at all today; only `source_client_assignments` exists, and that's an access-control mapping (which staff/clients may query a source), not a per-document tag. A source CAN serve multiple clients (the table is many-to-many), but nothing records which documents within it belong to which client, so there's no way to selectively purge one client's data from a shared source without first adding that tagging (folder-path inference, or manual admin tagging — both real design choices). Deferred until a concrete need for multi-client-source deletion exists, rather than building speculative infrastructure now; whole-source purge (already shipped) covers the common case of a per-engagement, single-client source.

### ✅ H5 — No rate limiting (RESOLVED)

**Original concern:** `POST /ask` triggers an embedding + LLM call per request with no rate limiting on API or MCP.

**Current state:** `@fastify/rate-limit` is registered globally in `apps/api/src/server.ts`, with tighter per-route limits on `/ask` (10/min) and on `DELETE`/`sync` (6/min).

> **Sequencing note for §11 roadmap:** P3's remaining gap (disclosure audit trail) and P4's remaining gaps (column-level encryption, `audit_log` retention, single-client deletion) are worth scheduling but do not block real client data ingestion the way the original P1–P4/H5 set did — the DPA, the code-level compliance gates, and per-user access control are all now in place.

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

| Item                                                                              | Sev | Effort | Status                              |
| --------------------------------------------------------------------------------- | --- | ------ | ----------------------------------- |
| C1 — index-drift guard + Drizzle ownership decision                               | 🔴  | S–M    | ✅ done (`required-indexes.ts`)     |
| H3 — startup embedding-dimension assertion                                        | 🟠  | S      | ✅ done (`embedding-dimensions.ts`) |
| H4 — boundary validation (`ParsedDocumentSchema`, `SourceKind.parse`, session-id) | 🟠  | S–M    | ✅ done (all three casts)           |
| M-N1 — hard token clamp before embedding                                          | 🟡  | S      | ✅ done (`token-clamp.ts`)          |
| C2 — parser shared-secret auth (before any networked deploy)                      | 🔴  | M      | ✅ done (`require_parser_token`)    |

### Highest-ROI RAG-quality upgrades

| Item                                                     | Sev   | Effort | Status                                                                 |
| -------------------------------------------------------- | ----- | ------ | ---------------------------------------------------------------------- |
| H1 — reranking stage over the existing 8× pool           | 🟠/🟢 | M      | OPEN — blocked on a real-embedder eval baseline (see EVAL-BASELINE.md) |
| OPT-C1 — contextual retrieval (optional chunk transform) | 🟢    | M      | OPEN                                                                   |
| H2 — make metadata filtering index-backed                | 🟠    | S–M    | ✅ done (`@>` containment + numeric fallback, index-backed, tested)    |
| M-N3 — per-document cap / MMR diversity                  | 🟡    | S      | OPEN                                                                   |
| **Build a small retrieval eval set first** (see §12)     | —     | M      | Partial — harness is real-embedder-capable; no real run recorded yet   |

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

| Item                                      | Sev | Effort | Status                                                     |
| ----------------------------------------- | --- | ------ | ---------------------------------------------------------- |
| H4 — unvalidated external-boundary casts  | 🟠  | S      | ✅ done (schema validation replaces all 3 casts)           |
| H5 — rate limiting (`/ask`, `/sync`, MCP) | 🟠  | S      | ✅ done (`@fastify/rate-limit`, global + per-route limits) |
| H6 — express major alignment              | 🟠  | S      | ✅ done (`express@5.2.1` + `@types/express@5.0.0`)         |
| M3, M6, M17, M19 (from audit)             | 🟡  | S each | OPEN                                                       |

### CPA-deployment blockers — close before ingesting real client data (§9)

| Item                                                                  | Sev | Effort | Status                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — enforced per-user/role `sourceId` access control in retrieval    | 🔴  | M–L    | ✅ done (`access-control.ts` + `hybridSearch` scope enforcement; per-user web auth via PR #31)                                                                                                                                                                                                       |
| P2 — metadata-exposure allowlist (sender/subject) at the API boundary | 🔴  | S      | ✅ done (`metadata-policy.ts`)                                                                                                                                                                                                                                                                       |
| P3 — LLM-provider disclosure (§7216): agreement + code-level gating   | 🔴  | M      | ✅ done — DPA signed; `COMPLIANCE_MODE`/`EGRESS_ALLOWED_HOSTS`/`dataClass` gate all ship; `audit_log` now records embedding provider/model on every /ask + /search call, both API and MCP (MCP previously had zero audit logging at all)                                                             |
| P4 — `DELETE`/purge-source + encryption-at-rest + retention policy    | 🔴  | M      | 🟡 partial (rest deliberately deferred, see §9) — `DELETE /sources/:id` + `purgeSource` cascade done; column-level encryption relies on managed-Postgres disk encryption; single-client-within-source deletion blocked on a missing `clientId`-on-documents schema concept, not just a missing query |

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

### PR-review backlog (PR #3, multi-agent review 2026-06-10) — OPEN

A 4-agent review (code / tests / error-handling / type-design) of the full PR ran after the two follow-ups above. One genuine regression was found and **already fixed** (commit `ba1971c`: `triggerSync` now only deletes the row on `SyncAlreadyRunningError`, marks genuine enqueue failures `failed`, and guards cleanup so it can't mask the original error; `sources.test.ts` expanded to 5 branches). The items below are the **remaining, not-yet-addressed** findings. None block merge; grouped by risk. Pick up here next session.

**Cheap + safe — ✅ ALL RESOLVED (2026-06-10, this session):**

1. ✅ **Test: cursor codec** — added `packages/connectors/src/util/cursor.test.ts` (8 tests): encode→decode round-trip deep-equal + opaque-base64 assertion; tamper rejection for non-base64, valid-base64-non-JSON, and `normalize`-rejects — each a `ValidationError("invalid <name> cursor")` with the original error attached as `cause`; gmail (`{mode:"initial"}`→nulled tokens) and outlook (`{}`→`{link:null}`) `normalize` defaulting.
2. ✅ **Test: `paginate`** — added `packages/connectors/src/util/paginate.test.ts` (5 tests): the regression guard (`{documents:[], done:false}` does NOT terminate the walk); terminate on `done:true`; `maxItems<=0` clamps to 1; over-filling page truncated to `maxItems`; `remaining` shrinks `[3,2,1]` and `encode` applied to the final cursor.
3. ✅ **Test: `filterSchema` DoS caps** — added `packages/core/src/validation.test.ts` (12 tests): at-limit accept / one-over reject for all four caps (`MAX_FILTER_KEYS`, `MAX_FILTER_KEY_LEN`, `MAX_FILTER_VALUE_LEN`, `MAX_FILTER_VALUES_PER_KEY`); `string` and `string[]` value shapes; over-length value inside an array rejected; non-string values rejected.
4. ✅ **Worker marks row `failed` on deleted source** — `apps/worker/src/handlers/sync-source.ts`. The `source not found` branch now calls `updateIngestionJob(db, job.data.ingestionId, { status: "failed", completedAt, error: "source not found" })` before returning, so the row no longer sits `pending` forever once pg-boss marks the job completed.
5. ✅ **`askQuestion` narrowed to non-null-generator `AskDeps`** — `packages/services/src/ask.ts`. Added exported `AskDeps = Omit<ServiceDeps,"generator"> & { generator: Generator }`; `askQuestion` does the single null-check/throw at the seam then delegates to an internal `ask(deps: AskDeps, …)` so the core path never re-checks the nullable. Added `ask.test.ts` (4 branch tests): no-generator throws + retriever untouched; empty retrieval → fixed answer, generator not invoked; happy path threads output with `topK` fallback to `defaultTopK`; explicit `topK`/`sourceIds`/`filter` forwarded.

**Moderate (low risk, more files) — ✅ ALL RESOLVED (2026-06-13):**

6. ✅ **Runtime metadata validation at the parser boundary** — **superseded by H4**: `parser-client.ts` now runs the full wire payload through `ParsedDocumentSchema.safeParse` (stronger than the originally-proposed plain-object guard), so `parsed.metadata` is structurally validated at the seam. The pipeline merge target (`pipeline.ts:154`) is now explicitly typed `DocumentMetadata & Record<string, unknown>` so the stored shape is honest about both halves.
7. ✅ **Unify `RetrievalQuery.filter` with `filterSchema`** — `packages/core/src/types.ts` `filter?` is now `z.infer<typeof filterSchema>` (type-only import of `filterSchema` from `./validation.js`), so the bounded DoS-capped shape is the only representable one past the HTTP/MCP boundary. All call sites in `apps/api/src/routes/` and `apps/mcp/src/tools/` still typecheck.
8. ✅ **`createTokenVerifier` empty-tokens guard** — `packages/core/src/auth.ts` now throws at construction on an empty `tokens` array (fails loud instead of silently rejecting every request). Defense-in-depth: `config.ts` already enforces `api.tokens` `.min(1)` and the MCP HTTP transport hard-throws on empty before constructing. `auth.test.ts` updated to assert the throw.

**Risky / pre-existing (tracking only — NOT a PR #3 regression):**

9. **`paginate` mid-page truncation** — when a single upstream page yields more documents than `remaining`, each connector's `fetchPage` advances the cursor past the _entire_ page (e.g. `outlook/index.ts` returns `cursor:{link:nextLink}`; `sharepoint/index.ts:154` sets `cursor.current={next:nextLink}`), so the unconsumed tail is skipped next call. Identical on `main` — the refactor only centralized it. Proper fix threads an intra-page offset through all 4 connectors' cursors (high regression surface). ~75% likely a real latent data-loss bug; needs the eval harness (§12) to validate any fix. Either fix deliberately with tests or document the "`fetchPage` must not over-fetch" contract loudly in `paginate.ts`.
10. **gmail/gdrive delta-with-null-token silently triggers full re-scan** — `gmail/index.ts:211-218`, `gdrive/index.ts:214-219` log at `warn` and reseed an initial full re-ingest when a delta cursor lacks its `historyId`/`pageToken`. Asymmetric with the loud failure for _malformed_ cursors. Consider rejecting "delta mode + null token" in each connector's `normalize` (→ `ValidationError`), or at minimum log at `error`/emit a metric since an unplanned full re-scan is an operational event. Also note gmail does not special-case the 404 "startHistoryId too old" → it becomes a hard job failure that retries 3× rather than self-healing to initial.
11. ✅ **Server-side logging of real `triggerSync` failures** (2026-06-13) — `ServiceDeps` now carries a minimal structural `ServiceLogger` (`error`/`warn`/`info`; pino's `Logger` satisfies it, so no `pino` dependency leaks into `@rag/services` — mirrors the `Queue`↔`pg-boss` decoupling). `triggerSync` logs a genuine (non-dedupe) enqueue failure via `deps.logger.error({ err, sourceId, ingestionId, mode }, "sync enqueue failed")` before cleanup/rethrow, so it's captured even when a transport reduces the thrown error to a string. `SyncAlreadyRunningError` stays out of the error log. API runtime `Deps` + the e2e `buildTestApi` helper now thread `logger` through (MCP `Deps` already did). `sources.test.ts` gains 2 tests (genuine failure logs full context; dedupe does not log).

## 12. A note on measuring any of this

Several recommendations (rerank vs no-rerank, dense/sparse weights at `queries.ts:223`, chunk size, contextual retrieval) are **tuning decisions you cannot make blind.** Before investing in H1/OPT-C, stand up a minimal **retrieval evaluation harness**: 30–50 representative questions from the CPA knowledge base, each labeled with the document(s) that should answer it, scored on **recall@k** and **nDCG@k**, plus an LLM-judge on final-answer faithfulness/citation. That turns every item above from "sounds better" into a measurable delta and lets you tune the existing RRF weights empirically (the hybrid-search best practice is explicitly "tune weights on your data, A/B test, don't assume one size fits all"). It is the cheapest way to avoid optimizing the wrong thing.

> **✅ Harness scaffolded (2026-06-13).** A runnable retrieval eval harness now lives under `tests/e2e/src/eval/` (`metrics.ts` — recall@k / precision@k / nDCG@k / MRR, pure + unit-tested; `corpus.ts` — labeled docs + golden questions; `run-eval.ts` — seed → query → aggregate + RRF weight sweep). Specs: `tests/e2e/src/specs/eval-metrics.spec.ts` (metric math, no DB) and `retrieval-eval.spec.ts` (DB-backed baseline guard + report + weight sweep). Run with `pnpm eval`. **Two gaps to close before it can tune production:** (1) the corpus is a 14-doc / 17-question synthetic starter — replace with the 30–50 real CPA questions; (2) it scores under the deterministic `FakeEmbedder`, so the dense/sparse weight sweep is uninformative (dense == lexical signal) and there is no LLM-judge on answer faithfulness yet — both need a real embedder/generator path wired behind an API-key gate. The metrics, seeding, and report machinery are done and are the measurement surface for H1 (rerank) and OPT-C1 (contextual retrieval).

---

### Appendix — what's already good (don't regress it)

Worth stating so these aren't "optimized away": the RRF query keeps filters out of the dense/sparse CTEs so HNSW/GIN actually fire (`queries.ts:387`), per-query `hnsw.ef_search` tuning in a scoped transaction, content-hash idempotency, the connector interface's clean cursor-driven delta model, the sheet-type-aware chunking router, and the non-finite-embedding guard (`queries.ts:215`). The bones are strong — most of this document is about raising an already-disciplined system to production RAG quality.

**Deliberate exception (2026-07-04):** `dense_hits` now also filters on `embedding_provider`/`embedding_model` (matching the caller's active embedder), inside the CTE rather than the final SELECT. This looks like it violates the "filters stay out of the CTEs" rule above, but it isn't a regression to fix — cosine distance across chunks from different providers/models is meaningless even at matching dimensionality, so the pool selected by `ORDER BY ... LIMIT` must already be restricted to the right model, not filtered after the fact. Recall may degrade (not error) during a live provider migration window while old- and new-model chunks coexist; no test yet seeds a real mixed-provider Postgres+pgvector dataset to measure this (see `packages/db/src/queries.access-control.test.ts`'s docstring) — do that, and consider `hnsw.iterative_scan` or a temporarily higher `efSearch`, before relying on this mid-migration.
