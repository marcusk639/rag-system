/**
 * Standalone runner (NOT a vitest spec) for measuring retrieval quality
 * against a REAL, configured embedding provider instead of the deterministic
 * FakeEmbedder used by the regression-guard specs (retrieval-eval.spec.ts).
 *
 * Why this is separate from the vitest specs: it needs real API credentials
 * and makes real network calls (or loads a real ONNX model for `local`), so
 * it can't run in CI on every PR the way the FakeEmbedder specs do. Run it
 * manually whenever a retrieval-affecting change (chunking, RRF weights,
 * reranking, embedding model) needs a real measurement — see
 * docs/EVAL-BASELINE.md for the last recorded numbers and the full rationale.
 *
 * Usage:
 *   pnpm docker:up   # postgres + parser must be running
 *   EMBEDDING_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval:real
 *   EMBEDDING_PROVIDER=local pnpm eval:real   # no API key, runs on-process
 *
 * Dimension note: `chunks.embedding` is a fixed `vector(768)` column (see
 * root CLAUDE.md's "pgvector dimension mismatch" section). `gemini` and
 * `local` both default to 768 dims and work as-is. `openai`'s default model
 * is 1536-dim and will fail at insert unless EMBEDDING_DIMENSIONS is set to
 * a value the chosen OpenAI model actually supports (text-embedding-3-*
 * supports dimension truncation) — set EMBEDDING_DIMENSIONS=768 explicitly.
 */
import { writeFile } from "node:fs/promises";
import { EgressPolicy, loadConfig, type EmbeddingProvider } from "@rag/core";
import { createEmbeddingProvider } from "@rag/rag";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import {
  DEFAULT_KS,
  formatMisses,
  formatReport,
  runRetrievalEval,
  seedEvalCorpus,
  sweepWeights,
  type EvalReport,
  type RrfWeights,
} from "./run-eval.js";
import { EVAL_DOCS, EVAL_QUESTIONS } from "./corpus.js";
import { EVAL_DOCS_CPA, EVAL_QUESTIONS_CPA } from "./corpus-cpa.js";

/**
 * Both corpora, measured with the SAME real embedder.
 *
 * `corpus.ts` is vocabulary-distinctive by design, so a keyword arm alone
 * saturates it — a `dense=0` sweep row scores the same as `dense=1`, which
 * means it cannot discriminate between embedding models at all. Running only
 * that corpus is how a real-embedder comparison can look conclusive while
 * measuring nothing about the embedder. `corpus-cpa.ts` removes the cushion:
 * its documents share CPA vocabulary heavily ("client", "engagement",
 * "Karbon", "time entry").
 */
const CORPORA = [
  {
    key: "starter",
    file: "corpus.ts",
    note: 'the "STARTER set" — vocabulary-distinctive, treat as a floor',
    docs: EVAL_DOCS,
    questions: EVAL_QUESTIONS,
  },
  {
    key: "cpa",
    file: "corpus-cpa.ts",
    note: "CPA-representative, shared vocabulary — the discriminating corpus",
    docs: EVAL_DOCS_CPA,
    questions: EVAL_QUESTIONS_CPA,
  },
] as const;

const DEFAULT_WEIGHTS: RrfWeights = { dense: 0.7, sparse: 0.3 };
const SWEEP: RrfWeights[] = [
  { dense: 1.0, sparse: 0.0 },
  { dense: 0.7, sparse: 0.3 },
  { dense: 0.5, sparse: 0.5 },
  { dense: 0.3, sparse: 0.7 },
  { dense: 0.0, sparse: 1.0 },
];

function markdownReport(
  provider: string,
  model: string,
  dimensions: number,
  baseline: EvalReport,
  sweep: EvalReport[],
  corpus: (typeof CORPORA)[number],
): string {
  const lines: string[] = [];
  lines.push(
    `### Provider: \`${provider}\` (model \`${model}\`, ${dimensions}d)`,
  );
  lines.push("");
  lines.push(
    `Corpus: ${corpus.docs.length} documents / ${corpus.questions.length} questions (see \`${corpus.file}\` — ${corpus.note}).`,
  );
  lines.push("");
  lines.push(
    `Default weights (dense=${DEFAULT_WEIGHTS.dense}, sparse=${DEFAULT_WEIGHTS.sparse}):`,
  );
  lines.push("");
  lines.push("| k | recall@k | precision@k | nDCG@k |");
  lines.push("| - | -------- | ----------- | ------ |");
  for (const k of baseline.ks) {
    lines.push(
      `| ${k} | ${(baseline.recallAtK[k]! * 100).toFixed(1)}% | ${(baseline.precisionAtK[k]! * 100).toFixed(1)}% | ${(baseline.ndcgAtK[k]! * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");
  lines.push(`MRR: ${baseline.mrr.toFixed(3)}`);
  lines.push("");
  lines.push("Weight sweep (recall@5 / nDCG@5 / MRR):");
  lines.push("");
  lines.push("| dense | sparse | recall@5 | nDCG@5 | MRR |");
  lines.push("| ----- | ------ | -------- | ------ | --- |");
  for (const r of sweep) {
    lines.push(
      `| ${r.weights.dense} | ${r.weights.sparse} | ${(r.recallAtK[5]! * 100).toFixed(1)}% | ${(r.ndcgAtK[5]! * 100).toFixed(1)}% | ${r.mrr.toFixed(3)} |`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const embedder: EmbeddingProvider = createEmbeddingProvider(
    config.embedding,
    {
      egressPolicy: EgressPolicy.fromEnv(),
      complianceMode: config.complianceMode,
    },
  );

  console.log(
    `Running real-embedder eval — provider=${config.embedding.provider} model=${config.embedding.model} dims=${config.embedding.dimensions}`,
  );

  const { db, close } = openTestDb();
  try {
    const sections: string[] = [];

    // Each corpus is seeded into a FRESH source after a truncate, so the two
    // never share a vector space or leak documents into each other's recall.
    for (const corpus of CORPORA) {
      console.log(
        `\n=== corpus: ${corpus.key} (${corpus.docs.length} docs / ${corpus.questions.length} questions) ===`,
      );
      await truncateAll(db);
      const sourceId = await createCustomSource(
        db,
        `eval-corpus-real-${corpus.key}`,
      );
      const externalIdByDocId = await seedEvalCorpus(
        db,
        sourceId,
        embedder,
        corpus.docs,
      );

      const baseline = await runRetrievalEval(db, externalIdByDocId, {
        weights: DEFAULT_WEIGHTS,
        ks: [...DEFAULT_KS],
        embedder,
        questions: corpus.questions,
      });
      console.log(formatReport(baseline));
      console.log(formatMisses(baseline, 5));

      const sweep = await sweepWeights(
        db,
        externalIdByDocId,
        SWEEP,
        [...DEFAULT_KS],
        embedder,
        corpus.questions,
      );
      for (const r of sweep) console.log(formatReport(r));

      sections.push(
        markdownReport(
          config.embedding.provider,
          config.embedding.model,
          config.embedding.dimensions,
          baseline,
          sweep,
          corpus,
        ),
      );
    }

    const md = sections.join("\n\n---\n\n");
    const outPath = new URL("./real-eval-result.md", import.meta.url);
    await writeFile(outPath, md + "\n", "utf8");
    console.log(`\nMarkdown report written to ${outPath.pathname}`);
    console.log(
      "Copy its contents into docs/EVAL-BASELINE.md under this provider's section.",
    );
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
