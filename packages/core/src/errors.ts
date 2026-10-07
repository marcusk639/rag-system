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

/**
 * Thrown when an outbound call would reach a host not on the egress allow-list.
 * Fail-closed: this is a hard block — the caller must not silently retry.
 * Add the host to EGRESS_ALLOWED_HOSTS (and confirm a DPA is on file) to allow it.
 */
export class EgressError extends RagError {
  readonly host: string;
  constructor(host: string) {
    super(
      `Outbound call to "${host}" blocked — not in EGRESS_ALLOWED_HOSTS. ` +
        `Add the host to the allow-list only after confirming a signed DPA is on file.`,
      "EGRESS_BLOCKED",
      undefined,
    );
    this.host = host;
  }
}

/**
 * Thrown when a compliance pre-flight check blocks an operation.
 * Currently used when TRI (taxpayer return information, IRC §7216) patterns
 * are detected in text destined for an external generation API.
 */
export class ComplianceError extends RagError {
  constructor(message: string) {
    super(message, "COMPLIANCE_VIOLATION", undefined);
  }
}

/**
 * `RagError.code`s whose MESSAGE has been audited as safe to return to a
 * caller. Every other code gets a generic string; the CODE is always returned
 * either way, so callers can still branch on the category.
 *
 * This is a different question from whose fault the error is, and conflating
 * the two is what made an earlier version of the MCP guard too permissive.
 * Fault attribution decides the log level and whether Sentry hears about it —
 * it is expressed as the sub-500 entries of `STATUS_BY_CODE`
 * (`apps/api/src/error-handler.ts`) and as `CLIENT_FAULT_CODES`
 * (`apps/mcp/src/tool-error.ts`). Showability is THIS set, and it is not the
 * same shape: `EGRESS_BLOCKED` is a server fault (503) whose message is
 * nonetheless audited — it is a hostname the operator needs to see.
 *
 * Adding a code here means auditing what that error class interpolates into
 * its message. `EmbeddingError` is the standing example of what must stay out:
 * it carries the embedding provider's own error text
 * (`packages/rag/src/embeddings/gemini.ts`) on a path every search and ask
 * call takes.
 *
 * Membership is decided by CODE, so a code is eligible only if EVERY throw
 * site produces a safe message. That makes most exclusions permanent rather
 * than pending-audit: `CONNECTOR_AUTH_ERROR`, `CONNECTOR_TRANSIENT_ERROR`,
 * `PARSER_ERROR`, `EMBEDDING_ERROR` and `VALIDATION_ERROR` take their message
 * as a constructor parameter, so "is it safe" varies per call site and cannot
 * be settled here. The members below are either zero-argument/sole-site
 * literals or audited interpolations.
 *
 * It lives in core because two transports enforce it — `registerErrorHandler`
 * and `guardToolHandler` — and a security allow-list duplicated per transport
 * drifts. `STREAMABLE_ERROR_CODES` (`apps/api/src/routes/ask.ts`) is
 * deliberately NOT this set, and the reason is NOT that a stream cannot carry
 * a code — `streamErrorPayload` does return `{ code, message }`. Nor is it
 * that fewer codes are reachable mid-stream: `apps/api/src/routes/ask.ts:236`
 * writes the 200 header before `pumpAskStream` runs, and
 * `packages/services/src/ask.ts:506` embeds the query inside the stream
 * generator before its first yield, so an EMBEDDING_ERROR lands mid-stream
 * too. (GENERATION_NOT_CONFIGURED is the one that cannot: ask.ts:229 checks
 * the generator before `reply.hijack()`.)
 *
 * The set is narrower because that payload carries no status and a non-member
 * loses its CODE as well as its message, flattening to a bare
 * "Generation failed." — the one surface here where the code is not always
 * returned. A higher bar for a lossier envelope, decided separately.
 */
export const ECHOABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  // Audited: a hostname, and TRI pattern labels.
  "EGRESS_BLOCKED",
  "COMPLIANCE_VIOLATION",
  // Caller-authored by construction — a bad argument, a missing id, a busy
  // source.
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "SYNC_ALREADY_RUNNING",
  // Static strings naming the env vars an operator must set. Suppressing
  // these told the caller "Service temporarily unavailable" about a permanent
  // misconfiguration, inviting an indefinite retry; docs/API.md documents the
  // GENERATION_NOT_CONFIGURED text as the response body, and apps/web renders
  // both straight to the user.
  "GENERATION_NOT_CONFIGURED",
  "STORAGE_NOT_CONFIGURED",
]);
