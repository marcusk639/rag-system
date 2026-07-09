import pino from "pino";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { runIngestion, type PipelineRunResult } from "@rag/ingestion";
import type { Connector, EmbeddingProvider } from "@rag/core";
import type { Db } from "@rag/db";
import { env } from "../env.js";
import { FakeEmbedder } from "@rag/test-fixtures";

/**
 * Drive the ingestion pipeline synchronously, bypassing pg-boss. The worker
 * uses pg-boss to gate concurrency in production; for tests we want a single
 * deterministic awaitable that produces the same DB end-state.
 *
 * Returns the pipeline's result so specs can assert on counts.
 */
export async function runOneIngestion(
  db: Db,
  sourceId: string,
  connector: Connector,
  overrides?: {
    chunkSize?: number;
    chunkOverlap?: number;
    /**
     * Defaults to `FakeEmbedder` (deterministic, no network) so every
     * existing spec is unaffected. Pass a real provider (see
     * `eval/run-real-eval.ts`) to seed a corpus with real vectors — the
     * embedder used here MUST match the one passed to the retriever that
     * later queries this corpus, or dense scores are meaningless (comparing
     * vectors from two different embedding spaces).
     */
    embedder?: EmbeddingProvider;
  },
): Promise<PipelineRunResult> {
  const logger = pino({ level: "silent" });
  const parser = new HttpParserClient(env.parserUrl, 60_000, env.parserSecret);
  const chunker = new CompositeChunker({
    markdown: {
      chunkSize: overrides?.chunkSize ?? 800,
      chunkOverlap: overrides?.chunkOverlap ?? 120,
    },
    table: {
      chunkSize: overrides?.chunkSize ?? 800,
      rowOverlap: 2,
    },
  });
  const embedder = overrides?.embedder ?? new FakeEmbedder();

  return runIngestion(
    sourceId,
    connector,
    null, // cursor
    { concurrency: 2, pageSize: 50 },
    {
      db,
      parser,
      chunker,
      embedder,
      logger,
    },
  );
}
