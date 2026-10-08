import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { chunks } from "./schema.js";

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

/**
 * Does this document have chunks embedded by THIS provider+model?
 *
 * The model-agnostic `documentHasChunks` is not sufficient for the
 * unchanged-hash short-circuit. The content hash
 * (`packages/ingestion/src/pipeline.ts`) covers the markdown and the
 * processing version but NOT the embedder's identity, while the dense arm of
 * hybrid search requires `embedding_provider`/`embedding_model` to equal the
 * active ones. So after an embedder swap every document is "unchanged" and has
 * chunks, yet none of those chunks can be retrieved densely — retrieval
 * degrades to sparse-only across the whole corpus with no error and no failed
 * sync, and a re-sync cannot repair it because it is a no-op by the same logic.
 *
 * Asking the model-scoped question instead lets the existing
 * "hash unchanged but no chunks -> re-embed" path self-heal the corpus one
 * document at a time on the next sync.
 */
export async function documentHasChunksForModel(
  db: Db,
  documentId: string,
  embeddingProvider: string,
  embeddingModel: string,
): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${chunks}
      WHERE ${chunks.documentId} = ${documentId}
        AND ${chunks.embeddingProvider} = ${embeddingProvider}
        AND ${chunks.embeddingModel} = ${embeddingModel}
    ) AS exists
  `);
  return result.rows[0]?.exists ?? false;
}
