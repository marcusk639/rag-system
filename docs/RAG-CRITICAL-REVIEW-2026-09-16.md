# RAG Critical Review — 2026-09-16

Branch: `fix/rag-retrieval-review` (worktree `.worktrees/rag-review`, based on `7486747`).

Inputs: prior-session memory (claude-mem, token-optimizer wiki), `docs/PILOT-LAUNCH-STATUS.md`,
`docs/ARCHITECTURE.md`, `docs/EVAL-BASELINE.md`, `docs/superpowers/{specs,plans}/`, the full
ingest → retrieve → generate code path, and the `llm-application-dev` plugin (wshobson/agents
v2.0.6) skills as an external best-practice checklist.

## What the system is for

A permission-scoped knowledge base over one CPA firm's internal SharePoint SOPs (pilot: 47 Class A
documents, 210 chunks, ~20 staff). Consumed through the Next.js web chat (Entra SSO, live), the MCP
server (agents), and a Teams bot (built, blocked on the firm's Azure subscription). The firm's
status is still "not ready for use"; the multi-vertical "packs" spec is the forward platform design.

## What is already strong

- **Confidentiality boundary.** Scope is a mandatory positional argument, fails closed on `[]`, and
  is enforced inside `hybridSearch`. A forbidden document looks the same as a missing one.
- **Ingestion safety.** Redaction runs before embedding (so no raw identifiers reach a third-party
  embedder), classification escalates per document, and a missing scanner pack fails the whole run
  instead of quietly quarantining documents one by one.
- **Grounded generation.** Retrieved text is delimited and escaped as untrusted, the A/B/C coverage
  modes explicitly prefer partial answers over refusals, returned citations are filtered to the
  `[N]` markers the answer actually uses, and the review status is set by the server.
- **Hybrid retrieval.** RRF uses k=60. The OR-semantics tsquery was adopted because AND-semantics
  measurably matched zero chunks on realistic questions. Gemini uses asymmetric query/document
  embeddings.

These match or exceed the plugin checklist (prompt-injection handling is actually stronger here than
anything the plugin offers).

## Defects fixed on this branch

| #   | Defect                                                                                              | Evidence                                                                                                                                                                               | Fix                                                                                   |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `audit_log.top_score` was always 1.0, so the docs-gap digest's "weak result" check could never fire | `hybridSearch` divides each score by the result set's max; all four audit writers stored `results[0].score`                                                                            | Store the best dense cosine similarity (`topRelevanceScore`, `@rag/core`) — `6d42f1e` |
| 2   | Dense side of hybrid search silently capped at 100 candidates                                       | HNSW returns at most `ef_search` rows. Probe on pgvector 0.8.6: `LIMIT 480` at `ef_search=100` returned 100 rows. Affects every reranked query (pool 480) and `/search` with topK > 12 | `resolveEfSearch` = max(40, override ?? 100, pool), clamped to 1000 — `f08849a`       |
| 3   | `MAX_CHUNKS_PER_DOCUMENT=3` shrank the generator's context below topK                               | Fetched exactly topK, then dropped extra chunks per document; worst when one document dominates                                                                                        | Fetch 3× topK, cap, then truncate to topK — `95709c4`                                 |

Verification: 11 unit test packages pass (new regression tests for each fix); `pnpm eval` 14/14
with numbers identical to `EVAL-BASELINE.md`. The CI corpus is too small to exercise fixes 2–3;
their effect needs `pnpm eval:real` against a corpus larger than ~100 chunks per query pool.

**Costs of fixes 2–3 to watch.** The candidate pool is now capped at 1000 per arm, matching the
highest `ef_search` pgvector accepts, so the dense and keyword lists stay the same length.
`ef_search` can rise from 100 up to 1000 on reranked or high-topK queries; that is negligible at
210 chunks but should be benchmarked (p95 latency) before the index grows. With a reranker
enabled, the 3× over-fetch also triples the candidates sent to the reranker (36 × 5 = 180).

**Follow-up required by fix 1:** `DOCS_GAP_DIGEST_MIN_SCORE=0.3` was never calibrated against a real
signal. Once a week of new `top_score` values exists, set it from the observed distribution of
gemini-embedding-001 similarities (irrelevant matches commonly sit well above 0.3). Rows from before
the fix hold 1.0 and are simply never flagged.

## Recommended next changes (not implemented — need a decision or data)

Ordered by pilot impact.

1. **Follow-up questions (conversation memory).** `AskInput` carries no history, so a question like
   "what about for partnerships?" retrieves against the fragment alone. `PILOT-LAUNCH-STATUS.md`
   calls this the largest unactioned gap; `plans/2026-08-01-reranking-and-conversation-memory.md` is
   listed "in flight" but has no code. Minimal viable version: accept `history` (last N turns,
   client-held, no new tables), and add a condense-to-standalone-question step before retrieval
   that only runs when history is present. The rewrite call touches the TRI pre-flight and is
   retrieval-affecting, so it needs the eval harness.
2. **The empty-retrieval refusal never fires.** Dense ANN always returns rows on a non-empty corpus,
   so the `EMPTY_ANSWER` short-circuit in `ask.ts` only triggers when scope/metadata filters eliminate every candidate; every
   out-of-corpus question reaches the model. Once fix 1 has produced a similarity distribution, add
   an opt-in floor (`RETRIEVAL_MIN_DENSE_SIMILARITY`, default off) that drops chunks with neither a
   sparse match nor dense similarity at or above the floor. This saves a model call and removes a
   hallucination path.
3. **Scoped principals are starved by post-filtering.** ACL, metadata and embedding-model filters all
   apply after the dense/sparse pools are truncated. With one source today this doesn't bite; once a
   principal can see only a small share of a multi-source index, relevant chunks fall outside the
   pool. pgvector ≥ 0.8 supports `SET LOCAL hnsw.iterative_scan = relaxed_order`, which allows the
   filters to move inside `dense_hits`. **First confirm the pgvector version in Railway's
   `postgres-ssl:16.14` image**; local is 0.8.6.
4. **Evaluation.** Per the `eval-harness-first` skill:
   - The CI corpus is saturated (100% at every weight split), so retrieval regressions pass CI. Wire
     the unused `corpus-cpa.ts`, including its negative questions, into `pnpm eval` with thresholds.
   - Faithfulness needs a calibrated judge: at least 100 labelled items, TPR and TNR each ≥ 0.85, and
     a judge from a different model family than the generator (the generator is Gemini, so Claude
     as judge). Until then the judge is advisory only.
   - The gold set still needs a credentialed CPA (constraint C2); this is the actual bottleneck.
5. **Cap `topK` on `/ask` separately from `/search`.** Both accept up to 100. At 100 × ~800 tokens,
   a single `/ask` builds an ~80k-token prompt, and there is no input-token budget guard at
   generation. Suggest a maximum of ~30 for `/ask`, or a token-budget truncation in `buildPrompt`.
6. **Reranking.** The plugin guidance says "always rerank", and a corpus with superseded and
   duplicate SOPs is where cross-encoders earn their cost. But Cohere/Jina would be a new
   subprocessor (this reopens the counsel/DPA gate). Evaluate a local cross-encoder first.
7. **Dormant redaction gap.** Spreadsheet chunks come from `document.tables`, which is never
   redacted (`PILOT-LAUNCH-STATUS.md`). It is currently masked only because tables are also rendered
   into markdown. Highest-care area: fix before any Class B spreadsheet source.
8. **Doc drift.**
   - `DEPLOYMENT-TARGET.md` says compose, but the service runs on Railway.
   - `README.md` still says 858 documents.
   - The reranking/memory plan is marked "in flight" with no code.
   - `0000_init.sql` still cites `text-embedding-004` (a comment only; left alone because migrations
     are forward-only).

## Plugin advice deliberately not adopted

- **LangChain/LangGraph scaffolding:** conflicts with the transport-agnostic `@rag/services` design.
- **HyDE / multi-query expansion:** adds an extra model call per query, and the recall bottleneck
  hasn't been shown. Revisit only if a real eval shows dense recall misses.
- **MMR:** the per-document cap already provides diversity.
- **HNSW `m`/`ef_construction` retuning, quantization:** irrelevant at 210 chunks.
- **Semantic response caching:** questions are low-volume and answers must reflect the latest
  documents plus scope; a cache keyed across principals would be a confidentiality risk.
