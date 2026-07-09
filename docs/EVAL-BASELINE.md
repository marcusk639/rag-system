# Retrieval Evaluation Baseline

**Status as of 2026-07-09: harness is real-embedder-capable; no real-embedder run has been recorded yet.** This file exists so `pnpm eval:real`'s output has a permanent home, and so nobody mistakes the FakeEmbedder numbers below for evidence of real-world retrieval quality.

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
