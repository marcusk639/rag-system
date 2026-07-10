-- Single-row watermark for the off-host audit-log shipping job
-- (apps/worker/src/handlers/ship-audit-log.ts). A dedicated table rather than
-- overloading `sources.cursor` -- keeps the shipping watermark's lifecycle
-- independent of any single source's sync state. Boolean-sentinel pattern
-- (`id` is always `true`) since this table only ever has one row, NOT
-- uuid_generate_v4().
CREATE TABLE audit_log_shipper_state (
  id boolean PRIMARY KEY DEFAULT true,
  last_shipped_at timestamptz
);
