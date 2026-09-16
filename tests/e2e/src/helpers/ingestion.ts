import pino from "pino";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { runIngestion, type PipelineRunResult } from "@rag/ingestion";
import {
  loadPack,
  type Connector,
  type EmbeddingProvider,
  type LoadedPack,
  type DocumentClass,
} from "@rag/core";
import type { Db } from "@rag/db";
import { env, TEST_SCANNER_PACK_DIR } from "../env.js";
import { FakeEmbedder } from "@rag/test-fixtures";

/**
 * The pipeline refuses to run without a scanner pack, so e2e wires the real
 * one rather than a stub: these specs are the only place the whole ingestion
 * path runs end-to-end, and a stub pack would exercise a redaction layer that
 * ships to nobody. Loaded once — `loadPack` reads and compiles from disk.
 */
const CPA_PACK: LoadedPack = loadPack(TEST_SCANNER_PACK_DIR);

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
    /**
     * Defaults to the `packs/cpa` scanner pack. Override to exercise a
     * different scanner set; the pipeline rejects a missing or empty pack.
     */
    pack?: LoadedPack;
    /** Defaults to "A" (synthetic public fixtures). */
    sourceDocClass?: DocumentClass;
    /** Retry earlier failed documents before listing (default false). */
    retryFailed?: boolean;
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
    {
      concurrency: 2,
      pageSize: 50,
      retryFailed: overrides?.retryFailed ?? false,
    },
    {
      db,
      parser,
      chunker,
      embedder,
      logger,
      // Layer 3 (2026-08-03): an undeclared source class now fails CLOSED to
      // "D", so every document quarantines. Fixtures are synthetic public
      // content, so declare Class A explicitly rather than relying on a
      // permissive default — the implicit default is what this layer removed.
      sourceDocClass: overrides?.sourceDocClass ?? "A",
      pack: overrides?.pack ?? CPA_PACK,
    },
  );
}
