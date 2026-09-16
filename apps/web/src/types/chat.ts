export type MessageRole = "user" | "assistant";

/** Citation shape from the RAG API (`/ask`, `/ask/stream`). */
export interface Citation {
  index: number; // 1-indexed; matches [N] markers in answer text
  documentId: string; // UUID -> use with GET /documents/:id
  title: string;
  url?: string;
  /** True when the original file can be downloaded via GET /documents/:id/download. */
  downloadable?: boolean;
  chunkId: string;
  score: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  citations?: Citation[];
  /** Server-assigned id for this answer. Required to submit feedback on it. */
  answerId?: string;
  /**
   * Set when the stream itself failed (network error, non-2xx response, a
   * mid-stream `event: error` frame). Rendered in its own element — kept out
   * of `content` so a stream error and a genuine refusal answer never share
   * one DOM node.
   */
  error?: string;
}

export interface ChatSession {
  id: string;
  name: string;
  messages: Message[];
}
