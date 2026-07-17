import { submitAnswerFeedback } from "@rag/services";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";

const FeedbackBody = z.object({
  answerId: z.string().uuid(),
  rating: z.enum(["helpful", "not_helpful"]),
  comment: z.string().max(1000).optional(),
});

/**
 * Derives the `answer_feedback` channel — "web" | "teams" — from the
 * X-RAG-Channel header the Teams bot BFF sends (see
 * apps/teams-bot/src/rag-client.ts). NOTE: this vocabulary is DIFFERENT from
 * audit_log's "api" | "mcp" | "teams" (see routes/ask.ts's
 * `channelFromRequest`), so it is intentionally NOT reused here — anything
 * other than an explicit "teams" header defaults to "web".
 */
function feedbackChannel(request: FastifyRequest): "web" | "teams" {
  const raw = request.headers["x-rag-channel"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "teams" ? "teams" : "web";
}

/**
 * POST /feedback — record a Helpful/Not-Helpful vote on a prior /ask answer.
 * Thin adapter: validate → service. `principal_subject` is derived SERVER-SIDE
 * from `request.principal` (the authenticated scoped principal's verified
 * subject) — there is no such field in `FeedbackBody`, so a client cannot set
 * another user's identity, mirroring the `principal_subject` plumbing already
 * enforced for /ask and /search (see routes/ask.ts `auditAsk`).
 */
export async function registerFeedbackRoute(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/feedback",
    { schema: { body: FeedbackBody } },
    async (request, reply) => {
      const principal = request.principal;
      await submitAnswerFeedback(deps, {
        answerId: request.body.answerId,
        rating: request.body.rating,
        comment: request.body.comment,
        // Server-derived identity — never the client's word.
        principalSubject:
          principal?.kind === "scoped" ? (principal.subject ?? null) : null,
        channel: feedbackChannel(request),
      });
      return reply.code(204).send();
    },
  );
}
