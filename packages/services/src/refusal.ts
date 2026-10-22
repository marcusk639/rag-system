/**
 * The fixed answer for empty retrieval, and byte-identical to the sentence the
 * generation prompt's coverage case C prescribes — so it is also what a model
 * refusal opens with.
 */
export const EMPTY_ANSWER =
  "The available documents do not contain enough information to answer that.";

/** The sentence with or without its final period. */
const REFUSAL_LINES = new Set([EMPTY_ANSWER, EMPTY_ANSWER.slice(0, -1)]);

/**
 * The rubric LABEL, which small models echo in place of the sentence — but
 * only as a whole one-sentence line ("The documents do not bear on the
 * question."), never as a phrase inside a longer answer.
 */
const LABEL_LINE = /^[^.!?\n]*\bdo not bear on the question(?: at all)?\.?$/i;

/**
 * The optional case-C line prescribed by the generation prompt, in exactly its
 * shape: a title, then one `[N]` citation, then nothing. The title may not
 * hold brackets or a sentence break, so a fabricated answer cannot ride along
 * ahead of the citation ("Travel SOP [1]. However, the rate is … [1].").
 * Trade-off: a title with an abbreviation like "Rev. Proc." fails this shape
 * and is scored as a non-refusal.
 */
const RELATED_MATERIAL =
  /^closest related material:(?:[^[\]\n.!?]|[.!?](?!\s))*\[\d+\]\s*\.?$/i;

/**
 * Whether an answer is a case-C refusal: the prescribed sentence (or the
 * echoed label) on its own line, optionally followed by exactly one
 * "Closest related material" line, and nothing else. The single predicate
 * shared by the ask path (citation warnings) and the eval harnesses.
 *
 * Exact shape rather than a continuation-word blocklist: any extra prose —
 * "However, …", or a bare uncited claim — means the model kept answering, and
 * scoring that as a refusal hides the confabulation this check exists to
 * catch. Citation count is deliberately not a signal: case C may cite the
 * closest related material.
 */
export function isRefusal(answer: string): boolean {
  const [opening = "", ...rest] = answer
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (!REFUSAL_LINES.has(opening) && !LABEL_LINE.test(opening)) return false;
  return (
    rest.length === 0 ||
    (rest.length === 1 && RELATED_MATERIAL.test(rest[0] ?? ""))
  );
}
