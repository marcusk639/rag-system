import type { DocumentMetadata, RetrievalResult } from "./types.js";

/**
 * Metadata-exposure allowlist — the PII boundary for this corpus.
 *
 * This RAG system indexes a CPA firm's confidential corpus: client emails
 * (Gmail/Outlook connectors), tax workpapers, and engagement documents. The
 * `DocumentMetadata` shape (see `types.ts`) is populated from connector and
 * message-header data and therefore carries taxpayer-identifying PII —
 * sender/recipient email addresses, author names, and email subject lines
 * (which routinely contain client names, SSN fragments, return years, etc.).
 *
 * `RetrievalResult.document.metadata` returns the WHOLE metadata object on
 * every search/ask hit, so without a filter any API-token holder doing a
 * search would receive real names, addresses, and subjects BEFORE even
 * reading a chunk body. That is the exact harm this allowlist prevents.
 *
 * Policy: DEFAULT-DENY. Only fields explicitly listed here may cross the API /
 * MCP boundary in a retrieval/document response. Everything else is dropped —
 * including any unknown keys that flow in via the `.passthrough()` on the
 * `DocumentMetadata` schema or connector-specific `extra` blobs whose contents
 * we cannot vouch for as PII-free.
 *
 * EXPOSED (non-PII, needed for citation / display / client-side filtering):
 *   - title      document title shown in citations
 *   - url        link back to the source document
 *   - mimeType   document type (for icon / handling)
 *   - sizeBytes  document size (display only)
 *   - createdAt  ISO timestamp (display / sort)
 *   - modifiedAt ISO timestamp (display / sort)
 *   - path       structural locator within the source (e.g. "Marketing/2024/plan.docx")
 *
 * STRIPPED (PII or unvetted):
 *   - author     person name
 *   - from       sender email address (email connectors)
 *   - to         recipient email addresses (email connectors)
 *   - subject    email subject line — frequently taxpayer-identifying
 *   - extra      free-form connector blob (drive ids, owner emails, etc.) — unvetted
 *   - <any other key>  default-deny: passthrough/unknown keys never escape
 *
 * If a new non-PII display field is genuinely needed at the boundary, add it
 * here deliberately — do NOT widen this to default-allow.
 */
export const EXPOSABLE_METADATA_FIELDS = [
  "title",
  "url",
  "mimeType",
  "sizeBytes",
  "createdAt",
  "modifiedAt",
  "path",
  // Classification tag — non-PII; needed for citation display and
  // index-boundary enforcement at the retrieval layer.
  "docClass",
] as const satisfies readonly (keyof DocumentMetadata)[];

/** The subset of `DocumentMetadata` that is safe to return across a boundary. */
export type ExposedMetadata = Pick<
  DocumentMetadata,
  (typeof EXPOSABLE_METADATA_FIELDS)[number]
>;

/**
 * Pure, output-path-only allowlist filter for `DocumentMetadata`.
 *
 * Returns a NEW object containing only the allowlisted, non-PII fields whose
 * values are present (not `undefined`). Never mutates the input. Apply this
 * ONLY when serializing metadata to an external caller — never on the internal
 * retrieval/filtering/ranking path, which still needs the full metadata (e.g.
 * `metadata->>from` filters in hybrid search).
 */
export function sanitizeMetadata(metadata: DocumentMetadata): ExposedMetadata {
  const safe: Record<string, unknown> = {};
  for (const key of EXPOSABLE_METADATA_FIELDS) {
    const value = metadata[key];
    if (value !== undefined) {
      safe[key] = value;
    }
  }
  return safe as ExposedMetadata;
}

/** A `RetrievalResult` whose `document.metadata` has passed the allowlist. */
export type SanitizedRetrievalResult = Omit<RetrievalResult, "document"> & {
  document: Omit<RetrievalResult["document"], "metadata"> & {
    metadata: ExposedMetadata;
  };
};

/**
 * Apply the metadata allowlist to a single `RetrievalResult`'s
 * `document.metadata`, leaving every other field (text, scores, ids, chunk
 * locator, url) untouched. Pure — returns a new result, does not mutate input.
 */
export function sanitizeRetrievalResult(
  result: RetrievalResult,
): SanitizedRetrievalResult {
  return {
    ...result,
    document: {
      ...result.document,
      metadata: sanitizeMetadata(result.document.metadata),
    },
  };
}

/** Convenience: sanitize an array of retrieval results. */
export function sanitizeRetrievalResults(
  results: RetrievalResult[],
): SanitizedRetrievalResult[] {
  return results.map(sanitizeRetrievalResult);
}
