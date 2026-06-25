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
}

export interface ChatSession {
  id: string;
  name: string;
  messages: Message[];
}
