import { z } from "zod";

/**
 * Bounded metadata filter shared by the `search_documents` and `ask` tools.
 *
 * Mirrors the caps enforced by the HTTP API (apps/api/src/routes/search.ts):
 * without these bounds an authenticated MCP caller could send hundreds of
 * keys, each with hundreds of multi-KB values, ballooning the hybrid-search
 * SQL into a massive N-way OR scan (query amplification / DoS).
 */
const FilterValue = z.union([
  z.string().max(256),
  z.array(z.string().max(256)).max(50),
]);

const MAX_FILTER_KEYS = 20;

export const filterSchema = z
  .record(z.string().max(64), FilterValue)
  .refine((obj) => Object.keys(obj).length <= MAX_FILTER_KEYS, {
    message: `filter accepts at most ${MAX_FILTER_KEYS} keys`,
  });
