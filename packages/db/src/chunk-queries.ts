import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

export interface NeighborChunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  headingPath: string[];
  page: number | null;
}

/**
 * Fetch specific chunks of one document by ordinal, in ordinal order. Ordinals
 * that do not exist are simply absent from the result.
 *
 * No authorization happens here: callers must only pass a document id that a
 * scope-enforced retrieval already returned to the same principal.
 */
export async function getChunksByOrdinals(
  db: Db,
  documentId: string,
  ordinals: readonly number[],
): Promise<NeighborChunk[]> {
  if (ordinals.length === 0) return [];
  const result = await db.execute<{
    id: string;
    document_id: string;
    ordinal: number;
    text: string;
    heading_path: string[] | null;
    page: number | null;
  }>(sql`
    SELECT id, document_id, ordinal, text, heading_path, page
    FROM chunks
    WHERE document_id = ${documentId}::uuid
      AND ordinal IN (${sql.join(
        ordinals.map((o) => sql`${o}::int`),
        sql`, `,
      )})
    ORDER BY ordinal
  `);
  return result.rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    ordinal: Number(r.ordinal),
    text: r.text,
    headingPath: r.heading_path ?? [],
    page: r.page,
  }));
}
