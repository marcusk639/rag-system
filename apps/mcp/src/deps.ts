import {
  createEmbeddingProvider,
  Retriever,
  createGenerator,
  type Generator,
} from "@rag/rag";
import { createDb, type Db } from "@rag/db";
import { createQueue } from "@rag/ingestion";
import { type Config } from "@rag/core";
import type { Logger } from "pino";

type Queue = Awaited<ReturnType<typeof createQueue>>;

/**
 * Aggregate runtime dependencies for the MCP server.
 *
 * Built once at startup so every tool handler shares the same DB pool,
 * embedding provider, retriever, queue, and (optional) generator instance.
 * Mirrors the pattern in apps/api/src/deps.ts so the two surfaces stay
 * trivially interchangeable when wiring new tools.
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
  const { db, close: closeDb } = createDb(config.databaseUrl);

  const embedder = createEmbeddingProvider(config.embedding);

  const retriever = new Retriever(db, embedder, {
    topK: config.retrieval.defaultTopK,
    denseWeight: config.retrieval.hybridDenseWeight,
    sparseWeight: config.retrieval.hybridSparseWeight,
  });

  const queue = await createQueue({
    databaseUrl: config.databaseUrl,
    schema: config.pgBossSchema,
  });

  // Generation is optional — agents can still use search/get/list/sync tools
  // even when no generation provider is configured. The `ask` tool will
  // return an isError result if invoked without a generator.
  //
  // We reuse `config.embedding.apiKey` rather than reading process.env here
  // because loadConfig() already centralizes env access. This couples the
  // generation provider to the embedding provider in practice (same vendor,
  // same key), which matches every realistic deployment.
  let generator: Generator | null = null;
  if (config.generation) {
    const apiKey = config.embedding.apiKey;
    if (!apiKey) {
      logger.warn(
        { provider: config.generation.provider },
        "Generation provider configured but no API key on embedding config — `ask` tool will return errors",
      );
    } else {
      generator = createGenerator({
        provider: config.generation.provider,
        model: config.generation.model,
        apiKey,
      });
    }
  }

  const close = async (): Promise<void> => {
    try {
      await queue.stop({ graceful: true });
    } catch (err) {
      logger.warn({ err }, "Error stopping pg-boss queue");
    }
    await closeDb();
  };

  return { config, db, retriever, queue, generator, close, logger };
}
