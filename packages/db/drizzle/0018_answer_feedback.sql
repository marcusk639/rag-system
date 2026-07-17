ALTER TABLE "audit_log" ADD COLUMN "answer_id" text;
--> statement-breakpoint
CREATE TABLE "answer_feedback" (
    "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
    "answer_id" text NOT NULL,
    "principal_subject" text,
    "rating" text NOT NULL,
    "comment" text,
    "channel" text NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "afb_answer_subject_unique"
    ON "answer_feedback" ("answer_id", "principal_subject") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX "afb_answer_idx" ON "answer_feedback" ("answer_id");
