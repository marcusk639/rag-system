-- Migration: librarian-facing content-type/governance taxonomy on documents
-- (Phase 2 of docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md).
--
-- Distinct from data_class / DocumentClass, which gate legal/regulatory
-- access (§7216/GLBA) — this taxonomy answers "is this an SOP, a template, a
-- research note, or an example file, and who maintains it, and is it still
-- active." Do not conflate the two systems.
--
-- content_type / owner_id / lifecycle_status are intentionally NOT added to
-- upsertDocument's INSERT/ON CONFLICT DO UPDATE SET column list
-- (packages/db/src/queries.ts) — leaving them out is what keeps a human's
-- manually-set values from being clobbered by a re-sync of an unchanged
-- source file.

DO $$ BEGIN
  CREATE TYPE "content_type" AS ENUM('sop', 'template', 'research_note', 'example', 'general');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "content_type"      "content_type",
  ADD COLUMN IF NOT EXISTS "owner_id"          text,
  ADD COLUMN IF NOT EXISTS "lifecycle_status"  text NOT NULL DEFAULT 'active';
