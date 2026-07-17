/**
 * Standalone runner (NOT a vitest spec) for measuring retrieval quality
 * against the CPA-representative synthetic corpus (`corpus-cpa.ts`) using a
 * REAL, configured embedding provider — mirrors `run-real-eval.ts` but:
 *   - uses the CPA corpus/questions instead of the generic starter corpus
 *   - fixes the RRF weights at the sparse-heavy split used by the demo
 *     (CPA jargon like "BOI", "K-1", "UPE" favors lexical/BM25 matching)
 *   - additionally measures retrieval separation on out-of-corpus
 *     ("negative") queries as a proxy for the retrieval layer's contribution
 *     to a clean "I don't know" behavior
 *
 * Usage:
 *   pnpm docker:up   # postgres + parser must be running
 *   pnpm db:migrate
 *   EMBEDDING_PROVIDER=local pnpm --filter @rag/e2e run eval:cpa
 */
import { writeFile } from "node:fs/promises";
import { ADMIN_SCOPE, EgressPolicy, loadConfig } from "@rag/core";
import { createEmbeddingProvider, Retriever } from "@rag/rag";
import { createDb, createSource } from "@rag/db";
import { truncateAll } from "../helpers/db.js";
import { seedEvalCorpus, runRetrievalEval, formatReport } from "./run-eval.js";
import {
  EVAL_DOCS_CPA,
  EVAL_QUESTIONS_CPA,
  EVAL_NEGATIVES_CPA,
} from "./corpus-cpa.js";

const WEIGHTS = { dense: 0.3, sparse: 0.7 }; // sparse-heavy: CPA jargon (matches demo)

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const embedder = createEmbeddingProvider(config.embedding, {
    egressPolicy: EgressPolicy.fromEnv(),
    complianceMode: config.complianceMode,
  });
  console.log(
    `CPA eval — provider=${config.embedding.provider} model=${config.embedding.model} dims=${config.embedding.dimensions}`,
  );

  const { db, close } = createDb(
    process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag",
    { max: 5 },
  );
  try {
    await truncateAll(db);
    const source = await createSource(db, {
      kind: "custom",
      name: "cpa-eval",
      config: {},
    });
    const map = await seedEvalCorpus(db, source.id, embedder, EVAL_DOCS_CPA);

    // Positives → retrieval metrics
    const report = await runRetrievalEval(db, map, {
      weights: WEIGHTS,
      questions: EVAL_QUESTIONS_CPA,
      embedder,
    });

    // Negatives → top-score separation (the "I don't know" proxy at the retrieval layer)
    const retriever = new Retriever(db, embedder, {
      topK: 5,
      denseWeight: WEIGHTS.dense,
      sparseWeight: WEIGHTS.sparse,
    });
    type ScoreRow = { id: string; top: number; dense: number; sparse: number };
    const negScores: ScoreRow[] = [];
    for (const q of EVAL_NEGATIVES_CPA) {
      const results = await retriever.search(
        { query: q.query, topK: 3 },
        ADMIN_SCOPE,
      );
      negScores.push({
        id: q.id,
        top: results[0]?.score ?? 0,
        dense: results[0]?.denseScore ?? 0,
        sparse: results[0]?.sparseScore ?? 0,
      });
    }
    const maxNeg = Math.max(...negScores.map((n) => n.top));

    // NOTE: `RetrievalResult.score` is the RRF score NORMALIZED WITHIN each
    // query's own result set (`rrf_score / maxScoreInThatQuery` — see
    // `hybridSearch` in `packages/db/src/queries.ts`). That means the rank-1
    // hit of ANY query — including a nonsense out-of-corpus query — is
    // mathematically guaranteed to land at ~1.0000. `results[0]?.score` is
    // therefore NOT a valid cross-query confidence/"I don't know" signal; a
    // max-negative-top-score of 1.0000 is expected by construction, not
    // evidence of poor retrieval separation. The raw, non-normalized
    // `denseScore` (cosine similarity) and `sparseScore` (ts_rank_cd) ARE
    // comparable across queries and are recorded below as the real proxy.
    const posScores: ScoreRow[] = [];
    for (const q of EVAL_QUESTIONS_CPA) {
      const results = await retriever.search(
        { query: q.query, topK: 3 },
        ADMIN_SCOPE,
      );
      posScores.push({
        id: q.id,
        top: results[0]?.score ?? 0,
        dense: results[0]?.denseScore ?? 0,
        sparse: results[0]?.sparseScore ?? 0,
      });
    }
    const minPosDense = Math.min(...posScores.map((p) => p.dense));
    const minPosSparse = Math.min(...posScores.map((p) => p.sparse));
    const maxNegDense = Math.max(...negScores.map((n) => n.dense));
    const maxNegSparse = Math.max(...negScores.map((n) => n.sparse));

    const md =
      `# CPA Real-Embedder Eval\n\n` +
      `provider=${config.embedding.provider} model=${config.embedding.model} dims=${config.embedding.dimensions}\n` +
      `weights dense=${WEIGHTS.dense} sparse=${WEIGHTS.sparse}\n\n` +
      formatReport(report) +
      `\n\n## Negative (out-of-corpus) top scores\n\n` +
      `Highest negative top-score (RRF, per-query-normalized): ${maxNeg.toFixed(4)}\n\n` +
      `**Caveat:** \`RetrievalResult.score\` is normalized WITHIN each query's own ` +
      `result set (rank-1 always lands at ~1.0000 regardless of query relevance — ` +
      `see \`hybridSearch\` in \`packages/db/src/queries.ts\`). A max-negative-top-score ` +
      `of ~1.0000 is therefore an expected artifact of the normalization, NOT evidence ` +
      `of poor retrieval separation. The raw component scores below are the valid, ` +
      `cross-query-comparable separation signal.\n\n` +
      negScores
        .map(
          (n) =>
            `- ${n.id}: score=${n.top.toFixed(4)} dense=${n.dense.toFixed(4)} sparse=${n.sparse.toFixed(4)}`,
        )
        .join("\n") +
      `\n\n### Raw component separation (valid cross-query signal)\n\n` +
      `| component | lowest positive (rank-1) | highest negative (rank-1) | separation holds? |\n` +
      `| --- | --- | --- | --- |\n` +
      `| dense (cosine) | ${minPosDense.toFixed(4)} | ${maxNegDense.toFixed(4)} | ${minPosDense > maxNegDense ? "yes" : "NO"} |\n` +
      `| sparse (ts_rank_cd) | ${minPosSparse.toFixed(4)} | ${maxNegSparse.toFixed(4)} | ${minPosSparse > maxNegSparse ? "yes" : "NO"} |\n` +
      "\n";

    const outPath = new URL("./cpa-eval-result.md", import.meta.url);
    await writeFile(outPath, md, "utf8");
    console.log(`\nWrote ${outPath.pathname}`);
    console.log(formatReport(report));
    console.log(`Max negative top-score: ${maxNeg.toFixed(4)}`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
