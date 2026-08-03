/**
 * Corpus-grounded scoring — the third tier.
 *
 * ── The gap this fills ─────────────────────────────────────────────────────
 *
 * `faithfulness.ts` compares the answer to **whatever happened to be
 * retrieved**. If retrieval returned the wrong document and the answer
 * faithfully reproduced it, faithfulness scores well and the answer is still
 * wrong. Nothing detects that today.
 *
 * This module compares the answer to **what the corpus actually says**,
 * independent of what retrieval returned. The reference is a `quote`: a
 * verbatim span sliced out of the source document by
 * `packages/rag/src/extraction/claim-verification.ts`, never a model's
 * paraphrase. That is what makes an LLM judge legitimate here for the same
 * reason it is in faithfulness — both texts are in the prompt, so the judge
 * compares rather than recalls.
 *
 * ── What a perfect score would and would not mean ──────────────────────────
 *
 * 100% means **the assistant faithfully reproduces the firm's documents.** It
 * does NOT mean the answers are correct. The KB is deliberately indexed as-is,
 * superseded documents included, so a perfect score can mean the assistant
 * faithfully reproduced a stale procedure. Never report this number without
 * that sentence attached.
 *
 * Whether an SOP is *right* is a KB-governance question and, where it is a tax
 * determination, a `tier2-cpa-verified` one. This tier does not touch it — and
 * corpus claims deliberately live outside `TwkGoldQuestion.expectedAnswer`,
 * because writing a document excerpt into that field would launder it into a
 * CPA attestation.
 */

/**
 * A claim plus its provenance, as produced by claim extraction. Structurally a
 * subset of `ExtractedClaim` (@rag/rag) — declared here rather than imported so
 * the eval harness does not depend on the extraction pipeline's build to score
 * a claim set that has already been written to disk.
 */
export interface CorpusClaimRef {
  id: string;
  /** The assertion, in one sentence. */
  claim: string;
  /** ⚠ VERBATIM span from the source document. The reference, not the claim. */
  quote: string;
  documentExternalId: string;
  documentTitle: string;
  /** `documents.source_modified_at` — the staleness signal. May be absent. */
  sourceModifiedAt: string | null;
  /** Clustering key for conflict detection. */
  topic: string;
}

export type ClaimVerdict = "supported" | "contradicted" | "unaddressed";

const VERDICTS: readonly ClaimVerdict[] = [
  "supported",
  "contradicted",
  "unaddressed",
];

export interface CorpusGroundedInput {
  question: string;
  answer: string;
  claim: CorpusClaimRef;
}

export interface CorpusGroundedResult {
  claimId: string;
  verdict: ClaimVerdict;
  /** Carried so a contradiction is traceable without re-joining the claim set. */
  documentExternalId: string;
  notes?: string;
}

/**
 * Prompt for the entailment judge.
 *
 * The CORPUS SAYS block is the verbatim quote. The judge is asked which of
 * three relations holds, and is told explicitly that "the answer never engaged
 * this" is a distinct outcome from "the answer disagreed" — collapsing those
 * two is what makes a retrieval miss look like a generation defect.
 */
export function buildEntailmentPrompt(input: CorpusGroundedInput): string {
  return `You are comparing an ANSWER against a verbatim excerpt from a source document.

Do not judge whether the excerpt is correct as accounting, tax, or professional
practice. That is out of scope. Your only question is how the ANSWER relates to
what the excerpt says.

Choose exactly one verdict:
- "supported"    — the ANSWER agrees with the excerpt on this point.
- "contradicted" — the ANSWER states something the excerpt contradicts.
- "unaddressed"  — the ANSWER never engages this point at all. Use this when the
                   answer is silent on the matter, including when it declined to
                   answer. Silence is NOT contradiction.

QUESTION ASKED:
${input.question}

THE CORPUS SAYS (verbatim excerpt from "${input.claim.documentTitle}"):
${input.claim.quote}

THE POINT BEING CHECKED:
${input.claim.claim}

ANSWER:
${input.answer}

Reply with ONLY a JSON object:
{"verdict": "supported" | "contradicted" | "unaddressed", "notes": "<one sentence>"}`;
}

/**
 * Parse a judge reply. Throws on malformed output or an unrecognized verdict
 * rather than guessing — defaulting an unknown verdict to `unaddressed` would
 * silently reclassify a judge malfunction as a retrieval finding.
 */
export function parseEntailmentReply(
  raw: string,
  claim: CorpusClaimRef,
): CorpusGroundedResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`judge returned no JSON object: ${raw.slice(0, 200)}`);
  }

  const parsed = JSON.parse(match[0]) as {
    verdict?: string;
    notes?: string;
  };

  const verdict = parsed.verdict as ClaimVerdict | undefined;
  if (!verdict || !VERDICTS.includes(verdict)) {
    throw new Error(
      `judge returned an unrecognized verdict: ${String(parsed.verdict)}`,
    );
  }

  return {
    claimId: claim.id,
    verdict,
    documentExternalId: claim.documentExternalId,
    notes: parsed.notes,
  };
}

export interface CorpusGroundedSummary {
  /**
   * supported / (supported + contradicted). `null` when nothing was scoreable.
   *
   * `unaddressed` is deliberately excluded rather than counted as 0: it is a
   * RETRIEVAL miss, and folding it in would blame the generator for the
   * retriever's failure while making the two indistinguishable in one number.
   * It is reported separately below, and belongs in the retrieval metrics pile.
   */
  corpusGrounded: number | null;
  supported: number;
  /** The real defect signal — the answer disagreed with the firm's own document. */
  contradicted: number;
  unaddressed: number;
  /** Listed so contradictions can be triaged individually, not just counted. */
  contradictedClaimIds: string[];
  total: number;
}

export function aggregateCorpusGrounded(
  results: readonly CorpusGroundedResult[],
): CorpusGroundedSummary {
  const supported = results.filter((r) => r.verdict === "supported");
  const contradicted = results.filter((r) => r.verdict === "contradicted");
  const scoreable = supported.length + contradicted.length;

  return {
    corpusGrounded: scoreable === 0 ? null : supported.length / scoreable,
    supported: supported.length,
    contradicted: contradicted.length,
    unaddressed: results.filter((r) => r.verdict === "unaddressed").length,
    contradictedClaimIds: contradicted.map((r) => r.claimId),
    total: results.length,
  };
}

/**
 * Two claims on the same topic sourced from different documents.
 *
 * Named "candidate" on purpose. This step is deterministic clustering — it
 * establishes that two documents both speak to a topic, NOT that they disagree.
 * Asserting disagreement is a semantic call; leaving it to a later judge (or a
 * human) keeps this function from manufacturing a verdict it cannot support.
 */
export interface ConflictCandidate {
  topic: string;
  /** Both claims, with their dates. Order is not significance. */
  claims: CorpusClaimRef[];
}

/**
 * Cluster claims by topic and emit every cross-document pair.
 *
 * In an uncleaned KB, two documents covering one topic is **expected** — the
 * index-as-is decision accepted exactly this. Emitting the pair turns that
 * accepted risk into something measured rather than assumed, and generates
 * cleanup work ranked by evidence.
 *
 * **Deliberately does not resolve by recency.** Newer is a strong prior, not a
 * fact: a recently-touched file may be a copy while the authoritative version
 * is older. Both dates are carried; a human decides.
 */
export function findConflictCandidates(
  claims: readonly CorpusClaimRef[],
): ConflictCandidate[] {
  const byTopic = new Map<string, CorpusClaimRef[]>();
  for (const c of claims) {
    const bucket = byTopic.get(c.topic);
    if (bucket) bucket.push(c);
    else byTopic.set(c.topic, [c]);
  }

  const candidates: ConflictCandidate[] = [];
  for (const [topic, bucket] of byTopic) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (!a || !b) continue;
        // One document elaborating its own topic is not a conflict.
        if (a.documentExternalId === b.documentExternalId) continue;
        candidates.push({ topic, claims: [a, b] });
      }
    }
  }
  return candidates;
}
