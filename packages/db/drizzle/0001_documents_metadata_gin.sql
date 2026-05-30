-- Add a GIN index on documents.metadata so the post-filter step of
-- hybridSearch (in queries.ts) doesn't sequential-scan the documents table
-- when callers pass a metadata filter. We use the default `jsonb_ops`
-- opclass (not jsonb_path_ops) so it accelerates the `->>'key' = ANY(...)`
-- pattern the API uses; jsonb_path_ops only helps with `@>` containment.

CREATE INDEX IF NOT EXISTS documents_metadata_gin_idx
  ON documents USING gin (metadata);
