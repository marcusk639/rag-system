import { loadConfig } from "@rag/core";
import {
  assertEmbeddingDimensions,
  assertRequiredIndexes,
  createIndexExistenceRunner,
} from "@rag/db";
import { JOB_NAMES, type SyncSourcePayload } from "@rag/ingestion";
import pino from "pino";
import { buildDeps, type WorkerDeps } from "./deps.js";
import { handleSyncSource } from "./handlers/sync-source.js";

/**
 * Entry point for the pg-boss worker. Long-running process:
 *   1. Load + validate config from env.
 *   2. Build long-lived deps (DB pool, parser client, chunker, embedder, queue).
 *   3. Register handlers for every job name we know about.
 *   4. Wait for SIGTERM/SIGINT, then drain pg-boss + close the DB pool.
 *
 * Scaling: run N copies of this process against the same Postgres. pg-boss
 * uses row-level locks so jobs are dispatched to exactly one worker at a time.
 */

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Pretty printing is left to PINO_TRANSPORT in dev; production stays JSON.
});

let deps: WorkerDeps | undefined;
let shuttingDown = false;

async function main(): Promise<void> {
  const config = loadConfig();
  // Fail fast before building deps / embedding any documents: the configured
  // provider's vector size must match the chunks.embedding column. Otherwise a
  // mismatch only surfaces at the first INSERT, mid-sync, after credits spent.
  assertEmbeddingDimensions(config.embedding.dimensions);
  deps = await buildDeps(config, logger);
  const builtDeps = deps;

  // Fail fast before processing any jobs: the HNSW + GIN search indexes (owned
  // by 0000_init.sql, invisible to Drizzle's model) must exist. If a stray
  // regenerate dropped them, retrieval would silently degrade to sequential
  // scans with no error — so refuse to start rather than serve slow results.
  await assertRequiredIndexes(createIndexExistenceRunner(builtDeps.db));

  // pg-boss v10 renamed the worker-pool knobs:
  //   batchSize       — how many jobs a single poll pulls (was `teamSize`)
  //   pollingIntervalSeconds — poll cadence
  // The handler receives an array of jobs; we process them serially because
  // the ingestion pipeline already parallelizes documents within a single
  // sync via `concurrency`, and stacking both would multiply load on the
  // parser sidecar and embedding API.
  await builtDeps.queue.work<SyncSourcePayload>(
    JOB_NAMES.syncSource,
    {
      batchSize: config.worker.concurrency,
      pollingIntervalSeconds: Math.max(
        1,
        Math.round(config.worker.pollIntervalMs / 1000),
      ),
    },
    async (jobs) => {
      for (const job of jobs) {
        await handleSyncSource(job, builtDeps);
      }
    },
  );

  logger.info(
    {
      concurrency: config.worker.concurrency,
      pollIntervalMs: config.worker.pollIntervalMs,
      jobs: Object.values(JOB_NAMES),
    },
    "worker started",
  );
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down worker");
  try {
    await deps?.close();
  } catch (err) {
    logger.error({ err }, "error during shutdown");
  }
  process.exit(exitCode);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandledRejection");
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  void shutdown("uncaughtException", 1);
});

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  void shutdown("startup-failure", 1);
});
