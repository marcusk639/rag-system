-- Add a GIN index on documents.metadata so the post-filter step of
-- hybridSearch (in queries.ts) doesn't sequential-scan the documents table
-- when callers pass a metadata filter. Default `jsonb_ops` opclass (not
-- jsonb_path_ops) so it accelerates `@>` containment.
--
-- Correction (2026-07-09, see H2 in docs/ISSUES-AND-OPTIMIZATIONS.md): the
-- original version of this comment claimed jsonb_ops accelerates
-- `->>'key' = ANY(...)`, which the query used at the time. That's wrong —
-- jsonb_ops GIN indexes support `@>`/`?`/`?&`/`?|`, not `->>` text
-- extraction; verified via EXPLAIN ANALYZE with enable_seqscan=off that the
-- old `->>` query forced a seq scan regardless of this index's presence.
-- queries.ts's metadataFilter now builds `@>` containment conditions
-- instead, which DO hit this index (confirmed: Bitmap Index Scan). This
-- comment edit does not change the executed SQL (CREATE INDEX is unchanged)
-- and is safe on an already-applied migration — drizzle-orm's migrator only
-- ever writes this file's content hash for its own bookkeeping row, it never
-- reads it back to validate against a previously-recorded hash.

CREATE INDEX IF NOT EXISTS documents_metadata_gin_idx
  ON documents USING gin (metadata);
