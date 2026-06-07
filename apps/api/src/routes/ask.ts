import {
  type Config,
  type RetrievalQuery,
  sanitizeRetrievalResults,
} from "@rag/core";
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

  // POST /ask — retrieval + generation
  typed.post("/ask", { schema: { body: AskBody } }, async (request, reply) => {
    if (!deps.generator) {
      return reply.code(503).send({
        error: {
          code: "GENERATION_NOT_CONFIGURED",
          message:
            "Generation is not configured. Set GENERATION_PROVIDER and GENERATION_MODEL to enable /ask.",
        },
      });
    }

    const { question, topK, sourceIds, filter } = request.body;

    const rq: RetrievalQuery = {
      query: question,
      topK: topK ?? config.retrieval.defaultTopK,
      ...(sourceIds ? { sourceIds } : {}),
      ...(filter ? { filter } : {}),
    };

    const retrieved = await deps.retriever.search(rq);

    // If nothing came back, short-circuit — the model would just hallucinate.
    if (retrieved.length === 0) {
      return {
        answer:
          "The available documents do not contain enough information to answer that.",
        citations: [],
        retrieved: [],
      };
    }

    // Generation runs against the FULL retrieved results (it never echoes raw
    // metadata to the caller — only answer text + citations). We only sanitize
    // the `retrieved` array we serialize back to the client.
    const result = await deps.generator.answer(question, retrieved);

    return {
      answer: result.answer,
      citations: result.citations,
      // PII boundary: strip non-allowlisted metadata before returning to the
      // caller. See @rag/core metadata-policy.
      retrieved: sanitizeRetrievalResults(retrieved),
    };
  });
}
