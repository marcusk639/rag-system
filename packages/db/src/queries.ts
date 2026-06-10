import { and, eq, inArray, sql } from "drizzle-orm";
import type { RetrievalResult, SourceKind } from "@rag/core";
import type { Db } from "./client.js";
import {
  chunks,
  documents,
  ingestionJobs,
  sources,
  type NewChunk,
  type NewDocument,
  type NewIngestionJob,
  type NewSource,
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

export async function updateSourceCursor(
  db: Db,
  id: string,
  cursor: string | null,
) {
  await db
    .update(sources)
    .set({ cursor, lastSyncedAt: new Date() })
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
   * Each retriever fetches this multiple of topK as candidates. Bumped from
   * the historical default of 4 because the dense CTE no longer joins
   * documents — filters now run as a post-filter, so we need a larger
   * unfiltered pool to absorb selectivity. 8× is safe for topK ≤ 50.
   */
  candidatePoolMultiplier?: number;
  sourceIds?: string[];
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
    }>(sql`
      WITH params AS (
        SELECT ${embedLiteral}::vector AS q_embedding,
               plainto_tsquery('english', ${opts.query}) AS q_tsquery
      ),
      dense_hits AS (
        -- Pure ANN: no JOIN, no extra WHERE beyond non-null. HNSW kicks in.
        SELECT
          c.id AS chunk_id,
          1 - (c.embedding <=> (SELECT q_embedding FROM params)) AS score,
          ROW_NUMBER() OVER (
            ORDER BY c.embedding <=> (SELECT q_embedding FROM params) ASC
          ) AS rank
        FROM chunks c
        WHERE c.embedding IS NOT NULL
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
        doc.metadata
      FROM fused f
      JOIN chunks c ON c.id = f.chunk_id
      JOIN documents doc ON doc.id = c.document_id
      JOIN sources src ON src.id = doc.source_id
      WHERE TRUE
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
