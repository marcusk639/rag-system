import type { Config } from "@rag/core";
import { askQuestion } from "@rag/services";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";

// Bounded metadata filter — same shape and limits as POST /search.
// See packages/db/src/queries.ts hybridSearch for how keys/values land in SQL.
const FilterValue = z.union([
  z.string().max(256),
  z.array(z.string().max(256)).max(50),
]);
const MAX_FILTER_KEYS = 20;
const FilterSchema = z
  .record(z.string().max(64), FilterValue)
  .refine((obj) => Object.keys(obj).length <= MAX_FILTER_KEYS, {
    message: `filter accepts at most ${MAX_FILTER_KEYS} keys`,
  });

const AskBody = z.object({
  question: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(100).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
  filter: FilterSchema.optional(),
});

export async function registerAskRoute(
  app: FastifyInstance,
  deps: Deps,
  config: Config,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /ask — retrieval + generation. Thin adapter: validate → service.
  // The generator-null guard and empty-results short-circuit live in
  // `askQuestion`; GenerationNotConfiguredError maps to 503 via the central
  // error handler (STATUS_BY_CODE).
  typed.post("/ask", { schema: { body: AskBody } }, async (request) => {
    return askQuestion(deps, request.body, config.retrieval.defaultTopK);
  });
}
