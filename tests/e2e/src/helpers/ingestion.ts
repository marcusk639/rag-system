import pino from "pino";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { runIngestion, type PipelineRunResult } from "@rag/ingestion";
import type { Connector } from "@rag/core";
import type { Db } from "@rag/db";
import { env } from "../env.js";
import { FakeEmbedder } from "../fakes/fake-embedder.js";

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
  overrides?: { chunkSize?: number; chunkOverlap?: number },
): Promise<PipelineRunResult> {
  const logger = pino({ level: "silent" });
  const parser = new HttpParserClient(env.parserUrl, 60_000);
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
  const embedder = new FakeEmbedder();

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
