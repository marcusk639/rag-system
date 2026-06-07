import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  bigint,
  vector,
  index,
  uniqueIndex,
  pgEnum,
  customType,
} from "drizzle-orm/pg-core";
import { EMBEDDING_COLUMN_DIMENSIONS } from "./embedding-dimensions.js";

// ----------------------------------------------------------------------------
// tsvector custom type — Drizzle has no native tsvector primitive, so we
// declare it ourselves. The column is populated by a trigger (see migration).
// ----------------------------------------------------------------------------
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ----------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------
export const sourceKindEnum = pgEnum("source_kind", [
  "sharepoint",
  "gdrive",
  "gmail",
  "outlook",
  "custom",
]);

export const ingestionStatusEnum = pgEnum("ingestion_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

// ----------------------------------------------------------------------------
// sources — one row per configured external system (a SharePoint site, a
// Gmail mailbox, a Drive folder, etc.)
// ----------------------------------------------------------------------------
export const sources = pgTable(
  "sources",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    kind: sourceKindEnum("kind").notNull(),
    name: text("name").notNull(),
    /** Connector-specific config (tenant id, folder id, query filter, etc.) */
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    /** Opaque delta cursor for incremental sync. Null = next sync is full. */
    cursor: text("cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    kindIdx: index("sources_kind_idx").on(table.kind),
  }),
);

// ----------------------------------------------------------------------------
// documents — one row per ingested logical document (file, email, etc.)
// (sourceId, externalId) is unique so re-ingesting the same source document
// updates rather than duplicates.
// ----------------------------------------------------------------------------
export const documents = pgTable(
  "documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** Stable id assigned by the source (drive file id, message id, etc.) */
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    mimeType: text("mime_type").notNull(),
    /** ISO timestamp the source reports as "last modified" */
    sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
    /** SHA-256 of the parsed markdown — if unchanged, skip re-chunking + re-embedding */
    contentHash: text("content_hash").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** Free-form metadata (path, author, url, email fields, etc.) */
    metadata: jsonb("metadata").notNull().$type<Record<string, unknown>>(),
    /** Cached parsed markdown for quick retrieval of full document */
    markdown: text("markdown").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceExternalIdx: uniqueIndex("documents_source_external_idx").on(
      table.sourceId,
      table.externalId,
    ),
    sourceIdx: index("documents_source_idx").on(table.sourceId),
    contentHashIdx: index("documents_content_hash_idx").on(table.contentHash),
  }),
);

// ----------------------------------------------------------------------------
// chunks — one row per embedded slice of a document. The `embedding` column
// is a pgvector type; dimension is 768 to match Gemini text-embedding-004.
//
// IMPORTANT: if you change embedding model dimensions, this column needs to
// be re-typed and the HNSW index rebuilt. See migration file 0000_init.sql
// for the manual statements (Drizzle can't yet diff vector dimensions cleanly).
// ----------------------------------------------------------------------------
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** Position within the document (0-indexed) */
    ordinal: integer("ordinal").notNull(),
    /** SHA-256 of the chunk text — dedupe key */
    hash: text("hash").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull(),
    /** Heading path at this chunk's location (["Intro", "Setup"]) */
    headingPath: jsonb("heading_path").$type<string[]>().notNull().default([]),
    /** PDF/Word page number, when known */
    page: integer("page"),
    /**
     * Dense vector — 768 dims for Gemini text-embedding-004.
     * NOT NULL: the pipeline always embeds before inserting (see
     * @rag/ingestion/src/pipeline.ts — embedBatch runs before replaceChunks).
     * Keeping this nullable would mean dense retrieval silently skips chunks
     * whose embedding step failed without any other signal.
     */
    embedding: vector("embedding", {
      dimensions: EMBEDDING_COLUMN_DIMENSIONS,
    }).notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    /** tsvector for BM25-style sparse retrieval — auto-populated by trigger */
    tsv: tsvector("tsv"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    documentIdx: index("chunks_document_idx").on(table.documentId),
    documentOrdinalIdx: uniqueIndex("chunks_document_ordinal_idx").on(
      table.documentId,
      table.ordinal,
    ),
    hashIdx: index("chunks_hash_idx").on(table.hash),
  }),
);

// ----------------------------------------------------------------------------
// ingestion_jobs — bookkeeping for sync runs. (pg-boss owns its own job
// state in the `pgboss` schema; this is human-readable run history.)
// ----------------------------------------------------------------------------
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    status: ingestionStatusEnum("status").notNull().default("pending"),
    /** "full" or "incremental" */
    mode: text("mode").notNull(),
    documentsProcessed: integer("documents_processed").notNull().default(0),
    documentsFailed: integer("documents_failed").notNull().default(0),
    chunksCreated: integer("chunks_created").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceStatusIdx: index("ingestion_jobs_source_status_idx").on(
      table.sourceId,
      table.status,
    ),
    createdIdx: index("ingestion_jobs_created_idx").on(table.createdAt),
  }),
);

// ----------------------------------------------------------------------------
// Inferred row types — what queries return / what callers insert
// ----------------------------------------------------------------------------
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
