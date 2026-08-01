/**
 * Claim verification — the rule "a claim's quote must literally appear in the
 * document" enforced in code rather than trusted to the model.
 *
 * ## Why this module exists
 *
 * Corpus-grounded eval (`docs/EVAL-CORPUS-GROUND-TRUTH.md`) asks a model to read
 * a document and emit `{claim, quote}` pairs. The quote is what makes the claim
 * checkable — without it, "ground truth" is just another model summary, and you
 * have built a second artefact to distrust instead of a reference to check
 * against.
 *
 * The model cannot be relied on to reproduce text exactly. Even when it is not
 * hallucinating, it collapses newlines, folds smart quotes, strips markdown
 * emphasis, and reads a table row as prose. So the quote it returns is used
 * **only to locate a span** — never stored.
 *
 * ```
 *   model returns quote text
 *     → locate it in the source markdown
 *     → store markdown.slice(start, end)      ← this is what persists
 *     → cannot locate it? the claim is DROPPED
 * ```
 *
 * What ends up in the artefact is therefore, by construction, **real document
 * text**. The model's job is reduced from *reproduce the text* to *point at the
 * text*, and pointing is checkable.
 *
 * (Asking the model for character offsets directly would be cleaner still and
 * does not work — models cannot count characters reliably.)
 *
 * ## The rung ladder, and why it is instrumented
 *
 * Matching runs in cumulative rungs, most-literal first. Each rung is a
 * concession, so the rung that matched is recorded — and the *distribution* over
 * a run is a diagnostic, not bookkeeping. If most claims only match at
 * `markdown`, extraction is paraphrasing, and the fix is to tighten the
 * extraction prompt, **not** to add another rung. A ladder that silently grows
 * is this design's own failure mode coming back as configuration.
 */

/** Cumulative match strictness. Earlier is stricter. */
export type MatchRung = "exact" | "whitespace" | "unicode" | "markdown";

/** In order of application. Exported so callers can report the distribution. */
export const MATCH_RUNGS: readonly MatchRung[] = [
  "exact",
  "whitespace",
  "unicode",
  "markdown",
] as const;

export interface VerifiedClaim {
  ok: true;
  claim: string;
  /**
   * The span **as it appears in the source document** — never the model's
   * string. Slicing the source is the entire guarantee this module provides.
   */
  quote: string;
  /** Offsets into the source markdown; `markdown.slice(start, end) === quote`. */
  start: number;
  end: number;
  /** Which concession was needed to find it. `exact` is the goal. */
  rung: MatchRung;
  /** True when the model's string differed from the source span it located. */
  modelQuoteDiffered: boolean;
}

export interface RejectedClaim {
  ok: false;
  claim: string;
  /** Kept for triage only — never promoted into an artefact. */
  modelQuote: string;
  reason: "empty-claim" | "empty-quote" | "not-found";
  detail: string;
}

export type ClaimVerification = VerifiedClaim | RejectedClaim;

// ---------------------------------------------------------------------------
// Normalization with an index map back to the original string
// ---------------------------------------------------------------------------

/**
 * A normalized view of a string plus the mapping needed to get back.
 *
 * `map` has length `text.length + 1`. `map[i]` is the offset in the ORIGINAL
 * string at which normalized character `i` begins; `map[text.length]` is the
 * offset just past the last consumed character. That final entry is what makes
 * `original.slice(map[s], map[e])` correct rather than off by one when the last
 * matched character came from a collapsed run.
 */
interface Normalized {
  text: string;
  map: number[];
}

/** Characters that markdown uses for emphasis/structure and carry no content. */
const MARKDOWN_NOISE = new Set(["*", "_", "`", "#", "|", ">", "~"]);

const UNICODE_FOLD: Record<string, string> = {
  "‘": "'", // ‘
  "’": "'", // ’
  "‚": "'",
  "“": '"', // “
  "”": '"', // ”
  "„": '"',
  "–": "-", // –
  "—": "-", // —
  "−": "-", // −
  " ": " ", // nbsp
  " ": " ",
  " ": " ",
  "…": "...", // …
};

/**
 * Build the normalized view for a given rung. Cumulative: each rung applies
 * every relaxation of the rungs before it.
 *
 * Implemented as a single character-wise pass so the index map stays exact.
 * Doing this with `String.replace` would be shorter and would lose the mapping,
 * which is the one thing that must not be approximate.
 */
function normalize(input: string, rung: MatchRung): Normalized {
  const foldWhitespace = rung !== "exact";
  const foldUnicode = rung === "unicode" || rung === "markdown";
  const stripMarkdown = rung === "markdown";

  const out: string[] = [];
  const map: number[] = [];

  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (stripMarkdown && MARKDOWN_NOISE.has(ch)) {
      i++;
      continue;
    }

    if (foldWhitespace && /\s/.test(ch)) {
      // Collapse the whole run; remember where the run started so the emitted
      // space maps to a real original offset.
      const runStart = i;
      while (i < input.length && /\s/.test(input[i]!)) i++;
      // Emit at most one space, and never a leading one. The `out[last] !== " "`
      // guard matters more than it looks: at the `markdown` rung a stripped
      // character can sit BETWEEN two whitespace runs — `| Code  | BK-CATCHUP |`
      // — and without it each run emits its own space, yielding a double space
      // that matches nothing. Found by the table-row test.
      if (out.length > 0 && out[out.length - 1] !== " ") {
        map.push(runStart);
        out.push(" ");
      }
      continue;
    }

    let emitted = ch;
    if (foldUnicode && UNICODE_FOLD[ch] !== undefined) {
      emitted = UNICODE_FOLD[ch]!;
    }

    // A fold may expand one char into several (… -> ...). Every emitted char
    // maps back to the same original offset, which is correct: they all came
    // from it.
    for (const c of emitted) {
      out.push(c);
      map.push(i);
    }
    i++;
  }

  // Drop a trailing collapsed space so `"a  "` and `"a"` compare equal.
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }

  map.push(input.length); // sentinel: end of the last consumed character
  return { text: out.join(""), map };
}

/**
 * Where a normalized match ends in the ORIGINAL string.
 *
 * `map[normEnd]` is the start of the character *after* the match, which for a
 * collapsed whitespace run would swallow the run into the span. Walk back over
 * trailing whitespace so the stored quote ends on real content.
 */
function originalEnd(original: string, map: number[], normEnd: number): number {
  let end = normEnd < map.length ? map[normEnd]! : original.length;
  while (end > 0 && /\s/.test(original[end - 1]!)) end--;
  return end;
}

// ---------------------------------------------------------------------------

/**
 * Verify one model-produced claim against the document it came from.
 *
 * Returns the claim with a quote sliced from `markdown`, or a rejection. **A
 * rejection is a normal outcome, not an error** — dropping a claim whose quote
 * cannot be located is precisely the behaviour this module exists to guarantee.
 */
export function verifyClaim(
  markdown: string,
  claim: string,
  modelQuote: string,
): ClaimVerification {
  const trimmedClaim = claim.trim();
  const trimmedQuote = modelQuote.trim();

  if (trimmedClaim.length === 0) {
    return {
      ok: false,
      claim,
      modelQuote,
      reason: "empty-claim",
      detail: "claim text was empty after trimming",
    };
  }
  if (trimmedQuote.length === 0) {
    return {
      ok: false,
      claim: trimmedClaim,
      modelQuote,
      reason: "empty-quote",
      detail:
        "quote was empty after trimming — an unquoted claim is unverifiable",
    };
  }

  for (const rung of MATCH_RUNGS) {
    const hay = normalize(markdown, rung);
    const needle = normalize(trimmedQuote, rung);
    if (needle.text.length === 0) continue;

    const at = hay.text.indexOf(needle.text);
    if (at === -1) continue;

    const start = hay.map[at]!;
    const end = originalEnd(markdown, hay.map, at + needle.text.length);
    const sourceSpan = markdown.slice(start, end);

    return {
      ok: true,
      claim: trimmedClaim,
      // The source span. NOT `modelQuote` — that is the whole point.
      quote: sourceSpan,
      start,
      end,
      rung,
      modelQuoteDiffered: sourceSpan !== trimmedQuote,
    };
  }

  return {
    ok: false,
    claim: trimmedClaim,
    modelQuote: trimmedQuote,
    reason: "not-found",
    detail:
      "quote could not be located in the document at any rung — the model " +
      "paraphrased rather than quoted, or cited the wrong document",
  };
}

export interface VerificationReport {
  verified: VerifiedClaim[];
  rejected: RejectedClaim[];
  /** How many claims matched at each rung. The diagnostic — see module header. */
  rungCounts: Record<MatchRung, number>;
  /**
   * True when the ladder is doing more work than it should: fewer than half of
   * verified claims matched exactly. Signals that the EXTRACTION PROMPT needs
   * tightening — it is never a reason to add another rung.
   */
  ladderStrain: boolean;
}

/** Verify a batch and summarize, including the rung distribution. */
export function verifyClaims(
  markdown: string,
  claims: readonly { claim: string; quote: string }[],
): VerificationReport {
  const verified: VerifiedClaim[] = [];
  const rejected: RejectedClaim[] = [];
  const rungCounts: Record<MatchRung, number> = {
    exact: 0,
    whitespace: 0,
    unicode: 0,
    markdown: 0,
  };

  for (const c of claims) {
    const result = verifyClaim(markdown, c.claim, c.quote);
    if (result.ok) {
      verified.push(result);
      rungCounts[result.rung]++;
    } else {
      rejected.push(result);
    }
  }

  return {
    verified,
    rejected,
    rungCounts,
    ladderStrain:
      verified.length > 0 && rungCounts.exact / verified.length < 0.5,
  };
}
