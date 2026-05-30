import type { Config } from "@rag/core";
import { createDb, type Db } from "@rag/db";
import { createQueue } from "@rag/ingestion";
import {
  Retriever,
  createEmbeddingProvider,
  createGenerator,
  type Generator,
} from "@rag/rag";
import type PgBoss from "pg-boss";
import type { Logger } from "pino";

/**
 * Long-lived runtime dependencies. Built once at startup and threaded into
 * route handlers via Fastify decorators. Every constructor side-effect lives
 * here so route code stays pure.
 */
export interface Deps {
  db: Db;
  queue: PgBoss;
  retriever: Retriever;
  /** Null when `config.generation` is not configured — /ask returns 503 in that case. */
  generator: Generator | null;
  close: () => Promise<void>;
}

export async function buildDeps(config: Config, logger: Logger): Promise<Deps> {
  logger.info("building runtime dependencies");

  const { db, close: closeDb } = createDb(config.databaseUrl);

  const queue = await createQueue({
    databaseUrl: config.databaseUrl,
    schema: config.pgBossSchema,
  });

  const embedder = createEmbeddingProvider(config.embedding);

  const retriever = new Retriever(db, embedder, {
    topK: config.retrieval.defaultTopK,
    denseWeight: config.retrieval.hybridDenseWeight,
    sparseWeight: config.retrieval.hybridSparseWeight,
  });

  let generator: Generator | null = null;
  if (config.generation) {
    // Generation reuses the embedding provider's API key — same vendor in
    // practice (Gemini embedding + Gemini generation, OpenAI + OpenAI).
    const apiKey = config.embedding.apiKey;
    if (!apiKey) {
      logger.warn(
        "generation configured but no API key on embedding config — /ask will return 503",
      );
    } else {
      generator = createGenerator({
        provider: config.generation.provider,
        model: config.generation.model,
        apiKey,
      });
    }
  }

  return {
    db,
    queue,
    retriever,
    generator,
    close: async () => {
      await queue.stop({ graceful: true });
      await closeDb();
    },
  };
}
