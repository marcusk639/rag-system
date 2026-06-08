import { NotFoundError } from "@rag/core";
import { getDocument } from "@rag/db";
import type { ServiceDeps } from "./deps.js";

/**
 * Fetch a full document row by id. Transport-agnostic core of
 * GET /documents/:id and the `get_document` MCP tool. Throws `NotFoundError`
 * when the id does not exist.
 */
export async function getDocumentById(
  deps: ServiceDeps,
  id: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getDocument>>>> {
  const row = await getDocument(deps.db, id);
  if (!row) throw new NotFoundError(`Document ${id} not found`);
  return row;
}
