import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Forget a document's stored original and return the object key it pointed
 * at, so the caller can delete the blob. Returns `{ storageKey: null }` when
 * nothing was stored.
 *
 * Used when a document turns out to contain redacted identifiers: the index
 * holds the redacted text, but the stored original is the raw file, so leaving
 * it downloadable would hand back everything redaction removed.
 */
export async function clearDocumentStorage(
  db: Db,
  documentId: string,
): Promise<{ storageKey: string | null }> {
  const result = await db.execute<{ storage_key: string }>(sql`
    WITH prev AS (
      SELECT storage_key FROM documents
      WHERE id = ${documentId} AND storage_key IS NOT NULL
      FOR UPDATE
    )
    UPDATE documents AS d
    SET storage_key = NULL, storage_bucket = NULL, original_size_bytes = NULL
    FROM prev
    WHERE d.id = ${documentId}
    RETURNING prev.storage_key
  `);
  return { storageKey: result.rows[0]?.storage_key ?? null };
}
