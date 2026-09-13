import { FakeConnector } from "@rag/test-fixtures";
// NOTE: LocalEmbeddingProvider is NOT exported from @rag/rag — only the factory
// is. Do not reach for a deep dist path; use createEmbeddingProvider.
import { createEmbeddingProvider } from "@rag/rag";
import type { Config } from "@rag/core";
import { createDb } from "@rag/db";
import {
  createFixtureSource,
  runOneIngestion,
  truncateAll,
} from "./ingestion.js";
import { E2E_ENV } from "../env.js";
import { FIXTURE_DOCS } from "../fixtures/corpus.js";

export async function seedCorpus(): Promise<{ sourceId: string }> {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    // Make the suite re-runnable: without this, a second run accumulates
    // documents and the "exactly one distinct embedding_model" coherence
    // assertion fails for the wrong reason (row count, not model drift).
    await truncateAll(db);
    const sourceId = await createFixtureSource(db);
    await runOneIngestion(db, sourceId, new FakeConnector(FIXTURE_DOCS), {
      // MUST be passed explicitly — runOneIngestion never reads env and would
      // otherwise chunk at 800, exceeding the local model's 512-token limit.
      chunkSize: 512,
      embedder: createEmbeddingProvider({
        provider: "local",
        model: E2E_ENV.EMBEDDING_MODEL,
        dimensions: 768,
      } as Config["embedding"]),
    });
    return { sourceId };
  } finally {
    await close();
  }
}
