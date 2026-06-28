-- Migration: identity→scope mapping tables (Phase B / Adoption-Plan Phase 1)
--
-- Maps users to clients (staff_client_assignments) and clients to sources
-- (source_client_assignments). The join of both tables powers
-- resolveSourceIdsForUser(), which BFF/Teams/SMS adapters call to compute
-- the sourceIds for ACL-enforced retrieval.
--
-- Soft-delete only (revoked_at IS NULL = active). Rows are NEVER hard-deleted
-- because §7216 requires that grant history be reconstructible for audit.

CREATE TABLE IF NOT EXISTS "staff_client_assignments" (
  "id"          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  "user_id"     text        NOT NULL,
  "client_id"   text        NOT NULL,
  "granted_at"  timestamptz NOT NULL DEFAULT now(),
  "granted_by"  text        NOT NULL,
  "revoked_at"  timestamptz
);

CREATE INDEX IF NOT EXISTS "sca_user_idx"   ON "staff_client_assignments"("user_id");
CREATE INDEX IF NOT EXISTS "sca_client_idx" ON "staff_client_assignments"("client_id");

CREATE TABLE IF NOT EXISTS "source_client_assignments" (
  "id"         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  "source_id"  uuid        NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
  "client_id"  text        NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "src_client_source_idx"  ON "source_client_assignments"("source_id");
CREATE INDEX IF NOT EXISTS "src_client_client_idx"  ON "source_client_assignments"("client_id");
