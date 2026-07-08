import { getWeakResultAuditEvents, type WeakResultAuditEvent } from "@rag/db";
import type PgBoss from "pg-boss";
import type { WorkerDeps } from "../deps.js";

/**
 * How far back each digest tick looks for weak-result events, independent of
 * how often the job itself is scheduled (`DOCS_GAP_DIGEST_CRON`). A rolling
 * 7-day window is the scoped MVP the plan asks for ("query the past week's
 * events") — unlike the cron/tz/score-threshold knobs, this isn't called out
 * as something that must be config-driven, so it stays a plain constant.
 */
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface SourceGroupSummary {
  /** Sorted `sourceIds` combination this group of events shares. */
  sourceIds: string[];
  count: number;
  /** Per-endpoint ("ask" | "search") counts within this source-id group. */
  byEndpoint: Record<string, number>;
}

export interface DocsGapDigestSummary {
  since: string;
  until: string;
  totalWeakEvents: number;
  byEndpoint: Record<string, number>;
  bySourceGroup: SourceGroupSummary[];
}

/**
 * The same "is this a documentation gap" predicate `getWeakResultAuditEvents`
 * applies in SQL, re-expressed in JS so the aggregation step below is
 * self-contained and testable on a mixed set of rows (weak + fine) without
 * needing a live Postgres to prove fine rows get excluded. Reads only
 * `retrievedCount`/`chunkIds`/`topScore` — never `questionHash` — per Phase
 * 3's privacy design decision.
 */
export function isWeakResultEvent(
  row: Pick<WeakResultAuditEvent, "retrievedCount" | "chunkIds" | "topScore">,
  minScore: number,
): boolean {
  return (
    row.retrievedCount === 0 ||
    row.chunkIds.length === 0 ||
    (row.topScore !== null && row.topScore < minScore)
  );
}

/**
 * Pure aggregation: filters `rows` down to weak-result events (see
 * `isWeakResultEvent`), then groups them by each row's (sorted) `sourceIds`
 * combination and by `endpoint`.
 *
 * `sourceIds` is a `text[]` column, so plain SQL `GROUP BY` can't group rows
 * by array equality the way callers want here — two rows for "the same"
 * source combination can come back with the ids in different orders, so we
 * sort before keying rather than trusting insertion order.
 *
 * Kept as a standalone pure function (no DB, no logger, no pg-boss types) so
 * the aggregation logic is testable without seeding a live Postgres or
 * constructing a fake pg-boss job.
 */
export function aggregateWeakResultEvents(
  rows: WeakResultAuditEvent[],
  minScore: number,
  window: { since: Date; until: Date },
): DocsGapDigestSummary {
  const weakRows = rows.filter((row) => isWeakResultEvent(row, minScore));

  const byEndpoint: Record<string, number> = {};
  const groups = new Map<string, SourceGroupSummary>();

  for (const row of weakRows) {
    byEndpoint[row.endpoint] = (byEndpoint[row.endpoint] ?? 0) + 1;

    const sortedSourceIds = [...row.sourceIds].sort();
    const key = JSON.stringify(sortedSourceIds);
    let group = groups.get(key);
    if (!group) {
      group = { sourceIds: sortedSourceIds, count: 0, byEndpoint: {} };
      groups.set(key, group);
    }
    group.count += 1;
    group.byEndpoint[row.endpoint] = (group.byEndpoint[row.endpoint] ?? 0) + 1;
  }

  return {
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    totalWeakEvents: weakRows.length,
    byEndpoint,
    bySourceGroup: [...groups.values()],
  };
}

/**
 * pg-boss hands this the scheduled tick (no meaningful payload — `schedule()`
 * enqueues `data: null`, see `packages/ingestion/src/queue.ts`). We:
 *   1. Query the past week's zero-result/weak-score `audit_log` rows.
 *   2. Aggregate them in JS (see `aggregateWeakResultEvents`).
 *   3. Log ONE summary line — no new table, no UI, per this phase's scope.
 *
 * Reads only `retrievedCount`/`chunkIds`/`topScore` (via
 * `getWeakResultAuditEvents`) — never `questionHash` — per Phase 3's privacy
 * design decision: raw question text is never stored and must never be
 * reconstructed or referenced here.
 */
export async function handleDocsGapDigest(
  job: PgBoss.JobWithMetadata<object>,
  deps: WorkerDeps,
): Promise<void> {
  const { db, logger, config } = deps;
  const log = logger.child({ jobId: job.id });

  const until = new Date();
  const since = new Date(until.getTime() - DIGEST_WINDOW_MS);

  const rows = await getWeakResultAuditEvents(db, {
    since,
    minScore: config.docsGapDigest.minScore,
  });

  const summary = aggregateWeakResultEvents(
    rows,
    config.docsGapDigest.minScore,
    { since, until },
  );

  log.info(
    { ...summary, marker: "docs.gap_digest.summary" },
    "weekly documentation gap digest",
  );
}
