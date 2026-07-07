-- Migration: human-confirmed "last reviewed" timestamp on documents (Phase 5
-- of docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md).
--
-- Distinct from updated_at (bumped by ANY write, human or automated re-sync)
-- and source_modified_at (source-reported, not a human review) — this column
-- is set ONLY when a person confirms the document is still current. Feeds the
-- staleness-sweep recurring job (apps/worker/src/handlers/staleness-sweep.ts),
-- which flags active documents where this is null or older than a configured
-- threshold (STALENESS_SWEEP_MAX_AGE_DAYS).
--
-- Same re-sync-safety rule as content_type / owner_id / lifecycle_status
-- (0008_document_governance.sql): NOT added to upsertDocument's
-- INSERT/ON CONFLICT DO UPDATE SET column list (packages/db/src/queries.ts) —
-- leaving it out keeps a human-set review timestamp from being clobbered by a
-- re-sync of an unchanged source file.

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "last_reviewed_at" timestamptz;
