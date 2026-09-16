import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * External ids of documents whose most recent ingest attempts FAILED (parse,
 * fetch or embedding error) with no later success or block, and that have
 * failed fewer than `maxAttempts` times since. Oldest failure first.
 *
 * A delta feed never re-lists a document whose bytes did not change, so
 * without this a transient parser or embedding outage would leave that
 * document out of the index until someone edited it at the source.
 */
export async function listRetryableIngestFailures(
  db: Db,
  sourceId: string,
  opts: { maxAttempts: number; limit: number },
): Promise<string[]> {
  const result = await db.execute<{ external_id: string }>(sql`
    WITH last_resolved AS (
      SELECT external_id, max(created_at) AS at
      FROM ingest_log
      WHERE source_id = ${sourceId}::uuid
        AND action IN ('ingested', 'blocked')
      GROUP BY external_id
    )
    SELECT f.external_id
    FROM ingest_log f
    LEFT JOIN last_resolved r ON r.external_id = f.external_id
    WHERE f.source_id = ${sourceId}::uuid
      AND f.action = 'failed'
      AND (r.at IS NULL OR f.created_at > r.at)
    GROUP BY f.external_id
    HAVING count(*) < ${opts.maxAttempts}
    ORDER BY min(f.created_at)
    LIMIT ${opts.limit}
  `);
  return result.rows.map((r) => r.external_id);
}
