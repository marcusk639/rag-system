import type { Config } from "@rag/core";
import { filterSchema } from "@rag/core";
import { searchDocuments } from "@rag/services";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { scopeFromRequest } from "./authz.js";

const SearchBody = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().positive().max(100).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
  // Shared bounded metadata filter (@rag/core/validation) — same caps on
  // /search, /ask, and the MCP tools.
  filter: filterSchema.optional(),
});

export async function registerSearchRoute(
  app: FastifyInstance,
  deps: Deps,
  config: Config,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /search — retrieval only (no LLM). Thin adapter: validate → service.
  typed.post("/search", { schema: { body: SearchBody } }, async (request) => {
    // The service enforces the MANDATORY confidentiality boundary (scope) and
    // the PII metadata allowlist; the route only resolves the principal's scope
    // from the request and delegates.
    const results = await searchDocuments(
      deps,
      request.body,
      config.retrieval.defaultTopK,
      scopeFromRequest(request),
    );
    return { results };
  });
}
