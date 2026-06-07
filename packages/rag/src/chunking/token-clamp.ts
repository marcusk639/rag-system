import { decode, encode } from "gpt-tokenizer";

/**
 * Hard upper bound on the token count of any chunk before it can reach
 * `embedBatch`. This is a safety net for pathological outliers (a very wide
 * table row, a huge fenced code block) — the normal target chunk size is much
 * smaller, so in practice this should rarely fire.
 *
 * Why 1700 and not 2048?
 *   - Gemini's documented embedding input limit is 2048 tokens. Exceeding it
 *     produces an opaque provider error mid-sync, *after* embedding credits are
 *     already spent.
 *   - We measure tokens with the `o200k_base` (GPT-4o family) tokenizer as a
 *     stable, provider-independent PROXY for Gemini's tokenizer. That proxy can
 *     UNDER-count Gemini by ~10–20% on dense content (wide tables, code).
 *   - Clamping to 2048 o200k-tokens is therefore NOT safe: a 20% undercount of
 *     a 2048-token measurement could be ~2458 real Gemini tokens.
 *   - 2048 / 1.2 ≈ 1706. We round down to a clean 1700 so that even a 20%
 *     undercount stays under the real 2048 limit (1700 × 1.2 = 2040 ≤ 2048).
 *
 * If the chunker's tokenizer changes, this constant and the proxy rationale
 * above must be revisited.
 */
export const MAX_EMBEDDING_TOKENS = 1700;

/**
 * Guarantee that `text` is at most `maxTokens` tokens long, truncating with the
 * SAME tokenizer the chunkers use (`o200k_base`). Truncation is token-aware:
 * we encode, keep the first `maxTokens` tokens, and decode that prefix back to
 * a string — never a raw character slice, which can split mid-token and corrupt
 * the trailing characters.
 *
 * Returns the input unchanged (no re-encode round-trip) when it already fits,
 * which is the overwhelmingly common case.
 */
export function clampToTokenLimit(
  text: string,
  maxTokens: number = MAX_EMBEDDING_TOKENS,
): string {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return text;
  return decode(tokens.slice(0, maxTokens));
}
