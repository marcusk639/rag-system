-- Migration: add document_class enum + doc_class columns to sources and documents
-- Phase 1 scope: A and B only. C and D are reserved for future phases.
-- Existing sources/documents default to 'A' (all current sources are firm SharePoint,
-- which is Class A). New sources must set docClass explicitly via the application layer.

DO $$ BEGIN
    CREATE TYPE "document_class" AS ENUM('A', 'B', 'C', 'D');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "sources"
    ADD COLUMN IF NOT EXISTS "doc_class" "document_class" NOT NULL DEFAULT 'A';

ALTER TABLE "documents"
    ADD COLUMN IF NOT EXISTS "doc_class" "document_class" NOT NULL DEFAULT 'A';
