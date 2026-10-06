/** What `audit_log` retains of a question/answer pair. See `AUDIT_LOG_CONTENT`. */
export type AuditLogContentPolicy = "none" | "full";

/** The text columns `logAskEvent` writes, after the policy has been applied. */
export interface AuditContent {
  questionText: string | null;
  answerText: string | null;
}

/**
 * Apply the AUDIT_LOG_CONTENT policy to one audit row's content.
 *
 * Every audit call site routes through here rather than testing the policy
 * itself, so a site cannot drift and retain content on a deployment that
 * chose not to. `AskEventRow` takes the result as REQUIRED fields, which is
 * what makes forgetting it a type error rather than a silent omission.
 *
 * Fails closed: anything that is not exactly "full" retains nothing, so a
 * typo in the env var cannot start storing client content.
 */
export function resolveAuditContent(
  policy: AuditLogContentPolicy,
  question: string,
  answer: string | null,
): AuditContent {
  if (policy !== "full") return { questionText: null, answerText: null };
  return { questionText: question, answerText: answer };
}
