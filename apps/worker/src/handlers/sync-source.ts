import {
  getSource,
  incrementIngestionJobCounters,
  markSourceSynced,
  updateIngestionJob,
} from "@rag/db";
import {
  enqueueContinuation,
  mapDataClassToDocumentClass,
  MAX_SYNC_CONTINUATIONS,
  runIngestion,
  type SyncSourcePayload,
} from "@rag/ingestion";
import { captureException } from "@rag/runtime";
import type PgBoss from "pg-boss";
import type { WorkerDeps } from "../deps.js";

/**
 * Pages processed per worker job before re-enqueuing a continuation. Coarser
 * than 1 so a huge SharePoint library doesn't fire one continuation (and one
 * Graph auth round-trip) per 50 documents — while still chaining so no single
 * job runs unbounded. ~250 docs/job at pageSize 50.
 */
const PAGES_PER_RUN = 5;

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
  job: PgBoss.JobWithMetadata<SyncSourcePayload>,
  deps: WorkerDeps,
): Promise<void> {
  const {
    db,
    logger,
    parser,
    chunker,
    embedder,
    objectStore,
    queue,
    makeConnector,
    config,
    pack,
    scanner,
  } = deps;
  const { sourceId, ingestionId, mode } = job.data;
  const continuation = job.data.continuation ?? false;
  const continuationCount = job.data.continuationCount ?? 0;
  const log = logger.child({ jobId: job.id, sourceId, continuation });

  const source = await getSource(db, sourceId);
  if (!source) {
    // The source was deleted between enqueue and execution. Close out the
    // history row (created by `triggerSync`) so it doesn't sit `pending`
    // forever — pg-boss otherwise marks the job completed and nothing else
    // ever touches this row again.
    log.error("source not found, marking ingestion job failed");
    await updateIngestionJob(db, ingestionId, {
      status: "failed",
      completedAt: new Date(),
      error: "source not found",
    });
    return;
  }

  // The history row was created by `triggerSync` (the sole writer of
  // ingestion_jobs). Transition it to "running" only on the FIRST job — a
  // continuation inherits the already-running row (so startedAt is stable and
  // counters accumulate rather than reset).
  if (!continuation) {
    await updateIngestionJob(db, ingestionId, {
      status: "running",
      startedAt: new Date(),
    });
  }

  try {
    // Loop-safety backstop: a non-terminating connector must not re-enqueue
    // forever.
    if (continuationCount > MAX_SYNC_CONTINUATIONS) {
      throw new Error(
        `sync exceeded ${MAX_SYNC_CONTINUATIONS} continuations — aborting (possible non-terminating connector)`,
      );
    }

    const connector = makeConnector({
      id: source.id,
      kind: source.kind,
      config: source.config,
    });
    // Validate credentials on the FIRST job only. Continuations run within
    // minutes on the same app credentials; re-validating each one would
    // N×-multiply auth round-trips against a shared, throttled Graph quota.
    if (!continuation) {
      await connector.validate();
    }

    // A continuation ALWAYS resumes from the persisted cursor — even for a
    // "full" sync (full resets the cursor only on the first job).
    const startCursor = mode === "full" && !continuation ? null : source.cursor;

    const result = await runIngestion(
      source.id,
      connector,
      startCursor,
      {
        concurrency: config.worker.concurrency,
        pageSize: 50,
        maxPagesPerRun: PAGES_PER_RUN,
        // Retry earlier fetch/parse/embed failures once per sync, not on every
        // continuation job (each retry counts toward the attempt cap).
        retryFailed: !continuation,
      },
      {
        db,
        parser,
        chunker,
        embedder,
        objectStore,
        logger: log,
        // Enforce the source's declared §7216/GLBA classification. Without
        // this, the pipeline's ClassBlockedError gate defaults every source
        // to Class A regardless of `sources.data_class` — see
        // packages/ingestion/src/classify-source.ts.
        sourceDocClass: mapDataClassToDocumentClass(source.dataClass),
        // Layer 1 (egress): identifier scanners the pipeline redacts against
        // before anything is embedded. Loaded once at worker startup.
        pack,
        // Layer 1.5: semantic client-context scanner. undefined (provider
        // "none") means ingestOne quarantines every document — see the
        // WorkerDeps.scanner comment.
        scanner,
      },
    );

    // Accumulate this run's counts into the single history row (additive, not
    // exactly-once under retries — see incrementIngestionJobCounters).
    await incrementIngestionJobCounters(db, ingestionId, {
      documentsProcessed: result.documentsProcessed,
      documentsFailed: result.documentsFailed,
      chunksCreated: result.chunksCreated,
    });

    if (result.done) {
      // Terminal: stamp the user-visible "last synced" signal (the ONLY place it
      // advances) and close the history row.
      await markSourceSynced(db, source.id);
      await updateIngestionJob(db, ingestionId, {
        status: "completed",
        completedAt: new Date(),
      });
      log.info({ ...result, continuationCount }, "sync completed");
      return;
    }

    // More pages remain. Guard against a non-advancing cursor (a connector that
    // reports done:false forever without progress) BEFORE re-enqueuing, so we
    // fail cleanly instead of spinning.
    if (result.nextCursor === startCursor) {
      throw new Error(
        "sync reported more pages but the cursor did not advance — aborting to avoid an infinite continuation loop",
      );
    }

    // Re-enqueue a continuation (queues behind this job under the singleton
    // policy; resumes from the persisted cursor). Do this LAST so a failure
    // before here doesn't leave a duplicate continuation in flight.
    const contId = await enqueueContinuation(queue, {
      sourceId,
      mode,
      ingestionId,
      continuationCount,
    });
    if (!contId) {
      throw new Error(
        "failed to enqueue sync continuation (pg-boss returned null)",
      );
    }
    log.info(
      { ...result, continuationCount, contId, marker: "ingest.continuation" },
      "sync page budget reached, continuation enqueued",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateIngestionJob(db, ingestionId, {
      status: "failed",
      completedAt: new Date(),
      error: message,
    });
    log.error({ err, marker: "ingest.sync.failed" }, "sync failed");
    // Alert only when this is the terminal failure (retries exhausted). Intermediate
    // failures will be retried by pg-boss — alerting on each attempt would produce
    // duplicate noise for a transient error that recovers on the next attempt.
    if (job.retryCount >= job.retryLimit) {
      captureException(err, {
        sourceId,
        ingestionId,
        jobId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    }
    // Re-throw so pg-boss records the job as failed and applies retries.
    throw err;
  }
}
