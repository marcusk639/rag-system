-- Record where a document's ORIGINAL bytes are stored in the object store, so a
-- cited document can be downloaded as-is. All columns are nullable: existing
-- rows, deployments with object storage disabled, and documents whose upload
-- failed keep storage_key / storage_bucket / original_size_bytes = NULL.
--
-- Hand-authored (not drizzle-kit generated) because drizzle's diff cannot see
-- the HNSW/GIN indexes and tsvector trigger owned by 0000_init.sql and would
-- emit DROP INDEX for them.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS storage_key text,
  ADD COLUMN IF NOT EXISTS storage_bucket text,
  ADD COLUMN IF NOT EXISTS original_size_bytes bigint;
