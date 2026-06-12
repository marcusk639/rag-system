import type { Config } from "@rag/core";
import { filterSchema } from "@rag/core";
import { askQuestion } from "@rag/services";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { scopeFromRequest } from "./authz.js";

const AskBody = z.object({
  question: z.string().min(1).max(2000),
  topK: z.number().int().positive().max(100).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
  // Shared bounded metadata filter (@rag/core/validation).
  filter: filterSchema.optional(),
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
  // error handler (STATUS_BY_CODE). The service enforces the confidentiality
  // scope and PII allowlist; the route only resolves the principal's scope.
  typed.post("/ask", { schema: { body: AskBody } }, async (request) => {
    return askQuestion(
      deps,
      request.body,
      config.retrieval.defaultTopK,
      scopeFromRequest(request),
    );
  });
}
