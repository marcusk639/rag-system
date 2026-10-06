-- Optional retention of question/answer TEXT on audit_log, off unless
-- AUDIT_LOG_CONTENT=full. Nullable with no default and no backfill: existing
-- rows keep NULL, and a deployment that never turns the setting on is
-- byte-for-byte unchanged.
--
-- These two columns are the ONLY ones in audit_log that can hold client
-- content. `getAuditLogRowsSince` projects columns explicitly so they are
-- never shipped to AUDIT_SINK_WEBHOOK_URL; shipping them would make an
-- internal record a third-party disclosure, which is what §7216 governs.
ALTER TABLE "audit_log" ADD COLUMN "question_text" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "answer_text" text;
