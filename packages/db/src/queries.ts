import { and, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  answerFeedback,
  auditLog,
  auditLogShipperState,
  chunks,
  docsGapDigestRuns,
  documents,
  ingestLog,
  ingestionJobs,
  pendingUploads,
  sources,
  type AuditLog,
  type DocsGapDigestRun,
  type DocsGapDigestSourceGroup,
  type NewAnswerFeedback,
  type NewAuditLog,
  type NewChunk,
  type NewDocsGapDigestRun,
  type NewDocument,
  type NewIngestionJob,
  type NewIngestLog,
  type NewPendingUpload,
  type NewSource,
  type PendingUpload,
  type Source,
} from "./schema.js";

// ============================================================================
// Liveness
// ============================================================================

/**
 * Cheap connectivity check for readiness probes. Throws if the DB pool can't
 * round-trip a `SELECT 1`. Exists so apps don't need to import drizzle-orm
 * directly just to run a one-off ping.
 */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`SELECT 1`);
}

// ============================================================================
// Sources
// ============================================================================

export async function createSource(db: Db, row: NewSource) {
  const [created] = await db.insert(sources).values(row).returning();
  if (!created) throw new Error("createSource: insert returned no row");
  return created;
}

export async function getSource(db: Db, id: string) {
  const [row] = await db.select().from(sources).where(eq(sources.id, id));
  return row;
}

export async function listSources(db: Db) {
  return db.select().from(sources).orderBy(sources.createdAt);
}

/**
 * Permanently delete a source and all associated rows (documents, chunks,
 * ingestion_jobs, pending_uploads). All child tables carry
 * `ON DELETE CASCADE → sources`, so a single statement handles everything.
 *
 * Returns `true` when a row was found and deleted, `false` when no source with
 * that id exists — the caller decides whether that warrants an error.
 */
export interface PurgeSourceResult {
  /** False when no source with that id existed. */
  deleted: boolean;
  /**
   * Logical object-store keys of the documents this purge removed, for the
   * caller to delete from the bucket.
   *
   * Returned rather than deleted here because @rag/db must not depend on
   * ObjectStore, and because only this function can see the rows: the cascade
   * removes them, so the keys are unrecoverable a moment later. That is exactly
   * how 1,747 objects (~499 MB) were orphaned in production — the DB rows went
   * and nothing remembered which files had belonged to them.
   */
  storageKeys: string[];
}

export async function purgeSource(
  db: Db,
  id: string,
): Promise<PurgeSourceResult> {
  // Read the keys BEFORE the delete: `documents` has ON DELETE CASCADE to
  // `sources`, so after the delete there is nothing left to ask.
  const rows = await db
    .select({ storageKey: documents.storageKey })
    .from(documents)
    .where(eq(documents.sourceId, id));

  const deleted = await db
    .delete(sources)
    .where(eq(sources.id, id))
    .returning({ id: sources.id });

  return {
    deleted: deleted.length > 0,
    // Null for documents ingested before storage was enabled, or whose upload
    // failed — those have nothing to clean up.
    storageKeys: rows
      .map((r) => r.storageKey)
      .filter((k): k is string => k !== null),
  };
}

/**
 * Persist the delta cursor for a source. CURSOR ONLY — this no longer stamps
 * `lastSyncedAt`. It runs after every page of an ingestion run (including
 * intermediate pages of a multi-page sync), so it must NOT advance the
 * user-visible "last synced" signal mid-sync. `lastSyncedAt` is stamped exactly
 * once, on completion, via `markSourceSynced` (called from the worker).
 */
export async function updateSourceCursor(
  db: Db,
  id: string,
  cursor: string | null,
) {
  await db.update(sources).set({ cursor }).where(eq(sources.id, id));
}

/**
 * Stamp `lastSyncedAt = now()` for a source. Call this ONCE, when a sync
 * reaches its terminal/completed state — never per page. Decoupled from
 * `updateSourceCursor` so the per-page cursor write doesn't make the
 * "is it finished?" signal (surfaced via the MCP `list_sources` tool) lie by
 * advancing mid-sync.
 */
export async function markSourceSynced(db: Db, id: string) {
  await db
    .update(sources)
    .set({ lastSyncedAt: new Date() })
    .where(eq(sources.id, id));
}

// ============================================================================
// Documents
// ============================================================================

/**
 * Upsert a document keyed by (sourceId, externalId). Returns the row plus
 * a flag indicating whether content changed — callers use that to decide
 * whether to re-chunk and re-embed.
 */
export async function upsertDocument(
  db: Db,
  row: NewDocument,
): Promise<{ id: string; contentChanged: boolean }> {
  // Race-safe single-statement upsert. Replaces the previous SELECT-then-
  // INSERT pattern that had a window during which two concurrent workers
  // for the same source could collide on the (source_id, external_id)
  // unique index and surface a constraint violation.
  //
  // The trick: a CTE `prev` snapshots the existing row's hash BEFORE the
  // upserting CTE runs. All CTEs in a single statement read the same
  // snapshot, so `prev` sees the pre-upsert state even though the upsert
  // happens in the same statement. `xmax = 0` after RETURNING means the
  // row was freshly inserted (no UPDATE happened) — treat as content-changed.
  const result = await db.execute<{ id: string; content_changed: boolean }>(sql`
    WITH prev AS (
      SELECT content_hash
      FROM documents
      WHERE source_id = ${row.sourceId} AND external_id = ${row.externalId}
    ),
    upserted AS (
      INSERT INTO documents (
        source_id, external_id, title, mime_type, source_modified_at,
        content_hash, size_bytes, metadata, markdown
      )
      VALUES (
        ${row.sourceId}, ${row.externalId}, ${row.title}, ${row.mimeType},
        ${row.sourceModifiedAt ?? null}, ${row.contentHash},
        ${row.sizeBytes ?? null}, ${JSON.stringify(row.metadata)}::jsonb,
        ${row.markdown}
      )
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        title              = EXCLUDED.title,
        mime_type          = EXCLUDED.mime_type,
        source_modified_at = EXCLUDED.source_modified_at,
        content_hash       = EXCLUDED.content_hash,
        size_bytes         = EXCLUDED.size_bytes,
        metadata           = EXCLUDED.metadata,
        markdown           = EXCLUDED.markdown
      RETURNING id, xmax
    )
    SELECT
      u.id,
      (
        u.xmax = 0                                      -- fresh insert
        OR (SELECT content_hash FROM prev) IS DISTINCT FROM ${row.contentHash}
      ) AS content_changed
    FROM upserted u
  `);

  const head = result.rows[0];
  if (!head) throw new Error("upsertDocument: no row returned");
  return { id: head.id, contentChanged: head.content_changed };
}

export async function getDocument(db: Db, id: string) {
  const [row] = await db.select().from(documents).where(eq(documents.id, id));
  return row;
}

/** One row of the corpus walk. `markdown` is omitted unless asked for — the
 *  full text of ~858 documents does not belong in memory by default. */
export interface DocumentSummary {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  mimeType: string;
  sourceModifiedAt: Date | null;
  sizeBytes: number | null;
  /** SHA-256 of the parsed markdown. Lets a caller detect corpus drift. */
  contentHash: string;
  metadata: Record<string, unknown>;
  /** Present only when `includeMarkdown` was set. */
  markdown?: string;
}

export interface ListDocumentsOptions {
  /** Restrict to one source. Omit to walk every source. */
  sourceId?: string;
  /** Page size. Default 100. */
  limit?: number;
  /**
   * Keyset cursor — pass the previous page's last `id`. Keyset rather than
   * OFFSET so a long walk stays O(1) per page and cannot skip or repeat rows
   * if the table changes underneath it.
   */
  afterId?: string;
  /** Include the parsed markdown. Off by default; see `DocumentSummary`. */
  includeMarkdown?: boolean;
}

/**
 * Walk the indexed corpus, one page at a time.
 *
 * Exists for corpus-level analysis — claim extraction for the corpus-grounded
 * eval tier, and the client-identifier screen that ISS-05 calls "the real gate"
 * (see `docs/EVAL-CORPUS-GROUND-TRUTH.md`). Nothing else in the system needs to
 * enumerate documents; ingestion addresses them by `externalId` and retrieval
 * reaches them through `hybridSearch`.
 *
 * ⚠ **Callers walking production must use `createReadOnlyDb`.** This function is
 * read-only in itself, but the surrounding script is the risk: the only existing
 * real-embedder runner (`tests/e2e/src/eval/run-real-eval.ts`) calls
 * `truncateAll`, and it is the obvious template to copy. See C3 in
 * `docs/ISSUES-AND-OPTIMIZATIONS.md`.
 *
 * Ordered by `id` so the keyset cursor is total and stable.
 */
export async function listDocuments(
  db: Db,
  opts: ListDocumentsOptions = {},
): Promise<DocumentSummary[]> {
  const limit = opts.limit ?? 100;

  const conditions = [];
  if (opts.sourceId) conditions.push(eq(documents.sourceId, opts.sourceId));
  if (opts.afterId) conditions.push(gt(documents.id, opts.afterId));

  const base = {
    id: documents.id,
    sourceId: documents.sourceId,
    externalId: documents.externalId,
    title: documents.title,
    mimeType: documents.mimeType,
    sourceModifiedAt: documents.sourceModifiedAt,
    sizeBytes: documents.sizeBytes,
    contentHash: documents.contentHash,
    metadata: documents.metadata,
  };

  const rows = await db
    .select(
      opts.includeMarkdown ? { ...base, markdown: documents.markdown } : base,
    )
    .from(documents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(documents.id)
    .limit(limit);

  return rows as DocumentSummary[];
}

/**
 * Convenience wrapper over `listDocuments` that yields every document, paging
 * transparently. Prefer this for a full-corpus walk — it keeps at most one page
 * in memory rather than materializing the whole corpus.
 */
export async function* iterateDocuments(
  db: Db,
  opts: Omit<ListDocumentsOptions, "afterId"> = {},
): AsyncGenerator<DocumentSummary> {
  const limit = opts.limit ?? 100;
  let afterId: string | undefined;

  for (;;) {
    const page = await listDocuments(db, { ...opts, limit, afterId });
    if (page.length === 0) return;
    for (const row of page) yield row;
    if (page.length < limit) return;
    afterId = page[page.length - 1]!.id;
  }
}

/** Total document count, optionally scoped to one source. */
export async function countDocuments(
  db: Db,
  opts: { sourceId?: string } = {},
): Promise<number> {
  const result = await db
    .select({ n: sql<string>`count(*)` })
    .from(documents)
    .where(opts.sourceId ? eq(documents.sourceId, opts.sourceId) : undefined);
  return Number(result[0]?.n ?? 0);
}

export async function deleteDocumentsByExternalIds(
  db: Db,
  sourceId: string,
  externalIds: string[],
) {
  if (externalIds.length === 0) return 0;
  const result = await db
    .delete(documents)
    .where(
      and(
        eq(documents.sourceId, sourceId),
        inArray(documents.externalId, externalIds),
      ),
    );
  return result.rowCount ?? 0;
}

// ============================================================================
// Chunks
// ============================================================================

/**
 * Replace all chunks for a document. Atomic: deletes existing rows then
 * inserts the new set in a single transaction. Use this whenever a document's
 * content has changed; it guarantees no orphan/stale chunks survive.
 */
export async function replaceChunks(
  db: Db,
  documentId: string,
  newChunks: NewChunk[],
) {
  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.documentId, documentId));
    if (newChunks.length > 0) {
      // Insert in batches to avoid hitting the parameter limit on huge docs.
      const batchSize = 200;
      for (let i = 0; i < newChunks.length; i += batchSize) {
        await tx.insert(chunks).values(newChunks.slice(i, i + batchSize));
      }
    }
  });
}

/**
 * Whether a document currently has any chunk rows.
 *
 * Used by the ingestion pipeline to detect documents that were upserted
 * (recording their `content_hash`) but never produced chunks — e.g. a prior
 * run embedded-failed (429/credit exhaustion) AFTER the document row was
 * written. On the next sync the hash matches, so the pipeline would normally
 * short-circuit and skip embedding forever, leaving the document permanently
 * un-retrievable. Checking for chunk presence lets us re-embed those stragglers.
 */
export async function documentHasChunks(
  db: Db,
  documentId: string,
): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${chunks} WHERE ${chunks.documentId} = ${documentId}
    ) AS exists
  `);
  return result.rows[0]?.exists ?? false;
}

/**
 * Whether a document currently has its original bytes recorded in object
 * storage.
 *
 * Used by the ingestion pipeline to detect documents whose `content_hash` is
 * up to date but whose `storage_key` never got set — e.g. a prior run's
 * object-store upload failed, or the process was killed between writing the
 * content hash and writing the storage columns (two separate statements, not
 * one transaction). Without this check, an unchanged-hash document would
 * short-circuit forever and never get a working download link, even after
 * the underlying issue is fixed — the only way out would be forcing every
 * document's hash to look "changed" (e.g. deleting and recreating the source).
 */
export async function documentHasStorage(
  db: Db,
  documentId: string,
): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${documents}
      WHERE ${documents.id} = ${documentId} AND ${documents.storageKey} IS NOT NULL
    ) AS exists
  `);
  return result.rows[0]?.exists ?? false;
}

/**
 * Delete a document by its source-scoped external ID. The `chunks` FK is
 * `ON DELETE CASCADE`, so removing the document also removes its chunks — this
 * is how delta tombstones (a file deleted in the source) are reconciled so the
 * corpus stops returning stale content. Returns true when a row was removed.
 */
export async function deleteDocumentByExternalId(
  db: Db,
  sourceId: string,
  externalId: string,
): Promise<{ deleted: boolean; storageKey: string | null }> {
  const result = await db.execute<{
    id: string;
    storage_key: string | null;
  }>(sql`
    DELETE FROM ${documents}
    WHERE ${documents.sourceId} = ${sourceId}
      AND ${documents.externalId} = ${externalId}
    RETURNING ${documents.id} AS id, ${documents.storageKey} AS storage_key
  `);
  const row = result.rows[0];
  return {
    deleted: result.rows.length > 0,
    storageKey: row?.storage_key ?? null,
  };
}

/**
 * Record where a document's original bytes were stored. Called after a
 * successful object-store upload so the download route can serve the original.
 * Kept separate from `upsertDocument` so a storage failure never blocks the
 * text-ingestion path (the row is upserted first; storage columns are filled
 * in afterwards, or left null).
 */
export async function setDocumentStorage(
  db: Db,
  documentId: string,
  storage: {
    storageKey: string;
    storageBucket: string;
    originalSizeBytes: number;
  },
): Promise<void> {
  await db
    .update(documents)
    .set({
      storageKey: storage.storageKey,
      storageBucket: storage.storageBucket,
      originalSizeBytes: storage.originalSizeBytes,
    })
    .where(eq(documents.id, documentId));
}

// ============================================================================
// Hybrid retrieval — extracted to ./hybrid-search.ts (file-size cap).
// Re-exported here so existing importers of "./queries.js" are unaffected.
// ============================================================================

export { hybridSearch, type HybridSearchOptions } from "./hybrid-search.js";

// ============================================================================
// Ingestion jobs (history table — pg-boss owns runtime job state separately)
// ============================================================================

export async function createIngestionJob(db: Db, row: NewIngestionJob) {
  const [created] = await db.insert(ingestionJobs).values(row).returning();
  if (!created) throw new Error("createIngestionJob: insert returned no row");
  return created;
}

export async function updateIngestionJob(
  db: Db,
  id: string,
  patch: Partial<NewIngestionJob>,
) {
  await db.update(ingestionJobs).set(patch).where(eq(ingestionJobs.id, id));
}

/**
 * Add to an ingestion job's running totals. Used by per-page sync continuations
 * so the single history row accumulates counts across pages instead of the
 * last page overwriting earlier ones.
 *
 * NOTE: additive updates are NOT crash-safe / exactly-once — if the worker
 * crashes after incrementing but before the job is marked complete, pg-boss
 * retries the page and adds its counts again. These counters are observability,
 * not billing; for an exact count, COUNT over `documents`/`chunks` instead.
 */
export async function incrementIngestionJobCounters(
  db: Db,
  id: string,
  delta: {
    documentsProcessed: number;
    documentsFailed: number;
    chunksCreated: number;
  },
): Promise<void> {
  await db.execute(sql`
    UPDATE ${ingestionJobs}
    SET documents_processed = documents_processed + ${delta.documentsProcessed},
        documents_failed = documents_failed + ${delta.documentsFailed},
        chunks_created = chunks_created + ${delta.chunksCreated}
    WHERE id = ${id}
  `);
}

/**
 * Delete an ingestion-job history row by id. Used to clean up a `pending` row
 * that was created optimistically but whose queue hand-off failed (e.g. a
 * duplicate sync rejected by the pg-boss singleton guard), so no orphaned
 * `pending` rows linger for syncs that never ran.
 */
export async function deleteIngestionJob(db: Db, id: string) {
  await db.delete(ingestionJobs).where(eq(ingestionJobs.id, id));
}

// ============================================================================
// Public projections
// ============================================================================

/**
 * Strip the raw `config` blob before a source is returned over the wire. The
 * config carries connector-specific values (site/folder ids, queries, OAuth
 * impersonation subjects) and operator-supplied credential-like values that
 * must never be echoed to a read-token holder.
 *
 * Single-sourced here so every transport (HTTP routes, MCP `list_sources`)
 * sanitizes identically and the projection can't drift.
 */
export function toPublicSource(row: Source): Omit<Source, "config"> {
  const { config: _config, ...safe } = row;
  return safe;
}

// ============================================================================
// Ingestion audit log
// ============================================================================

export interface IngestEventRow {
  sourceId: string;
  /** Null when the document was blocked before a DB row existed. */
  docId: string | null;
  /** Connector-assigned stable document id. */
  externalId: string;
  /** DocumentClass at ingest time (A | B | C | D). */
  docClass: string;
  /**
   * "ingested"    — normal success path.
   * "blocked"     — ClassBlockedError fired before the document was written.
   * "tri-flagged" — TRI patterns detected in parsed content; ingestion
   *   continued but a compliance event was logged. Matched pattern labels
   *   are stored in rejectionReason.
   * "failed"      — fetch/parse/embed error; the document was not indexed and
   *   is retried on the next full sync.
   */
  action: "ingested" | "blocked" | "tri-flagged" | "failed";
  /** Non-null for "blocked" (error message), "tri-flagged" (pattern list) and
   *  "failed" (error name/code — see listRetryableIngestFailures). */
  rejectionReason?: string | null;
}

/**
 * Write one row to `ingest_log`. Called by the ingestion pipeline:
 *   - after a successful `upsertDocument` with action="ingested"
 *   - before re-throwing a ClassBlockedError with action="blocked"
 *   - after TRI patterns are detected in parsed content with action="tri-flagged"
 *
 * Logging errors are NOT swallowed — a failed write is surfaced to the
 * caller so audit integrity issues don't pass silently.
 */
export async function logIngestEvent(
  db: Db,
  row: IngestEventRow,
): Promise<void> {
  const values: NewIngestLog = {
    sourceId: row.sourceId,
    docId: row.docId ?? null,
    externalId: row.externalId,
    docClass: row.docClass,
    action: row.action,
    rejectionReason: row.rejectionReason ?? null,
  };
  await db.insert(ingestLog).values(values);
}

export interface AskEventRow {
  principalKind: "admin" | "scoped";
  principalSources: string[] | null;
  /**
   * The AAD oid from a BFF-asserted scope-assertion JWT's `sub` claim, when
   * present — null for admin/static-token/OIDC-non-subject principals. Raw
   * (not hashed), per CR-10's expectation of per-user identity in structured
   * retrieval logs.
   */
  principalSubject: string | null;
  questionHash: string;
  channel: "api" | "mcp" | "teams";
  model: string | null;
  /**
   * §7216/Circular 230 §10.22 disclosure recordkeeping — which embedding
   * provider/model processed the query text. Always present: both /ask and
   * /search embed the query, even when there's no generation model.
   */
  embeddingProvider: string;
  embeddingModel: string;
  sourceIds: string[];
  chunkIds: string[];
  docIds: string[];
  retrievedCount: number;
  /** "ask" | "search" — discriminates which endpoint produced this row. */
  endpoint: "ask" | "search";
  /** Top retrieval result's combined score (0-1); null when nothing retrieved. */
  topScore: number | null;
  /**
   * The `answerId` returned alongside the answer (`AskResult.answerId`,
   * `packages/services/src/ask.ts`) — links this audit row to any
   * `answer_feedback` votes cast against the same answer. Not a FK (that
   * write is best-effort and may be absent). Required (not optional) at the
   * TypeScript layer so every call site makes an explicit choice: `/ask`
   * always has a real answerId; `/search` has no generated answer and passes
   * `null` — matching the nullable SQL column (pre-0018 rows also have none).
   */
  answerId: string | null;
}

/**
 * Write one row to `audit_log` for every answered ask()/askStream()/search()
 * call. Called asynchronously — failures are logged but do not block the
 * response.
 */
export async function logAskEvent(db: Db, row: AskEventRow): Promise<void> {
  const values: NewAuditLog = {
    principalKind: row.principalKind,
    principalSources: row.principalSources,
    principalSubject: row.principalSubject,
    questionHash: row.questionHash,
    channel: row.channel,
    model: row.model ?? null,
    embeddingProvider: row.embeddingProvider,
    embeddingModel: row.embeddingModel,
    sourceIds: row.sourceIds,
    chunkIds: row.chunkIds,
    docIds: row.docIds,
    retrievedCount: row.retrievedCount,
    endpoint: row.endpoint,
    topScore: row.topScore,
    answerId: row.answerId,
  };
  await db.insert(auditLog).values(values);
}

// ============================================================================
// Answer feedback — Helpful / Not Helpful votes on a given answer.
// ============================================================================

/**
 * Record one Helpful/Not-Helpful vote for `row.answerId`. Upserts on
 * `(answer_id, principal_subject)` (matching `afb_answer_subject_unique`,
 * which is `NULLS NOT DISTINCT` so repeated admin/no-subject votes on the
 * same answer collapse to one row too) — a second vote from the same asker
 * on the same answer overwrites the first (last-write-wins), it never
 * accumulates a second row.
 */
export async function submitAnswerFeedback(
  db: Db,
  row: {
    answerId: string;
    principalSubject: string | null;
    rating: "helpful" | "not_helpful";
    comment: string | null;
    channel: "web" | "teams";
  },
): Promise<void> {
  const values: NewAnswerFeedback = {
    answerId: row.answerId,
    principalSubject: row.principalSubject,
    rating: row.rating,
    comment: row.comment,
    channel: row.channel,
  };
  await db
    .insert(answerFeedback)
    .values(values)
    .onConflictDoUpdate({
      target: [answerFeedback.answerId, answerFeedback.principalSubject],
      set: {
        rating: row.rating,
        comment: row.comment,
        createdAt: sql`now()`,
      },
    });
}

export interface FeedbackStats {
  helpful: number;
  notHelpful: number;
  recentNotHelpful: Array<{
    answerId: string;
    comment: string | null;
    createdAt: Date;
  }>;
}

/**
 * Aggregate Helpful/Not-Helpful vote counts, plus the 20 most recent
 * Not-Helpful votes (with their comment, if any) for triage. `opts.since`
 * restricts to votes cast at or after that time; omitted scans the whole
 * table.
 */
export async function getFeedbackStats(
  db: Db,
  opts: { since?: Date } = {},
): Promise<FeedbackStats> {
  const rows = await db
    .select()
    .from(answerFeedback)
    .where(opts.since ? gte(answerFeedback.createdAt, opts.since) : undefined);
  return {
    helpful: rows.filter((r) => r.rating === "helpful").length,
    notHelpful: rows.filter((r) => r.rating === "not_helpful").length,
    recentNotHelpful: rows
      .filter((r) => r.rating === "not_helpful")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 20)
      .map((r) => ({
        answerId: r.answerId,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
  };
}

export interface WeakResultAuditQuery {
  /** Only rows created at or after this timestamp. */
  since: Date;
  /** `topScore < minScore` counts as weak (null topScore never matches this arm). */
  minScore: number;
}

/**
 * The exact, narrow shape the documentation-gap digest needs — nothing more.
 * Deliberately excludes `questionHash` (and every other `audit_log` column):
 * per Phase 3's privacy design decision, raw question/query content is never
 * stored, so the digest path shouldn't even pull the hash into memory when it
 * has no use for it.
 */
export type WeakResultAuditEvent = Pick<
  AuditLog,
  "sourceIds" | "endpoint" | "retrievedCount" | "chunkIds" | "topScore"
>;

/**
 * Selects `audit_log` rows from the digest window that look like a
 * documentation gap: nothing was retrieved, the chunk list is empty, or the
 * top result's confidence was below `minScore`. Projects only
 * `sourceIds`/`endpoint`/`retrievedCount`/`chunkIds`/`topScore` — never
 * `questionHash` — per Phase 3's privacy design decision (raw question text
 * is never stored/derived, and this path has no reason to fetch its hash
 * either).
 *
 * Aggregation by `sourceIds`/`endpoint` happens in the caller (JS), not here:
 * `sourceIds` is a `text[]` column, so SQL `GROUP BY` can't group by array
 * equality the way a caller wants (see `docs-gap-digest.ts`).
 */
export async function getWeakResultAuditEvents(
  db: Db,
  { since, minScore }: WeakResultAuditQuery,
): Promise<WeakResultAuditEvent[]> {
  return db
    .select({
      sourceIds: auditLog.sourceIds,
      endpoint: auditLog.endpoint,
      retrievedCount: auditLog.retrievedCount,
      chunkIds: auditLog.chunkIds,
      topScore: auditLog.topScore,
    })
    .from(auditLog)
    .where(
      and(
        gte(auditLog.createdAt, since),
        or(
          eq(auditLog.retrievedCount, 0),
          sql`array_length(${auditLog.chunkIds}, 1) IS NULL`,
          lt(auditLog.topScore, minScore),
        ),
      ),
    );
}

export interface DocsGapDigestRunRow {
  windowSince: Date;
  windowUntil: Date;
  totalWeakEvents: number;
  byEndpoint: Record<string, number>;
  bySourceGroup: DocsGapDigestSourceGroup[];
}

/**
 * Persists one row of the already-computed `DocsGapDigestSummary` aggregate
 * (see `aggregateWeakResultEvents` in `docs-gap-digest.ts`) unchanged --
 * Tier 1 only. Never pass question text, a hash, or any other reversible
 * derivative here; `byEndpoint`/`bySourceGroup` are the same small,
 * display-only count aggregates the digest job already logs.
 */
export async function insertDocsGapDigestRun(
  db: Db,
  row: DocsGapDigestRunRow,
): Promise<void> {
  const values: NewDocsGapDigestRun = {
    windowSince: row.windowSince,
    windowUntil: row.windowUntil,
    totalWeakEvents: row.totalWeakEvents,
    byEndpoint: row.byEndpoint,
    bySourceGroup: row.bySourceGroup,
  };
  await db.insert(docsGapDigestRuns).values(values);
}

/**
 * Most recent digest runs, newest first, for the admin UI (Step 8). No
 * filtering by inner jsonb keys -- these are small, whole-row reads.
 */
export async function listDocsGapDigestRuns(
  db: Db,
  limit = 20,
): Promise<DocsGapDigestRun[]> {
  return db
    .select()
    .from(docsGapDigestRuns)
    .orderBy(desc(docsGapDigestRuns.runAt))
    .limit(limit);
}

// ============================================================================
// Audit-log shipping (off-host sink) — cursor-based scheduled job, see
// apps/worker/src/handlers/ship-audit-log.ts. `audit_log_shipper_state` is a
// dedicated single-row watermark table (not overloading `sources.cursor`).
// ============================================================================

/** The current shipping watermark, or `null` if the job has never run. */
export async function getAuditLogShipperWatermark(
  db: Db,
): Promise<Date | null> {
  const [row] = await db.select().from(auditLogShipperState).limit(1);
  return row?.lastShippedAt ?? null;
}

/**
 * Advance the shipping watermark to `lastShippedAt`. Callers MUST only call
 * this after a successful `ship()` — never on a thrown egress-rejection or
 * network error — so a failed batch is retried on the next tick.
 */
export async function advanceAuditLogShipperWatermark(
  db: Db,
  lastShippedAt: Date,
): Promise<void> {
  await db
    .insert(auditLogShipperState)
    .values({ id: true, lastShippedAt })
    .onConflictDoUpdate({
      target: auditLogShipperState.id,
      set: { lastShippedAt },
    });
}

/**
 * `audit_log` rows created strictly after `since` (or all rows when `since`
 * is `null` — the job's first-ever tick), oldest first so the caller can
 * advance the watermark to the last row's `createdAt`.
 */
export async function getAuditLogRowsSince(
  db: Db,
  since: Date | null,
): Promise<AuditLog[]> {
  return db
    .select()
    .from(auditLog)
    .where(since ? gt(auditLog.createdAt, since) : undefined)
    .orderBy(auditLog.createdAt);
}

// ---------------------------------------------------------------------------
// Identity → scope mapping (Phase B / Adoption-Plan Phase 1)
// ---------------------------------------------------------------------------

/**
 * Resolves the source IDs accessible to a given user via client assignments
 * AND direct source assignments.
 *
 * Unions two branches:
 *   1. staff_client_assignments → source_client_assignments on clientId —
 *      every source the user's active (non-revoked) engagements cover.
 *   2. staff_source_assignments — every source the user was directly and
 *      actively granted, with no client involved at all (e.g. firm-internal
 *      sources like firm-sop/firm-research).
 *
 * Returns [] for unmapped users. Callers MUST treat [] as fail-closed:
 * pass it as `enforcedSourceIds` to hybridSearch, which short-circuits to an
 * empty result set without touching the DB. This satisfies CR-5.
 *
 * Uses UNION (not UNION ALL) so cross-branch duplicates are removed
 * automatically — the inner DISTINCT on branch 1 alone would be redundant
 * once wrapped in a UNION, so it's dropped here.
 *
 * Never hard-deletes grants — soft-delete only (revoked_at IS NULL = active),
 * preserving §7216 reconstructibility.
 */
export async function resolveSourceIdsForUser(
  db: Db,
  userId: string,
): Promise<string[]> {
  const rows = await db.execute<{ source_id: string }>(sql`
    SELECT source_id FROM (
      SELECT sca.source_id
      FROM staff_client_assignments sta
      JOIN source_client_assignments sca ON sca.client_id = sta.client_id
      WHERE sta.user_id = ${userId}
        AND sta.revoked_at IS NULL
      UNION
      SELECT source_id
      FROM staff_source_assignments
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
    ) combined
  `);
  return rows.rows.map((r) => r.source_id);
}

/**
 * Source-ids that EVERY user in `userIds` has an active grant to, excluding
 * client-confidential sources. Used to compute a channel-safe scope for the
 * Teams bot: a source appears only if all channel members can already see it,
 * so a channel answer can never expose content a member lacks access to.
 *
 * Reuses the SAME grant UNION as resolveSourceIdsForUser (client-routed +
 * direct grants) so channel scope and per-user scope never diverge on what a
 * grant is. Intersection = HAVING count(DISTINCT user_id) = number of members.
 * Empty `userIds` returns [] (no shared scope over an empty member set).
 *
 * Uses `IN (${sql.join(...)})` rather than `= ANY(${distinct})` for the
 * userId filter — this driver's tagged-template `sql` expands a JS array as
 * individual scalar params, not a single Postgres array bind, so
 * `ANY(${array})` throws 42809 ("op ANY/ALL (array) requires array on right
 * side"). Same parameterization already used for source-id IN-lists above
 * (see the `sourceFilter`/`enforcedSourceFilter` comment) and the same
 * scalar-array pitfall already documented for staff_client_assignments in
 * `tests/e2e/src/specs/access-grants.spec.ts`'s afterEach cleanup comment.
 */
export async function resolveSharedSourceIdsForUsers(
  db: Db,
  userIds: string[],
): Promise<string[]> {
  const distinct = [...new Set(userIds)];
  if (distinct.length === 0) return [];
  const userIdList = sql.join(
    distinct.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<{ source_id: string }>(sql`
    SELECT grants.source_id
    FROM (
      SELECT sta.user_id, sca.source_id
      FROM staff_client_assignments sta
      JOIN source_client_assignments sca ON sca.client_id = sta.client_id
      WHERE sta.user_id IN (${userIdList})
        AND sta.revoked_at IS NULL
      UNION
      SELECT user_id, source_id
      FROM staff_source_assignments
      WHERE user_id IN (${userIdList})
        AND revoked_at IS NULL
    ) grants
    JOIN sources ON sources.id = grants.source_id
    WHERE sources.data_class <> 'client_confidential'
    GROUP BY grants.source_id
    HAVING count(DISTINCT grants.user_id) = ${distinct.length}
  `);
  return rows.rows.map((r) => r.source_id);
}

export interface GrantClientAccessInput {
  userId: string;
  clientId: string;
  grantedBy: string;
}

/**
 * Grant a staff member access to a client's sources. Un-revokes an existing
 * (possibly revoked) row for this exact (userId, clientId) pair if one
 * exists, rather than inserting a duplicate. Implemented as a single atomic
 * `INSERT ... ON CONFLICT (user_id, client_id) DO UPDATE`, relying on the
 * `sca_user_client_unique` unique index (migration 0010) — a prior
 * SELECT-then-INSERT/UPDATE version had a TOCTOU race where two concurrent
 * grants for the same pair could both pass the existence check and both
 * insert, producing duplicate rows.
 */
export async function grantClientAccess(
  db: Db,
  { userId, clientId, grantedBy }: GrantClientAccessInput,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO staff_client_assignments (user_id, client_id, granted_by)
    VALUES (${userId}, ${clientId}, ${grantedBy})
    ON CONFLICT (user_id, client_id)
    DO UPDATE SET
      revoked_at = NULL,
      granted_by = ${grantedBy},
      granted_at = now()
  `);
}

/**
 * Revoke a staff member's access to a client. Soft-delete only (sets
 * `revoked_at`) — never a hard `DELETE`, preserving the audit trail per the
 * schema's existing design intent. A no-op if no active grant exists.
 */
export async function revokeClientAccess(
  db: Db,
  { userId, clientId }: { userId: string; clientId: string },
): Promise<void> {
  await db.execute(sql`
    UPDATE staff_client_assignments
    SET revoked_at = now()
    WHERE user_id = ${userId} AND client_id = ${clientId} AND revoked_at IS NULL
  `);
}

export interface StaffAssignmentHistoryRow {
  clientId: string;
  grantedAt: Date;
  grantedBy: string;
  revokedAt: Date | null;
}

/** Full grant/revoke history for one staff member, newest first — powers the admin UI's history view. */
export async function listAssignmentHistoryForStaff(
  db: Db,
  userId: string,
): Promise<StaffAssignmentHistoryRow[]> {
  const rows = await db.execute<{
    client_id: string;
    granted_at: Date;
    granted_by: string;
    revoked_at: Date | null;
  }>(sql`
    SELECT client_id, granted_at, granted_by, revoked_at
    FROM staff_client_assignments
    WHERE user_id = ${userId}
    ORDER BY granted_at DESC
  `);
  return rows.rows.map((r) => ({
    clientId: r.client_id,
    grantedAt: r.granted_at,
    grantedBy: r.granted_by,
    revokedAt: r.revoked_at,
  }));
}

export interface GrantSourceAccessInput {
  userId: string;
  sourceId: string;
  grantedBy: string;
}

/**
 * Grant a staff member direct access to a source (no client involved).
 * Un-revokes an existing (possibly revoked) row for this exact
 * (userId, sourceId) pair if one exists, rather than inserting a duplicate —
 * same atomic `INSERT ... ON CONFLICT DO UPDATE` pattern as
 * `grantClientAccess`, relying on the `ssa_user_source_unique` unique index
 * (migration 0012) to avoid the TOCTOU race a SELECT-then-INSERT/UPDATE
 * version would have.
 */
export async function grantSourceAccess(
  db: Db,
  { userId, sourceId, grantedBy }: GrantSourceAccessInput,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO staff_source_assignments (user_id, source_id, granted_by)
    VALUES (${userId}, ${sourceId}, ${grantedBy})
    ON CONFLICT (user_id, source_id)
    DO UPDATE SET
      revoked_at = NULL,
      granted_by = ${grantedBy},
      granted_at = now()
  `);
}

/**
 * Revoke a staff member's direct access to a source. Soft-delete only (sets
 * `revoked_at`) — never a hard `DELETE`, preserving the audit trail per the
 * schema's existing design intent. A no-op if no active grant exists.
 */
export async function revokeSourceAccess(
  db: Db,
  { userId, sourceId }: { userId: string; sourceId: string },
): Promise<void> {
  await db.execute(sql`
    UPDATE staff_source_assignments
    SET revoked_at = now()
    WHERE user_id = ${userId} AND source_id = ${sourceId} AND revoked_at IS NULL
  `);
}

export interface StaffSourceAssignmentHistoryRow {
  sourceId: string;
  grantedAt: Date;
  grantedBy: string;
  revokedAt: Date | null;
}

/** Full grant/revoke history for one staff member's direct source grants, newest first — powers the admin UI's history view. */
export async function listSourceAssignmentHistoryForStaff(
  db: Db,
  userId: string,
): Promise<StaffSourceAssignmentHistoryRow[]> {
  const rows = await db.execute<{
    source_id: string;
    granted_at: Date;
    granted_by: string;
    revoked_at: Date | null;
  }>(sql`
    SELECT source_id, granted_at, granted_by, revoked_at
    FROM staff_source_assignments
    WHERE user_id = ${userId}
    ORDER BY granted_at DESC
  `);
  return rows.rows.map((r) => ({
    sourceId: r.source_id,
    grantedAt: r.granted_at,
    grantedBy: r.granted_by,
    revokedAt: r.revoked_at,
  }));
}

// ============================================================================
// Pending uploads — staging rows for browser-uploaded files (custom sources).
// ============================================================================

/**
 * Record a staged upload. The original bytes are already in the object store
 * under `storageKey`; this row is what the `custom` connector later claims and
 * turns into a SourceDocument for ingestion.
 */
export async function createPendingUpload(
  db: Db,
  row: NewPendingUpload,
): Promise<PendingUpload> {
  const [created] = await db.insert(pendingUploads).values(row).returning();
  if (!created) throw new Error("createPendingUpload: insert returned no row");
  return created;
}

/**
 * Atomically claim up to `limit` pending uploads for a source: select the
 * oldest pending rows (FOR UPDATE SKIP LOCKED so concurrent workers never grab
 * the same row) and flip them to "ingested" in the same transaction, returning
 * the claimed rows. The connector then ingests them. A claimed row is NOT
 * re-listed on a later sync, so a downstream ingest failure leaves the upload
 * recorded but un-chunked; the remedy is a re-upload (acceptable for the
 * manual, low-volume Phase-1 upload path).
 */
export async function claimPendingUploads(
  db: Db,
  sourceId: string,
  limit: number,
): Promise<PendingUpload[]> {
  return db.transaction(async (tx) => {
    const claimable = await tx
      .select({ id: pendingUploads.id })
      .from(pendingUploads)
      .where(
        and(
          eq(pendingUploads.sourceId, sourceId),
          eq(pendingUploads.status, "pending"),
        ),
      )
      .orderBy(pendingUploads.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    if (claimable.length === 0) return [];

    return tx
      .update(pendingUploads)
      .set({ status: "ingested" })
      .where(
        inArray(
          pendingUploads.id,
          claimable.map((r) => r.id),
        ),
      )
      .returning();
  });
}

/** Look up a single staged upload by its (sourceId, externalId). */
export async function getPendingUploadByExternalId(
  db: Db,
  sourceId: string,
  externalId: string,
): Promise<PendingUpload | null> {
  const [row] = await db
    .select()
    .from(pendingUploads)
    .where(
      and(
        eq(pendingUploads.sourceId, sourceId),
        eq(pendingUploads.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}
