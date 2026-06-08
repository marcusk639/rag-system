import { NotFoundError } from "@rag/core";
import {
  createIngestionJob,
  getSource,
  listSources,
  type Source,
} from "@rag/db";
import { enqueueSync } from "@rag/ingestion";
import type { ServiceDeps } from "./deps.js";

/**
 * Drop the raw `config` blob before returning a source over the wire. The
 * config carries connector-specific values (site/folder ids, queries, OAuth
 * impersonation subjects) that should never be echoed to a read-token holder.
 *
 * Inlined here for Phase 1; Phase 3 promotes a shared `toPublicSource` in
 * `@rag/db` and both API and MCP import that instead.
 */
function sanitizeSource(row: Source): Omit<Source, "config"> {
  const { config: _config, ...safe } = row;
  return safe;
}

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
  const jobId = await enqueueSync(deps.queue, {
    sourceId: input.sourceId,
    mode: input.mode,
    ingestionId: ingestionRow.id,
  });

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
  return rows.map(sanitizeSource);
}
