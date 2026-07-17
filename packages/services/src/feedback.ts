import { submitAnswerFeedback as dbSubmitAnswerFeedback } from "@rag/db";
import type { ServiceDeps } from "./deps.js";

export interface SubmitFeedbackInput {
  answerId: string;
  rating: "helpful" | "not_helpful";
  comment?: string;
  /** Derived server-side from the authenticated principal — NOT the client body. */
  principalSubject: string | null;
  channel: "web" | "teams";
}

/**
 * Record a Helpful/Not-Helpful vote for an answer. Thin pass-through to the
 * `@rag/db` upsert (Task 3) — the security-relevant contract is entirely in
 * `SubmitFeedbackInput.principalSubject`'s JSDoc and enforced by the caller
 * (the `/feedback` route derives it from `request.principal`, never from the
 * request body).
 */
export async function submitAnswerFeedback(
  deps: ServiceDeps,
  input: SubmitFeedbackInput,
): Promise<void> {
  await dbSubmitAnswerFeedback(deps.db, {
    answerId: input.answerId,
    rating: input.rating,
    comment: input.comment ?? null,
    principalSubject: input.principalSubject,
    channel: input.channel,
  });
}
