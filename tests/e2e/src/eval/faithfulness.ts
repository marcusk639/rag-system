/**
 * Faithfulness scoring — Tier 1 answer quality.
 *
 * Retrieval metrics (recall@k, nDCG, MRR) measure whether the right DOCUMENT
 * came back. They say nothing about whether the ANSWER was any good. This
 * closes half that gap — the half that can be automated honestly.
 *
 * ── The line this module does not cross ────────────────────────────────────
 *
 * It scores **groundedness**: is every claim in the answer supported by the
 * retrieved chunks, and does each citation actually contain what it is cited
 * for? That is a text-entailment question. A language model is a legitimate
 * judge of it, because the ground truth is *present in the prompt* — the judge
 * compares two texts rather than consulting knowledge it may not have.
 *
 * It does **NOT** score whether the answer is correct as CPA practice. That is
 * a tax/accounting determination, epistemic constraint C2 forbids AI making
 * one, and a system grading its own professional correctness is precisely the
 * liability the strategy documents warn about. Substantive correctness is
 * Tier 2 and requires a credentialed reviewer (see twk-gold-set.ts).
 *
 * The distinction matters practically, not just legally: an answer can be
 * perfectly faithful to a retrieved document and still be wrong, because the
 * document itself is outdated or wrong. Faithfulness catches hallucination.
 * It cannot catch a bad source.
 */

export interface RetrievedChunk {
  chunkId: string;
  documentExternalId: string;
  text: string;
}

export interface FaithfulnessInput {
  question: string;
  answer: string;
  /** Exactly the chunks shown to the generator — not a re-retrieval. */
  retrieved: readonly RetrievedChunk[];
  /** documentExternalIds the answer claimed as citations. */
  citedDocumentIds: readonly string[];
}

export interface FaithfulnessResult {
  /** Claims stated by the answer and supported by the retrieved text. */
  supportedClaims: number;
  /** Claims stated by the answer that no retrieved chunk supports. */
  unsupportedClaims: number;
  /**
   * supported / (supported + unsupported). 1.0 = fully grounded.
   * `null` when the answer asserts nothing scoreable (e.g. "I don't know"),
   * which must NOT be averaged in as 0 — see `aggregateFaithfulness`.
   */
  faithfulness: number | null;
  /**
   * Cited ids absent from the retrieved set. Non-empty is a **hard failure**,
   * not a low score: the system invented a source. This is the single most
   * damaging failure mode in a professional setting.
   */
  fabricatedCitations: string[];
  /** Cited ids present in the retrieved set but not supporting the claim. */
  unsupportingCitations: string[];
  /** True when the answer correctly declined instead of guessing. */
  abstained: boolean;
  notes?: string;
}

/**
 * Cheap, deterministic, no-model checks. Run these FIRST — they need no API
 * call and catch the worst failure outright.
 *
 * A fabricated citation is detectable by set membership alone: if the answer
 * cites a document that was never retrieved, no judge is required to know
 * something is wrong.
 */
export function checkCitations(
  input: FaithfulnessInput,
): Pick<FaithfulnessResult, "fabricatedCitations"> {
  const retrievedIds = new Set(
    input.retrieved.map((c) => c.documentExternalId),
  );
  return {
    fabricatedCitations: input.citedDocumentIds.filter(
      (id) => !retrievedIds.has(id),
    ),
  };
}

/**
 * Prompt for an LLM judge.
 *
 * Written to make abstention explicit rather than punished. A system that says
 * "the knowledge base does not cover this" is behaving *correctly* — that is a
 * coverage finding, and the docs-gap-digest already treats it as one. Scoring
 * it as a faithfulness failure would train exactly the wrong behaviour: it
 * would reward confident guessing over honest declining, which in a CPA firm is
 * the more dangerous of the two by a wide margin.
 */
export function buildJudgePrompt(input: FaithfulnessInput): string {
  const context = input.retrieved
    .map((c, i) => `[${i + 1}] (doc: ${c.documentExternalId})\n${c.text}`)
    .join("\n\n");

  return `You are scoring whether an ANSWER is grounded in the CONTEXT provided.

Judge ONLY grounding. Do NOT judge whether the answer is correct accounting,
tax, or professional advice — that is out of scope and you must not comment on
it. Your sole question is: does the CONTEXT support what the ANSWER asserts?

Rules:
- A claim is "supported" only if the CONTEXT states or directly entails it.
  Plausible, well-known, or obviously-true claims are UNSUPPORTED if the
  CONTEXT does not contain them.
- If the ANSWER declines to answer, or says the information is not available,
  set "abstained": true and leave both claim counts at 0. This is correct
  behaviour, not a failure.
- Ignore pleasantries, restatements of the question, and hedging language.
  Count substantive assertions only.

QUESTION:
${input.question}

CONTEXT:
${context}

ANSWER:
${input.answer}

Reply with ONLY a JSON object:
{"supportedClaims": <int>, "unsupportedClaims": <int>, "abstained": <bool>,
 "unsupportingCitations": [<doc ids cited but not supporting>],
 "notes": "<one sentence>"}`;
}

/** Parse a judge reply. Throws on malformed output rather than guessing. */
export function parseJudgeReply(raw: string): Omit<
  FaithfulnessResult,
  "fabricatedCitations" | "faithfulness"
> & {
  faithfulness: number | null;
} {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match)
    throw new Error(`judge returned no JSON object: ${raw.slice(0, 200)}`);

  const parsed = JSON.parse(match[0]) as {
    supportedClaims?: number;
    unsupportedClaims?: number;
    abstained?: boolean;
    unsupportingCitations?: string[];
    notes?: string;
  };

  const supported = Number(parsed.supportedClaims ?? 0);
  const unsupported = Number(parsed.unsupportedClaims ?? 0);
  const abstained = Boolean(parsed.abstained);
  const total = supported + unsupported;

  return {
    supportedClaims: supported,
    unsupportedClaims: unsupported,
    abstained,
    // null, not 0 — an abstention has no faithfulness score to report, and
    // coercing it to 0 would drag the aggregate down for correct behaviour.
    faithfulness: total === 0 ? null : supported / total,
    unsupportingCitations: parsed.unsupportingCitations ?? [],
    notes: parsed.notes,
  };
}

export interface FaithfulnessSummary {
  /** Mean over scoreable answers only — abstentions excluded, not zeroed. */
  meanFaithfulness: number | null;
  scored: number;
  abstained: number;
  /** Any value above 0 should fail the run outright. */
  answersWithFabricatedCitations: number;
  total: number;
}

/**
 * Aggregate. Reports abstention as its own number rather than folding it into
 * the mean, so "the KB doesn't cover this" stays visible as a coverage signal
 * instead of masquerading as poor answer quality.
 */
export function aggregateFaithfulness(
  results: readonly FaithfulnessResult[],
): FaithfulnessSummary {
  const scoreable = results.filter((r) => r.faithfulness !== null);
  const sum = scoreable.reduce((acc, r) => acc + (r.faithfulness ?? 0), 0);

  return {
    meanFaithfulness: scoreable.length ? sum / scoreable.length : null,
    scored: scoreable.length,
    abstained: results.filter((r) => r.abstained).length,
    answersWithFabricatedCitations: results.filter(
      (r) => r.fabricatedCitations.length > 0,
    ).length,
    total: results.length,
  };
}
