import PgBoss from "pg-boss";
import { SyncAlreadyRunningError } from "./errors.js";

/**
 * Thin wrapper around pg-boss. We define the job names + payload shapes once
 * here so producers (api) and consumers (worker) cannot drift.
 */

export const JOB_NAMES = {
  syncSource: "rag.sync_source",
  /**
   * Recurring (pg-boss `schedule()`) staleness-sweep job — Phase 5 of
   * docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md. Flags active documents
   * nobody has confirmed as still-current within a configurable window. No
   * payload — a scheduled tick, not a producer-enqueued job, so it has no
   * `*Payload` interface like `SyncSourcePayload`.
   */
  stalenessSweep: "rag.staleness_sweep",
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
  /**
   * True on a self-re-enqueued continuation (the source spans more pages than
   * one job processes). A continuation resumes from the persisted cursor
   * regardless of `mode`, does NOT reset the history row to "running", and does
   * NOT re-validate connector credentials.
   */
  continuation?: boolean;
  /** How many continuations have fired for this logical sync (loop-safety bound). */
  continuationCount?: number;
}

/**
 * Per-page jobs are short, so size expiry to a page-budget's worst-case
 * DURATION (a handful of large PDFs through parser + embedder), not a whole
 * source. A job stuck `active` past this is reclaimed → retried/failed.
 */
export const SYNC_EXPIRE_SECONDS = 1800;

/** Hard cap on continuations per logical sync — a runaway-connector backstop. */
export const MAX_SYNC_CONTINUATIONS = 100_000;

export interface QueueOptions {
  databaseUrl: string;
  schema?: string;
  /**
   * Cron schedule (5-field crontab syntax) for the recurring staleness-sweep
   * job. Required (not optional/defaulted here) so a schedule can never be
   * hardcoded in this module — callers must thread it through from
   * `Config.stalenessSweep.cron` (`packages/core/src/config.ts`).
   */
  stalenessSweepCron: string;
  /** IANA timezone the cron expression above is evaluated in. */
  stalenessSweepTz: string;
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

  // Serialize sync jobs per source. Under the DEFAULT `standard` policy a
  // `singletonKey` provides NO dedup or serialization (the uniqueness indexes
  // are gated on policy), so two syncs — or a self-re-enqueued continuation and
  // a retried predecessor — could run concurrently and race `sources.cursor`.
  // `singleton` policy enforces exactly ONE active job per `singletonKey` while
  // letting the next one QUEUE behind it. updateQueue is idempotent on an
  // existing queue and reversible (set back to "standard"); it does NOT require
  // dropping/recreating the queue, so no jobs are lost.
  await boss.updateQueue(JOB_NAMES.syncSource, {
    name: JOB_NAMES.syncSource,
    policy: "singleton",
  });

  // Register the staleness-sweep as a recurring job. pg-boss v10's
  // `schedule(name, cron, data?, options?)` upserts by `name` (see
  // `ON CONFLICT (name) DO UPDATE` in pg-boss's schedule plan) into its own
  // `<schema>.schedule` table, so calling this on every boot — from every
  // process (api/mcp/worker) that builds this queue — is safe and idempotent,
  // the same way createQueue/updateQueue above are. `schedule.name` has a
  // FOREIGN KEY to `<schema>.queue`, so this MUST run after the createQueue
  // loop above (which already creates a queue for every JOB_NAMES entry,
  // including this one) or the insert fails with an FK violation.
  await boss.schedule(
    JOB_NAMES.stalenessSweep,
    opts.stalenessSweepCron,
    // No payload — `data?: object` doesn't accept `null` in pg-boss's types.
    undefined,
    { tz: opts.stalenessSweepTz },
  );

  return boss;
}

/** Convenience: enqueue a sync. Producers (the HTTP API) call this. */
export async function enqueueSync(
  boss: PgBoss,
  payload: SyncSourcePayload,
): Promise<string> {
  const id = await boss.send(JOB_NAMES.syncSource, payload, {
    // One active per source (singleton policy). A second concurrent external
    // trigger QUEUES behind the active one rather than returning null, so this
    // throws only when pg-boss rejects the insert outright.
    singletonKey: `sync:${payload.sourceId}`,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: SYNC_EXPIRE_SECONDS,
  });
  if (!id) {
    throw new SyncAlreadyRunningError(payload.sourceId);
  }
  return id;
}

/**
 * Re-enqueue a continuation of an in-flight sync (the source has more pages).
 * Carries the SAME `ingestionId` (one history row per logical sync) and the
 * same `singletonKey`, so under the singleton policy it queues behind the
 * still-active current job and runs once that completes — never concurrently.
 * Returns the new job id, or `null` if pg-boss unexpectedly dropped the insert
 * (the caller treats `null` as an error).
 */
export async function enqueueContinuation(
  boss: PgBoss,
  payload: SyncSourcePayload,
): Promise<string | null> {
  return boss.send(
    JOB_NAMES.syncSource,
    {
      ...payload,
      continuation: true,
      continuationCount: (payload.continuationCount ?? 0) + 1,
    },
    {
      singletonKey: `sync:${payload.sourceId}`,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: SYNC_EXPIRE_SECONDS,
    },
  );
}
