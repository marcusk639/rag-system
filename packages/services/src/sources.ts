import { NotFoundError } from "@rag/core";
import {
  createIngestionJob,
  deleteIngestionJob,
  getSource,
  listSources,
  toPublicSource,
  updateIngestionJob,
  type Source,
} from "@rag/db";
import { enqueueSync, SyncAlreadyRunningError } from "@rag/ingestion";
import type { ServiceDeps } from "./deps.js";

export interface TriggerSyncInput {
  sourceId: string;
  mode: "full" | "incremental";
}

export interface TriggerSyncResult {
  jobId: string;
  ingestionId: string;
  mode: "full" | "incremental";
}

/**
 * Enqueue a background ingestion sync. Transport-agnostic core of
 * POST /sources/:id/sync and the `trigger_sync` MCP tool.
 *
 * C2a fix: this function is the *sole* writer of `ingestion_jobs` rows. It
 * creates exactly one row (status=pending) and threads its id into the queue
 * payload; the worker only transitions that row. Throws `NotFoundError` when
 * the source is unknown and `SyncAlreadyRunningError` (from `@rag/ingestion`,
 * via `enqueueSync`) when a sync is already pending/running.
 */
export async function triggerSync(
  deps: ServiceDeps,
  input: TriggerSyncInput,
): Promise<TriggerSyncResult> {
  const source = await getSource(deps.db, input.sourceId);
  if (!source) throw new NotFoundError(`Source ${input.sourceId} not found`);

  // Record the run in our human-readable history table — the only place this
  // row is ever created.
  const ingestionRow = await createIngestionJob(deps.db, {
    sourceId: input.sourceId,
    mode: input.mode,
    status: "pending",
  });

  // Hand off to pg-boss for async execution, carrying the history row id so
  // the worker updates it rather than creating its own.
  let jobId: string;
  try {
    jobId = await enqueueSync(deps.queue, {
      sourceId: input.sourceId,
      mode: input.mode,
      ingestionId: ingestionRow.id,
    });
  } catch (err) {
    // The row we just created is for a sync that will never run. A duplicate
    // rejected by pg-boss's singleton guard leaves no real attempt, so delete
    // the row (the in-flight sync owns its own). Any other enqueue failure is
    // a genuine attempt that failed — mark it `failed` so it stays auditable
    // rather than stuck `pending`. Cleanup must never mask the original error.
    try {
      if (err instanceof SyncAlreadyRunningError) {
        await deleteIngestionJob(deps.db, ingestionRow.id);
      } else {
        await updateIngestionJob(deps.db, ingestionRow.id, { status: "failed" });
      }
    } catch {
      // Swallow cleanup failure; the original enqueue error is what matters.
    }
    throw err;
  }

  return { jobId, ingestionId: ingestionRow.id, mode: input.mode };
}

/**
 * List all registered sources with the `config` blob stripped.
 * Transport-agnostic core of GET /sources and the `list_sources` MCP tool.
 */
export async function listPublicSources(
  deps: ServiceDeps,
): Promise<Omit<Source, "config">[]> {
  const rows = await listSources(deps.db);
  return rows.map(toPublicSource);
}
