-- Layer 1.5 (semantic content scan) quarantines a document instead of indexing
-- it. That count existed only in memory and in a pino line: the durable row an
-- operator or the sources UI reads recorded documents_failed: 0, so a run that
-- quarantined most of a source still read as a clean success. Give it a column
-- so partial degradation is visible after the process exits.
ALTER TABLE "ingestion_jobs"
  ADD COLUMN IF NOT EXISTS "documents_quarantined" integer DEFAULT 0 NOT NULL;
