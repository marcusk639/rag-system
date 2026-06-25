-- Staging table for browser-uploaded files awaiting ingestion. A
-- `POST /sources/:id/documents` writes the original bytes to the object store
-- and records one row here (status 'pending'). The `custom` connector claims
-- these rows on the next sync (pending -> ingested) and feeds each to the
-- ingestion pipeline. Rows cascade-delete with their source.
--
-- Hand-authored (not drizzle-kit generated), idempotent (IF NOT EXISTS), to
-- stay consistent with the other migrations and avoid drizzle's diff touching
-- the HNSW/GIN indexes and tsvector trigger owned by 0000_init.sql.

CREATE TABLE IF NOT EXISTS pending_uploads (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  storage_key text NOT NULL,
  storage_bucket text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_uploads_source_status_idx
  ON pending_uploads (source_id, status);
