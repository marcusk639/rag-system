import { NotFoundError, type AuthorizationScope } from "@rag/core";
import {
  createIngestionJob,
  deleteIngestionJob,
  getSource,
  listSources,
  purgeSource as purgeSourceQuery,
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
    const isDuplicate = err instanceof SyncAlreadyRunningError;

    // A duplicate is expected and benign (the in-flight sync is doing the work),
    // so it stays out of the error log. A genuine enqueue failure must be
    // captured server-side here: a transport may reduce the thrown error to a
    // user-facing string (the `trigger_sync` MCP tool does), making this the
    // only guaranteed point of capture.
    if (!isDuplicate) {
      deps.logger.error(
        {
          err,
          sourceId: input.sourceId,
          ingestionId: ingestionRow.id,
          mode: input.mode,
        },
        "sync enqueue failed",
      );
    }

    // The row we just created is for a sync that will never run. A rejected
    // duplicate leaves no real attempt, so delete the row (the in-flight sync
    // owns its own). Any other enqueue failure is a genuine attempt that
    // failed — mark it `failed` so it stays auditable rather than stuck
    // `pending`. Cleanup must never mask the original error.
    try {
      if (isDuplicate) {
        await deleteIngestionJob(deps.db, ingestionRow.id);
      } else {
        await updateIngestionJob(deps.db, ingestionRow.id, {
          status: "failed",
        });
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
 *
 * `scope` is the MANDATORY confidentiality boundary (P1 fix): a scoped
 * principal must only ever see the sources in its `allowedSourceIds` — never
 * the full corpus, regardless of transport. `enforcedSourceIds === null`
 * (admin) returns every row; an empty array (`DENY_ALL_SCOPE`) returns `[]`.
 */
export async function listPublicSources(
  deps: ServiceDeps,
  scope: AuthorizationScope,
): Promise<Omit<Source, "config">[]> {
  const rows = await listSources(deps.db);
  const publicRows = rows.map(toPublicSource);
  if (scope.enforcedSourceIds === null) return publicRows;
  const allowed = new Set(scope.enforcedSourceIds);
  return publicRows.filter((row) => allowed.has(row.id));
}

/**
 * Permanently delete a source and all associated data (documents, chunks,
 * ingestion jobs, pending uploads). Transport-agnostic core of
 * DELETE /sources/:id and the `purge_source` MCP tool.
 *
 * Throws `NotFoundError` when no source with that id exists.
 */
export async function purgeSource(
  deps: ServiceDeps,
  sourceId: string,
): Promise<void> {
  const { deleted, storageKeys } = await purgeSourceQuery(deps.db, sourceId);
  if (!deleted) throw new NotFoundError(`Source ${sourceId} not found`);

  // The Postgres cascade is committed at this point. The originals live in the
  // object store and are NOT reached by it, so without this they outlive the
  // source that owned them — which is how a §7216 purge left the corpus it was
  // performed over sitting in a third-party bucket.
  if (!deps.objectStore || storageKeys.length === 0) return;

  let failed = 0;
  for (const key of storageKeys) {
    try {
      await deps.objectStore.delete(key);
    } catch (err) {
      failed += 1;
      // Deliberately not rethrown. The rows are already gone, so failing here
      // would return an error for a purge that largely succeeded and invite a
      // retry against a source that no longer exists. The orphan is recorded
      // instead, with the key, so it can be swept up.
      deps.logger?.error(
        { err, sourceId, storageKey: key, marker: "purge.object_orphaned" },
        "source purged but its stored original could not be deleted; the " +
          "object is now orphaned in the bucket",
      );
    }
  }

  deps.logger?.info(
    {
      sourceId,
      objectsDeleted: storageKeys.length - failed,
      objectsOrphaned: failed,
    },
    "purged source originals from object storage",
  );
}
