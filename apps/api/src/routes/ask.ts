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
    );
  });

  // POST /ask/stream — SSE streaming variant of /ask. Same body, same scope.
  // Emits `event: token` (data = JSON-encoded text chunk, newline-safe) per
  // token, then a single `event: done` (data = JSON `{citations, retrieved}`).
  // The no-generator guard runs BEFORE the response head is written so it can
  // still fail closed with 503 GENERATION_NOT_CONFIGURED via the error handler.
  typed.post(
    "/ask/stream",
    { schema: { body: AskBody } },
    async (request, reply) => {
      if (!deps.generator) {
        throw new GenerationNotConfiguredError();
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        for await (const event of askQuestionStream(
          deps,
          request.body,
          config.retrieval.defaultTopK,
          scopeFromRequest(request),
        )) {
          if (event.type === "token") {
            send("token", event.value);
          } else {
            send("done", {
              citations: event.citations,
              retrieved: event.retrieved,
            });
          }
        }
      } catch (err) {
        request.log.error(err, "ask/stream generation failed");
        send("error", { message: "Stream generation failed." });
      } finally {
        reply.raw.end();
      }
    },
  );
}
