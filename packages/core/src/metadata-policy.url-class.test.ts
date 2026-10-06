import { describe, expect, it } from "vitest";
import {
  sanitizeMetadata,
  sanitizeRetrievalResult,
} from "./metadata-policy.js";
import type { DocumentMetadata, RetrievalResult } from "./types.js";

/**
 * The source URL is class-gated.
 *
 * `metadata.url` is the connector's own link to the document — for SharePoint,
 * the `webUrl`, which embeds the folder path. At a CPA firm those folders are
 * named for clients ("Clients/Smith Family/2024"), which is exactly why
 * `metadata.path` is already stripped as PII. The URL carries the same path in
 * a different field, is never scanned by Layer 1.5 and never redacted by
 * Layer 1, and reaches every citation.
 *
 * Class A is firm-internal, non-sensitive (SOPs, templates, research notes) —
 * a link back is useful and safe. Class B upward requires de-identification,
 * so the link is withheld. An ABSENT class is treated as stricter than A: an
 * untagged row is not evidence that it is class A.
 */
const SHAREPOINT_WEBURL =
  "https://firm.sharepoint.com/sites/Tax/Shared%20Documents/Clients/Smith%20Family/2024/return.pdf";

const metaWithClass = (
  docClass: DocumentMetadata["docClass"],
): DocumentMetadata => ({
  title: "2024 Return",
  url: SHAREPOINT_WEBURL,
  mimeType: "application/pdf",
  ...(docClass ? { docClass } : {}),
});

const resultWithClass = (
  docClass: DocumentMetadata["docClass"],
): RetrievalResult =>
  ({
    text: "chunk",
    score: 1,
    denseScore: 1,
    sparseScore: 1,
    document: {
      id: "d1",
      title: "2024 Return",
      sourceId: "s1",
      sourceKind: "sharepoint",
      // Populated at `packages/db/src/hybrid-search.ts` straight from
      // `metadata.url`, and a SEPARATE field from the metadata copy.
      url: SHAREPOINT_WEBURL,
      metadata: metaWithClass(docClass),
    },
    chunk: { id: "c1", ordinal: 0, headingPath: [] },
  }) as unknown as RetrievalResult;

describe("sanitizeMetadata — url is class-gated", () => {
  it("exposes the url for class A", () => {
    const safe = sanitizeMetadata(metaWithClass("A"));
    expect(safe.url).toBe(SHAREPOINT_WEBURL);
  });

  it.each(["B", "C", "D"] as const)("withholds the url for class %s", (c) => {
    const safe = sanitizeMetadata(metaWithClass(c));
    expect(safe.url).toBeUndefined();
  });

  it("withholds the url when no class is recorded", () => {
    // Fail closed: an untagged row is not evidence of class A.
    const safe = sanitizeMetadata(metaWithClass(undefined));
    expect(safe.url).toBeUndefined();
  });

  it("still exposes the other allowlisted fields for class B", () => {
    // Withholding the url must not collapse the whole citation.
    const safe = sanitizeMetadata(metaWithClass("B"));
    expect(safe.title).toBe("2024 Return");
    expect(safe.mimeType).toBe("application/pdf");
    expect(safe.docClass).toBe("B");
  });
});

describe("sanitizeRetrievalResult — document.url is class-gated too", () => {
  it("clears document.url for class B, not just metadata.url", () => {
    // `document.url` is a second carrier of the same value and is NOT part of
    // EXPOSABLE_METADATA_FIELDS, so gating the metadata copy alone leaves the
    // one that actually reaches citations fully exposed.
    const safe = sanitizeRetrievalResult(resultWithClass("B"));
    expect(safe.document.metadata.url).toBeUndefined();
    expect(safe.document.url).toBeUndefined();
  });

  it("clears document.url when no class is recorded", () => {
    const safe = sanitizeRetrievalResult(resultWithClass(undefined));
    expect(safe.document.url).toBeUndefined();
  });

  it("keeps document.url for class A", () => {
    const safe = sanitizeRetrievalResult(resultWithClass("A"));
    expect(safe.document.url).toBe(SHAREPOINT_WEBURL);
    expect(safe.document.metadata.url).toBe(SHAREPOINT_WEBURL);
  });

  it("leaves the rest of the result untouched for class B", () => {
    const safe = sanitizeRetrievalResult(resultWithClass("B"));
    expect(safe.text).toBe("chunk");
    expect(safe.document.title).toBe("2024 Return");
    expect(safe.document.id).toBe("d1");
  });

  it("does not leak the client folder path through any field", () => {
    const safe = sanitizeRetrievalResult(resultWithClass("B"));
    expect(JSON.stringify(safe)).not.toContain("Smith%20Family");
    expect(JSON.stringify(safe)).not.toContain("Smith Family");
  });
});
