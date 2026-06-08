import { z } from "zod";

/**
 * Shared bounded metadata-filter schema for `/search`, `/ask`, and the MCP
 * `search_documents`/`ask` tools. Single-sourced here so the DoS caps can't
 * drift between transports.
 *
 * Without these bounds an authenticated caller could send hundreds of keys,
 * each with hundreds of multi-KB values, ballooning the hybrid-search SQL into
 * a massive N-way OR scan (query amplification / DoS).
 */
export const MAX_FILTER_VALUE_LEN = 256;
export const MAX_FILTER_VALUES_PER_KEY = 50;
export const MAX_FILTER_KEY_LEN = 64;
export const MAX_FILTER_KEYS = 20;

const FilterValue = z.union([
  z.string().max(MAX_FILTER_VALUE_LEN),
  z.array(z.string().max(MAX_FILTER_VALUE_LEN)).max(MAX_FILTER_VALUES_PER_KEY),
]);

export const filterSchema = z
  .record(z.string().max(MAX_FILTER_KEY_LEN), FilterValue)
  .refine((obj) => Object.keys(obj).length <= MAX_FILTER_KEYS, {
    message: `filter accepts at most ${MAX_FILTER_KEYS} keys`,
  });
