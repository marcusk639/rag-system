-- De-duplicate any (user_id, client_id) rows that may already exist from the
-- TOCTOU race in grantClientAccess (fixed in the same change that introduces
-- this unique index) before the index is created below. The table's intended
-- design is one row per (user_id, client_id) pair, kept current via upsert
-- (grant/re-grant updates the row in place; revoke sets revoked_at) — a
-- pre-existing duplicate pair is a bug artifact, not meaningful grant history,
-- so collapsing it to a single row does not violate the "never hard-delete"
-- soft-delete policy that governs revocation. For each duplicate group, keep
-- exactly one row: prefer an active grant (revoked_at IS NULL) over a revoked
-- one, then the most recently granted row, then the highest id as a final
-- deterministic tie-break. Safe to re-run: a table with no duplicate pairs
-- has nothing matching rn > 1, so this is a no-op.
DELETE FROM staff_client_assignments t
USING (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, client_id
      ORDER BY
        (revoked_at IS NULL) DESC,
        granted_at DESC,
        id DESC
    ) AS rn
  FROM staff_client_assignments
) ranked
WHERE t.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS sca_user_client_unique
  ON staff_client_assignments (user_id, client_id);
