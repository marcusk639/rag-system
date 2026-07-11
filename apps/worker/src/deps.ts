import type { AuditLogSink, Config, Connector, ObjectStore } from "@rag/core";
import {
  claimPendingUploads,
  getPendingUploadByExternalId,
  type Db,
  type PendingUpload,
} from "@rag/db";
import { HttpParserClient, CompositeChunker } from "@rag/rag";
import { buildCoreDeps, type Embedder, type Queue } from "@rag/runtime";
// NOTE: The connector factory signature is:
//   createConnector(
//     { id, kind, config },
//     { microsoft?, google? },
//     logger,
//   ): Connector
// This import (and the `makeConnector` adapter below) is the single point to
// reconcile if the connectors package signature changes. The `custom` kind is
// NOT built by the factory (it rejects it) — we construct CustomConnector
// directly with a db-backed staging store below.
import {
  createConnector,
  CustomConnector,
  type StagedUpload,
  type UploadStagingStore,
} from "@rag/connectors";
import { SourceKind } from "@rag/core";
import type { Logger } from "pino";

/**
 * Long-lived dependencies built once at worker startup and reused across
 * every job. Anything that owns a connection (DB pool, pg-boss, parser HTTP
 * client) lives here so a single `close()` can drain everything cleanly on
 * SIGTERM/SIGINT.
 */
export interface WorkerDeps {
  config: Config;
  logger: Logger;
  db: Db;
  parser: HttpParserClient;
  chunker: CompositeChunker;
  embedder: Embedder;
  queue: Queue;
  /** Where original document bytes are persisted; null when storage is disabled. */
  objectStore: ObjectStore | null;
  /** Off-host sink for `audit_log` rows; null when shipping is disabled. */
  auditLogSink: AuditLogSink | null;
  /**
   * Build a connector for a given source row. The worker calls this per-job
   * because connector instances may hold per-source state (cursors, clients
   * bound to specific credentials/folders).
   */
  makeConnector: (source: {
    id: string;
    kind: string;
    config: Record<string, unknown>;
  }) => Connector;
  /** Drain pg-boss + DB pool. Idempotent — safe to call multiple times. */
  close: () => Promise<void>;
}

export async function buildDeps(
  config: Config,
  logger: Logger,
): Promise<WorkerDeps> {
  // Shared core graph (db/embedder/queue/close + an unused generator). Worker-
  // only resources (parser, chunker, connector factory) are layered on below.
  const { db, embedder, queue, objectStore, auditLogSink, close } =
    await buildCoreDeps(config, logger);

  const parser = new HttpParserClient(
    config.parser.url,
    config.parser.timeoutMs,
    config.parser.secret,
  );

  const chunker = new CompositeChunker({
    markdown: {
      chunkSize: config.retrieval.chunkSize,
      chunkOverlap: config.retrieval.chunkOverlap,
    },
    table: {
      chunkSize: config.retrieval.chunkSize,
      // Two-row overlap preserves cross-chunk reference context (e.g. a totals
      // row mentioned in the prior chunk still appears at the top of the next).
      rowOverlap: 2,
    },
  });

  // Staging store for the `custom` (upload) connector, backed by the
  // `pending_uploads` table. Kept here (not in @rag/connectors) so the
  // connectors package stays free of any database dependency.
  const toStaged = (row: PendingUpload): StagedUpload => ({
    externalId: row.externalId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    uploadedAt: row.createdAt.toISOString(),
  });
  const uploadStore: UploadStagingStore = {
    claim: async (sourceId, limit) =>
      (await claimPendingUploads(db, sourceId, limit)).map(toStaged),
    get: async (sourceId, externalId) => {
      const row = await getPendingUploadByExternalId(db, sourceId, externalId);
      return row ? toStaged(row) : null;
    },
  };

  const makeConnector: WorkerDeps["makeConnector"] = (source) => {
    // `custom` sources are browser uploads staged in our own DB, not an
    // external system — build the connector directly (the factory rejects
    // `custom`) with the staging store + object store.
    if (source.kind === "custom") {
      return new CustomConnector(source.id, uploadStore, objectStore, logger);
    }
    return createConnector(
      {
        id: source.id,
        // Validate at the boundary instead of trusting the DB blindly: a new
        // SourceKind that the connector factory can't build must fail loudly
        // here, not crash deep inside `createConnector`. `.parse` throws a Zod
        // error for any value outside the enum.
        kind: SourceKind.parse(source.kind),
        config: source.config,
      },
      { microsoft: config.microsoft, google: config.google },
      logger,
    );
  };

  return {
    config,
    logger,
    db,
    parser,
    chunker,
    embedder,
    queue,
    objectStore,
    auditLogSink,
    makeConnector,
    close,
  };
}
