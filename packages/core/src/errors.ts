/**
 * Base for all RAG-system errors. Carries a stable `code` so callers can
 * branch on category without string-matching the message.
 *
 * `cause` is passed to `Error`'s constructor (ES2022) rather than stored as
 * a parameter property, because `Error.cause` already exists in the prototype
 * and re-declaring it as a readonly parameter property triggers TS4115 under
 * `noImplicitOverride`.
 */
export class RagError extends Error {
  readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.code = code;
    this.name = this.constructor.name;
  }
}

/** Bad user/agent input — should surface as 400 in the API. */
export class ValidationError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, "VALIDATION_ERROR", cause);
  }
}

/** Auth/permission failure with an external system (expired token, missing scope). */
export class ConnectorAuthError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, "CONNECTOR_AUTH_ERROR", cause);
  }
}

/** Source is unreachable or returned an unexpected response — transient, retryable. */
export class ConnectorTransientError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, "CONNECTOR_TRANSIENT_ERROR", cause);
  }
}

/** Parser sidecar could not handle a document (corrupt, unsupported, too large). */
export class ParserError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, "PARSER_ERROR", cause);
  }
}

/** Embedding provider failed (rate limited, quota exceeded, model error). */
export class EmbeddingError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, "EMBEDDING_ERROR", cause);
  }
}

/** Resource not found (e.g. document, source). 404 in the API. */
export class NotFoundError extends RagError {
  constructor(message: string) {
    super(message, "NOT_FOUND", undefined);
  }
}

/**
 * Thrown when an ingestion attempt is blocked by the document classification
 * policy. Phase 1 accepts Class A and B only; C and D are denied.
 *
 * This is a hard enforcement error — it must NOT be silently swallowed or
 * retried. A ClassBlockedError means the source itself is misconfigured
 * (Class C/D source attempted ingestion before the required consent workflow
 * exists).
 */
export class ClassBlockedError extends RagError {
  readonly docClass: string;
  constructor(docClass: string, sourceId: string) {
    super(
      `Class ${docClass} documents cannot be indexed in Phase 1 ` +
        `(source ${sourceId}). Class C requires a §314.4(f) addendum; ` +
        `Class D requires a §7216 consent workflow. ` +
        `Fix the source configuration or escalate to compliance.`,
      "CLASS_BLOCKED",
      undefined,
    );
    this.docClass = docClass;
  }
}
