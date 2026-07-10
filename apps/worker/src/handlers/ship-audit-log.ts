import {
  advanceAuditLogShipperWatermark,
  getAuditLogRowsSince,
  getAuditLogShipperWatermark,
} from "@rag/db";
import type PgBoss from "pg-boss";
import type { WorkerDeps } from "../deps.js";

/**
 * pg-boss hands this the scheduled tick (no meaningful payload — `schedule()`
 * enqueues `data: null`, see `packages/ingestion/src/queue.ts`). Scheduled,
 * cursor-based shipping (NOT hooked into `logAskEvent`'s write path) — write-
 * time coupling would add network I/O and an external vendor's availability
 * risk to the hot request path, which `logAskEvent` explicitly avoids today.
 *
 * Steps:
 *   1. Read the `audit_log_shipper_state` watermark (null on the first tick).
 *   2. Query `audit_log` rows created since that watermark.
 *   3. No-op if shipping is disabled (`deps.auditLogSink` is null,
 *      `AUDIT_SINK_PROVIDER=none`) or there are no new rows.
 *   4. Ship the batch, then advance the watermark to the last row's
 *      `createdAt` — ONLY on success. A thrown egress-rejection or network
 *      error propagates out of this handler unswallowed, so the watermark is
 *      NOT advanced and pg-boss retries the same rows on the next tick.
 */
export async function handleShipAuditLog(
  job: PgBoss.JobWithMetadata<object>,
  deps: WorkerDeps,
): Promise<void> {
  const { db, logger, auditLogSink } = deps;
  const log = logger.child({ jobId: job.id });

  if (!auditLogSink) {
    return;
  }

  const watermark = await getAuditLogShipperWatermark(db);
  const rows = await getAuditLogRowsSince(db, watermark);

  if (rows.length === 0) {
    log.debug(
      { marker: "audit_log.ship.empty" },
      "no new audit_log rows to ship",
    );
    return;
  }

  await auditLogSink.ship(rows);

  const lastRow = rows[rows.length - 1]!;
  await advanceAuditLogShipperWatermark(db, lastRow.createdAt);

  log.info(
    { marker: "audit_log.ship.summary", shipped: rows.length },
    "shipped audit_log rows to off-host sink",
  );
}
