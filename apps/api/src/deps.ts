import type { Config, ObjectStore } from "@rag/core";
import type { Db } from "@rag/db";
import { buildCoreDeps, type Embedder, type Queue } from "@rag/runtime";
import type { Generator, Retriever } from "@rag/rag";
import type { Logger } from "pino";

/**
 * Long-lived runtime dependencies. Built once at startup and threaded into
 * route handlers via Fastify decorators. The core graph (db/queue/retriever/
 * generator/close) comes from `buildCoreDeps`; the API adds no extras.
 */
export interface Deps {
  db: Db;
  queue: Queue;
  retriever: Retriever;
  /**
   * The configured embedding provider. Routes read `.name`/`.model` for the
   * §7216/§10.22 disclosure audit trail (every /ask and /search call embeds
   * the query, so this is always populated) — not used for embedding
   * directly by route handlers, `retriever` already owns that.
   */
  embedder: Embedder;
  /** Null when `config.generation` is not configured — /ask returns 503 in that case. */
  generator: Generator | null;
  /** Object store for original document bytes; null when storage is disabled. */
  objectStore: ObjectStore | null;
  /** Threaded to the service layer so it can capture failures server-side. */
  logger: Logger;
  close: () => Promise<void>;
}

export async function buildDeps(config: Config, logger: Logger): Promise<Deps> {
  logger.info("building runtime dependencies");
  const { db, embedder, queue, retriever, generator, objectStore, close } =
    await buildCoreDeps(config, logger);
  return {
    db,
    embedder,
    queue,
    retriever,
    generator,
    objectStore,
    logger,
    close,
  };
}
