import { RagError } from "@rag/core";

/**
 * A sync was requested for a source that already has one pending or running.
 * pg-boss's `singletonKey` dedupe rejects the duplicate (returns falsy), and we
 * surface that as a typed error so adapters can map it to 409 (HTTP) / isError
 * (MCP) instead of treating it as a 500.
 */
export class SyncAlreadyRunningError extends RagError {
  constructor(sourceId: string) {
    super(
      `A sync is already pending or running for source ${sourceId}`,
      "SYNC_ALREADY_RUNNING",
    );
  }
}

/**
 * One or more delta tombstones on a page could not be applied.
 *
 * Thrown BEFORE the page's cursor is persisted. Delta feeds (Graph, Drive) do
 * not re-send a tombstone once the caller has advanced past it, so saving the
 * cursor after a failed delete would leave that document searchable forever
 * with no further signal. Failing the page makes pg-boss retry from the last
 * good cursor instead; the page's documents re-process as content-hash no-ops.
 */
export class DeletionReconciliationError extends RagError {
  constructor(
    readonly sourceId: string,
    readonly failedExternalIds: readonly string[],
  ) {
    super(
      `Failed to reconcile ${failedExternalIds.length} deleted document(s) for ` +
        `source ${sourceId}; cursor not advanced so the deletions are retried`,
      "DELETION_RECONCILIATION_FAILED",
    );
  }
}
