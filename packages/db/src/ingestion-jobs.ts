import { eq, sql } from "drizzle-orm";
import { GATE_FAILURE_REASON_PREFIX } from "@rag/core";
import type { Db } from "./client.js";
import { ingestionJobs, type NewIngestionJob } from "./schema.js";

// ============================================================================
// Ingestion jobs (history table — pg-boss owns runtime job state separately)
//
// Extracted from ./queries.ts, which is grandfathered past this repo's
// 800-line cap (`.claude/rules/quality-gates.md`: "shrink it, never extend").
// Re-exported from there so existing importers are unaffected — same pattern
// as ./hybrid-search.ts.
// ============================================================================

export async function createIngestionJob(db: Db, row: NewIngestionJob) {
  const [created] = await db.insert(ingestionJobs).values(row).returning();
  if (!created) throw new Error("createIngestionJob: insert returned no row");
  return created;
}

export async function updateIngestionJob(
  db: Db,
  id: string,
  patch: Partial<NewIngestionJob>,
) {
  await db.update(ingestionJobs).set(patch).where(eq(ingestionJobs.id, id));
}

/** Accumulated counters on an `ingestion_jobs` row, after an increment. */
export interface IngestionJobCounters {
  documentsProcessed: number;
  documentsFailed: number;
  chunksCreated: number;
  /** Every quarantine, both causes. */
  documentsQuarantined: number;
  /**
   * The subset a BROKEN gate refused — scanner threw or was unreachable,
   * redaction threw, pack missing or empty. Always
   * `<= documentsQuarantined`.
   *
   * Separate from the total because the two demand opposite responses. A
   * `policy` quarantine is the gate working as designed and is ordinary (Layer
   * 3 escalates on any single identifier finding), so it must never fail a
   * run; a gate failure is silent data loss with no retry path, so it must.
   * One counter covering both cannot express that, and a guard keyed on the
   * total failed every sync of a legitimately sensitive source forever.
   */
  documentsQuarantinedGateFailure: number;
}

/**
 * Add to an ingestion job's running totals, returning the accumulated row.
 *
 * NOTE: additive updates are NOT crash-safe / exactly-once — if the worker
 * crashes after incrementing but before the job is marked complete, pg-boss
 * retries the page and adds its counts again. These counters are observability,
 * not billing; for an exact count, COUNT over `documents`/`chunks` instead.
 */
export async function incrementIngestionJobCounters(
  db: Db,
  id: string,
  delta: {
    documentsProcessed: number;
    documentsFailed: number;
    chunksCreated: number;
    // Optional so existing callers compile unchanged; a run that never
    // quarantines contributes 0 either way.
    documentsQuarantined?: number;
    documentsQuarantinedGateFailure?: number;
  },
): Promise<IngestionJobCounters> {
  // RETURNING the accumulated totals rather than a second SELECT: a multi-page
  // sync runs this once per continuation job, and the caller's "did a safety
  // gate break during this whole sync?" test has to read the accumulated row,
  // not the one run's in-memory result. One statement keeps the two consistent.
  const result = await db.execute<{
    documents_processed: number;
    documents_failed: number;
    chunks_created: number;
    documents_quarantined: number;
    documents_quarantined_gate_failure: number;
  }>(sql`
    UPDATE ${ingestionJobs}
    SET documents_processed = documents_processed + ${delta.documentsProcessed},
        documents_failed = documents_failed + ${delta.documentsFailed},
        chunks_created = chunks_created + ${delta.chunksCreated},
        documents_quarantined = documents_quarantined + ${delta.documentsQuarantined ?? 0},
        documents_quarantined_gate_failure = documents_quarantined_gate_failure + ${
          delta.documentsQuarantinedGateFailure ?? 0
        }
    WHERE id = ${id}
    RETURNING documents_processed, documents_failed, chunks_created,
              documents_quarantined, documents_quarantined_gate_failure
  `);
  const row = result.rows[0];
  // Fail loud. Coalescing a no-match UPDATE to zeros is indistinguishable from
  // a healthy run, and the caller's safety guard reads nothing else — so a bad
  // ingestion id would report "no gate failures" for every run forever.
  if (!row) {
    throw new Error(
      `incrementIngestionJobCounters: no ingestion_jobs row matched id ${id}`,
    );
  }
  return {
    documentsProcessed: Number(row.documents_processed),
    documentsFailed: Number(row.documents_failed),
    chunksCreated: Number(row.chunks_created),
    documentsQuarantined: Number(row.documents_quarantined),
    documentsQuarantinedGateFailure: Number(
      row.documents_quarantined_gate_failure,
    ),
  };
}

/**
 * Delete an ingestion-job history row by id. Used to clean up a `pending` row
 * that was created optimistically but whose queue hand-off failed (e.g. a
 * duplicate sync rejected by the pg-boss singleton guard), so no orphaned
 * `pending` rows linger for syncs that never ran.
 */
export async function deleteIngestionJob(db: Db, id: string) {
  await db.delete(ingestionJobs).where(eq(ingestionJobs.id, id));
}

/** One document a broken safety gate refused, with how often it has happened. */
export interface GateFailureQuarantine {
  externalId: string;
  rejectionReason: string;
  attempts: number;
  /** node-postgres parses `timestamptz` to a JS Date, not a string. */
  lastSeenAt: Date;
}

/**
 * Documents a BROKEN gate refused, newest first — the durable "problematic
 * documents" list for a source.
 *
 * A gate failure has no retry path: the cursor advances past the document and
 * its `blocked` audit row resolves it, so without this the only way to find
 * the file that keeps breaking the scanner is to guess. A document appearing
 * here repeatedly (`attempts`) is one to exclude or fix at the source, not one
 * to keep re-running a whole sync over.
 *
 * Both causes are recorded `action = 'blocked'` on purpose, so a compliance
 * query for refused documents keeps seeing both; the reason prefix is what
 * narrows this to genuine faults.
 */
export async function listGateFailureQuarantines(
  db: Db,
  sourceId: string,
  opts: { limit: number },
): Promise<GateFailureQuarantine[]> {
  const result = await db.execute<{
    external_id: string;
    rejection_reason: string;
    attempts: number;
    last_seen_at: Date;
  }>(sql`
    SELECT external_id,
           max(rejection_reason) AS rejection_reason,
           count(*)::int AS attempts,
           max(created_at) AS last_seen_at
    FROM ingest_log
    WHERE source_id = ${sourceId}::uuid
      AND action = 'blocked'
      AND rejection_reason LIKE ${`${GATE_FAILURE_REASON_PREFIX}%`}
    GROUP BY external_id
    ORDER BY max(created_at) DESC
    LIMIT ${opts.limit}
  `);
  return result.rows.map((r) => ({
    externalId: r.external_id,
    rejectionReason: r.rejection_reason,
    attempts: Number(r.attempts),
    lastSeenAt: r.last_seen_at,
  }));
}
