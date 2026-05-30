import type { Config } from "@rag/core";
import { createDb, type Db } from "@rag/db";
import {
  createEmbeddingProvider,
  HttpParserClient,
  CompositeChunker,
} from "@rag/rag";
import { createQueue } from "@rag/ingestion";
// NOTE: `@rag/connectors` is being built in parallel. The factory signature
// below matches what was agreed in the worker spec:
//   createConnector(
//     { id, kind, config },
//     { microsoft?, google? },
//     logger,
//   ): Connector
// If the connectors package lands with a different signature, this import
// (and the `makeConnector` adapter below) is the single point to reconcile.
import { createConnector } from "@rag/connectors";
import type { Connector } from "@rag/core";
import type { Logger } from "pino";
import type PgBoss from "pg-boss";

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
  embedder: ReturnType<typeof createEmbeddingProvider>;
  queue: PgBoss;
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
  const { db, close: closeDb } = createDb(config.databaseUrl);

  const parser = new HttpParserClient(
    config.parser.url,
    config.parser.timeoutMs,
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

  const embedder = createEmbeddingProvider(config.embedding);

  const queue = await createQueue({
    databaseUrl: config.databaseUrl,
    schema: config.pgBossSchema,
  });

  const makeConnector: WorkerDeps["makeConnector"] = (source) =>
    createConnector(
      {
        id: source.id,
        // SourceKind narrows to the enum in core; we trust the DB to only
        // store valid values because the column is a Postgres enum.
        kind: source.kind as never,
        config: source.config,
      },
      { microsoft: config.microsoft, google: config.google },
      logger,
    );

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Stop pg-boss first so it stops handing out new jobs and lets in-flight
    // ones finish (graceful: true). Then end the DB pool.
    try {
      await queue.stop({ graceful: true });
    } catch (err) {
      logger.error({ err }, "error stopping pg-boss");
    }
    try {
      await closeDb();
    } catch (err) {
      logger.error({ err }, "error closing db pool");
    }
  };

  return {
    config,
    logger,
    db,
    parser,
    chunker,
    embedder,
    queue,
    makeConnector,
    close,
  };
}
