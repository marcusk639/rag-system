import type { Readable } from "node:stream";
import type {
  Chunk,
  Embedding,
  ParsedDocument,
  RetrievalResult,
  SourceDocument,
} from "./types.js";

// ============================================================================
// EmbeddingProvider — converts text to vectors. Swap providers by implementing this.
// ============================================================================

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;

  /** Embed one text. Throws on transient failures so retries surface as job retries. */
  embed(text: string): Promise<Embedding>;

  /**
   * Batch-embed. Implementations should pack as many texts per request as the
   * provider allows. Order of results must match order of inputs.
   *
   * NOTE: `embed`/`embedBatch` are the CORPUS/document side. For providers with
   * asymmetric retrieval embeddings, these use the document task type.
   */
  embedBatch(texts: string[]): Promise<Embedding[]>;

  /**
   * Embed a search QUERY. Optional. Providers with asymmetric retrieval
   * embeddings (e.g. Gemini `RETRIEVAL_QUERY` vs `RETRIEVAL_DOCUMENT`) implement
   * this so queries are projected with the query task type. Providers without
   * the distinction (e.g. OpenAI) may omit it; callers fall back to `embed`.
   */
  embedQuery?(text: string): Promise<Embedding>;
}

// ============================================================================
// Generator — answers a question grounded in retrieved chunks. Swap providers
// (Gemini, OpenAI, etc.) by implementing this. Concrete implementations and the
// `createGenerator` factory live in `@rag/rag`; only the contract lives here.
// ============================================================================

export interface Generator {
  answer(
    question: string,
    context: RetrievalResult[],
  ): Promise<GenerationResult>;
  /**
   * Streaming counterpart of `answer`. Yields answer text incrementally as the
   * model produces it. Citations are derived deterministically from `context`
   * (see `buildCitations`), so the stream carries text only — the caller
   * attaches citations once the stream completes.
   */
  answerStream(
    question: string,
    context: RetrievalResult[],
  ): AsyncIterable<string>;
}

export interface GenerationResult {
  answer: string;
  citations: Array<{
    index: number; // matches [N] in the answer
    documentId: string;
    title: string;
    url?: string;
    /** True when the original file can be downloaded (GET /documents/:id/download). */
    downloadable: boolean;
    chunkId: string;
    score: number;
  }>;
}

// ============================================================================
// Reranker — re-orders a candidate pool by true query relevance. Swap providers
// by implementing this (hosted cross-encoder, LLM-based, etc.).
// ============================================================================

export interface Reranker {
  readonly name: string;

  /**
   * Re-order `candidates` by relevance to `query` and return the top `topK`.
   * Implementations MUST return a NEW array (no mutation of the input) and MUST
   * NOT add or fabricate results — only re-order and truncate the candidates
   * they were given. Throwing is acceptable; callers degrade to the pre-rerank
   * (RRF) order so a reranker outage never fails a query.
   */
  rerank(
    query: string,
    candidates: RetrievalResult[],
    topK: number,
  ): Promise<RetrievalResult[]>;
}

// ============================================================================
// Parser — converts raw bytes into a normalized markdown representation
// ============================================================================

export interface Parser {
  /**
   * Convert a binary document into clean markdown plus structured metadata.
   * @param input.content     Raw file bytes
   * @param input.mimeType    MIME type hint (parser may sniff/override)
   * @param input.filename    Filename hint for extension-based fallback detection
   */
  parse(input: {
    content: Buffer;
    mimeType: string;
    filename: string;
  }): Promise<ParsedDocument>;
}

// ============================================================================
// Chunker — slices a parsed document into embedding-ready chunks
// ============================================================================

export interface Chunker {
  /**
   * Split a parsed document. Chunkers MUST be deterministic — same input
   * yields the same chunks (including same hashes) so re-ingestion is idempotent.
   */
  chunk(document: ParsedDocument): Promise<Chunk[]>;
}

// ============================================================================
// Connector — pulls SourceDocuments from an external system
// ============================================================================

export interface ConnectorListOptions {
  /**
   * Opaque cursor returned by a previous call. When supplied, the connector
   * returns only changes since that cursor (delta sync).
   */
  cursor?: string | null;
  /** Hard cap on how many documents to enumerate this call (rate-limit safety) */
  maxItems?: number;
}

export interface ConnectorListResult {
  /** Documents to ingest. Implementations may return small batches and a continuation cursor. */
  documents: SourceDocument[];
  /** New cursor to persist for next call. `null` means no more pages. */
  nextCursor: string | null;
  /** True when the source has nothing more to return at this point in time */
  done: boolean;
  /**
   * External IDs of documents the source reports as deleted/removed since the
   * last cursor (delta tombstones). The pipeline removes these documents (and
   * their chunks) so the corpus stays truthful. Optional: connectors that do
   * not surface deletions simply omit it.
   */
  deletions?: string[];
  /**
   * Count of items skipped this call because they exceeded the connector's
   * file-size cap. Surfaced for observability only (not an error). Optional.
   */
  skippedOversize?: number;
}

export interface Connector {
  readonly kind: string;
  /**
   * Validate credentials and configuration. Should be cheap (a single API call).
   * Throws if the connector cannot operate (bad token, missing scopes, etc).
   */
  validate(): Promise<void>;

  /**
   * Enumerate documents. With no cursor, this is a full sync. With a cursor,
   * it returns deltas. Implementations should use server-side delta APIs where
   * available (Microsoft Graph delta, Drive changes feed, Gmail history).
   */
  list(options?: ConnectorListOptions): Promise<ConnectorListResult>;

  /**
   * Fetch a single document by external ID. Used for retry/reprocess flows.
   */
  fetch(externalId: string): Promise<SourceDocument>;
}

// ============================================================================
// ObjectStore — persists original document bytes (S3-compatible) so cited
// documents can be downloaded later. Swap backends by implementing this.
// ============================================================================

/** The bytes + content metadata returned when fetching a stored object. */
export interface ObjectStoreGetResult {
  /** The object's bytes as a Node Readable stream (suitable for HTTP streaming). */
  body: Readable;
  /** The stored content type, if the backend recorded one. */
  contentType?: string;
  /** The object's size in bytes, if known. */
  contentLength?: number;
}

export interface ObjectStore {
  /** The bucket originals are written to (recorded alongside each document). */
  readonly bucket: string;
  /**
   * Store bytes under a logical key. Implementations may transparently prefix
   * the key (e.g. a configured key prefix); callers pass and later read back
   * the SAME logical key. Overwriting an existing key is allowed (idempotent
   * re-ingest of changed content).
   */
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** Fetch the object stored under the logical key. Throws if absent. */
  get(key: string): Promise<ObjectStoreGetResult>;
  /** Remove the object under the logical key. A missing key is not an error. */
  delete(key: string): Promise<void>;
}
