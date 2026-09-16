import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_SCOPE } from "@rag/core";
import type { Db } from "@rag/db";
import { Retriever } from "@rag/rag";
import { FakeEmbedder } from "@rag/test-fixtures";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import {
  EVAL_DOCS_CPA,
  EVAL_KEYWORD_QUESTIONS_CPA,
  EVAL_NEGATIVES_CPA,
  EVAL_QUESTIONS_CPA,
} from "../eval/corpus-cpa.js";
import {
  formatMisses,
  formatReport,
  runRetrievalEval,
  seedEvalCorpus,
} from "../eval/run-eval.js";

/**
 * Retrieval gate on the CPA-representative corpus.
 *
 * The starter corpus (`retrieval-eval.spec.ts`) is vocabulary-distinctive and
 * saturated — every metric is 100% at every weight split, so it cannot detect
 * a regression or measure an improvement. This corpus shares vocabulary
 * across documents ("client", "engagement", "Karbon", "time entry"), so
 * near-neighbour discrimination is actually exercised.
 *
 * Thresholds sit just under the measured FakeEmbedder numbers (recorded in the
 * first test) and above what the same corpus scores with the keyword arm
 * disabled. The run is deterministic, so they do not flake. Re-measure and
 * move them deliberately when retrieval changes.
 */
describe("E2E: CPA retrieval evaluation gate", () => {
  let db: Db;
  let close: () => Promise<void>;
  let externalIdByDocId: Map<string, string>;
  const embedder = new FakeEmbedder();

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
    await truncateAll(db);
    const sourceId = await createCustomSource(db, "eval-corpus-cpa");
    externalIdByDocId = await seedEvalCorpus(
      db,
      sourceId,
      embedder,
      EVAL_DOCS_CPA,
    );
  });

  afterAll(async () => {
    await close();
  });

  it("meets the CPA retrieval baseline at the default weights", async () => {
    const report = await runRetrievalEval(db, externalIdByDocId, {
      weights: { dense: 0.7, sparse: 0.3 },
      questions: EVAL_QUESTIONS_CPA,
      embedder,
    });
    // eslint-disable-next-line no-console
    console.log("\n" + formatReport(report) + "\n" + formatMisses(report, 3));

    // Measured 2026-09-16 (FakeEmbedder, deterministic): recall@1 92.5%,
    // recall@3 100%, nDCG@3 98.2%, MRR 0.975. With the keyword arm disabled
    // (dense=1, sparse=0) the same corpus scores recall@3 95%, nDCG@3 93.2%,
    // MRR 0.938 — so these thresholds FAIL when hybrid retrieval loses its
    // sparse half, which the starter corpus cannot detect.
    expect(report.recallAtK[1]!).toBeGreaterThanOrEqual(0.88);
    expect(report.recallAtK[3]!).toBeGreaterThanOrEqual(1);
    expect(report.ndcgAtK[3]!).toBeGreaterThanOrEqual(0.95);
    expect(report.mrr).toBeGreaterThanOrEqual(0.95);
  });

  it("scores bare identifiers through the keyword arm, not dense similarity alone", async () => {
    const retriever = new Retriever(db, embedder, {
      topK: 5,
      denseWeight: 0.7,
      sparseWeight: 0.3,
    });
    for (const q of EVAL_KEYWORD_QUESTIONS_CPA) {
      const results = await retriever.search(
        { query: q.query, topK: 5 },
        ADMIN_SCOPE,
      );
      const hits = results.filter((r) =>
        q.relevant.includes(externalIdByDocId.get(r.document.id) ?? ""),
      );
      // eslint-disable-next-line no-console
      console.log(
        `${q.id} ${q.query}: rank=${results.findIndex((r) => hits.includes(r))} sparse=${hits[0]?.sparseScore ?? "none"}`,
      );
      expect(
        hits.length,
        `${q.id}: expected document not in top 5`,
      ).toBeGreaterThan(0);
      expect(
        Math.max(...hits.map((h) => h.sparseScore)),
        `${q.id}: keyword arm did not score the expected document`,
      ).toBeGreaterThan(0);
    }
  });

  it("logs the dense score distribution of negatives vs positives", async () => {
    const retriever = new Retriever(db, embedder, {
      topK: 1,
      denseWeight: 0.7,
      sparseWeight: 0.3,
    });
    const top = async (query: string) =>
      (await retriever.search({ query, topK: 1 }, ADMIN_SCOPE))[0]
        ?.denseScore ?? 0;
    const pos = await Promise.all(EVAL_QUESTIONS_CPA.map((q) => top(q.query)));
    const neg = await Promise.all(EVAL_NEGATIVES_CPA.map((q) => top(q.query)));
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Informational only with FakeEmbedder (bag-of-words vectors). With real
    // embeddings (`pnpm eval:real`) this gap is what a no-answer threshold is
    // tuned from.
    // eslint-disable-next-line no-console
    console.log(
      `top dense score — positives avg ${avg(pos).toFixed(3)}, negatives avg ${avg(neg).toFixed(3)}`,
    );
    expect(pos.length).toBe(EVAL_QUESTIONS_CPA.length);
  });
});
