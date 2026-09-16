/** pgvector's accepted range for `hnsw.ef_search`. */
const EF_SEARCH_MIN = 40;
const EF_SEARCH_MAX = 1000;
const EF_SEARCH_DEFAULT = 100;

/**
 * `hnsw.ef_search` for a hybrid query whose dense arm asks for `densePool`
 * rows. An HNSW index scan returns at most `ef_search` tuples, so a
 * `LIMIT densePool` above it is silently truncated — the dense arm of RRF
 * would see fewer candidates than the sparse arm (reranking and per-document
 * cap over-fetch both push the pool past the old fixed 100).
 */
export function resolveEfSearch(densePool: number, override?: number): number {
  const wanted = Math.max(
    EF_SEARCH_MIN,
    override ?? EF_SEARCH_DEFAULT,
    densePool,
  );
  return Math.min(EF_SEARCH_MAX, Math.ceil(wanted));
}
