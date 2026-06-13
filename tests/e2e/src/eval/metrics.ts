/**
 * Retrieval-quality metrics for the eval harness.
 *
 * All functions operate on DOCUMENT-LEVEL identifiers (we dedupe chunks to the
 * documents they came from before scoring) and binary relevance: a document is
 * either in the labeled relevant set or it is not. That is the standard model
 * for an IR eval where ground truth is "which document(s) answer this question".
 *
 * Pure + deterministic — no DB, no I/O — so the math is unit-testable without
 * the docker stack.
 */

/** A ranked list of retrieved document ids (rank 0 = top hit). */
export type Ranking = readonly string[];

/** The set of document ids that are correct answers for a question. */
export type RelevantSet = readonly string[];

function topK(ranking: Ranking, k: number): readonly string[] {
  return ranking.slice(0, Math.max(0, k));
}

/**
 * recall@k — fraction of the relevant documents that appear in the top-k.
 * Returns 0 when there are no relevant documents (undefined recall → 0 so it
 * never poisons an average).
 */
export function recallAtK(
  ranking: Ranking,
  relevant: RelevantSet,
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const rel = new Set(relevant);
  const hits = topK(ranking, k).filter((id) => rel.has(id)).length;
  return hits / relevant.length;
}

/**
 * precision@k — fraction of the top-k that are relevant. Normalized by k (not
 * by how many results came back) so a short result list is penalized, which is
 * the conventional definition.
 */
export function precisionAtK(
  ranking: Ranking,
  relevant: RelevantSet,
  k: number,
): number {
  if (k <= 0) return 0;
  const rel = new Set(relevant);
  const hits = topK(ranking, k).filter((id) => rel.has(id)).length;
  return hits / k;
}

/**
 * nDCG@k with binary gains. DCG sums 1/log2(rank+2) for each relevant hit in
 * the top-k; IDCG is the DCG of the ideal ranking (all relevant docs first).
 * Returns 0 when IDCG is 0 (no relevant docs).
 */
export function ndcgAtK(
  ranking: Ranking,
  relevant: RelevantSet,
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const rel = new Set(relevant);
  const dcg = topK(ranking, k).reduce((acc, id, i) => {
    return rel.has(id) ? acc + 1 / Math.log2(i + 2) : acc;
  }, 0);
  const idealHits = Math.min(relevant.length, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Reciprocal rank — 1/(1-based rank of the first relevant hit), 0 if none.
 * Mean over a question set is MRR.
 */
export function reciprocalRank(
  ranking: Ranking,
  relevant: RelevantSet,
): number {
  const rel = new Set(relevant);
  for (let i = 0; i < ranking.length; i++) {
    if (rel.has(ranking[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
