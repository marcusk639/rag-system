import { getStaleDocuments, type StaleDocument } from "@rag/db";
import type PgBoss from "pg-boss";
import type { WorkerDeps } from "../deps.js";

export interface SourceStaleSummary {
  sourceId: string;
  count: number;
  /** How many of this source's stale docs have never been reviewed at all. */
  neverReviewedCount: number;
}

export interface StalenessSweepSummary {
  maxAgeDays: number;
  totalStale: number;
  bySource: SourceStaleSummary[];
}

/**
 * Pure aggregation: groups stale documents (already filtered to
 * `lifecycleStatus = 'active'` and past-threshold by `getStaleDocuments`'s SQL
 * predicate) by `sourceId`, and counts how many within each group have never
 * been reviewed (`lastReviewedAt IS NULL`) versus merely overdue.
 *
 * Kept as a standalone pure function (no DB, no logger, no pg-boss types) so
 * the aggregation logic is testable without seeding a live Postgres or
 * constructing a fake pg-boss job — mirrors
 * `docs-gap-digest.ts`'s `aggregateWeakResultEvents`.
 */
export function aggregateStaleDocuments(
  rows: StaleDocument[],
  maxAgeDays: number,
): StalenessSweepSummary {
  const groups = new Map<string, SourceStaleSummary>();

  for (const row of rows) {
    let group = groups.get(row.sourceId);
    if (!group) {
      group = { sourceId: row.sourceId, count: 0, neverReviewedCount: 0 };
      groups.set(row.sourceId, group);
    }
    group.count += 1;
    if (row.lastReviewedAt === null) {
      group.neverReviewedCount += 1;
    }
  }

  return {
    maxAgeDays,
    totalStale: rows.length,
    bySource: [...groups.values()],
  };
}

/**
 * pg-boss hands this the scheduled tick (no meaningful payload — `schedule()`
 * enqueues `data: null`, see `packages/ingestion/src/queue.ts`). We:
 *   1. Query active documents nobody has reviewed within the configured
 *      threshold (`getStaleDocuments`).
 *   2. Aggregate them in JS by sourceId (see `aggregateStaleDocuments`).
 *   3. Log ONE summary line — no new table, no UI, per this phase's scope
 *      (mirrors `docs-gap-digest.ts`'s `handleDocsGapDigest`).
 *
 * Never mutates or deletes anything — this is read-only observability; an
 * operator/librarian acts on the log line (e.g. by reviewing and bumping
 * `lastReviewedAt`, or archiving) via whatever manual path exists today.
 */
export async function handleStalenessSweep(
  job: PgBoss.JobWithMetadata<object>,
  deps: WorkerDeps,
): Promise<void> {
  const { db, logger, config } = deps;
  const log = logger.child({ jobId: job.id });

  const maxAgeDays = config.stalenessSweep.maxAgeDays;
  const rows = await getStaleDocuments(db, { maxAgeDays });
  const summary = aggregateStaleDocuments(rows, maxAgeDays);

  log.info(
    { ...summary, marker: "docs.staleness_sweep.summary" },
    "staleness sweep summary",
  );
}
