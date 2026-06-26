import type { Readable } from "node:stream";
import {
  isSourceAllowed,
  NotFoundError,
  sanitizeMetadata,
  type AuthorizationScope,
  type DocumentMetadata,
} from "@rag/core";
import { getDocument } from "@rag/db";
import type { ServiceDeps } from "./deps.js";

/**
 * Fetch a full document row by id. Transport-agnostic core of
 * GET /documents/:id and the `get_document` MCP tool.
 *
 * Confidentiality boundary (P1b): a scoped caller must not be able to read — or
 * even confirm the existence of — a document outside its enforced source set.
 * A forbidden source is treated EXACTLY like a missing id (same `NotFoundError`)
 * so the two cases are indistinguishable to the caller.
 *
 * PII boundary (P2): the stored `metadata` jsonb carries email author/from/to/
 * subject and connector `extra`. The allowlist is applied before the row leaves
 * the service.
 */
export async function getDocumentById(
  deps: ServiceDeps,
  id: string,
  scope: AuthorizationScope,
) {
  const row = await getDocument(deps.db, id);
  if (!row || !isSourceAllowed(scope, row.sourceId)) {
    throw new NotFoundError(`Document ${id} not found`);
  }
  return {
    ...row,
    metadata: sanitizeMetadata(row.metadata as DocumentMetadata),
  };
}


/** The original bytes + headers needed to serve a document download. */
export interface DocumentDownload {
  body: Readable;
  contentType: string;
  filename: string;
  contentLength?: number;
}

/**
 * Resolve a document's ORIGINAL file bytes for download, enforcing the SAME
 * confidentiality boundary as `getDocumentById`: a forbidden source or a
 * missing id both surface as `NotFoundError` (→ 404), so a scoped caller can't
 * probe for documents outside its scope. A document whose original was never
 * stored (storage disabled, pre-storage ingest, or a failed upload) is also a
 * 404 — there is simply nothing to download.
 *
 * Transport-agnostic core of GET /documents/:id/download.
 */
export async function getDocumentDownload(
  deps: ServiceDeps,
  id: string,
  scope: AuthorizationScope,
): Promise<DocumentDownload> {
  const row = await getDocument(deps.db, id);
  if (!row || !isSourceAllowed(scope, row.sourceId)) {
    throw new NotFoundError(`Document ${id} not found`);
  }
  if (!row.storageKey || !deps.objectStore) {
    throw new NotFoundError(
      `Original file for document ${id} is not available for download`,
    );
  }
  const obj = await deps.objectStore.get(row.storageKey);
  return {
    body: obj.body,
    contentType: row.mimeType || obj.contentType || "application/octet-stream",
    filename: sanitizeDownloadFilename(row.title),
    contentLength: obj.contentLength ?? row.originalSizeBytes ?? undefined,
  };
}

/**
 * Make a document title safe for a `Content-Disposition: attachment; filename`
 * header: strip CR/LF (header-injection), quotes, and path separators; collapse
 * to a bounded fallback when empty.
 */
function sanitizeDownloadFilename(title: string): string {
  const cleaned = title
    .replace(/[\r\n"]/g, "")
    .replace(/[/\\]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "document";
}
