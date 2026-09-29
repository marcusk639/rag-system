import type { RetrievalResult } from "./types.js";

/**
 * Absolute relevance signal for the audit log's `topScore` column: the best
 * dense (cosine) similarity among the retrieved chunks, or `null` when nothing
 * usable was retrieved.
 *
 * Deliberately NOT `results[0].score`. `hybridSearch` divides every RRF score
 * by the result set's max, so the top row is 1.0 for any non-empty result set
 * regardless of how poor the match is — which made the docs-gap digest's
 * `topScore < minScore` "weak result" check unreachable. RRF is rank-based and
 * carries no absolute relevance; cosine similarity does.
 */
export function topRelevanceScore(
  results: ReadonlyArray<Pick<RetrievalResult, "denseScore">>,
): number | null {
  let best: number | null = null;
  for (const r of results) {
    if (!Number.isFinite(r.denseScore)) continue;
    if (best === null || r.denseScore > best) best = r.denseScore;
  }
  return best;
}
