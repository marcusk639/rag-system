import PgBoss from "pg-boss";
import { SyncAlreadyRunningError } from "./errors.js";

/**
 * Thin wrapper around pg-boss. We define the job names + payload shapes once
 * here so producers (api) and consumers (worker) cannot drift.
 */

export const JOB_NAMES = {
  syncSource: "rag.sync_source",
} as const;

export interface SyncSourcePayload {
  sourceId: string;
  /** "full" forces cursor=null (re-enumerate everything), "incremental" uses stored cursor */
  mode: "full" | "incremental";
  /**
   * Id of the `ingestion_jobs` history row created by the producer
   * (`triggerSync`). The worker updates *this* row through its lifecycle
   * instead of creating its own — keeping `triggerSync` the sole writer.
   */
  ingestionId: string;
}

export interface QueueOptions {
  databaseUrl: string;
  schema?: string;
}

export async function createQueue(opts: QueueOptions): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: opts.databaseUrl,
    schema: opts.schema ?? "pgboss",
    // Retain completed jobs for 24h for observability.
    archiveCompletedAfterSeconds: 60 * 60 * 24,
  });

  boss.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[pg-boss]", err);
  });

  await boss.start();

  // pg-boss v10 requires queues to exist before send()/work(): `send` JOINs the
  // job insert against `pgboss.queue` and silently inserts nothing for an
  // unknown queue, which `enqueueSync` then misreads as a duplicate (a false
  // SYNC_ALREADY_RUNNING), while `work()` just polls a queue that never fills.
  // Ensure every queue we produce to / consume from exists. createQueue is
  // idempotent (upsert + CREATE TABLE IF NOT EXISTS), so both api and worker
  // can call this safely on every boot.
  for (const name of Object.values(JOB_NAMES)) {
    await boss.createQueue(name);
  }

  return boss;
}

/** Convenience: enqueue a sync. Producers (the HTTP API) call this. */
export async function enqueueSync(
  boss: PgBoss,
  payload: SyncSourcePayload,
): Promise<string> {
  const id = await boss.send(JOB_NAMES.syncSource, payload, {
    // Dedupe — if a sync is already pending/active for this source, don't pile up.
    singletonKey: `sync:${payload.sourceId}`,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInHours: 6,
  });
  if (!id) {
    throw new SyncAlreadyRunningError(payload.sourceId);
  }
  return id;
}
