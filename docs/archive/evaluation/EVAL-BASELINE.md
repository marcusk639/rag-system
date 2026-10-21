# Retrieval Evaluation Baseline

**Status as of 2026-08-01: the first real-embedder run has been executed. It did
not measure retrieval quality — it proved the corpus cannot.** See
[Real-embedder results](#real-embedder-results-gemini-2026-08-01). This file exists so `pnpm eval:real`'s output has a permanent home, and so nobody mistakes the FakeEmbedder numbers below for evidence of real-world retrieval quality.

## What exists today

- `pnpm eval` — the regression-guard suite (`tests/e2e/src/specs/retrieval-eval.spec.ts`, `eval-metrics.spec.ts`). Runs in CI on every PR. Uses the deterministic `FakeEmbedder` (bag-of-words hash, no network, no API key). Fast and stable, but **not evidence of real retrieval quality** — see the caveat below.
- `pnpm eval:real` — a standalone script (`tests/e2e/src/eval/run-real-eval.ts`, not a vitest spec, doesn't run in CI) that seeds the same labeled corpus and runs the same metrics against whatever `EMBEDDING_PROVIDER` is configured in the environment. Writes a markdown block to `tests/e2e/src/eval/real-eval-result.md` intended to be copied into this file.

The harness itself (`tests/e2e/src/eval/run-eval.ts`, `tests/e2e/src/helpers/ingestion.ts`) was made embedder-swappable on 2026-07-09 — previously `Retriever` and the ingestion pipeline's embedder were hardcoded to `FakeEmbedder` with no way to substitute a real provider at all. `seedEvalCorpus`/`runOneIngestion`/`runRetrievalEval` now accept an optional `embedder`, defaulting to `FakeEmbedder` so every existing spec is unaffected.

## Why no real-embedder numbers are recorded yet

This session prepared the harness but did not execute `pnpm eval:real` — real embedding-provider credentials could not be verified in this environment (the operator's `.env` is access-restricted from this session by design, and guessing/probing for credential presence was correctly blocked). **This is an explicit, acknowledged gap, not a silent skip** — per this file's own purpose, the next person who has real credentials available should run:

```bash
pnpm docker:up   # postgres + parser must be running
EMBEDDING_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval:real
# or: EMBEDDING_PROVIDER=local pnpm eval:real   (no API key, runs ONNX on-process)
```

and paste the resulting `tests/e2e/src/eval/real-eval-result.md` content into a new `## Real-embedder results` section below, then delete this paragraph.

**Dimension compatibility:** `chunks.embedding` is a fixed `vector(768)` Postgres column. `gemini` (`gemini-embedding-001`) and `local` (ONNX) both default to 768 dimensions and work unmodified. `openai`'s default model is 1536-dim and will fail at insert — set `EMBEDDING_DIMENSIONS=768` explicitly if evaluating an OpenAI model that supports dimension truncation (the `text-embedding-3-*` family does).

## Real-embedder results (gemini, 2026-08-01)

**First real-embedder run in the project's history.** Provider `gemini`, model
`gemini-embedding-001`, 768 dims, 17 questions, against the same starter corpus.

| k   | recall@k   | precision@k | nDCG@k |
| --- | ---------- | ----------- | ------ |
| 1   | 91.2%      | 100.0%      | 100.0% |
| 3   | **100.0%** | 39.2%       | 99.1%  |
| 5   | **100.0%** | 23.5%       | 99.1%  |
| 10  | **100.0%** | 11.8%       | 99.1%  |

MRR: **1.000**. Marginally better than FakeEmbedder (recall@3 97.1% → 100%).

### ⚠ The result that matters is the one that did NOT move

**The dense/sparse weight sweep is completely flat.** Every configuration —
`dense=1/sparse=0`, `0.7/0.3`, `0.5/0.5`, `0.3/0.7`, and `dense=0/sparse=1` —
returns **identical** numbers at every k, with MRR 1.000 throughout.

Read that last configuration again: at **`dense=0`, embeddings contribute nothing
to the ranking at all** — it is pure keyword search — and the score is unchanged.
**On this corpus, the embedding model is not doing measurable work.** You would
get the same numbers with no vector search whatsoever.

This was predicted by inference when only FakeEmbedder numbers existed (a
bag-of-words hash makes "dense" a keyword proxy, so flatness was expected). **It
is now demonstrated with a real semantic embedder**, which rules out the
harness and the model and leaves only one explanation: the corpus is too easy.
14 documents across vocabulary-disjoint topics (Postgres, Docker, espresso,
sailing, gardening) means keyword overlap alone identifies the right document
every time. There is no semantic difficulty for an embedding model to resolve.

> ### ⛔ CORRECTION 2026-08-01 (later the same day) — the elimination above was incomplete
>
> **"Leaves only one explanation" was wrong.** A third explanation was never
> considered: **the sparse arm was broken**, so varying its weight was a no-op
> regardless of the corpus. `hybridSearch` built its full-text query with
> `plainto_tsquery`, which ANDs every lexeme — requiring one chunk to contain
> every content word of the question. Measured against the firm's real SOP
> corpus, **5 of 15 realistic staff questions matched zero chunks**, so the
> "sparse" contribution was frequently empty.
>
> After fixing that (OR-semantics tsquery, `packages/db/src/queries.ts`), the
> **same sweep on the same corpus with the same harness is no longer flat**:
>
> | weights              | recall@5 (before → after) | nDCG@5 (before → after) |
> | -------------------- | ------------------------- | ----------------------- |
> | dense=1 sparse=0     | 97.1% → 97.1%             | 97.3% → 97.3%           |
> | dense=0.7 sparse=0.3 | 97.1% → **100.0%**        | 97.3% → **99.1%**       |
> | dense=0.5 sparse=0.5 | 97.1% → **100.0%**        | 97.3% → **99.5%** ←peak |
> | dense=0.3 sparse=0.7 | 97.1% → **100.0%**        | 97.3% → 97.4%           |
> | dense=0 sparse=1     | 97.1% → **100.0%**        | 97.3% → 97.4%           |
>
> **What still stands:** the corpus IS too easy (MRR 1.000), and the gold set is
> still the blocking input for real tuning decisions. **What does not:** the
> claim that the flat sweep proved the corpus was the _only_ problem, and the
> blanket conclusion that no retrieval work is worth doing until the gold set
> exists — a measurable defect was sitting underneath it the whole time.
>
> The transferable lesson: **a degenerate metric is a reason to suspect the
> instrument, not only the data.** Full analysis:
> [`PROTOTYPE-READINESS-REVIEW-2026-08-01.md`](./PROTOTYPE-READINESS-REVIEW-2026-08-01.md) § H-1 / H-1b.

### What this run is, and is not, evidence of

| Claim                                                             | Supported?                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| The pipeline works end to end with a real embedding provider      | ✅ **Yes** — this is the real value of the run            |
| Gemini embeddings are correctly wired, dimensioned, and queryable | ✅ Yes — 768-dim, no insert failures                      |
| Retrieval quality on the firm's knowledge base                    | ❌ **No.** Nothing here speaks to that                    |
| Dense vs sparse weighting is correctly tuned                      | ❌ **No** — the corpus cannot distinguish any setting     |
| Reranking would or would not help                                 | ❌ **No** — unmeasurable on a corpus already at MRR 1.000 |

**Consequence, and it is the actionable one:** a corpus with a ceiling of 1.000
MRR can only ever detect catastrophic regressions. It cannot support a decision
about weights, reranking, chunking, or embedding models — every such change will
read as "no difference." **The blocking input is a real question set with genuine
near-neighbour distractors** (P2 #7 / ISS-05). Until that exists, retrieval
tuning is unfalsifiable and should not be attempted.

### Reproducing this run

```bash
docker compose up -d          # postgres + parser
EMBEDDING_PROVIDER=gemini GEMINI_API_KEY=... \
EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com \
API_TOKENS=<any-non-empty> AUTH_PROVIDER=static-token \
E2E_DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
  pnpm eval:real
```

Three config gates block this and are **not** documented elsewhere — each one
stopped the run until satisfied: `API_TOKENS` must be non-empty, `AUTH_PROVIDER`
must be `static-token` (not `static`), and `EGRESS_ALLOWED_HOSTS` must include the
provider host or `EgressPolicy` refuses the call.

> ⚠ **On the egress guard.** It blocked this run by default, which is correct
> behaviour — it exists so no provider call happens without a DPA decision. It was
> overridden here only because **this corpus is synthetic test data (espresso,
> sailing, gardening); no firm content left the machine.** Overriding it against
> real KB content is a different act and needs the P0 #2 counsel determination,
> which is still open.

---

## FakeEmbedder numbers (regression guard only — NOT a real-world baseline)

Recorded 2026-07-09, `pnpm eval` (17 questions, default RRF weights dense=0.7/sparse=0.3):

| k   | recall@k | precision@k | nDCG@k |
| --- | -------- | ----------- | ------ |
| 1   | 91.2%    | 100.0%      | 100.0% |
| 3   | 97.1%    | 37.3%       | 97.3%  |
| 5   | 97.1%    | 22.4%       | 97.3%  |
| 10  | 100.0%   | 11.8%       | 98.4%  |

MRR: 1.000. Weight sweep (dense=1→0, sparse=0→1) is flat across all five configurations — recall@5/nDCG@5/MRR identical at every point.

**Why these numbers are not meaningful evidence of retrieval quality:** the corpus (`tests/e2e/src/eval/corpus.ts`) is 14 documents / 17 questions, deliberately built around vocabulary-distinctive topics (Postgres tuning, Docker, espresso, sailing, gardening) specifically so keyword overlap trivially determines relevance. Under `FakeEmbedder`'s deterministic bag-of-words hash, the "dense" vector is essentially a keyword-overlap proxy — there is no semantic-similarity difficulty in this test set at all, which is exactly why the weight sweep shows zero variation regardless of dense/sparse mix. The file's own comment calls this a "STARTER set" and names the real target: 30–50 real CPA-knowledge-base questions with genuine near-neighbor distractors. Treat the numbers in this section as a **regression trip-wire** (did a change tank retrieval on trivial cases?), not a measurement of real-world quality.

## Corpus growth (stretch follow-up, not yet done)

Per the corpus file's own "STARTER set" comment: grow toward 30–50 real CPA-domain questions with genuine near-neighbor distractors (e.g. two similar-sounding tax topics that only a real embedding model could distinguish). This is what would make both `pnpm eval:real`'s numbers and any future reranking evaluation ([reranking](./ISSUES-AND-OPTIMIZATIONS.md#4-reranking-exists-but-has-never-been-evaluated-let-alone-enabled)) actually trustworthy.
