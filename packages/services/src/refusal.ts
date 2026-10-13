/**
 * The fixed answer for empty retrieval, and byte-identical to the sentence the
 * generation prompt's coverage case C prescribes — so it is also what a model
 * refusal opens with.
 */
export const EMPTY_ANSWER =
  "The available documents do not contain enough information to answer that.";

const REFUSAL_SENTENCE = EMPTY_ANSWER.replace(/\.$/, "");

/** The rubric LABEL, which small models echo in place of the sentence. */
const REFUSAL_LABEL = "do not bear on the question";

/**
 * A continuation word after the refusal sentence means the model kept going —
 * "…do not contain enough information. However, the rate is 70 cents [1]." is
 * a confabulation, and scoring it as a refusal hides the exact failure a
 * refusal check exists to catch.
 */
const CONTINUATION = /\b(however|but|that said|based on|according to)\b/i;

/** A real case C is the sentence plus at most one "Closest related material" line. */
const MAX_REFUSAL_CHARS = 400;

/**
 * Whether an answer is a case-C refusal. The single predicate shared by the
 * ask path (citation warnings) and the eval harnesses.
 *
 * Anchored on the OPENING line, because case C opens with the prescribed
 * sentence; matching anywhere would misread an answer that merely quotes it.
 * Citation count is deliberately not a signal: case C may cite the closest
 * related material.
 */
export function isRefusal(answer: string): boolean {
  const trimmed = answer.trim();
  const opening = trimmed.split("\n")[0] ?? "";
  if (
    !opening.includes(REFUSAL_SENTENCE) &&
    !opening.toLowerCase().includes(REFUSAL_LABEL)
  ) {
    return false;
  }
  return trimmed.length <= MAX_REFUSAL_CHARS && !CONTINUATION.test(trimmed);
}
