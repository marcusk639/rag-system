import type { Citation } from "@/types";

export interface AskStreamHandlers {
  onToken: (text: string) => void;
  onDone: (citations: Citation[]) => void;
  onError: (message: string) => void;
}

interface AskRequest {
  question: string;
  topK?: number;
  sourceIds?: string[];
}

/**
 * POST a question to the same-origin BFF (/api/chat) and parse the SSE response.
 * Event contract (from apps/api ask/stream):
 *   event: token  data: <JSON-encoded string chunk>
 *   event: done   data: {citations, retrieved, reviewStatus, disclaimer}
 *   event: error  data: {message}
 */
export async function askStream(
  req: AskRequest,
  handlers: AskStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = await res.json();
      message = body?.error?.message ?? message;
    } catch {
      /* keep default */
    }
    handlers.onError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatchFrame(frame, handlers);
    }
  }
}

function dispatchFrame(frame: string, handlers: AskStreamHandlers): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  const raw = dataLines.join("\n");

  if (event === "token") {
    try {
      handlers.onToken(JSON.parse(raw) as string);
    } catch {
      handlers.onToken(raw);
    }
    return;
  }
  if (event === "done") {
    try {
      const payload = JSON.parse(raw) as { citations?: Citation[] };
      handlers.onDone(payload.citations ?? []);
    } catch {
      handlers.onDone([]);
    }
    return;
  }
  if (event === "error") {
    let message = "Stream generation failed.";
    try {
      message = (JSON.parse(raw) as { message?: string }).message ?? message;
    } catch {
      /* keep default */
    }
    handlers.onError(message);
  }
}
