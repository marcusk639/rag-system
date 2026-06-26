import pino from "pino";
import { loadConfig } from "@rag/core";
import { initMonitoring } from "@rag/runtime";
import {
  assertEmbeddingDimensions,
  assertRequiredIndexes,
  createIndexExistenceRunner,
} from "@rag/db";
import { buildDeps } from "./deps.js";
import { buildServer } from "./server.js";

/**
 * Entry point for the HTTP API. Reads config from env, builds deps, starts
 * Fastify, and wires graceful shutdown so in-flight requests + DB connections
 * + pg-boss listeners all drain cleanly on SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  initMonitoring(config.monitoring?.sentryDsn);
  // Fail fast before building deps / embedding the first /ask query: the
  // configured provider's vector size must match the chunks.embedding column.
  assertEmbeddingDimensions(config.embedding.dimensions);
  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "rag-api" },
  });

  const deps = await buildDeps(config, logger);

  // Fail fast before serving traffic: the HNSW + GIN search indexes (owned by
  // 0000_init.sql, invisible to Drizzle's model) must exist. If a stray
  // regenerate dropped them, /ask + /search would silently degrade to
  // sequential scans with no error — so refuse to start instead.
  await assertRequiredIndexes(createIndexExistenceRunner(deps.db));

  const app = await buildServer({ config, logger, deps });

  await app.listen({ host: config.api.host, port: config.api.port });
  logger.info(
    { host: config.api.host, port: config.api.port },
    "API server listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      await deps.close();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // Use stderr directly here — pino isn't constructed yet if loadConfig fails.
  process.stderr.write(
    `Fatal startup error: ${(err as Error).stack ?? String(err)}\n`,
  );
  process.exit(1);
});
