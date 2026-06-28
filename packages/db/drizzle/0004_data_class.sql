-- Migration: add data_class enum + data_class column to sources
-- Replaces the doc_class / document_class approach (never applied to any DB —
-- 0004_doc_class.sql was generated but never registered in the journal).
-- Existing sources default to 'general'.

DO $$ BEGIN
  CREATE TYPE "data_class" AS ENUM('general', 'research', 'sop', 'client_confidential');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "sources"
  ADD COLUMN IF NOT EXISTS "data_class" "data_class" NOT NULL DEFAULT 'general';
