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
