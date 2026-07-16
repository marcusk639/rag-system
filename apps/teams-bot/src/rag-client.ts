export interface Citation {
  index: number;
  title: string;
  documentId: string;
  downloadable: boolean;
}

export interface AskAnswer {
  answer: string;
  citations: Citation[];
  disclaimer: string;
}

export class KbUnavailableError extends Error {
  constructor() {
    super("The knowledge base is temporarily unavailable.");
    this.name = "KbUnavailableError";
  }
}

interface AskKbInput {
  question: string;
  scopeToken: string;
}

interface AskKbDeps {
  ragApiUrl: string;
  fetch: typeof fetch;
}

export async function askKb(
  input: AskKbInput,
  deps: AskKbDeps,
): Promise<AskAnswer> {
  const { question, scopeToken } = input;
  const { ragApiUrl, fetch: fetchFn } = deps;

  try {
    const res = await fetchFn(`${ragApiUrl}/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scopeToken}`,
        "X-RAG-Channel": "teams",
      },
      body: JSON.stringify({ question }),
    });

    if (!res.ok) {
      throw new KbUnavailableError();
    }

    const data = (await res.json()) as AskAnswer;
    return data;
  } catch (error) {
    // Re-throw KbUnavailableError as-is
    if (error instanceof KbUnavailableError) {
      throw error;
    }
    // Convert any other error to KbUnavailableError
    throw new KbUnavailableError();
  }
}
