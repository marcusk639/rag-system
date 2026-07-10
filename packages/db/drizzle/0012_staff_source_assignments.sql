-- Direct per-source access grants, alongside the existing per-client model
-- (staff_client_assignments / source_client_assignments). Lets an admin grant
-- a staff member access to a firm-internal source (e.g. firm-sop,
-- firm-research) without inventing a synthetic client row.
--
-- Deliberately a standalone table, not a nullable-client_id sentinel on
-- staff_client_assignments — a sentinel would need a special-cased NULL-match
-- join branch that would grant every "direct" user access to every "direct"
-- source, not a specific per-user-per-source pairing.
CREATE TABLE staff_source_assignments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text NOT NULL,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX ssa_user_source_unique
  ON staff_source_assignments (user_id, source_id);

-- Standalone source_id index so a source deletion (ON DELETE CASCADE above)
-- doesn't force a sequential scan to find referencing rows — mirrors
-- src_client_source_idx on source_client_assignments.
CREATE INDEX ssa_source_idx
  ON staff_source_assignments (source_id);
