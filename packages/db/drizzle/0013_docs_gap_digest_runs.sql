-- Persists the weekly documentation-gap digest aggregate (already computed
-- by aggregateWeakResultEvents in apps/worker/src/handlers/docs-gap-digest.ts)
-- so it's queryable/visible beyond a single structured log line. Tier 1 only:
-- by_endpoint/by_source_group are the same small, display-only aggregates the
-- job already logs -- no question text, hash, or other reversible derivative
-- is stored here or anywhere in this table.
CREATE TABLE docs_gap_digest_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_at timestamptz NOT NULL DEFAULT now(),
  window_since timestamptz NOT NULL,
  window_until timestamptz NOT NULL,
  total_weak_events integer NOT NULL,
  by_endpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_source_group jsonb NOT NULL DEFAULT '{}'::jsonb
);
