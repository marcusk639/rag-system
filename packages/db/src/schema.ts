import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  bigint,
  real,
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

/** §7216 / GLBA data classification for a source.
 *  `client_confidential` ingestion is refused at the pipeline level. */
export const dataClassEnum = pgEnum("data_class", [
  "general",
  "research",
  "sop",
  "client_confidential",
]);
export type DataClass = (typeof dataClassEnum.enumValues)[number];

/** Librarian-facing content-type taxonomy for a document (Phase 2 of
 *  docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md): "is this an SOP, a
 *  template, a research note, or an example file." Distinct from
 *  `dataClassEnum`/`DocumentClass`, which gate legal/regulatory access — do
 *  NOT conflate the two. */
export const contentTypeEnum = pgEnum("content_type", [
  "sop",
  "template",
  "research_note",
  "example",
  "general",
]);
export type ContentType = (typeof contentTypeEnum.enumValues)[number];

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
    /** §7216/GLBA classification — controls ingestion gate and retrieval filter. */
    dataClass: dataClassEnum("data_class").notNull().default("general"),
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
    /**
     * Object-store location of the ORIGINAL file bytes, so a cited document can
     * be downloaded as-is. Null when originals are not stored (object storage
     * disabled, an upload failure, or a document ingested before storage was
     * enabled).
     */
    storageKey: text("storage_key"),
    storageBucket: text("storage_bucket"),
    originalSizeBytes: bigint("original_size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Librarian-facing content-type taxonomy (Phase 2 governance work).
     * Null = unclassified — no default guess is forced on backfill. Distinct
     * from `dataClass`/`DocumentClass`, which gate legal/regulatory access.
     *
     * NOT wired into `upsertDocument`'s INSERT/ON CONFLICT DO UPDATE SET
     * column list (queries.ts) — that omission is intentional so a re-sync of
     * an unchanged source file never clobbers a human-set value here.
     */
    contentType: contentTypeEnum("content_type"),
    /** Maintainer's IdP/user id (opaque string — not a DB FK), matching the
     *  `staffClientAssignments.userId` precedent. Same re-sync-safety rule as
     *  `contentType` applies: never add to `upsertDocument`'s SET clause. */
    ownerId: text("owner_id"),
    /** Free-text lifecycle status: "draft" | "active" | "archived" — matches
     *  the free-text-status precedent (`ingestLog.action`, `pendingUploads.status`)
     *  rather than a third pgEnum. Same re-sync-safety rule as `contentType`. */
    lifecycleStatus: text("lifecycle_status").notNull().default("active"),
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
    // ⚠️ SOURCE-OF-TRUTH WARNING — DO NOT "fix" the diff by deleting indexes.
    // ────────────────────────────────────────────────────────────────────────
    // The two indexes that actually MAKE RETRIEVAL WORK are NOT declared here:
    //   • chunks_embedding_hnsw_idx — HNSW, vector_cosine_ops (dense ANN search)
    //   • chunks_tsv_idx            — GIN on `tsv`            (sparse full-text)
    // Plus the `chunks_tsv_update` trigger + `chunks_tsv_trigger()` function
    // that populate `tsv`.
    //
    // These three objects are OWNED BY `packages/db/drizzle/0000_init.sql`
    // (lines ~100–122), because Drizzle cannot express HNSW opclass options or
    // a plpgsql trigger. They are therefore INVISIBLE to Drizzle's model, so a
    // `drizzle-kit generate` will diff them as "removed" and emit `DROP INDEX`.
    // Dropping them throws NO error and breaks NO test — dense + sparse search
    // just collapse to sequential scans and queries quietly get slow.
    //
    // DO NOT add these to the schema to "silence" the diff, and DO NOT apply a
    // generated migration that drops them. The migration is the owner. The
    // regression guard `assertRequiredIndexes()` (see required-indexes.ts,
    // wired into api/mcp/worker startup) fails fast if either index ever goes
    // missing — keep `REQUIRED_SEARCH_INDEXES` in sync with 0000_init.sql.
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
// pending_uploads — staging rows for browser-uploaded files awaiting ingestion.
// A `POST /sources/:id/documents` writes the original bytes to the object store
// and records one row here (status "pending"). The `custom` connector claims
// these rows on the next sync (pending -> ingested), turning each into a
// SourceDocument the pipeline parses/chunks/embeds like any other document.
// Scoped to `custom` sources only.
// ----------------------------------------------------------------------------
export const pendingUploads = pgTable(
  "pending_uploads",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** Stable id threaded to the ingested document's `externalId` (UUID). */
    externalId: text("external_id").notNull(),
    /** Original filename, used as the document title in citations. */
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Object-store key + bucket where the original bytes were written. */
    storageKey: text("storage_key").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    /** "pending" | "ingested" | "failed". Claimed pending -> ingested on sync. */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceStatusIdx: index("pending_uploads_source_status_idx").on(
      table.sourceId,
      table.status,
    ),
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
export type PendingUpload = typeof pendingUploads.$inferSelect;

// ----------------------------------------------------------------------------
// audit_log — one row per ask()/askStream()/search() call for §7216 /
// Circular 230 accountability. `endpoint` discriminates which one. Written
// async (fire-and-forget); does NOT block the response.
// ----------------------------------------------------------------------------
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    /** "admin" | "scoped" */
    principalKind: text("principal_kind").notNull(),
    /** Null for admin principals; source-ID list for scoped ones. */
    principalSources: text("principal_sources").array(),
    /**
     * Nullable — the AAD oid when the request was authenticated via a
     * per-user scope-assertion JWT (`InternalScopeAuthProvider`); null for
     * admin/static-token/OIDC-non-subject principals. Stores the raw oid
     * (not hashed) per CR-10's expectation of per-user identity in
     * structured retrieval logs — distinct from `questionHash`, which
     * protects question CONTENT, not identity.
     */
    principalSubject: text("principal_subject"),
    /** SHA-256 of the question text (no raw PII stored here). */
    questionHash: text("question_hash").notNull(),
    /** "api" | "mcp" */
    channel: text("channel").notNull(),
    /** Generation model identifier (null when not applicable). */
    model: text("model"),
    sourceIds: text("source_ids").array().notNull(),
    chunkIds: text("chunk_ids").array().notNull(),
    docIds: text("doc_ids").array().notNull(),
    retrievedCount: integer("retrieved_count").notNull(),
    /** "ask" | "search" — discriminates which endpoint produced this row. */
    endpoint: text("endpoint").notNull().default("ask"),
    /** Top retrieval result's combined score (0-1); null when nothing retrieved. */
    topScore: real("top_score"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    createdIdx: index("audit_log_created_idx").on(table.createdAt),
    principalKindIdx: index("audit_log_principal_kind_idx").on(
      table.principalKind,
    ),
  }),
);
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;

// ----------------------------------------------------------------------------
// ingest_log — one row per document ingestion attempt, regardless of outcome.
// Written by the pipeline immediately after upsert (action="ingested") or on
// ClassBlockedError before re-throwing (action="blocked"). Provides a durable
// audit trail of what was indexed and what was rejected, keyed by source.
// ----------------------------------------------------------------------------
export const ingestLog = pgTable(
  "ingest_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /**
     * Null when the document was blocked before a DB row was created
     * (ClassBlockedError fires before upsertDocument).
     */
    docId: uuid("doc_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    /** Connector-assigned stable id — lets callers cross-reference the source. */
    externalId: text("external_id").notNull(),
    /** DocumentClass at ingest time (A | B | C | D). */
    docClass: text("doc_class").notNull(),
    /** "ingested" | "blocked" */
    action: text("action").notNull(),
    /** Non-null only when action = "blocked". */
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceIdx: index("ingest_log_source_idx").on(table.sourceId),
    createdIdx: index("ingest_log_created_idx").on(table.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Identity → scope mapping (Phase B / Adoption-Plan Phase 1)
// ---------------------------------------------------------------------------
// Answers: "which sources may this user access?"
//
// staff_client_assignments  — user  ↔ client  (who works which engagements)
// source_client_assignments — source ↔ client  (which sources belong to which client)
//
// resolveSourceIdsForUser joins these two tables to return the source_ids a
// given userId may query. Soft-delete only (revoked_at) — §7216 requires
// that grant history be reconstructible; rows are NEVER hard-deleted.
// ---------------------------------------------------------------------------

export const staffClientAssignments = pgTable(
  "staff_client_assignments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    /** PropelAuth/IdP userId (opaque string — not a DB FK). */
    userId: text("user_id").notNull(),
    /** Firm-defined client identifier (e.g. "smithco", "acme-2024"). */
    clientId: text("client_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** userId of the admin who granted access — audit trail. */
    grantedBy: text("granted_by").notNull(),
    /** Null = active. Set to now() to revoke. Never DELETE. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    userIdx: index("sca_user_idx").on(table.userId),
    clientIdx: index("sca_client_idx").on(table.clientId),
    scaUserClientUnique: uniqueIndex("sca_user_client_unique").on(
      table.userId,
      table.clientId,
    ),
  }),
);

export const sourceClientAssignments = pgTable(
  "source_client_assignments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** Must match clientId values used in staff_client_assignments. */
    clientId: text("client_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceIdx: index("src_client_source_idx").on(table.sourceId),
    clientIdx: index("src_client_client_idx").on(table.clientId),
  }),
);

/**
 * Direct per-source access grants — a staff member ↔ source pairing that
 * bypasses the client-routed model entirely. Exists for firm-internal
 * sources (e.g. firm-sop, firm-research) that have no client to route
 * through. NOT a nullable-clientId sentinel on staffClientAssignments: that
 * would need a special-cased NULL-match join branch that would grant every
 * "direct" user access to every "direct" source, not a specific
 * per-user-per-source pairing. Soft-delete only (revoked_at), same §7216
 * reconstructibility rule as staffClientAssignments.
 */
export const staffSourceAssignments = pgTable(
  "staff_source_assignments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuid_generate_v4()`),
    /** PropelAuth/IdP userId (opaque string — not a DB FK). */
    userId: text("user_id").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** userId of the admin who granted access — audit trail. */
    grantedBy: text("granted_by").notNull(),
    /** Null = active. Set to now() to revoke. Never DELETE. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    ssaUserSourceUnique: uniqueIndex("ssa_user_source_unique").on(
      table.userId,
      table.sourceId,
    ),
    // Deliberate deviation from strictly mirroring staffClientAssignments
    // (which has no equivalent standalone index): source_id carries an ON
    // DELETE CASCADE FK, so a standalone index here avoids a sequential scan
    // on every source deletion (mirrors src_client_source_idx on
    // sourceClientAssignments). No separate user_id-only index — the
    // composite unique index above already leads with user_id, so lookups
    // by user_id alone use it via leftmost-prefix matching.
    sourceIdx: index("ssa_source_idx").on(table.sourceId),
  }),
);

// ----------------------------------------------------------------------------
// docs_gap_digest_runs — one row per weekly documentation-gap digest tick
// (apps/worker/src/handlers/docs-gap-digest.ts), persisting the exact
// DocsGapDigestSummary aggregate the job already logs so it's queryable and
// admin-visible instead of existing only as a structured log line.
//
// Tier 1 only, deliberately: by_endpoint/by_source_group are small,
// display-only count aggregates -- never raw question text, a hash, or any
// other reversible derivative. Do NOT add a column here that could
// reconstruct what was asked; that is a separate, out-of-scope policy
// decision (see docs/TWK-MANUAL-RUNBOOK.md).
// ----------------------------------------------------------------------------
/**
 * Structurally mirrors `SourceGroupSummary` in
 * `apps/worker/src/handlers/docs-gap-digest.ts`, redeclared here rather than
 * imported so `@rag/db` doesn't take a dependency on an app package.
 */
export interface DocsGapDigestSourceGroup {
  sourceIds: string[];
  count: number;
  byEndpoint: Record<string, number>;
}

export const docsGapDigestRuns = pgTable("docs_gap_digest_runs", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v4()`),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  windowSince: timestamp("window_since", { withTimezone: true }).notNull(),
  windowUntil: timestamp("window_until", { withTimezone: true }).notNull(),
  totalWeakEvents: integer("total_weak_events").notNull(),
  /** Keyed by endpoint ("ask" | "search") -> count. */
  byEndpoint: jsonb("by_endpoint")
    .notNull()
    .default({})
    .$type<Record<string, number>>(),
  /** Array of source-id-group summaries -- sourceIds/count/byEndpoint. */
  bySourceGroup: jsonb("by_source_group")
    .notNull()
    .default({})
    .$type<DocsGapDigestSourceGroup[]>(),
});
export type DocsGapDigestRun = typeof docsGapDigestRuns.$inferSelect;
export type NewDocsGapDigestRun = typeof docsGapDigestRuns.$inferInsert;

export type StaffClientAssignment = typeof staffClientAssignments.$inferSelect;
export type NewStaffClientAssignment =
  typeof staffClientAssignments.$inferInsert;

export type SourceClientAssignment =
  typeof sourceClientAssignments.$inferSelect;
export type NewSourceClientAssignment =
  typeof sourceClientAssignments.$inferInsert;

export type StaffSourceAssignment = typeof staffSourceAssignments.$inferSelect;
export type NewStaffSourceAssignment =
  typeof staffSourceAssignments.$inferInsert;

export type NewIngestLog = typeof ingestLog.$inferInsert;
export type NewPendingUpload = typeof pendingUploads.$inferInsert;
