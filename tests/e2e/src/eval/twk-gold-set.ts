/**
 * TWK gold set — the real evaluation corpus.
 *
 * ⚠ THIS FILE IS INTENTIONALLY EMPTY OF QUESTIONS. That is not an oversight.
 *
 * The 2026-08-01 real-embedder run (docs/EVAL-BASELINE.md) established that the
 * starter corpus in `corpus.ts` cannot measure retrieval quality: the
 * dense/sparse weight sweep is completely flat, and at `dense=0` — embeddings
 * contributing nothing — the score is unchanged. A corpus with a ceiling of
 * MRR 1.000 detects only catastrophic regressions. It cannot support a decision
 * about weights, reranking, chunking, or embedding models.
 *
 * This file is where the corpus that CAN do that lives. Unlike `corpus.ts` it
 * defines no documents: questions reference documents already indexed in
 * production by their connector `externalId`, so the eval runs against the real
 * SharePoint knowledge base rather than a synthetic stand-in.
 *
 * ── Why it is empty ────────────────────────────────────────────────────────
 *
 * Authoring these questions requires knowing (a) what staff actually ask and
 * (b) what the correct answer is. Neither is available to an engineer, and
 * inventing them would manufacture evidence — a gold set whose answers nobody
 * qualified has verified produces confident, meaningless numbers.
 *
 * `expectedAnswer` in particular is a **CPA judgment**. Per epistemic
 * constraint C2, AI does not make accounting or tax determinations, and that
 * applies with double force to the artifact used to *score* the system. A
 * credentialed preparer authors these. See docs/EVAL-GOLD-SET-GUIDE.md.
 *
 * ── How to fill it ─────────────────────────────────────────────────────────
 *
 * Append entries below. Nothing else in the harness changes — `pnpm eval:twk`
 * picks them up automatically and refuses to run while the set is empty.
 */

/** Tier of scoring a question supports. See docs/EVAL-GOLD-SET-GUIDE.md. */
export type ScoringTier =
  /** Retrieval + faithfulness only. Automatable, needs no CPA review. */
  | "tier1-automatable"
  /** Substantive CPA correctness. Requires a credentialed reviewer. */
  | "tier2-cpa-verified";

export interface TwkGoldQuestion {
  /** Stable id, e.g. "twk-q-001". Never renumber — results are keyed on it. */
  id: string;

  /** The question, phrased the way a staff member would actually type it. */
  query: string;

  /**
   * `externalId`s of production documents that SHOULD answer this. Drives
   * recall@k / precision@k / nDCG / MRR. An empty array is meaningful and
   * valuable: it asserts the KB genuinely does not cover this, making the
   * question a coverage test rather than a retrieval test.
   */
  relevant: string[];

  /**
   * What a correct answer must contain — the substance, not exact wording.
   *
   * ⚠ Only a credentialed preparer fills this in. Leave undefined for
   * tier1-automatable questions.
   */
  expectedAnswer?: string;

  tier: ScoringTier;

  /**
   * Who verified `expectedAnswer`, and when (ISO date). Required whenever
   * `expectedAnswer` is set — an unattributed gold answer is not a gold answer.
   */
  verifiedBy?: string;
  verifiedOn?: string;

  /**
   * Why this question is hard. THE most valuable field, and the reason the
   * starter corpus fails: name the near-neighbour that a keyword search would
   * wrongly return. A question with no plausible distractor cannot discriminate
   * between retrieval strategies and adds nothing.
   */
  distractorNote?: string;

  /** Free-text context — where the question came from, caveats. */
  note?: string;
}

/**
 * ⚠ EMPTY BY DESIGN — see the header. Populate via docs/EVAL-GOLD-SET-GUIDE.md.
 *
 * Target: 30–50 questions, of which a meaningful share carry a
 * `distractorNote`. Thirty easy questions are worth less than ten hard ones.
 */
export const TWK_GOLD_QUESTIONS: TwkGoldQuestion[] = [];

/** Validation failure describing one malformed gold-set entry. */
export interface GoldSetIssue {
  id: string;
  problem: string;
}

/**
 * Structural validation. Deliberately strict about provenance: the failure mode
 * this guards against is a gold set that silently degrades into someone's
 * guesses, at which point every number downstream is fiction.
 */
export function validateGoldSet(
  questions: readonly TwkGoldQuestion[] = TWK_GOLD_QUESTIONS,
): GoldSetIssue[] {
  const issues: GoldSetIssue[] = [];
  const seen = new Set<string>();

  for (const q of questions) {
    if (seen.has(q.id)) {
      issues.push({ id: q.id, problem: "duplicate id" });
    }
    seen.add(q.id);

    if (!q.query.trim()) {
      issues.push({ id: q.id, problem: "empty query" });
    }

    // An expected answer nobody signed for is worse than none at all: it looks
    // authoritative while being unattributable.
    if (q.expectedAnswer && !(q.verifiedBy && q.verifiedOn)) {
      issues.push({
        id: q.id,
        problem: "expectedAnswer set without verifiedBy + verifiedOn",
      });
    }

    if (q.tier === "tier2-cpa-verified" && !q.expectedAnswer) {
      issues.push({
        id: q.id,
        problem: "tier2-cpa-verified requires an expectedAnswer",
      });
    }
  }

  return issues;
}

/** True when the gold set has content and no structural problems. */
export function isGoldSetUsable(
  questions: readonly TwkGoldQuestion[] = TWK_GOLD_QUESTIONS,
): boolean {
  return questions.length > 0 && validateGoldSet(questions).length === 0;
}
