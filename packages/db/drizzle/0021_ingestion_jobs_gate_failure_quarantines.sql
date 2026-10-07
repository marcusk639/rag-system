-- documents_quarantined (0020) collapses two opposite outcomes: a gate that
-- REFUSED a document (Layer 3 escalated it to class C/D -- ordinary, and
-- triggered by any single identifier finding) and a gate that BROKE (scanner
-- threw or was unreachable, redaction threw, pack missing or empty). Only the
-- second is a fault, and only the second has no retry path: the cursor
-- advances past the document and its 'blocked' audit row resolves it.
--
-- A guard keyed on the collapsed total therefore cannot work. It failed every
-- sync of a legitimately sensitive source, permanently, because the share of
-- policy quarantines is a stable property of such a corpus. Split the count so
-- the worker can escalate faults without ever failing a run over policy.
ALTER TABLE "ingestion_jobs"
  ADD COLUMN IF NOT EXISTS "documents_quarantined_gate_failure" integer DEFAULT 0 NOT NULL;
