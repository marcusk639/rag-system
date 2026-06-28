CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_sources" text[],
	"question_hash" text NOT NULL,
	"channel" text NOT NULL,
	"model" text,
	"source_ids" text[] NOT NULL,
	"chunk_ids" text[] NOT NULL,
	"doc_ids" text[] NOT NULL,
	"retrieved_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_principal_kind_idx" ON "audit_log" USING btree ("principal_kind");
