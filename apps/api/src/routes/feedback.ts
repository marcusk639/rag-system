import { submitAnswerFeedback } from "@rag/services";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";

const FeedbackBody = z.object({
  answerId: z.string().min(1),
  rating: z.enum(["helpful", "not_helpful"]),
  comment: z.string().max(1000).optional(),
});

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
        channel: "web",
      });
      return reply.code(204).send();
    },
  );
}
