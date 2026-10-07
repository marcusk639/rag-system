-- A safety gate quarantines a document instead of indexing it. That count
-- existed only in memory and in a pino line: the durable ingestion_jobs row
-- recorded documents_failed: 0, so a run that quarantined most of a source
-- still read as a clean success. Give it a column so partial degradation is
-- visible after the process exits.
--
-- No read path selects from ingestion_jobs yet -- not in apps/api, apps/web or
-- packages/services (triggerSync is its sole WRITER). The column is for an
-- operator querying the table directly, and for the worker's own guard
-- (apps/worker/src/handlers/sync-source.ts), which reads it back via
-- incrementIngestionJobCounters' RETURNING.
ALTER TABLE "ingestion_jobs"
  ADD COLUMN IF NOT EXISTS "documents_quarantined" integer DEFAULT 0 NOT NULL;
