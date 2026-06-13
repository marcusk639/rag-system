import { sql } from "drizzle-orm";
import { ADMIN_SCOPE } from "@rag/core";
import { Retriever } from "@rag/rag";
import type { Db } from "@rag/db";
import { FakeConnector } from "../fakes/fake-connector.js";
import { plainTextDoc } from "../fakes/factories.js";
import { FakeEmbedder } from "../fakes/fake-embedder.js";
import { runOneIngestion } from "../helpers/ingestion.js";
import { EVAL_DOCS, EVAL_QUESTIONS, type EvalQuestion } from "./corpus.js";
import {
  mean,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "./metrics.js";

/** Cutoffs the report computes recall/precision/nDCG at. */
export const DEFAULT_KS = [1, 3, 5, 10] as const;

export interface RrfWeights {
  dense: number;
  sparse: number;
}

export interface PerQuestionResult {
  id: string;
  query: string;
  relevant: string[];
  /** De-duplicated document ranking (externalIds), best-first. */
  retrieved: string[];
  recall: Record<number, number>;
  ndcg: Record<number, number>;
  reciprocalRank: number;
}

export interface EvalReport {
  weights: RrfWeights;
  ks: number[];
  perQuestion: PerQuestionResult[];
  /** Mean across questions, keyed by k. */
  recallAtK: Record<number, number>;
  precisionAtK: Record<number, number>;
  ndcgAtK: Record<number, number>;
  mrr: number;
}

/**
 * Seed the labeled corpus into a fresh source and return a map from the stored
 * document UUID → its ground-truth externalId, so retrieval results (which only
 * carry `document.id`) can be scored against the golden labels.
 */
export async function seedEvalCorpus(
  db: Db,
  sourceId: string,
): Promise<Map<string, string>> {
  const connector = new FakeConnector(
    EVAL_DOCS.map((d) =>
      plainTextDoc({
        externalId: d.externalId,
        title: d.title,
        text: d.text,
      }),
    ),
  );
  await runOneIngestion(db, sourceId, connector);

  const rows = await db.execute<{ id: string; external_id: string }>(sql`
    SELECT id, external_id FROM documents WHERE source_id = ${sourceId}
  `);
  const index = new Map<string, string>();
  for (const r of rows.rows) index.set(r.id, r.external_id);
  return index;
}

/** Collapse a chunk-level result list to a document ranking by externalId. */
function toDocRanking(
  results: Array<{ document: { id: string } }>,
  externalIdByDocId: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const ranking: string[] = [];
  for (const r of results) {
    const ext = externalIdByDocId.get(r.document.id);
    if (ext === undefined || seen.has(ext)) continue;
    seen.add(ext);
    ranking.push(ext);
  }
  return ranking;
}

/**
 * Run every question through the retriever at the given weights and aggregate
 * the metrics. `poolK` is the per-question fetch depth — it must be >= the
 * largest k so recall@k can actually be satisfied.
 */
export async function runRetrievalEval(
  db: Db,
  externalIdByDocId: Map<string, string>,
  opts: {
    weights: RrfWeights;
    ks?: number[];
    poolK?: number;
    questions?: EvalQuestion[];
  },
): Promise<EvalReport> {
  const ks = opts.ks ?? [...DEFAULT_KS];
  const poolK = opts.poolK ?? Math.max(...ks, 10);
  const questions = opts.questions ?? EVAL_QUESTIONS;

  const retriever = new Retriever(db, new FakeEmbedder(), {
    topK: poolK,
    denseWeight: opts.weights.dense,
    sparseWeight: opts.weights.sparse,
  });

  const perQuestion: PerQuestionResult[] = [];
  for (const q of questions) {
    const results = await retriever.search(
      { query: q.query, topK: poolK },
      ADMIN_SCOPE,
    );
    const retrieved = toDocRanking(results, externalIdByDocId);
    const recall: Record<number, number> = {};
    const ndcg: Record<number, number> = {};
    for (const k of ks) {
      recall[k] = recallAtK(retrieved, q.relevant, k);
      ndcg[k] = ndcgAtK(retrieved, q.relevant, k);
    }
    perQuestion.push({
      id: q.id,
      query: q.query,
      relevant: q.relevant,
      retrieved,
      recall,
      ndcg,
      reciprocalRank: reciprocalRank(retrieved, q.relevant),
    });
  }

  const recallAgg: Record<number, number> = {};
  const precisionAgg: Record<number, number> = {};
  const ndcgAgg: Record<number, number> = {};
  for (const k of ks) {
    recallAgg[k] = mean(perQuestion.map((p) => p.recall[k]!));
    ndcgAgg[k] = mean(perQuestion.map((p) => p.ndcg[k]!));
    precisionAgg[k] = mean(
      perQuestion.map((p) => precisionAtK(p.retrieved, p.relevant, k)),
    );
  }

  return {
    weights: opts.weights,
    ks,
    perQuestion,
    recallAtK: recallAgg,
    precisionAtK: precisionAgg,
    ndcgAtK: ndcgAgg,
    mrr: mean(perQuestion.map((p) => p.reciprocalRank)),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Human-readable aggregate table for logging from a spec. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(
    `Retrieval eval — weights dense=${report.weights.dense} sparse=${report.weights.sparse} | ${report.perQuestion.length} questions`,
  );
  lines.push(`  k     recall    precision  nDCG`);
  for (const k of report.ks) {
    lines.push(
      `  @${String(k).padEnd(4)}${pct(report.recallAtK[k]!).padStart(7)}   ${pct(
        report.precisionAtK[k]!,
      ).padStart(7)}   ${pct(report.ndcgAtK[k]!).padStart(7)}`,
    );
  }
  lines.push(`  MRR: ${report.mrr.toFixed(3)}`);
  return lines.join("\n");
}

/** Single-line summary of misses (questions with recall@k < 1) for triage. */
export function formatMisses(report: EvalReport, k: number): string {
  const misses = report.perQuestion.filter((p) => (p.recall[k] ?? 0) < 1);
  if (misses.length === 0) return `No misses at recall@${k}.`;
  return [
    `Misses at recall@${k} (${misses.length}):`,
    ...misses.map(
      (m) =>
        `  ${m.id}: want [${m.relevant.join(", ")}] got [${m.retrieved
          .slice(0, k)
          .join(", ")}]`,
    ),
  ].join("\n");
}

/**
 * Sweep several RRF weight settings over the same seeded corpus so the
 * dense/sparse split can be tuned empirically rather than assumed. Returns one
 * report per weight config, in input order.
 */
export async function sweepWeights(
  db: Db,
  externalIdByDocId: Map<string, string>,
  weightConfigs: RrfWeights[],
  ks: number[] = [...DEFAULT_KS],
): Promise<EvalReport[]> {
  const reports: EvalReport[] = [];
  for (const weights of weightConfigs) {
    reports.push(
      await runRetrievalEval(db, externalIdByDocId, { weights, ks }),
    );
  }
  return reports;
}
