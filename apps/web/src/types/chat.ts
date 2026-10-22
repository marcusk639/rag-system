export type MessageRole = "user" | "assistant";

/** Citation shape from the RAG API (`/ask`, `/ask/stream`). */
export interface Citation {
  index: number; // 1-indexed; matches [N] markers in answer text
  documentId: string; // UUID -> use with GET /documents/:id
  title: string;
  url?: string;
  /** True when the original file can be downloaded via GET /documents/:id/download. */
  downloadable?: boolean;
  /** The document's best-ranked chunk. One citation is emitted per document. */
  chunkId: string;
  /** Every retrieved chunk from the document, in reading order. */
  chunkIds?: string[];
  score: number;
  /** Source document's last-modified date (YYYY-MM-DD), when known. */
  modifiedAt?: string;
  /**
   * §7216/GLBA class of the source document, when tagged. Absent means
   * UNTAGGED, which the server treats as stricter than A — never render a
   * default here.
   */
  docClass?: "A" | "B" | "C" | "D";
}

/**
 * A server-detected citation problem on an answer (mirrors `CitationWarning`
 * in @rag/services; restated because the client bundle does not import it).
 * Not a per-claim check: an empty list does not prove the answer is grounded.
 */
export type CitationWarning =
  { kind: "invalid_citation"; indices: number[] } | { kind: "uncited_answer" };

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  citations?: Citation[];
  /** Server-assigned id for this answer. Required to submit feedback on it. */
  answerId?: string;
  /** Citation problems the server found on this answer; see `CitationWarning`. */
  citationWarnings?: CitationWarning[];
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
