import { createHash } from "node:crypto";
import type { Config } from "@rag/core";
import { filterSchema } from "@rag/core";
import { logAskEvent } from "@rag/db";
import {
  askQuestion,
  askQuestionStream,
  type AskResult,
  GenerationNotConfiguredError,
} from "@rag/services";
import type { FastifyInstance, FastifyRequest } from "fastify";
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

// "mcp" is intentionally excluded: that channel value is written only by the
// MCP app's own hard-coded code (apps/mcp/src/tools/ask.ts), never via a
// client-supplied header on this HTTP route. Allowing it here would let an
// external caller spoof X-RAG-Channel: mcp and corrupt the compliance audit
// log's transport attribution.
const KNOWN_CHANNELS = new Set(["api", "teams"]);
function channelFromRequest(request: FastifyRequest): "api" | "teams" {
  const raw = request.headers["x-rag-channel"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value && KNOWN_CHANNELS.has(value) ? value : "api") as
    "api" | "teams";
}

/**
 * Fire-and-forget audit record for every successful /ask call.
 * Failures are logged but must not block the response.
 */
function auditAsk(
  deps: Deps,
  request: FastifyRequest,
  question: string,
  retrieved: AskResult["retrieved"],
  model: string | undefined,
): void {
  const p = request.principal;
  void logAskEvent(deps.db, {
    principalKind: p?.kind ?? "scoped",
    principalSources: p?.kind === "scoped" ? p.allowedSourceIds : null,
    principalSubject: p?.kind === "scoped" ? (p.subject ?? null) : null,
    questionHash: createHash("sha256").update(question).digest("hex"),
    channel: channelFromRequest(request),
    model: model ?? null,
    embeddingProvider: deps.embedder.name,
    embeddingModel: deps.embedder.model,
    sourceIds: [...new Set(retrieved.map((r) => r.document.sourceId))],
    chunkIds: retrieved.map((r) => r.chunk.id),
    docIds: [...new Set(retrieved.map((r) => r.document.id))],
    retrievedCount: retrieved.length,
    endpoint: "ask",
    topScore: retrieved[0]?.score ?? null,
  }).catch((err: unknown) => deps.logger.error({ err }, "audit log failed"));
}

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
  //
  // Tighter per-route rate limit (10/min) — each request triggers an embedding
  // call + full LLM generation, so cost exposure is much higher than a plain
  // read. The global 60/min default applies to all other routes.
  typed.post(
    "/ask",
    {
      schema: { body: AskBody },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) => {
      const result = await askQuestion(
        deps,
        request.body,
        config.retrieval.defaultTopK,
        scopeFromRequest(request),
        config.retrieval.maxChunksPerDocument,
      );
      auditAsk(
        deps,
        request,
        request.body.question,
        result.retrieved,
        config.generation?.model,
      );
      return result;
    },
  );

  // POST /ask/stream — same retrieval + generation as /ask, but streamed as SSE
  // so the chat client can render tokens as they arrive. The generator-null
  // case is rejected BEFORE hijacking the reply, so it still maps to a 503 JSON
  // envelope via the central error handler; once streaming starts, failures are
  // surfaced as an `error` SSE event (status is already committed to 200).
  //
  // SSE event contract (consumed by apps/web/src/lib/stream-chat.ts):
  //   event: token  data: <JSON-encoded string chunk>
  //   event: done   data: {citations, retrieved, reviewStatus, disclaimer}
  //   event: error  data: {message}
  typed.post(
    "/ask/stream",
    {
      schema: { body: AskBody },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!deps.generator) {
        throw new GenerationNotConfiguredError();
      }
      const scope = scopeFromRequest(request);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      try {
        for await (const event of askQuestionStream(
          deps,
          request.body,
          config.retrieval.defaultTopK,
          scope,
          config.retrieval.maxChunksPerDocument,
        )) {
          if (event.type === "token") {
            raw.write(`event: token\ndata: ${JSON.stringify(event.text)}\n\n`);
          } else {
            auditAsk(
              deps,
              request,
              request.body.question,
              event.retrieved,
              config.generation?.model,
            );
            raw.write(
              `event: done\ndata: ${JSON.stringify({
                citations: event.citations,
                retrieved: event.retrieved,
                reviewStatus: event.reviewStatus,
                disclaimer: event.disclaimer,
              })}\n\n`,
            );
          }
        }
      } catch (err) {
        // The scope/PII boundary is enforced inside the service; never echo the
        // raw error (it may carry connection details). Log server-side instead.
        deps.logger.error({ err }, "ask/stream generation failed");
        raw.write(
          `event: error\ndata: ${JSON.stringify({
            message: "Generation failed.",
          })}\n\n`,
        );
      } finally {
        raw.end();
      }
    },
  );
}
