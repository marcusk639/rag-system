# cpa-kb-demo

End-to-end spike proving the rag-system can power an internal Knowledge-Base Q&A bot for a CPA firm. This is the runnable companion to:

- `~/dev/cpa-consulting/cpa-consulting/docs/strategy-eval/rag-kb-design.md` (Play 1 design)
- `~/dev/cpa-consulting/cpa-consulting/docs/strategy-eval/rag-compliance-scope.md` (operational scope contract)

## What this demo proves

1. The rag-system can ingest firm-style markdown SOPs through its real pipeline (parser-py → CompositeChunker → embedder → Postgres + pgvector).
2. Hybrid retrieval (dense cosine + sparse tsvector, fused via RRF) returns the right SOP for natural-language questions a CPA would ask.
3. Every answer is grounded in cited source chunks — the foundation for Circular 230 §10.35 basis-of-work-product.
4. The bot honestly says "I don't know" on questions outside the indexed corpus (low-confidence threshold).

## What this demo does NOT prove

- **Real embedding quality.** It uses a deterministic bag-of-words 768-dim embedder so it runs with zero API cost and is repeatable. Production swaps in Gemini `text-embedding-004` or a local Ollama model.
- **Production-grade citations.** It prints text; production renders SharePoint URLs with click-through.
- **Authentication or audit logging.** Production wires the audit-log schema from the compliance scope contract.

## Documents indexed

All under `docs/`. Every file is clearly marked `SYNTHETIC SAMPLE` and is fabricated for demo purposes. None of them are the firm's actual SOPs.

| File                              | Topic                                         |
| --------------------------------- | --------------------------------------------- |
| `boi-filing-sop.md`               | Beneficial Ownership Information (BOI) filing |
| `time-coding-guide.md`            | Time-code catalog + rules                     |
| `k1-treatment-reference.md`       | Schedule K-1 box-level treatment positions    |
| `1040-intake-checklist.md`        | 1040 engagement intake                        |
| `catchup-bookkeeping-workflow.md` | Catch-up bookkeeping engagement workflow      |
| `karbon-template-catalog.md`      | Karbon work-item template inventory           |
| `onboarding-staff-week1.md`       | New-hire onboarding (Week 1)                  |

## How to run

```bash
# 1. Boot the local stack (Postgres + parser-py)
pnpm docker:up

# 2. Run the demo
pnpm --filter @rag/example-cpa-kb-demo demo
```

The demo:

1. Connects to local Postgres (`postgres://rag:rag@localhost:5432/rag`)
2. Truncates the application tables (does NOT touch pg-boss or migration history)
3. Ingests the synthetic docs through the production pipeline
4. Runs six natural-language queries and prints retrieved chunks with citations + scores

## Customising for partner demo

Replace docs in `docs/` with a small set of REAL firm SOPs (Class A only — see `rag-compliance-scope.md` §2). Re-run. The same script ingests and retrieves against the real corpus. This is the simplest possible end-to-end test of "does this work on our content?" before committing to a full deployment.

The synthetic docs in this repo are MIT-licensed alongside the rest of the workspace; the real firm docs should never be committed here.

## Expected output (abridged)

```
[setup] Clearing prior demo data from local Postgres
[setup] Creating source row (kind='custom', name='cpa-kb-demo')
[ingest] Ingesting docs from .../docs
[ingest]   documents: 7 ingested
[ingest]   chunks:    ~30 created

=================================================================
  CPA KB Q&A DEMO — synthetic SOPs, real hybrid retrieval pipeline
=================================================================

-----------------------------------------------------------------
Q: How do we handle BOI filings for an LLC formed in 2024?
   (expects: boi-filing-sop.md)
-----------------------------------------------------------------
  Top match: Boi Filing Sop  [score 1.00]
             section: BOI Filing SOP — Internal › Process — new entity formed in 2024 or later
             excerpt:
               # BOI Filing SOP — Internal ...
  Citations:
    [1] Boi Filing Sop                          score=1.00  docs/boi-filing-sop.md
    [2] ...
```

## What's next after this demo

Per `rag-kb-design.md` §8, the production sequence is:

1. Counsel + carrier review of the compliance scope contract
2. Doug finishes SharePoint cleanup
3. Replace this directory's synthetic docs with the real Class A corpus
4. Wire the SharePoint connector (already exists at `packages/connectors/src/sharepoint`)
5. Pilot with 3 users (Doug + 2 others) for 6 weeks
6. Greenlight firm-wide if the adoption metrics from §7.2 are hit

This demo is the proof point Marcus brings to the partner conversation to short-circuit "but does it actually work?" — yes, here it is running on your laptop, ingesting markdown, returning cited answers.
