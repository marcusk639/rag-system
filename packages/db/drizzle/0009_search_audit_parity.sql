-- Migration: search-path audit logging parity (Phase 3 of
-- docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md).
--
-- `/ask` already writes one audit_log row per call; `/search` wrote none.
-- Adds two columns so a single row shape now covers both endpoints instead
-- of a second parallel table:
--   - endpoint:  "ask" | "search" discriminator. NOT NULL DEFAULT 'ask' so
--                the column add itself backfills every pre-existing row to
--                'ask' (their only possible prior meaning) with no separate
--                UPDATE needed.
--   - top_score: nullable real — the top retrieval result's combined score
--                (0-1), already computed by the retriever but not previously
--                persisted. Null when nothing was retrieved. Purely numeric;
--                does NOT reintroduce raw question/query text storage, which
--                remains excluded by design (see questionHash's doc comment).

ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "endpoint"  text NOT NULL DEFAULT 'ask',
  ADD COLUMN IF NOT EXISTS "top_score" real;
