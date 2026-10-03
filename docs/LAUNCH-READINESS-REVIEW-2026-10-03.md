# RAG launch-readiness review — 2026-10-03

**Scope:** the retrieval/generation pipeline, assessed against one bar only — a
**10–15 user internal CPA-firm pilot**. Not general production readiness.
Severity is calibrated to that bar throughout, so a MEDIUM here may be a HIGH at
larger scale.

**Method:** four parallel reviews — chunking/embedding, retrieval, prompting/
generation, and the evaluation baseline. Every claim was required to carry a
`path:line` citation; anything unverifiable had to be marked UNVERIFIED rather
than inferred. The three findings this document leans on hardest were then
re-verified independently before being written down (see _Provenance_).

**Verdict:** no CRITICAL findings. Two HIGH findings, neither of which is a
confidentiality leak. The single most consequential conclusion is not a bug at
all — it is that **the eval harness cannot currently measure launch quality**,
so the other findings cannot be scored against a number.

---

## Findings

| #   | Area       | Finding                                                                                          | Severity |
| --- | ---------- | ------------------------------------------------------------------------------------------------ | -------- |
| 1   | Eval       | `pnpm eval` is a regression trip-wire, not a quality gate — gold set is empty, corpora synthetic | HIGH     |
| 2   | Generation | No runtime faithfulness check; claim-vs-context verification is offline-eval-only                | HIGH     |
| 3   | Retrieval  | ~~ACL post-filter can under-return for scoped users~~ — overstated; FIXED 2026-10-03             | resolved |
| 4   | Compliance | Class A/B labels are not surfaced anywhere in the answer path; the docs imply they are           | MEDIUM   |
| 5   | Compliance | `local` ONNX embedder has no `EgressPolicy` gate — the one path `client-data` mode relies on     | MEDIUM   |
| 6   | Generation | No token-budget cap; neighbor expansion is not bounded by `MAX_ASK_TOP_K`                        | MEDIUM   |
| 7   | Generation | TRI `warn` is server-log-only; its safety case was built on post-redaction text                  | MEDIUM   |
| 8   | Chunking   | Naive sentence splitter mishandles citation-dense IRC/eCFR prose, and is untested                | MEDIUM   |
| 9   | Chunking   | No test coverage for pathological inputs (giant paragraphs, OCR noise)                           | MEDIUM   |
| 10  | Embedding  | Proactive throttle is opt-in, not default — a large backfill self-trips rate limits              | MEDIUM   |
| 11  | Embedding  | No proactive mixed-model detection; a mid-pilot model change silently hides old chunks           | MEDIUM   |
| 12  | Retrieval  | MCP tool error path not confirmed sanitized at the SDK boundary                                  | MEDIUM   |
| 13  | Retrieval  | Reranker fetch has no explicit timeout (moot while `RERANK_PROVIDER=none`)                       | MEDIUM   |
| 14  | Retrieval  | RRF `ROW_NUMBER()` has no secondary tiebreaker — ordering not stable across re-plans             | LOW      |
| 15  | Embedding  | `schema.ts:205` still names the retired `text-embedding-004` in a comment                        | LOW      |
| 16  | Generation | Production `GENERATION_MODEL` is UNVERIFIED beyond the shipped `gemini-2.5-flash` default        | LOW      |

---

## HIGH 1 — the eval harness cannot gate this launch

`pnpm eval` passes 17/17, reporting recall@5 100%, nDCG@5 99.1%, MRR 1.000 on
`corpus.ts`, and recall@5 100% / nDCG@5 98.2% / MRR 0.975 on `corpus-cpa.ts`.
Those numbers mean very little:

- Both corpora are **entirely synthetic** — `tests/e2e/src/eval/corpus.ts` (14
  fabricated docs, 17 questions) and `corpus-cpa.ts` (7 CPA-styled docs, 20
  questions). Neither was derived from or checked against real firm SOPs.
- The mechanism built to score the **real** 47-document corpus is empty on
  purpose: `GOLD_QUESTIONS: GoldQuestion[] = []` at
  `tests/e2e/src/eval/gold-set.ts:93`. `pnpm eval:gold` has therefore never
  produced a number.
- The run was `FakeEmbedder` only (deterministic bag-of-words hash, no network).
  `pnpm eval:real` was not run — no provider credentials present.
- The repo's own docs reach this conclusion independently: the starter corpus
  "cannot measure retrieval quality" and retrieval tuning is "unfalsifiable"
  until the gold set exists (`docs/EVAL-BASELINE.md:42-56`,
  `docs/EVAL-GOLD-SET-GUIDE.md:10-16`).

The closest real-corpus signal is `scripts/check-kb-grounding.mjs`
self-retrieval at 91.5% (`docs/PILOT-LAUNCH-STATUS.md:175`) — whose own header
calls it a lexical-overlap **floor**, not a quality measure.

**Smallest fix that makes this trustworthy:** populate `gold-set.ts` with 10–15
CPA-verified questions against the real 47-document KB, a meaningful share
carrying a `distractorNote`, then run `pnpm eval:gold`.

## HIGH 2 — no runtime hallucination guardrail

The pilot's headline risk is wrong tax guidance stated confidently. Nothing in
the live request path checks that an answer's claims are supported by the
retrieved text.

- Faithfulness scoring exists only offline, in `tests/e2e/src/eval/faithfulness.ts`,
  reachable solely via `pnpm eval`. Neither `packages/services/src/ask.ts` nor
  `packages/rag/src/generation/generator.ts` imports it.
- The one per-answer mechanical check, `filterCitationsToAnswer`
  (`packages/rag/src/generation/prompt-context.ts:146-198`), verifies citation
  **bookkeeping** — that a `[N]` marker maps to a real retrieved index. It says
  nothing about whether the sentence beside `[N]` is entailed by that chunk.

Real mitigations that do exist, all soft: temperature 0.2
(`generator.ts:339,473`), strong grounding/refusal instructions in the shared
system prompt (`generator.ts:55-100`), a hard server-side `EMPTY_ANSWER`
short-circuit when retrieval returns nothing (`ask.ts:116-117,417-426`), and a
non-dismissible, server-stamped practitioner-review disclaimer on every answer
(`ask.ts:94-102`, rendered at
`apps/web/src/components/chat-interface/chat-interface.tsx:151-160`).

That disclaimer plus the internal, non-client-facing nature of the pilot is what
keeps this at HIGH rather than blocking.

## HIGH 3 — ACL post-filter — OVERSTATED, and now FIXED

**Correction, recorded rather than quietly edited away.** The original finding
cited `hybrid-search.ts:279-352` and concluded that a scoped principal could
silently receive a short or empty result set. It missed the adaptive retry at
`:356-378`: for any scoped principal `filtered` was always true, so a short
result triggered a second query at a 1000-candidate pool (`hnsw.ts:3,29`)
against a 210-chunk corpus — which sees everything. The user-visible failure the
finding described **could not occur at current scale.**

What was actually wrong, and has now been fixed:

- **A growth cliff.** The retry stops rescuing anything once a scoped user's
  relevant chunks can be crowded out of 1000 candidates.
- **A routine double query.** With only 210 chunks, many legitimate queries match
  fewer than `topK = 12`, so scoped users triggered the retry on the normal
  path, not the exceptional one — paying two round trips for most searches.
- **A real gap in the withdrawal gate.** `lifecycle_status = 'active'` was
  deliberately excluded from `filtered` (`:362-370`), so for an _admin_ query
  with no caller filter, withdrawn documents could occupy pool slots and crowd
  out servable ones with no retry and no error. This was reproduced with a
  failing test before being fixed.

**Fix:** both mandatory filters — the ACL and the withdrawal gate — now run
inside each candidate CTE via `EXISTS`, before its `LIMIT pool` truncation, so
neither an unreadable nor a withdrawn chunk can consume a slot. They are also
retained in the final `SELECT` as a backstop. `enforcedSourceIds` was dropped
from the retry predicate, removing the routine second query for scoped users.
The optional caller filters (`sourceIds`, metadata) remain post-filters and
still rely on the retry.

**Residual, deliberately accepted:** a filtered `ORDER BY` on the dense arm can
no longer be served purely by the HNSW index, so the planner may seq-scan. At
this corpus size that is the faster plan. pgvector 0.8 added
`hnsw.iterative_scan` for exactly this tradeoff — local is 0.8.6, but the
version on Railway's `postgres-ssl:16.14` is **UNVERIFIED**, so adopting it is a
follow-up, not part of this change.

## MEDIUM 4 — the Class A/B guarantee has no user-visible surface

`DocumentClass` (`packages/core/src/types.ts:30-36`) is computed server-side at
ingestion (`packages/ingestion/src/classify-document.ts:75-113`) and stored on
`documents.doc_class` (`packages/db/src/schema.ts:468`), where it gates ingestion
— C/D are quarantined (`classify-document.ts:108-113`).

It goes no further. `docClass` is absent from `RetrievalResult.document`
(`types.ts:232-265`), from `GenerationResult.citations`
(`packages/core/src/interfaces.ts:77-94`), from `buildCitations()`
(`prompt-context.ts:205-221`), and from the metadata-exposure allowlist
(`packages/core/src/metadata-policy.ts:1-45`). Repo-wide, the only occurrences
under `apps/` are the **ingestion** path (`apps/worker/src/handlers/sync-source.ts:132`
and its tests) and compiled `.next` build artifacts that bundle the DB schema —
nothing in `apps/api/src` or `apps/web/src`.

So the compliance narrative's "Class A/B sources only"
(`docs/PILOT-LAUNCH-STATUS.md:17-19,293-298`) rests entirely on the ingestion
gate being correct, with no second surface by which a user or auditor could
verify it per-answer. Given this corpus has had real client PII reach the index
before (`PURGE-RECORD-2026-08-03.md`), surfacing `docClass` in the citation audit
trail is worth doing as belt-and-suspenders — recommended, not blocking.

## MEDIUM 5 — the `local` embedder is the one provider with no egress gate

`COMPLIANCE_MODE=client-data` hard-requires the local ONNX provider
(`packages/rag/src/embeddings/factory.ts:24-31`). That provider is also the only
one with zero `EgressPolicy`/`assertAllowed` references: `local.ts` has **0**,
against 5 in `gemini.ts` and 6 in `openai.ts`. The factory passes an
`egressPolicy` to the gemini and openai cases but not to the local one
(`factory.ts:39-59` vs `:60-66`), and `local.ts:16-19` documents that model
weights are downloaded from HuggingFace Hub on the first `embed()` call — real
network egress, outside the allow-list every other outbound call must pass.

Scoped to MEDIUM because only public model weights leave — no chunk text, no TRI
— and `scripts/warm-model.ts` pre-warms the model so the runtime call never
happens if deployment follows it. Still worth closing before `client-data` is
described as an airtight zero-egress guarantee.

## MEDIUM 6–13 — the rest

**6. Context budget.** Sizing is chunk-count-based only; no code path counts
tokens. `topK` is zod-bounded to 30 (`packages/core/src/validation.ts:46-51`),
but `expandWithNeighbors` (`ask.ts:221-275`) appends up to `documents ×
chunksPerDocument` more chunks **after** the `topK` slice, default 2 × 4
(`config.ts:173-178`) — worst case 38 chunks (~30k tokens) reach the model with
no truncation backstop. Low practical risk at 47 documents against Gemini's
context window; a real gap if the corpus or settings grow.

**7. TRI `warn`.** Identifying patterns (SSN/EIN) always block regardless of
policy (`packages/rag/src/generation/screen-context.ts:21-25`). Only _contextual_
patterns (e.g. "1099+amount") become advisory, and under `warn` the chunk is kept
and `onTriDetected` fires into a pino log only
(`packages/runtime/src/index.ts:293-297`) — nothing reaches the user, whose
answer is indistinguishable from a clean one. `COMPLIANCE_MODE=client-data`
forces `block` regardless (`runtime/index.ts:163-168`). The decision to run
`warn` is measured and auditable — it followed a 36% false-refusal rate
(`docs/PILOT-LAUNCH-STATUS.md:168-197`) — but its justifying sweep scanned
post-redaction markdown, so it says what can reach the model, not what is in the
original SharePoint files (`PILOT-LAUNCH-STATUS.md:216-218`).

**8–9. Chunking gaps.** The last-resort splitter is
`text.match(/[^.!?]+[.!?]?\s*/g)` (`packages/rag/src/chunking/markdown-chunker.ts:235`),
with no abbreviation awareness — "I.R.C.", "Treas. Reg. §", "Rev. Rul." all
split spuriously. Fragments are reassembled to the token budget, so this
misplaces boundaries rather than losing data, and only fires on paragraphs >800
tokens. Untested: the chunking suite has zero matches for `sentence`,
`hardSplit`, `OCR`, or `scanned`. Whether typical OCR noise clears `hasRealText`'s
3-character bar (`markdown-chunker.ts:163-165`) is UNVERIFIED.

**10. Throttle.** `createThrottle` disables pacing unless `requestsPerMinute` is
set (`packages/rag/src/embeddings/throttle.ts:18-24,45-51`); `retry.ts:18-22`
notes backoff "does not help against a burst you are about to cause yourself."
Fine at pilot volume, relevant if a large initial backfill is planned.

**11. Mixed models.** Dense retrieval hard-filters to the configured
provider/model (`hybrid-search.ts:285-290`), so stale-model chunks are excluded
rather than mis-scored — the dangerous failure is already prevented. But nothing
warns an operator that a re-embed is overdue; old chunks simply stop appearing in
dense results. A startup log of `SELECT DISTINCT embedding_model,
embedding_provider, count(*) FROM chunks` would close it.

**12. MCP errors.** `apps/mcp/src/tools/ask.ts:142-154` special-cases only
`GenerationNotConfiguredError` and re-throws the rest, and `apps/mcp/src/server.ts`
has no top-level handler. What an MCP client sees for a DB/embedder failure
depends on the SDK's default error conversion — UNVERIFIED, and worth confirming
it cannot surface a raw `Error.message` (e.g. a connection string). The HTTP side
is correctly sanitized (`apps/api/src/error-handler.ts:114-119`).

**13. Reranker timeout.** No `AbortSignal` on the fetch
(`packages/rag/src/retrieval/reranker.ts:79-95`). Moot at `RERANK_PROVIDER=none`;
add it before anyone flips it on, to bound `/ask` latency.

---

## What was verified as sound

These settle open questions rather than raising new ones.

**Citations are server-authoritative — definitively.** This closes a previously
unverified compliance claim. `buildCitations()`
(`prompt-context.ts:205-221`) builds the citation array from `RetrievalResult`
metadata — document id, title, url, chunk id, score, `modifiedAt` — and takes no
input from model text. The only place model output touches citations is
`filterCitationsToAnswer`, which can **only narrow** the server-built list: a
model writing `[99]` gets that reference dropped, never fabricated into a source.
Recency captions are the same — `citationDate()` (`:223-227`) shape-validates
`document.metadata.modifiedAt` and emits nothing if it fails.

**RRF is implemented correctly.** `k = 60` (`hybrid-search.ts:107`), correct rank
basis on both arms (`:282-284`, `:297-299`), weights matching the documented
formula (`:310-313`), defaults consistent between SQL and config
(`:105-106`, `packages/core/src/config.ts:159-160`). The sparse leg is live, not
dead weight: GIN-indexed (`0000_init.sql:102`) and deliberately OR-semantic
because AND-semantics caused 33% zero-match on a representative SOP corpus
(`hybrid-search.ts:217-236`).

**Scope threading is mandatory and fails closed.** `enforcedSourceIds` is a
required field, not optional, all the way down (`access-control.ts:57-60` →
`retriever.ts:65-67` → `hybrid-search.ts:46-59`), with an empty scope
short-circuiting before the DB is touched (`:94-96`). `resolvePrincipal` returns
`null` rather than throwing on a bad token (`access-control.ts:175-198`).

**Idempotency is solid.** Race-safe `ON CONFLICT (source_id, external_id) DO
UPDATE` (`packages/db/src/queries.ts:150-204`), content-hash short-circuit on
unchanged documents (`packages/ingestion/src/pipeline.ts:636-647`), atomic
`replaceChunks` in one transaction (`queries.ts:358-372`), and straggler recovery
for documents whose hash was recorded but whose embedding failed
(`queries.ts:385-395`, `pipeline.ts:636-649`) — so a mid-batch embedding failure
wastes cost but never leaves a document permanently unretrievable.

**The retired embedding model is unreachable by default.** `gemini-embedding-001`
at 768 dims is the real runtime default
(`packages/rag/src/embeddings/gemini.ts:63-64`); the factory passes `cfg.model`
through with no fallback to `text-embedding-004` (`factory.ts:34-46`), which now
404s if someone configures it by hand — loud, not silent. One stale comment still
names it at `packages/db/src/schema.ts:205` (finding 15).

**Concurrency headroom is adequate.** Pool `max: 10` per app
(`packages/db/src/client.ts:41`, `runtime/index.ts:187-189`), 5s connection
timeout and 30s statement timeout (`client.ts:46,50`), HNSW `m=16,
ef_construction=64` (`0000_init.sql:94-99`) with `ef_search` capped
(`packages/db/src/hnsw.ts`). No O(corpus) per-query work and no N+1 in the search
path.

**Error sanitization on HTTP/SSE is correct.** Sanitized 500s with server-side
Sentry detail (`apps/api/src/error-handler.ts:114-119`); SSE errors echo only
allow-listed `RagError` codes, else a generic "Generation failed."
(`apps/api/src/routes/ask.ts:103-111,261-266`). The reranker degrades to
pre-rerank RRF order rather than failing the request
(`retriever.ts:109-116`).

---

## Recommended before go-live

Ordered by value, not effort.

1. **Populate the gold set** (10–15 CPA-verified questions, real 47-doc KB) and
   run `pnpm eval:gold`. Without this, every other tuning decision is
   unfalsifiable — including whether findings 3 and 8 actually matter.
2. **Smoke-test retrieval with a scoped principal** against the real corpus, to
   size finding 3. If pilot users are all admin-scope, finding 3 does not apply
   and can be deferred.
3. **Confirm the MCP SDK error path** does not leak raw `Error.message`
   (finding 12) — cheap to check, bad to get wrong.
4. **Pre-warm the local model** per `scripts/warm-model.ts` if `client-data` mode
   is used, and gate `local.ts` behind `EgressPolicy` (finding 5).
5. Regression tests for the sentence splitter and pathological chunking inputs
   (findings 8–9); mixed-model startup log (finding 11); reranker timeout
   (finding 13) before `RERANK_PROVIDER` is ever flipped on.

Findings 4, 6, 7, 10, 14, 15, 16 are safe to carry into the pilot and revisit
after.

---

## Provenance and limitations

Four reviews ran in parallel; each was required to cite `path:line` and to mark
UNVERIFIED rather than infer. Three findings were re-verified independently
before being recorded here, because each contradicts or qualifies an existing
document: `GOLD_QUESTIONS` is `[]` at `gold-set.ts:93`; `local.ts` has 0
`EgressPolicy`/`assertAllowed` references against 5 and 6 in gemini/openai;
`docClass` appears nowhere in the serving path under `apps/api/src` or
`apps/web/src`.

Known gaps in this review, stated rather than papered over:

- No live production environment was inspected. The production
  `GENERATION_MODEL`, and whether anything overrides the DB pool `max`, are
  UNVERIFIED beyond shipped defaults.
- Eval numbers come from `FakeEmbedder` only. No real-provider run was made.
- The parser sidecar's OCR path was out of scope, so OCR-noise behavior against
  `hasRealText` is UNVERIFIED.
- Reviewers reported their tool output contained what they read as prompt
  injection. On inspection this was local harness tooling (the token-optimizer
  and context-mode hooks) advertising tools and cached file state, not an
  attack. They were right to distrust it and re-verify against source; the
  findings above are unaffected.
