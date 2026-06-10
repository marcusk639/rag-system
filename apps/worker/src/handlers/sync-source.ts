import { getSource, updateIngestionJob } from "@rag/db";
import { runIngestion, type SyncSourcePayload } from "@rag/ingestion";
import type { WorkerDeps } from "../deps.js";

/**
 * pg-boss hands the worker a job whose `data` is the SyncSourcePayload we put
 * on the queue from the API. We:
 *   1. Resolve the source row from Postgres.
 *   2. Mark the producer-created ingestion_jobs history row running.
 *   3. Build the right connector + delegate to `runIngestion`.
 *   4. Mark the history row completed/failed accordingly.
 *
 * Throwing here is intentional on failure: pg-boss interprets a thrown error
 * as job failure and applies its retry policy (configured at enqueue time).
 */
export async function handleSyncSource(
  job: { id: string; data: SyncSourcePayload },
  deps: WorkerDeps,
): Promise<void> {
  const { db, logger, parser, chunker, embedder, makeConnector, config } = deps;
  const log = logger.child({ jobId: job.id, sourceId: job.data.sourceId });

  const source = await getSource(db, job.data.sourceId);
  if (!source) {
    // The source was deleted between enqueue and execution. Close out the
    // history row (created by `triggerSync`) so it doesn't sit `pending`
    // forever — pg-boss otherwise marks the job completed and nothing else
    // ever touches this row again.
    log.error("source not found, marking ingestion job failed");
    await updateIngestionJob(db, job.data.ingestionId, {
      status: "failed",
      completedAt: new Date(),
      error: "source not found",
    });
    return;
  }

  // The history row was created by `triggerSync` (the sole writer of
  // ingestion_jobs). We only transition it through its lifecycle here.
  await updateIngestionJob(db, job.data.ingestionId, {
    status: "running",
    startedAt: new Date(),
  });

  try {
    const connector = makeConnector({
      id: source.id,
      kind: source.kind,
      config: source.config,
    });
    await connector.validate();

    const startCursor = job.data.mode === "full" ? null : source.cursor;
    const result = await runIngestion(
      source.id,
      connector,
      startCursor,
      { concurrency: config.worker.concurrency, pageSize: 50 },
      { db, parser, chunker, embedder, logger: log },
    );

    await updateIngestionJob(db, job.data.ingestionId, {
      status: "completed",
      completedAt: new Date(),
      documentsProcessed: result.documentsProcessed,
      documentsFailed: result.documentsFailed,
      chunksCreated: result.chunksCreated,
    });
    log.info(result, "sync completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateIngestionJob(db, job.data.ingestionId, {
      status: "failed",
      completedAt: new Date(),
      error: message,
    });
    log.error({ err }, "sync failed");
    // Re-throw so pg-boss records the job as failed and applies retries.
    throw err;
  }
}
