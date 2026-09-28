import { TRUNCATION_NOTICE } from "@rag/rag";
import type { GoldQuestion } from "./gold-set.js";
import { mean, recallAtK, reciprocalRank } from "./metrics.js";

/**
 * Scoring for `pnpm eval:gold` — pure, so it is unit-tested without the live
 * knowledge base. The runner (`run-gold-eval.ts`) collects one observation per
 * gold question from the deployed /ask endpoint and hands them here.
 *
 * What it can score without a CPA: retrieval (recall@k, MRR against the
 * `relevant` externalIds), coverage behavior (refusing questions the KB does
 * not cover, and NOT refusing ones it does), fabricated citations, and
 * truncation. Substantive correctness (tier 2) and claim-level faithfulness
 * are out of scope here; they need a reviewer or a calibrated judge.
 */

export interface GoldObservation {
  id: string;
  answer: string;
  /** Retrieved documents, best-first, de-duplicated, as connector externalIds. */
  retrievedExternalIds: string[];
  /** Documents the answer's citations point at, as externalIds. */
  citedExternalIds: string[];
}

export interface GoldReport {
  ks: number[];
  /** Answerable questions (non-empty `relevant`) that were observed. */
  answerable: number;
  recallAtK: Record<number, number>;
  mrr: number;
  coverage: { total: number; correctlyRefused: number };
  /** Answerable questions the system refused outright. */
  wrongRefusals: string[];
  fabricatedCitations: Array<{ id: string; externalIds: string[] }>;
  truncated: string[];
  /** Gold questions with no observation (request failed). */
  missing: string[];
}

/**
 * Refusal sentence from the generation prompt's coverage mode C, which is also
 * @rag/services `EMPTY_ANSWER` (not a dependency of this package, so restated).
 */
const REFUSAL = "do not contain enough information to answer that";
const TRUNCATION = TRUNCATION_NOTICE.trim();

function isRefusal(answer: string): boolean {
  // Mode C opens with the refusal sentence (optionally followed by a "Closest
  // related material" line). Matching anywhere would misread an answer that
  // quotes the phrase; mode B ("Not covered by the documents:") is a partial
  // answer, not a refusal.
  const opening = answer.trimStart().split("\n")[0] ?? "";
  return opening.includes(REFUSAL);
}

export function scoreGoldRun(
  questions: readonly GoldQuestion[],
  observations: readonly GoldObservation[],
  ks: number[] = [1, 3, 5],
): GoldReport {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const missing: string[] = [];
  const recall: Record<number, number[]> = Object.fromEntries(
    ks.map((k) => [k, [] as number[]]),
  );
  const rr: number[] = [];
  const coverage = { total: 0, correctlyRefused: 0 };
  const wrongRefusals: string[] = [];
  const fabricatedCitations: GoldReport["fabricatedCitations"] = [];
  const truncated: string[] = [];

  for (const q of questions) {
    const o = byId.get(q.id);
    if (!o) {
      missing.push(q.id);
      continue;
    }
    const refused = isRefusal(o.answer);
    if (q.relevant.length === 0) {
      coverage.total++;
      if (refused) coverage.correctlyRefused++;
    } else {
      for (const k of ks)
        recall[k]!.push(recallAtK(o.retrievedExternalIds, q.relevant, k));
      rr.push(reciprocalRank(o.retrievedExternalIds, q.relevant));
      if (refused) wrongRefusals.push(q.id);
    }
    const retrieved = new Set(o.retrievedExternalIds);
    const fabricated = o.citedExternalIds.filter((id) => !retrieved.has(id));
    if (fabricated.length > 0) {
      fabricatedCitations.push({ id: q.id, externalIds: fabricated });
    }
    if (o.answer.includes(TRUNCATION)) truncated.push(q.id);
  }

  return {
    ks,
    answerable: rr.length,
    recallAtK: Object.fromEntries(ks.map((k) => [k, mean(recall[k]!)])),
    mrr: mean(rr),
    coverage,
    wrongRefusals,
    fabricatedCitations,
    truncated,
    missing,
  };
}
