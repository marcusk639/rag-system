import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { insertBackupRun } from "@rag/db";
import type PgBoss from "pg-boss";
import type { WorkerDeps } from "../deps.js";

const execFileAsync = promisify(execFile);

/**
 * pg_dump's custom-format output for this corpus is tens of MB today — 512MB
 * is generous headroom without risking an unbounded buffer. This buffers the
 * ENTIRE dump in process memory before uploading, though, which is a real
 * ceiling as the corpus grows; if this job ever needs to handle a
 * multi-GB database, switch to streaming pg_dump's stdout directly into
 * `objectStore` (a multipart/streaming upload) instead of buffering here.
 * Deliberately v1 — the corpus is nowhere near that size yet.
 */
const MAX_DUMP_BYTES = 512 * 1024 * 1024;

/**
 * pg-boss hands this the scheduled tick (no meaningful payload — same as
 * docsGapDigest/shipAuditLog). Takes a full `pg_dump -F c` of the configured
 * database, uploads it to the object store under `backup.keyPrefix`, and
 * records the run in `backup_runs` so "the job ran and produced something" is
 * queryable, not just a log line — mirrors the docsGapDigestRuns precedent.
 *
 * No-ops when `config.backup.provider === "none"` or no object store is
 * configured — matches `handleShipAuditLog`'s no-op-when-disabled shape. A
 * thrown pg_dump/upload error propagates unswallowed so pg-boss retries the
 * same tick rather than silently recording a partial/failed backup as done.
 */
export async function handleBackupPostgres(
  job: PgBoss.JobWithMetadata<object>,
  deps: WorkerDeps,
): Promise<void> {
  const { db, logger, config, objectStore } = deps;
  const log = logger.child({ jobId: job.id });

  if (config.backup.provider === "none" || !objectStore) {
    return;
  }

  const startedAt = Date.now();
  const { stdout } = await execFileAsync(
    "pg_dump",
    [config.databaseUrl, "-F", "c"],
    { maxBuffer: MAX_DUMP_BYTES, encoding: "buffer" },
  );
  const durationMs = Date.now() - startedAt;

  const ranAt = new Date();
  const objectKey = `${config.backup.keyPrefix}${ranAt.toISOString().replace(/[:.]/g, "-")}.dump`;

  await objectStore.put(objectKey, stdout, "application/octet-stream");

  await insertBackupRun(db, {
    ranAt,
    sizeBytes: stdout.length,
    objectKey,
    durationMs,
  });

  log.info(
    {
      marker: "backup.postgres.summary",
      sizeBytes: stdout.length,
      objectKey,
      durationMs,
    },
    "Postgres backup completed",
  );
}
