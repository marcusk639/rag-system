import type {
  Chunk,
  Embedding,
  ParsedDocument,
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
   */
  embedBatch(texts: string[]): Promise<Embedding[]>;
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
