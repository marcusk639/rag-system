import { createHash } from "node:crypto";
import type { Config } from "@rag/core";
import type { SanitizedRetrievalResult } from "@rag/core";
import { filterSchema } from "@rag/core";
import { logAskEvent } from "@rag/db";
import { searchDocuments } from "@rag/services";
import type { FastifyInstance, FastifyRequest } from "fastify";
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

/**
 * Fire-and-forget audit record for every successful /search call. Mirrors
 * `auditAsk` (`apps/api/src/routes/ask.ts`) field-for-field, differing only
 * in `endpoint` and hashing the search query instead of a question. Reuses
 * `logAskEvent`/`audit_log` — no parallel table.
 * Failures are logged but must not block the response.
 */
function auditSearch(
  deps: Deps,
  request: FastifyRequest,
  query: string,
  results: SanitizedRetrievalResult[],
): void {
  const p = request.principal;
  void logAskEvent(deps.db, {
    principalKind: p?.kind ?? "scoped",
    principalSources: p?.kind === "scoped" ? p.allowedSourceIds : null,
    principalSubject: p?.kind === "scoped" ? (p.subject ?? null) : null,
    questionHash: createHash("sha256").update(query).digest("hex"),
    channel: "api",
    model: null,
    embeddingProvider: deps.embedder.name,
    embeddingModel: deps.embedder.model,
    sourceIds: [...new Set(results.map((r) => r.document.sourceId))],
    chunkIds: results.map((r) => r.chunk.id),
    docIds: [...new Set(results.map((r) => r.document.id))],
    retrievedCount: results.length,
    endpoint: "search",
    topScore: results[0]?.score ?? null,
  }).catch((err: unknown) => deps.logger.error({ err }, "audit log failed"));
}

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
    auditSearch(deps, request, request.body.query, results);
    return { results };
  });
}
