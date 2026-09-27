import { sql } from "drizzle-orm";
import type { RetrievalResult, SourceKind } from "@rag/core";
import type { Db } from "./client.js";
import { resolveCandidatePool, resolveEfSearch } from "./hnsw.js";

// ============================================================================
// Hybrid retrieval — dense (pgvector cosine) + sparse (tsvector BM25-ish)
// combined via Reciprocal Rank Fusion (RRF).
//
// RRF is robust to score scale differences between the two retrievers:
//   score = sum( weight / (k + rank) )
// k=60 is the standard literature value.
// ============================================================================

export interface HybridSearchOptions {
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
  const defaultPool = resolveCandidatePool(
    topK,
    opts.candidatePoolMultiplier ?? 8,
  );
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
      // `->>${key} IN (...)` extracts metadata as text and compares — the
      // `documents_metadata_gin_idx` GIN index (default jsonb_ops opclass)
      // cannot accelerate that operator, only `@>` containment (verified via
      // EXPLAIN ANALYZE with enable_seqscan=off: `->>` forces a seq scan
      // regardless, `@>` produces a Bitmap Index Scan on the GIN index).
      // Rewrite to an OR of per-value containment checks, built with
      // `jsonb_build_object` so both key and value stay parameterised
      // (injection-safe) rather than string-concatenated into a JSON literal.
      //
      // `@>` is type-sensitive: `{"k":"5"}` does not contain `{"k":5}`, and
      // `{"k":"true"}` does not contain `{"k":true}`. The filter API only
      // ever sends string values (packages/core/src/validation.ts's
      // filterSchema), but DocumentMetadata is `.passthrough()` and could
      // hold non-string top-level values (e.g. the numeric `sizeBytes`) that
      // `->>`'s old text coercion matched against a string filter value.
      // Also try the value as a JSON number/boolean when it parses as one,
      // so those metadata fields keep matching post-fix — confirmed via
      // EXPLAIN this still produces a BitmapOr over the same GIN index, not
      // a fallback scan, for both the numeric and boolean cases.
      return sql`AND (${sql.join(
        values.flatMap((v) => {
          const conditions = [
            sql`doc.metadata @> jsonb_build_object(${key}::text, ${v}::text)`,
          ];
          if (v.trim() !== "" && Number.isFinite(Number(v))) {
            conditions.push(
              sql`doc.metadata @> jsonb_build_object(${key}::text, ${v}::numeric)`,
            );
          }
          if (v === "true" || v === "false") {
            conditions.push(
              sql`doc.metadata @> jsonb_build_object(${key}::text, ${v}::boolean)`,
            );
          }
          return conditions;
        }),
        sql` OR `,
      )})`;
    },
  );

  // Serialize the embedding once. We pass it as a text parameter and cast
  // to vector; declaring it inside a `params` CTE lets the planner reference
  // it three times (dense distance, dense rank, RRF) from a single binding.
  const embedLiteral = "[" + opts.queryEmbedding.join(",") + "]";

  // Tune HNSW recall per-query via session GUC. SET LOCAL scopes it to the
  // current transaction; we wrap the query in a tx so the setting takes effect.
  // Must cover `pool`, or the index scan truncates the dense arm (see hnsw.ts).
  const runAt = (pool: number) =>
    db.transaction(async (tx) => {
      const efSearch = resolveEfSearch(pool, opts.efSearch);
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
               -- OR-semantics tsquery. "plainto_tsquery"/"websearch_to_tsquery"
               -- both AND every lexeme together, which requires ONE chunk to
               -- contain EVERY content word of the question. On a natural
               -- question that is a bar almost nothing clears: measured against
               -- a representative accounting-firm SOP corpus with 15 realistic
               -- staff questions, 5 of 15 (33%) matched ZERO chunks under AND —
               -- including multi-clause questions about client setup and
               -- payroll configuration, both
               -- of which have a dedicated SOP in the corpus. For those queries
               -- the sparse arm contributed nothing and hybrid search silently
               -- degraded to dense-only, losing exactly the exact-token recall
               -- (form numbers, work codes like BK-CATCHUP, product names) that
               -- the sparse arm exists to provide.
               --
               -- Rewriting the lexemes with "|" restores that recall; precision
               -- is then the ranking layer's job, which is how BM25-style
               -- retrieval is meant to work: "ts_rank_cd" orders the matches,
               -- the pool is truncated to "topK * candidatePoolMultiplier", and
               -- RRF fuses by RANK POSITION (not raw score), so a broad match
               -- set cannot swamp the dense arm.
               --
               -- "to_tsvector" first (rather than splitting the raw string) so
               -- stop words and stemming are handled by the same dictionary the
               -- indexed "chunks.tsv" column used.
               --
               -- Each lexeme is "quote_literal"-wrapped rather than concatenated
               -- raw. "to_tsquery" parses its argument as tsquery SYNTAX, so an
               -- unquoted lexeme carrying "&", "|", "!", "(", ":" or "<->" would
               -- be read as an OPERATOR — a raw-concatenation build raises a
               -- syntax error on inputs as ordinary as a pasted URL, and the
               -- question text here is untrusted end-user input from a Teams
               -- message. Quoting makes every lexeme a literal term. Verified
               -- against pasted URLs, email addresses, punctuation-heavy source
               -- text, and a pure tsquery-operator-soup string.
               --
               -- "NULLIF"+"COALESCE" guard the all-stop-word query ("how do I do
               -- it"), where the aggregate is NULL/empty and "to_tsquery('')"
               -- would raise a syntax error — that degrades to a deliberate
               -- no-match tsquery, leaving dense retrieval to answer the query
               -- rather than failing the whole search.
               COALESCE(
                 to_tsquery(
                   'english',
                   NULLIF(
                     (
                       SELECT string_agg(quote_literal(lex), ' | ')
                       FROM unnest(
                         tsvector_to_array(to_tsvector('english', ${opts.query}))
                       ) AS lex
                     ),
                     ''
                   )
                 ),
                 to_tsquery('english', 'zzzznomatchzzzz')
               ) AS q_tsquery
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

  let rows = await runAt(defaultPool);
  // Filters apply AFTER each arm is truncated to its pool, so a principal
  // scoped to a small source (or a selective metadata filter) can have every
  // matching chunk crowded out of the pool by chunks it cannot read, and get
  // fewer than topK rows back — or none — with no error. Retry once at the
  // largest pool the HNSW index can serve. Unfiltered queries never retry.
  const filtered =
    opts.enforcedSourceIds !== null ||
    (opts.sourceIds?.length ?? 0) > 0 ||
    metadataConditions.length > 0;
  const maxPool = resolveCandidatePool(topK, Number.POSITIVE_INFINITY);
  if (filtered && rows.rows.length < topK && defaultPool < maxPool) {
    rows = await runAt(maxPool);
  }

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
