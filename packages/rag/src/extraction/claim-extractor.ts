import {
  verifyClaims,
  type RejectedClaim,
  type VerificationReport,
  type VerifiedClaim,
} from "./claim-verification.js";
import { loadPrompt } from "../prompts/index.js";

/**
 * Claim extraction — ask a model to point at checkable assertions in a document,
 * then **verify every one of them against the source before it is kept.**
 *
 * Verification is not optional and not a caller's responsibility: this module
 * runs `verifyClaims` on the model's output and only returns what survived. The
 * design rule "drop any claim whose quote does not literally support it" is
 * therefore enforced here, in code, rather than requested in a prompt and hoped
 * for. See `docs/evaluation/EVAL-CORPUS-GROUND-TRUTH.md`.
 *
 * ⚠ **Extraction sends document text to a model — it is an egress event.** Run
 * the client-identifier screen over the corpus and resolve its flags *first*.
 * The corpus is classified internal-only by default rather than because anyone
 * checked (ISS-05), and a combined pass would disclose documents before the
 * check that was supposed to gate them.
 */

/** The prompt asks for these; nothing here is trusted until verified. */
interface RawClaim {
  claim?: unknown;
  quote?: unknown;
  topic?: unknown;
  distractorNote?: unknown;
}

export interface ExtractedClaim extends VerifiedClaim {
  documentExternalId: string;
  documentTitle: string;
  sourceModifiedAt: string | null;
  topic: string;
  /**
   * The near-neighbour a keyword search would wrongly return. Required: a claim
   * with no plausible distractor cannot discriminate between retrieval
   * strategies and is dead weight in a gold set.
   */
  distractorNote: string;
}

export interface ExtractionResult {
  claims: ExtractedClaim[];
  rejected: RejectedClaim[];
  /** Rung distribution + strain flag. Report it; do not bury it. */
  verification: Omit<VerificationReport, "verified" | "rejected">;
  /** Claims dropped for reasons other than quote verification. */
  droppedForShape: { claim: string; reason: string }[];
}

/**
 * The extraction prompt.
 *
 * Two rules here exist to counter failure modes that are invisible in the
 * output and fatal to the gold set:
 *
 *  - **Atomicity.** A compound claim is half-supported by its quote and scores
 *    as supported. Splitting is cheap; a half-true gold entry poisons every
 *    number computed from it.
 *  - **Selection bias.** Models preferentially extract crisp, quotable facts —
 *    exactly the ones retrieval already handles. A set built from those cannot
 *    tell dense retrieval from sparse, which this repo has already demonstrated
 *    the expensive way (`corpus.ts`: flat weight sweep, identical at dense=0,
 *    MRR 1.000). The quota and the distractor requirement exist to force the
 *    harder material.
 */
export const CLAIM_EXTRACTION_PROMPT = loadPrompt("claim-extraction");

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Pull the JSON object out of a model response that may be fenced or prefixed. */
function parseClaims(raw: string): RawClaim[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      claims?: unknown;
    };
    return Array.isArray(parsed.claims) ? (parsed.claims as RawClaim[]) : [];
  } catch {
    return [];
  }
}

/**
 * Minimal model port for extraction: prompt in, text out.
 *
 * Deliberately NOT the `Generator` interface. `Generator.answer` prepends the
 * question-answering system prompt — "cite every claim using [N] notation", "if
 * the context does not contain the answer, say so" — which is tuned for cited
 * Q&A and actively fights a JSON extraction instruction. Extraction is a
 * different task and needs its own prompt with nothing else in front of it.
 *
 * Keeping this a bare function also keeps the module free of provider
 * dependencies: the caller wires whichever model it wants.
 */
export type CompleteFn = (prompt: string) => Promise<string>;

export interface ExtractDocumentInput {
  externalId: string;
  title: string;
  markdown: string;
  sourceModifiedAt: string | null;
}

/**
 * Extract verified claims from one document.
 *
 * Every returned claim carries a `quote` sliced from `markdown` — never the
 * model's string — plus the offsets proving it. Claims the model produced that
 * could not be located are returned separately in `rejected` so the failure rate
 * is visible rather than silently swallowed.
 */
export async function extractClaims(
  complete: CompleteFn,
  doc: ExtractDocumentInput,
): Promise<ExtractionResult> {
  const prompt = [
    CLAIM_EXTRACTION_PROMPT,
    "",
    `DOCUMENT TITLE: ${doc.title}`,
    "DOCUMENT TEXT:",
    doc.markdown,
  ].join("\n");

  const raw = parseClaims(await complete(prompt));
  const droppedForShape: { claim: string; reason: string }[] = [];

  // Shape checks before verification — a claim missing its distractor is
  // discarded regardless of whether its quote would have verified, because an
  // undiscriminating question is not worth the tokens to score it.
  const candidates: { claim: string; quote: string; meta: RawClaim }[] = [];
  for (const r of raw) {
    const claim = asString(r.claim);
    const quote = asString(r.quote);
    const distractorNote = asString(r.distractorNote);

    if (!claim) continue;
    if (!distractorNote) {
      droppedForShape.push({
        claim,
        reason: "no distractorNote — cannot discriminate, so not worth scoring",
      });
      continue;
    }
    candidates.push({ claim, quote, meta: r });
  }

  const report = verifyClaims(doc.markdown, candidates);

  // Re-attach metadata to the verified claims, matched by claim text.
  const metaByClaim = new Map(candidates.map((c) => [c.claim, c.meta]));
  const claims: ExtractedClaim[] = report.verified.map((v) => {
    const meta = metaByClaim.get(v.claim);
    return {
      ...v,
      documentExternalId: doc.externalId,
      documentTitle: doc.title,
      sourceModifiedAt: doc.sourceModifiedAt,
      topic: asString(meta?.topic) || "uncategorized",
      distractorNote: asString(meta?.distractorNote),
    };
  });

  return {
    claims,
    rejected: report.rejected,
    verification: {
      rungCounts: report.rungCounts,
      ladderStrain: report.ladderStrain,
    },
    droppedForShape,
  };
}
