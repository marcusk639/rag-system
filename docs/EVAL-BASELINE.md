# Retrieval Evaluation Baseline

**Status as of 2026-07-11: a real-embedder baseline (Gemini) is recorded below.** This file exists so `pnpm eval:real`'s output has a permanent home, and so nobody mistakes the FakeEmbedder numbers further down for evidence of real-world retrieval quality.

## What exists today

- `pnpm eval` — the regression-guard suite (`tests/e2e/src/specs/retrieval-eval.spec.ts`, `eval-metrics.spec.ts`). Runs in CI on every PR. Uses the deterministic `FakeEmbedder` (bag-of-words hash, no network, no API key). Fast and stable, but **not evidence of real retrieval quality** — see the caveat below.
- `pnpm eval:real` — a standalone script (`tests/e2e/src/eval/run-real-eval.ts`, not a vitest spec, doesn't run in CI) that seeds the same labeled corpus and runs the same metrics against whatever `EMBEDDING_PROVIDER` is configured in the environment. Writes a markdown block to `tests/e2e/src/eval/real-eval-result.md`, folded into this file below.

The harness itself (`tests/e2e/src/eval/run-eval.ts`, `tests/e2e/src/helpers/ingestion.ts`) was made embedder-swappable on 2026-07-09 — previously `Retriever` and the ingestion pipeline's embedder were hardcoded to `FakeEmbedder` with no way to substitute a real provider at all. `seedEvalCorpus`/`runOneIngestion`/`runRetrievalEval` now accept an optional `embedder`, defaulting to `FakeEmbedder` so every existing spec is unaffected.

**Dimension compatibility:** `chunks.embedding` is a fixed `vector(768)` Postgres column. `gemini` (`gemini-embedding-001`) and `local` (ONNX) both default to 768 dimensions and work unmodified. `openai`'s default model is 1536-dim and will fail at insert — set `EMBEDDING_DIMENSIONS=768` explicitly if evaluating an OpenAI model that supports dimension truncation (the `text-embedding-3-*` family does).

## Real-embedder results

### Provider: `gemini` (model `gemini-embedding-001`, 768d)

Recorded 2026-07-11 via `pnpm eval:real`.

Corpus: 14 documents / 17 questions (see `corpus.ts` — this is the "STARTER set," vocabulary-distinctive, no semantic-similarity difficulty; treat these numbers as a floor, not a ceiling).

Default weights (dense=0.7, sparse=0.3):

| k   | recall@k | precision@k | nDCG@k |
| --- | -------- | ----------- | ------ |
| 1   | 91.2%    | 100.0%      | 100.0% |
| 3   | 100.0%   | 39.2%       | 99.1%  |
| 5   | 100.0%   | 23.5%       | 99.1%  |
| 10  | 100.0%   | 11.8%       | 99.1%  |

MRR: 1.000. No misses at recall@5.

Weight sweep (recall@5 / nDCG@5 / MRR):

| dense | sparse | recall@5 | nDCG@5 | MRR   |
| ----- | ------ | -------- | ------ | ----- |
| 1     | 0      | 100.0%   | 99.1%  | 1.000 |
| 0.7   | 0.3    | 100.0%   | 99.1%  | 1.000 |
| 0.5   | 0.5    | 100.0%   | 99.1%  | 1.000 |
| 0.3   | 0.7    | 100.0%   | 99.1%  | 1.000 |
| 0     | 1      | 100.0%   | 99.1%  | 1.000 |

**Reading these numbers:** recall@5/nDCG@5/MRR are flat across the entire dense/sparse weight sweep, same as the FakeEmbedder run below — this is a property of the corpus (vocabulary-distinctive topics with no near-neighbor distractors), not evidence that dense vs. sparse weighting doesn't matter in general. A real Gemini embedding slightly _improved_ recall@3 over FakeEmbedder (100.0% vs. 97.1%) but that delta is too small and the corpus too easy to read as a meaningful signal either way. **This baseline does not yet unblock reranking evaluation** ([H1](./ISSUES-AND-OPTIMIZATIONS.md#4-reranking-exists-but-has-never-been-evaluated-let-alone-enabled)) with real confidence — the corpus still needs to grow into genuine near-neighbor territory (see "Corpus growth" below) before a reranking A/B on it would mean anything. It's still worth running as a first real-provider datapoint and a regression trip-wire.

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

## Corpus growth (deferred — decision recorded 2026-07-12)

Per the corpus file's own "STARTER set" comment, the original plan was to hand-author 30–50 real CPA-domain questions with genuine near-neighbor distractors. **Decision: not now — deferred, and rescoped.**

**Why not now:** the real-Gemini baseline above is already at a ceiling (recall@5=100%, nDCG@5=99.1%, MRR=1.000, flat across the entire dense/sparse weight sweep). There's no headroom left in this corpus for a reranker to show a measurable lift — any A/B run against it today would be noise on a 14-doc/17-question sample, not signal, and could wrongly "prove" H1 ([reranking](./ISSUES-AND-OPTIMIZATIONS.md)) doesn't help.

**Why hand-authoring more synthetic near-neighbor pairs is also the wrong fix:** whoever curates "genuine near-neighbor distractors" is grading their own test (labeler bias), and a synthetic corpus doesn't represent real TWK query patterns anyway — it'd be thrown away once real usage exists.

**Better source, already built:** `getWeakResultAuditEvents` (`packages/db/src/queries.ts:843`) plus the docs-gap-digest pipeline (Phase 4) capture real `ask`/`search` queries with low `topScore` once the KB is live. That's an organic near-neighbor-difficulty query set sourced from actual TWK usage — the right place to harvest a real eval corpus from, once there's enough live traffic to draw from. Revisit corpus growth then, not before.
