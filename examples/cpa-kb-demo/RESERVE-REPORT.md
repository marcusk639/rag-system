# KB-Bot Reserve Report (Synthetic-SOP De-Risk)

**Date:** 2026-07-17 · **Embedder:** local ONNX `Xenova/bge-base-en-v1.5` (768-dim, no API key) · **Corpus:** 7 synthetic CPA SOPs (64 chunks), 20 labeled questions + 8 out-of-corpus negatives.

> Reserve artifact for KB-bot roadmap item 3.1. Proves the pipeline retrieves on
> realistic CPA content and honors the §7216 compliance path — on SYNTHETIC data,
> offline, no credentials. Not a partner demo.

## Retrieval quality (real local embedder)

Source: `tests/e2e/src/eval/cpa-eval-result.md` — `pnpm --filter @rag/e2e run eval:cpa`, `provider=local model=Xenova/bge-base-en-v1.5 dims=768`, weights dense=0.3/sparse=0.7, 20 questions.

| k   | recall | precision | nDCG   |
| --- | ------ | --------- | ------ |
| @1  | 97.5%  | 100.0%    | 100.0% |
| @3  | 100.0% | 35.0%     | 100.0% |
| @5  | 100.0% | 21.0%     | 100.0% |
| @10 | 100.0% | 10.5%     | 100.0% |

MRR: 1.000

## "I don't know" behavior

Highest out-of-corpus (negative) top-score (RRF, per-query-normalized): **1.0000**. This normalized number is expected by construction — `RetrievalResult.score` is renormalized WITHIN each query's own result set, so rank-1 always lands near 1.0000 regardless of whether the query is actually relevant to the corpus (see `hybridSearch` in `packages/db/src/queries.ts`). It is not evidence of good or bad separation on its own.

The valid, cross-query-comparable signal is the **raw component score**, and here is the honest finding:

| component           | lowest positive (rank-1) | highest negative (rank-1) | separation holds? |
| ------------------- | ------------------------ | ------------------------- | ----------------- |
| dense (cosine)      | 0.5868                   | 0.6324                    | **NO**            |
| sparse (ts_rank_cd) | 0.0000                   | 0.0000                    | NO                |

**The lowest in-corpus positive dense score (0.5868) is below the highest out-of-corpus negative dense score (0.6324).** Raw retrieval scores alone do not cleanly separate "this question is about our SOPs" from "this question is not about our SOPs" — an 8-negative sample where the top negative dense score exceeds the bottom positive dense score means a naive score-threshold rule (e.g. "refuse if top dense score < 0.60") would misfire on at least one side of that boundary. Retrieval RANKING is excellent (recall@3=100%, MRR=1.000 — when there IS a right answer in the corpus, it is found), but raw retrieval SCORE is not, by itself, a reliable "in-corpus vs. out-of-corpus" signal.

**Conclusion: any "I don't know" safety behavior in the bot has to live in the answer/generation-confidence layer (e.g. an LLM-judged relevance check, an explicit refusal prompt, or a calibrated classifier trained on more negatives) — not in a raw dense/sparse retrieval-score cutoff. This eval exercises retrieval ranking only; it does not exercise that generation-confidence layer at all**, so it proves nothing about whether the bot's actual "I don't know" behavior (however it is eventually implemented) works.

## Compliance path (evidence)

Source: `examples/cpa-kb-demo/evidence-output.txt` — `pnpm --filter @rag/example-cpa-kb-demo run evidence`.

```
EVIDENCE: data_class 'sop' maps to DocumentClass 'A' (expected A)
EVIDENCE: Class-A ingest succeeded: 7 docs, 64 chunks (documentsFailed=0)
EVIDENCE: data_class 'client_confidential' maps to DocumentClass 'D' (expected D)
EVIDENCE: Class-D ingest REFUSED at the gate: documentsProcessed=0, documentsFailed=7 (runIngestion resolves rather than throws — ClassBlockedError is caught per-document via Promise.allSettled; see ingest_log check below for the actual error class/message)
EVIDENCE: ingest_log block row: action=blocked reason="Class D documents cannot be indexed in Phase 1 (source ac899f83-7349-4a26-bc2d-e1da2ddcaab5). Class C requires a §314.4(f) addendum; Class D requires a §7216 consent workflow. Fix the source configuration or escalate to compliance."
EVIDENCE: ingest_log rejection_reason matches ClassBlockedError("D", sourceId).message exactly
EVIDENCE: audit_log row: endpoint=search retrieved=3 top_score=1 hash=0b69316d7bde...
EVIDENCE: citation resolves: top chunk -> document bb30d18e-19e1-4a96-b322-e13d6edf41a1 (path=boi-filing-sop.md) [dense=0.393 sparse=0.000 score=1.000]
EVIDENCE: ALL COMPLIANCE CHECKS PASSED
```

## What this proves

- The production ingest → chunk → embed → hybrid-retrieve path returns the right SOP on realistic CPA questions with a REAL embedder (recall@3=100%, MRR=1.000).
- The §7216/GLBA data-class gate refuses Class-C/D at ingest (code path, not a process rule) — Class-A ("sop") ingests cleanly, Class-D ("client_confidential") is blocked for every document with a logged, human-readable reason.
- Every query writes an `audit_log` row (endpoint, retrieved count, top score, hash) and citations resolve to a real source document.

## What this does NOT prove / what production still needs

- **"I don't know" safety is not proven.** As shown above, raw retrieval scores do not separate in-corpus from out-of-corpus queries at the boundary (lowest positive dense 0.5868 < highest negative dense 0.6324). This eval only exercises retrieval ranking, not the answer/generation-confidence layer where actual refusal behavior would need to live. Do not read recall@3=100% as "the bot correctly says I don't know" — that claim is unverified here.
- Quality on the FIRM'S real SOPs (this corpus is synthetic — 7 documents, 20 questions).
- Production embedding numbers (Gemini) unless separately run — this report is local-ONNX only.
- Real SharePoint Class-A ingest, counsel + carrier sign-off, and adoption — all Phase-3 / firm-gated.
- Only 8 out-of-corpus negatives were tested; this is a small sample for a separation claim in either direction.

## Reproduce

```bash
cd ~/dev/rag-system
pnpm docker:up && pnpm db:migrate
EMBEDDING_PROVIDER=local pnpm --filter @rag/e2e run eval:cpa
EMBEDDING_PROVIDER=local pnpm --filter @rag/example-cpa-kb-demo run evidence
```
