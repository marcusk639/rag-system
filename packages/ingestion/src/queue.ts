import PgBoss from "pg-boss";

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
    throw new Error(
      `enqueueSync: pg-boss rejected (likely duplicate sync running for ${payload.sourceId})`,
    );
  }
  return id;
}
