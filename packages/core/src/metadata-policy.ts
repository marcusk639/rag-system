import type {
  DocumentClass,
  DocumentMetadata,
  RetrievalResult,
} from "./types.js";

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
 *
 * STRIPPED (PII or unvetted):
 *   - path       folder location — at a CPA firm folder names routinely carry
 *                client names ("Clients/Smith Family/2024"); kept internally
 *                for structural exclusion only
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
  // Classification tag — non-PII. Consumed for citation display on all three
  // staff surfaces (web chip, Teams card, MCP Sources footer) and for
  // index-boundary enforcement at the retrieval layer. Note an ABSENT class is
  // stricter than A (see `isSourceUrlExposable`), so a display must omit the
  // label rather than default it.
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
/**
 * Whether a document's source URL may cross the boundary.
 *
 * `metadata.url` is the connector's link to the document; for SharePoint it is
 * the `webUrl`, which embeds the folder path. At this firm those folders are
 * named for clients ("Clients/Smith Family/2024") -- which is precisely why
 * `metadata.path` is stripped above. The URL carries the same path in a
 * different field, is never examined by Layer 1.5 and never rewritten by
 * Layer 1, and reaches every citation.
 *
 * Class A is firm-internal and non-sensitive, so a link back is useful and
 * safe. Class B upward requires de-identification, so it is withheld. An
 * ABSENT class is treated as stricter than A on purpose: an untagged row is
 * not evidence that it is class A.
 */
export function isSourceUrlExposable(
  docClass: DocumentClass | undefined,
): boolean {
  return docClass === "A";
}

export function sanitizeMetadata(metadata: DocumentMetadata): ExposedMetadata {
  const safe: Record<string, unknown> = {};
  const urlExposable = isSourceUrlExposable(metadata.docClass);
  for (const key of EXPOSABLE_METADATA_FIELDS) {
    if (key === "url" && !urlExposable) continue;
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
  // `document.url` is a SECOND carrier of `metadata.url` -- assembled in
  // `hybridSearch` straight from it -- and is not an entry in
  // EXPOSABLE_METADATA_FIELDS, so the allowlist never reached it. Gating only
  // the metadata copy would withhold the field nobody reads and keep exposing
  // the one every citation renders.
  const { url: _sourceUrl, ...documentWithoutUrl } = result.document;
  const urlExposable = isSourceUrlExposable(result.document.metadata.docClass);
  return {
    ...result,
    document: {
      ...documentWithoutUrl,
      ...(urlExposable && _sourceUrl !== undefined ? { url: _sourceUrl } : {}),
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
