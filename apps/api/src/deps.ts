import type { Config } from "@rag/core";
import type { Db } from "@rag/db";
import { buildCoreDeps, type Queue } from "@rag/runtime";
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
  /** Null when `config.generation` is not configured — /ask returns 503 in that case. */
  generator: Generator | null;
  /** Threaded to the service layer so it can capture failures server-side. */
  logger: Logger;
  close: () => Promise<void>;
}

export async function buildDeps(config: Config, logger: Logger): Promise<Deps> {
  logger.info("building runtime dependencies");
  const { db, queue, retriever, generator, close } = await buildCoreDeps(
    config,
    logger,
  );
  return { db, queue, retriever, generator, logger, close };
}
