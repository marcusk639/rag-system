-- Migration: create ingest_log table
-- Tracks every document ingestion attempt: "ingested" on success, "blocked"
-- when ClassBlockedError fires (Class C/D rejection). Provides a durable
-- audit trail for compliance review and pipeline observability.

CREATE TABLE IF NOT EXISTS "ingest_log" (
  "id"               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  "source_id"        uuid        NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
  "doc_id"           uuid        REFERENCES "documents"("id") ON DELETE SET NULL,
  "external_id"      text        NOT NULL,
  "doc_class"        text        NOT NULL,
  "action"           text        NOT NULL,
  "rejection_reason" text,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ingest_log_source_idx"  ON "ingest_log"("source_id");
CREATE INDEX IF NOT EXISTS "ingest_log_created_idx" ON "ingest_log"("created_at");
