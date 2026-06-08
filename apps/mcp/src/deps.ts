import type { Generator, Retriever } from "@rag/rag";
import type { Db } from "@rag/db";
import { buildCoreDeps, type Queue } from "@rag/runtime";
import { type Config } from "@rag/core";
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
  queue: Queue;
  generator: Generator | null;
  close: () => Promise<void>;
  logger: Logger;
}

export async function buildDeps(config: Config, logger: Logger): Promise<Deps> {
  const { db, retriever, queue, generator, close } = await buildCoreDeps(
    config,
    logger,
  );
  return { config, db, retriever, queue, generator, close, logger };
}
