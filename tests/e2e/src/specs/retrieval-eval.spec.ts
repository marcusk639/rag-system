import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@rag/db";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import {
  formatMisses,
  formatReport,
  runRetrievalEval,
  seedEvalCorpus,
  sweepWeights,
  type RrfWeights,
} from "../eval/run-eval.js";

/**
 * Retrieval evaluation harness (§12 of ISSUES-AND-OPTIMIZATIONS.md).
 *
 * Seeds the labeled corpus ONCE, then:
 *  1. measures recall@k / precision@k / nDCG@k / MRR at the production default
 *     RRF weights and guards them against a conservative baseline (a regression
 *     trip-wire — if a change tanks retrieval, this fails),
 *  2. logs the full report + a dense/sparse weight sweep so the weights can be
 *     tuned empirically rather than assumed.
 *
 * Uses the deterministic FakeEmbedder, so results are stable across runs. The
 * thresholds are intentionally loose — this is a guard against regressions and
 * a measurement surface for H1 (rerank) / OPT-C1 (contextual retrieval), not a
 * tight assertion on the fake embedder's absolute quality.
 */
describe("E2E: retrieval evaluation harness", () => {
  let db: Db;
  let close: () => Promise<void>;
  let externalIdByDocId: Map<string, string>;

  const DEFAULT_WEIGHTS: RrfWeights = { dense: 0.7, sparse: 0.3 };

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
    await truncateAll(db);
    const sourceId = await createCustomSource(db, "eval-corpus");
    externalIdByDocId = await seedEvalCorpus(db, sourceId);
  });

  afterAll(async () => {
    await close();
  });

  it("meets the baseline retrieval quality at the default RRF weights", async () => {
    const report = await runRetrievalEval(db, externalIdByDocId, {
      weights: DEFAULT_WEIGHTS,
    });

    // Surface the numbers on every run for tuning/triage.
    // eslint-disable-next-line no-console
    console.log("\n" + formatReport(report));
    // eslint-disable-next-line no-console
    console.log(formatMisses(report, 5) + "\n");

    // Conservative regression baselines. The default weights should put the
    // answer doc in the top-5 for the large majority of questions.
    expect(report.recallAtK[5]!).toBeGreaterThanOrEqual(0.8);
    expect(report.recallAtK[3]!).toBeGreaterThanOrEqual(0.7);
    expect(report.ndcgAtK[5]!).toBeGreaterThanOrEqual(0.6);
    expect(report.mrr).toBeGreaterThanOrEqual(0.6);
  });

  it("recall is monotonic non-decreasing as k grows", async () => {
    const report = await runRetrievalEval(db, externalIdByDocId, {
      weights: DEFAULT_WEIGHTS,
      ks: [1, 3, 5, 10],
    });
    expect(report.recallAtK[1]!).toBeLessThanOrEqual(report.recallAtK[3]!);
    expect(report.recallAtK[3]!).toBeLessThanOrEqual(report.recallAtK[5]!);
    expect(report.recallAtK[5]!).toBeLessThanOrEqual(report.recallAtK[10]!);
  });

  it("logs a dense/sparse weight sweep for empirical tuning", async () => {
    const configs: RrfWeights[] = [
      { dense: 1.0, sparse: 0.0 }, // dense only
      { dense: 0.7, sparse: 0.3 }, // production default
      { dense: 0.5, sparse: 0.5 }, // balanced
      { dense: 0.3, sparse: 0.7 }, // sparse-leaning
      { dense: 0.0, sparse: 1.0 }, // sparse only
    ];
    const reports = await sweepWeights(db, externalIdByDocId, configs);

    const table = reports
      .map(
        (r) =>
          `  dense=${r.weights.dense} sparse=${r.weights.sparse} | recall@5=${(
            r.recallAtK[5]! * 100
          ).toFixed(1)}% nDCG@5=${(r.ndcgAtK[5]! * 100).toFixed(
            1,
          )}% MRR=${r.mrr.toFixed(3)}`,
      )
      .join("\n");
    // eslint-disable-next-line no-console
    console.log("\nRRF weight sweep:\n" + table + "\n");
    // Honesty note: under the deterministic FakeEmbedder the dense vector is a
    // bag-of-words, so it tracks the SAME lexical signal as the sparse BM25 side
    // and the weight split makes no difference (the rows above will be ~equal).
    // This sweep becomes meaningful only against a real embedder (or a corpus
    // where semantic and lexical similarity diverge) — wire those in before
    // drawing any conclusion about the production dense/sparse weights.

    // Every configuration should return *something* useful; this just guards the
    // sweep machinery, not a specific winner.
    for (const r of reports) {
      expect(r.recallAtK[10]!).toBeGreaterThan(0);
    }
  });
});
