-- ============================================================================
-- Initial schema for the RAG system.
--
-- This file is manually authored rather than drizzle-generated because we need
-- to express things Drizzle can't (yet) diff:
--   - HNSW index on a vector column with operator class
--   - tsvector + trigger to auto-maintain the search column
--   - extensions
--
-- Run order: docker/init-db.sql creates extensions, then this file creates
-- the tables, then `drizzle-kit generate` produces incremental migrations
-- for any future schema changes.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
DO $$ BEGIN
  CREATE TYPE source_kind AS ENUM ('sharepoint', 'gdrive', 'gmail', 'outlook', 'custom');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE ingestion_status AS ENUM ('pending', 'running', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ----------------------------------------------------------------------------
-- sources
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind            source_kind NOT NULL,
  name            text NOT NULL,
  config          jsonb NOT NULL,
  cursor          text,
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_kind_idx ON sources (kind);

-- ----------------------------------------------------------------------------
-- documents
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id            uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id          text NOT NULL,
  title                text NOT NULL,
  mime_type            text NOT NULL,
  source_modified_at   timestamptz,
  content_hash         text NOT NULL,
  size_bytes           bigint,
  metadata             jsonb NOT NULL,
  markdown             text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_source_external_idx
  ON documents (source_id, external_id);
CREATE INDEX IF NOT EXISTS documents_source_idx ON documents (source_id);
CREATE INDEX IF NOT EXISTS documents_content_hash_idx ON documents (content_hash);

-- ----------------------------------------------------------------------------
-- chunks — note vector(768) matches Gemini text-embedding-004.
-- To use OpenAI text-embedding-3-small (1536) or -large (3072):
--   ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1536);
--   DROP INDEX chunks_embedding_hnsw_idx;
--   CREATE INDEX chunks_embedding_hnsw_idx ON chunks
--     USING hnsw (embedding vector_cosine_ops);
-- and re-embed all rows.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id           uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal               integer NOT NULL,
  hash                  text NOT NULL,
  text                  text NOT NULL,
  token_count           integer NOT NULL,
  heading_path          jsonb NOT NULL DEFAULT '[]'::jsonb,
  page                  integer,
  embedding             vector(768) NOT NULL,
  embedding_provider    text NOT NULL,
  embedding_model       text NOT NULL,
  tsv                   tsvector,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS chunks_document_ordinal_idx
  ON chunks (document_id, ordinal);
CREATE INDEX IF NOT EXISTS chunks_hash_idx ON chunks (hash);

-- HNSW index for dense ANN search (cosine similarity).
-- m=16, ef_construction=64 are sensible defaults for <1M chunks;
-- bump ef_search at query time for higher recall.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index on the tsvector for fast BM25-style full-text search.
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);

-- Trigger to keep `tsv` in sync with `text`. We use the english dictionary;
-- switch to a multilingual config (or pg_search) for non-English corpora.
--
-- The trigger skips recomputation when NEW.tsv is already set by the caller.
-- This lets bulk-ingest code precompute tsvectors in application space and
-- pass them in the INSERT, avoiding N synchronous `to_tsvector` calls during
-- a batch of N chunks (the per-row cost compounds with HNSW maintenance
-- for large documents). Inserts that omit NEW.tsv still work as before.
CREATE OR REPLACE FUNCTION chunks_tsv_trigger() RETURNS trigger AS $$
BEGIN
  IF NEW.tsv IS NULL THEN
    NEW.tsv := to_tsvector('english', COALESCE(NEW.text, ''));
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_tsv_update ON chunks;
CREATE TRIGGER chunks_tsv_update
  BEFORE INSERT OR UPDATE OF text ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_tsv_trigger();

-- ----------------------------------------------------------------------------
-- ingestion_jobs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id             uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  status                ingestion_status NOT NULL DEFAULT 'pending',
  mode                  text NOT NULL,
  documents_processed   integer NOT NULL DEFAULT 0,
  documents_failed      integer NOT NULL DEFAULT 0,
  chunks_created        integer NOT NULL DEFAULT 0,
  error                 text,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingestion_jobs_source_status_idx
  ON ingestion_jobs (source_id, status);
CREATE INDEX IF NOT EXISTS ingestion_jobs_created_idx
  ON ingestion_jobs (created_at);

-- ----------------------------------------------------------------------------
-- updated_at touch trigger (reused across tables that have it)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sources_touch_updated_at ON sources;
CREATE TRIGGER sources_touch_updated_at
  BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS documents_touch_updated_at ON documents;
CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
