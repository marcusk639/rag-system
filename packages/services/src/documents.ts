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
