CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"size_bytes" bigint NOT NULL,
	"object_key" text NOT NULL,
	"duration_ms" integer NOT NULL
);
