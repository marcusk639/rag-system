import type { Message } from "@/types";

/**
 * Must match `MAX_HISTORY_TURNS` in @rag/core (the API's DoS bound). Restated
 * rather than imported: this module is used by client components, and pulling
 * @rag/core into the browser bundle is not safe.
 */
export const MAX_FORWARDED_HISTORY_TURNS = 12;

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface UpstreamAskBody {
  question: unknown;
  sourceIds?: unknown;
  history?: HistoryTurn[];
}

/**
 * The conversation so far, as the API expects it: role + content of every
 * completed turn. Citations, answer ids, errored and still-empty assistant
 * placeholders stay in the browser. How many turns feed the follow-up rewrite
 * is the server's decision, so nothing is trimmed here.
 */
export function toHistory(messages: readonly Message[]): HistoryTurn[] {
  return messages
    .filter((m) => m.content.length > 0 && !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
}

function isTurn(value: unknown): value is HistoryTurn {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.role === "user" || v.role === "assistant") &&
    typeof v.content === "string"
  );
}

/**
 * The body the BFF forwards to POST /ask/stream. Allow-list, not pass-through:
 * a browser client must not be able to pick `topK` (context size, and so cost)
 * or metadata filters. History is cut to the most recent turns the API accepts
 * so a long chat keeps working instead of failing validation.
 */
export function buildUpstreamAskBody(body: unknown): UpstreamAskBody {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const out: UpstreamAskBody = { question: b.question };
  if (b.sourceIds !== undefined) out.sourceIds = b.sourceIds;
  if (Array.isArray(b.history)) {
    const turns = b.history
      .filter(isTurn)
      .map((t) => ({ role: t.role, content: t.content }))
      .slice(-MAX_FORWARDED_HISTORY_TURNS);
    if (turns.length > 0) out.history = turns;
  }
  return out;
}
