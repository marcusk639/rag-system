import type { Config } from "@rag/core";
import { filterSchema } from "@rag/core";
import {
  askQuestion,
  askQuestionStream,
  GenerationNotConfiguredError,
} from "@rag/services";
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
      config.retrieval.maxChunksPerDocument,
    );
  });

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
    { schema: { body: AskBody } },
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
