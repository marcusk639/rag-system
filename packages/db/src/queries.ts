import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { RetrievalResult, SourceKind } from "@rag/core";
import type { Db } from "./client.js";
import {
  auditLog,
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
export async function purgeSource(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(sources)
    .where(eq(sources.id, id))
    .returning({ id: sources.id });
  return deleted.length > 0;
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
// Hybrid retrieval — dense (pgvector cosine) + sparse (tsvector BM25-ish)
// combined via Reciprocal Rank Fusion (RRF).
//
// RRF is robust to score scale differences between the two retrievers:
//   score = sum( weight / (k + rank) )
// k=60 is the standard literature value.
// ============================================================================

interface HybridSearchOptions {
  query: string;
  queryEmbedding: number[];
  topK: number;
  /**
   * MANDATORY discriminator for the currently active embedding provider/model
   * (e.g. the caller's configured `EmbeddingProvider.name`/`.model`). `chunks`
   * accumulates rows from whichever provider embedded them at ingest time, and
   * `chunks.embedding` vectors from different providers/models are NOT
   * comparable by cosine distance even when dimensions happen to coincide
   * (e.g. Gemini and a local model both default to 768-dim) — mixing them
   * silently corrupts ranking with no error. Required (not optional) so a
   * caller cannot forget it during a provider migration, the exact moment a
   * mixed-model corpus is most likely to exist.
   */
  embeddingProvider: string;
  embeddingModel: string;
  /**
   * Each retriever fetches this multiple of topK as candidates. Bumped from
   * the historical default of 4 because the dense CTE no longer joins
   * documents — filters now run as a post-filter, so we need a larger
   * unfiltered pool to absorb selectivity. 8× is safe for topK ≤ 50.
   */
  candidatePoolMultiplier?: number;
  /**
   * Optional caller-narrowing filter, retained for direct hybridSearch callers.
   * NOTE: Retriever folds caller-narrowing into `enforcedSourceIds` via
   * `effectiveSourceFilter` — this field is NOT the access-control enforcement
   * path; do not rely on it for ACL.
   */
  sourceIds?: string[];
  /**
   * MANDATORY confidentiality boundary (per-principal source-id ACL).
   *   - `null`  => admin / unrestricted (no enforced WHERE restriction).
   *   - `[]`    => fail closed: return ZERO rows (short-circuited before the DB).
   *   - `[...]` => results are ALWAYS restricted to `doc.source_id IN (...)`,
   *               ANDed on top of (and independent from) the optional caller
   *               `sourceIds` convenience filter above.
   *
   * This is a required field (not optional) so a route cannot forget it — the
   * effective scope is computed in @rag/core `effectiveSourceFilter` from the
   * caller's principal. Passing `[]` is the fail-closed default for a principal
   * with no readable sources; never pass `null` for an untrusted caller.
   */
  enforcedSourceIds: string[] | null;
  /** JSON path → value(s) filter against documents.metadata */
  metadataFilter?: Record<string, string | string[]>;
  weights?: { dense: number; sparse: number };
  /**
   * Override pgvector's `hnsw.ef_search` for this query. Higher = better
   * recall, slower. Postgres default is 40; RAG workloads typically want 100+.
   */
  efSearch?: number;
}

/**
 * Hybrid search returning RRF-combined ranked chunks with full document context.
 *
 * The query runs two CTEs in a single round-trip:
 *   - `dense_hits`:  ANN over pgvector with `<=>` cosine distance
 *   - `sparse_hits`: full-text match using ts_rank_cd on the tsvector index
 * Then a final SELECT merges them via RRF and joins documents for citation data.
 */
export async function hybridSearch(
  db: Db,
  opts: HybridSearchOptions,
): Promise<RetrievalResult[]> {
  // Guard against poisoned embeddings (NaN/Infinity from a degraded provider
  // response). pgvector would reject these at parse time but the error is
  // opaque ("invalid input syntax for type vector"); fail clearly here.
  if (opts.queryEmbedding.some((v) => !Number.isFinite(v))) {
    throw new Error("queryEmbedding contains non-finite values");
  }

  // MANDATORY ACL fail-closed short-circuit. A principal scoped to an empty
  // set (or a caller filter that is disjoint from the principal's scope, after
  // intersection upstream) may read NOTHING — return before touching the DB.
  // `null` means admin/unrestricted and is the ONLY way to skip the enforced
  // source filter below.
  if (opts.enforcedSourceIds !== null && opts.enforcedSourceIds.length === 0) {
    return [];
  }

  const topK = opts.topK;
  // Pool size — see comments on `candidatePoolMultiplier`. Default 8× because
  // filters now run as a post-filter; selective filters demand more candidates.
  const pool = topK * (opts.candidatePoolMultiplier ?? 8);
  const wDense = opts.weights?.dense ?? 0.7;
  const wSparse = opts.weights?.sparse ?? 0.3;
  const k = 60; // RRF constant from the original RRF paper.

  // Build optional filter fragments. NOTE: these are applied to the FINAL
  // SELECT, not inside the dense/sparse CTEs. Putting filters inside the
  // dense CTE forces Postgres to evaluate the embedding distance for every
  // row that passes the filter — defeating the HNSW index, which can only
  // accelerate `ORDER BY embedding <=> $1 LIMIT N` over the full table.
  // With a generous pool (topK × 8) we still get good recall after filtering.
  // Build a parameterised IN-list. Drizzle's `sql` tag expands an array as
  // INDIVIDUAL parameters (one $N per element), so `ANY(${arr}::uuid[])` was
  // broken: pg received the element as a single scalar and tried to cast a
  // bare UUID string to `uuid[]`, throwing "malformed array literal". The
  // correct shape is `IN ($1::uuid, $2::uuid, ...)` built via `sql.join`.
  const sourceFilter = opts.sourceIds?.length
    ? sql`AND doc.source_id IN (${sql.join(
        opts.sourceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;

  // MANDATORY ACL filter — SEPARATE from the optional caller `sourceFilter`
  // above and always ANDed in. `null` === admin/unrestricted (no fragment).
  // A non-empty array restricts to the principal's allowed sources; the empty
  // case was already short-circuited to `[]` before the DB call. Built with the
  // same `sql.join` / `::uuid` parameterization the comment above explains, so
  // it's injection-safe.
  const enforcedSourceFilter =
    opts.enforcedSourceIds && opts.enforcedSourceIds.length > 0
      ? sql`AND doc.source_id IN (${sql.join(
          opts.enforcedSourceIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;

  const metadataConditions = Object.entries(opts.metadataFilter ?? {}).map(
    ([key, value]) => {
      const values = Array.isArray(value) ? value : [value];
      // Same fix as sourceFilter — IN-list of parameterised text values.
      // `key` rides through `->>${key}` as a single parameter and `values`
      // expands into a per-value parameter list, both injection-safe.
      return sql`AND doc.metadata->>${key} IN (${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )})`;
    },
  );

  // Serialize the embedding once. We pass it as a text parameter and cast
  // to vector; declaring it inside a `params` CTE lets the planner reference
  // it three times (dense distance, dense rank, RRF) from a single binding.
  const embedLiteral = "[" + opts.queryEmbedding.join(",") + "]";

  // Tune HNSW recall per-query via session GUC. SET LOCAL scopes it to the
  // current transaction; we wrap the query in a tx so the setting takes effect.
  const efSearch = Math.max(40, opts.efSearch ?? 100);

  const rows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(efSearch))}`,
    );
    return tx.execute<{
      chunk_id: string;
      document_id: string;
      text: string;
      ordinal: number;
      heading_path: string[];
      page: number | null;
      dense_score: number;
      sparse_score: number;
      rrf_score: number;
      title: string;
      source_id: string;
      source_kind: SourceKind;
      metadata: Record<string, unknown>;
      has_original: boolean;
    }>(sql`
      WITH params AS (
        SELECT ${embedLiteral}::vector AS q_embedding,
               plainto_tsquery('english', ${opts.query}) AS q_tsquery
      ),
      dense_hits AS (
        -- Pure ANN over the HNSW index, restricted to the active embedding
        -- provider/model. Cosine distance between vectors from different
        -- models is meaningless even at matching dimensionality, so this
        -- filter is load-bearing correctness, not just a convenience — see
        -- the comment on HybridSearchOptions.embeddingProvider/embeddingModel.
        SELECT
          c.id AS chunk_id,
          1 - (c.embedding <=> (SELECT q_embedding FROM params)) AS score,
          ROW_NUMBER() OVER (
            ORDER BY c.embedding <=> (SELECT q_embedding FROM params) ASC
          ) AS rank
        FROM chunks c
        WHERE c.embedding IS NOT NULL
          AND c.embedding_provider = ${opts.embeddingProvider}
          AND c.embedding_model = ${opts.embeddingModel}
        ORDER BY c.embedding <=> (SELECT q_embedding FROM params) ASC
        LIMIT ${pool}
      ),
      sparse_hits AS (
        -- BM25-ish via tsvector GIN. Same principle: no JOIN at this stage.
        SELECT
          c.id AS chunk_id,
          ts_rank_cd(c.tsv, (SELECT q_tsquery FROM params)) AS score,
          ROW_NUMBER() OVER (
            ORDER BY ts_rank_cd(c.tsv, (SELECT q_tsquery FROM params)) DESC
          ) AS rank
        FROM chunks c
        WHERE c.tsv @@ (SELECT q_tsquery FROM params)
        ORDER BY score DESC
        LIMIT ${pool}
      ),
      fused AS (
        SELECT
          COALESCE(d.chunk_id, s.chunk_id) AS chunk_id,
          COALESCE(d.score, 0) AS dense_score,
          COALESCE(s.score, 0) AS sparse_score,
          (${wDense} * (1.0 / (${k} + COALESCE(d.rank, 1000000))))
            + (${wSparse} * (1.0 / (${k} + COALESCE(s.rank, 1000000)))) AS rrf_score
        FROM dense_hits d
        FULL OUTER JOIN sparse_hits s ON d.chunk_id = s.chunk_id
      )
      -- Post-filter + final join. Filters are applied HERE so the HNSW and
      -- GIN indexes can serve the inner CTEs without restriction.
      SELECT
        f.chunk_id,
        c.document_id,
        c.text,
        c.ordinal,
        c.heading_path,
        c.page,
        f.dense_score,
        f.sparse_score,
        f.rrf_score,
        doc.title,
        doc.source_id,
        src.kind AS source_kind,
        doc.metadata,
        (doc.storage_key IS NOT NULL) AS has_original
      FROM fused f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN documents doc ON doc.id = c.document_id
      JOIN sources src ON src.id = doc.source_id
      WHERE TRUE
      ${enforcedSourceFilter}
      ${sourceFilter}
      ${sql.join(metadataConditions, sql` `)}
      ORDER BY f.rrf_score DESC
      LIMIT ${topK}
    `);
  });

  // Normalize RRF scores to [0,1] for easier consumption. Use reduce instead
  // of `Math.max(...arr)` so the call survives very large result sets.
  const maxScore = rows.rows.reduce(
    (m, r) => Math.max(m, Number(r.rrf_score)),
    1e-9,
  );

  return rows.rows.map((r) => {
    const metadata = r.metadata ?? {};
    const url = typeof metadata.url === "string" ? metadata.url : undefined;
    return {
      text: r.text,
      score: Number(r.rrf_score) / maxScore,
      denseScore: Number(r.dense_score),
      sparseScore: Number(r.sparse_score),
      document: {
        id: r.document_id,
        title: r.title,
        sourceId: r.source_id,
        sourceKind: r.source_kind,
        url,
        hasOriginal: r.has_original,
        metadata,
      },
      chunk: {
        id: r.chunk_id,
        ordinal: r.ordinal,
        headingPath: r.heading_path ?? [],
        page: r.page ?? undefined,
      },
    };
  });
}

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
   */
  action: "ingested" | "blocked" | "tri-flagged";
  /** Non-null for "blocked" (error message) and "tri-flagged" (pattern list). */
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
  channel: "api" | "mcp";
  model: string | null;
  sourceIds: string[];
  chunkIds: string[];
  docIds: string[];
  retrievedCount: number;
  /** "ask" | "search" — discriminates which endpoint produced this row. */
  endpoint: "ask" | "search";
  /** Top retrieval result's combined score (0-1); null when nothing retrieved. */
  topScore: number | null;
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
    sourceIds: row.sourceIds,
    chunkIds: row.chunkIds,
    docIds: row.docIds,
    retrievedCount: row.retrievedCount,
    endpoint: row.endpoint,
    topScore: row.topScore,
  };
  await db.insert(auditLog).values(values);
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
