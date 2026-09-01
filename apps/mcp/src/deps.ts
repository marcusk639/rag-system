import type { Generator, Retriever } from "@rag/rag";
import type { Db } from "@rag/db";
import { buildCoreDeps, type Embedder, type Queue } from "@rag/runtime";
import { type Config, type ObjectStore } from "@rag/core";
import type { Logger } from "pino";

/**
 * Aggregate runtime dependencies for the MCP server.
 *
 * The core graph (db/retriever/queue/generator/close) comes from
 * `buildCoreDeps`; the MCP surface additionally threads `config` and `logger`
 * through to tool handlers.
 */
export interface Deps {
  config: Config;
  db: Db;
  retriever: Retriever;
  /**
   * The configured embedding provider. Tools read `.name`/`.model` for the
   * §7216/§10.22 disclosure audit trail — see `tools/ask.ts`/
   * `tools/search-documents.ts`.
   */
  embedder: Embedder;
  queue: Queue;
  generator: Generator | null;
  /**
   * Threaded through purely so `purge_source` can delete a purged source's
   * originals. Without it the Postgres cascade runs and the objects survive —
   * the orphaning bug, reachable via this surface even after the API was fixed.
   */
  objectStore: ObjectStore | null;
  close: () => Promise<void>;
  logger: Logger;
}

export async function buildDeps(config: Config, logger: Logger): Promise<Deps> {
  const { db, embedder, retriever, queue, generator, objectStore, close } =
    await buildCoreDeps(config, logger);
  return {
    config,
    db,
    embedder,
    retriever,
    queue,
    generator,
    objectStore,
    close,
    logger,
  };
}
