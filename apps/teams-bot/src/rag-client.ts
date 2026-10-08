export interface Citation {
  index: number;
  title: string;
  documentId: string;
  downloadable: boolean;
  /**
   * The source document's canonical URL (e.g. a SharePoint/Drive link),
   * browser-clickable under the user's own M365 access. Not derived from
   * `documentId`/`downloadable` — those describe the auth-gated
   * `/documents/:id/download` endpoint, which a Teams card link cannot reach.
   */
  url?: string;
  /** Source document's last-modified date (YYYY-MM-DD), when known. */
  modifiedAt?: string;
  /**
   * §7216/GLBA class of the source document, when tagged. Absent means
   * UNTAGGED, which the server treats as stricter than A — never substitute a
   * default.
   */
  docClass?: "A" | "B" | "C" | "D";
}

export interface AskAnswer {
  answer: string;
  citations: Citation[];
  disclaimer: string;
  /** Server id for this answer; feedback references it. */
  answerId?: string;
}

export type FeedbackRating = "helpful" | "not_helpful";

/**
 * An API failure whose `message` is safe to show the user verbatim. Messages
 * are fixed here, never copied from the response body, which can carry
 * internal detail.
 */
export class KbUserFacingError extends Error {}

export class KbUnavailableError extends KbUserFacingError {
  constructor() {
    super("The knowledge base is temporarily unavailable.");
    this.name = "KbUnavailableError";
  }
}

/** 422: the TRI pre-flight refused the question or everything it retrieved. */
export class KbComplianceRefusedError extends KbUserFacingError {
  constructor() {
    super(
      "I can't answer that one: the question, or the documents that match it, contain client identifiers. Try asking without client-specific details.",
    );
    this.name = "KbComplianceRefusedError";
  }
}

export class KbRateLimitedError extends KbUserFacingError {
  constructor() {
    super("Too many questions right now — please wait a minute and try again.");
    this.name = "KbRateLimitedError";
  }
}

export class KbAccessError extends KbUserFacingError {
  constructor() {
    super(
      "The knowledge base didn't accept this request's credentials. Please try again; if it keeps happening, sign out of Teams and back in, or contact an admin.",
    );
    this.name = "KbAccessError";
  }
}

export class KbInvalidQuestionError extends KbUserFacingError {
  constructor() {
    super("I couldn't process that question — try rephrasing it more briefly.");
    this.name = "KbInvalidQuestionError";
  }
}

function errorForStatus(status: number): KbUserFacingError {
  if (status === 422) return new KbComplianceRefusedError();
  if (status === 429) return new KbRateLimitedError();
  if (status === 401 || status === 403) return new KbAccessError();
  if (status === 400) return new KbInvalidQuestionError();
  return new KbUnavailableError();
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

interface AskKbInput {
  question: string;
  scopeToken: string;
  /** Prior turns, oldest first; the API rewrites a follow-up for retrieval. */
  history?: HistoryTurn[];
}

/** Upper bound on how long a single /ask call may take before the bot gives
 * up and shows the "temporarily unavailable" card. Generation latency is
 * real (LLM round-trip), so this is generous — but a hung upstream must
 * never hang the Teams turn forever. */
const DEFAULT_ASK_TIMEOUT_MS = 20_000;

interface AskKbDeps {
  ragApiUrl: string;
  fetch: typeof fetch;
  /** Overridable for tests; defaults to {@link DEFAULT_ASK_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export async function askKb(
  input: AskKbInput,
  deps: AskKbDeps,
): Promise<AskAnswer> {
  const { question, scopeToken, history } = input;
  const { ragApiUrl, fetch: fetchFn } = deps;

  try {
    const res = await fetchFn(`${ragApiUrl}/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scopeToken}`,
        "X-RAG-Channel": "teams",
      },
      body: JSON.stringify(
        history && history.length > 0 ? { question, history } : { question },
      ),
      // A timeout abort surfaces as a rejection and is mapped to
      // KbUnavailableError by the catch below — never leaked verbatim.
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw errorForStatus(res.status);
    }

    const data = (await res.json()) as AskAnswer;
    return data;
  } catch (error) {
    // Re-throw a mapped, user-safe error as-is
    if (error instanceof KbUserFacingError) {
      throw error;
    }
    // Convert any other error to KbUnavailableError
    throw new KbUnavailableError();
  }
}

interface SubmitFeedbackInput {
  answerId: string;
  rating: FeedbackRating;
  scopeToken: string;
}

/** Record a Helpful/Not-helpful vote. The API derives the voter's identity from
 * the scope token, never from this body. Throws `KbUnavailableError` on any
 * failure. */
export async function submitFeedback(
  input: SubmitFeedbackInput,
  deps: AskKbDeps,
): Promise<void> {
  try {
    const res = await deps.fetch(`${deps.ragApiUrl}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.scopeToken}`,
        "X-RAG-Channel": "teams",
      },
      body: JSON.stringify({ answerId: input.answerId, rating: input.rating }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS),
    });
    if (!res.ok) throw new KbUnavailableError();
  } catch (error) {
    if (error instanceof KbUnavailableError) throw error;
    throw new KbUnavailableError();
  }
}
