import pino from "pino";
import { sql } from "drizzle-orm";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { runIngestion, type PipelineRunResult } from "@rag/ingestion";
import {
  loadPack,
  type Connector,
  type EmbeddingProvider,
  type LoadedPack,
} from "@rag/core";
import { createSource, type Db } from "@rag/db";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_ENV } from "../env.js";
import { FIXTURE_SOURCE_NAME } from "../fixtures/corpus.js";

// The pipeline refuses to run without a scanner pack; wire the real one.
// Resolved from import.meta.url (matching stack.ts / global-setup.ts)
// rather than process.cwd() — a cwd-relative path only works when the
// invocation happens to run from the package directory, and breaks with a
// confusing pack-not-found error when run from the repo root.
const CPA_PACK: LoadedPack = loadPack(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "packs",
    "cpa",
  ),
);

/**
 * Truncate every application table. Copied from tests/e2e/src/helpers/db.ts —
 * `@rag/e2e` has no build/exports so it cannot be imported from here (see the
 * copy-don't-import decision recorded for this package).
 *
 * Called at the start of `seedCorpus()` so re-running the suite doesn't
 * accumulate documents across runs (which would break the "exactly one
 * distinct embedding_model" coherence assertion for the wrong reason).
 *
 * Order matters because of FKs: chunks → documents → ingestion_jobs →
 * sources. `RESTART IDENTITY CASCADE` makes UUID PKs noisy-but-safe; we use it
 * so we don't have to enumerate dependents.
 */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE chunks, documents, ingestion_jobs, sources
    RESTART IDENTITY CASCADE
  `);
}

export async function createFixtureSource(db: Db): Promise<string> {
  const row = await createSource(db, {
    kind: "custom",
    name: FIXTURE_SOURCE_NAME,
    config: {},
  });
  return row.id;
}

export async function runOneIngestion(
  db: Db,
  sourceId: string,
  connector: Connector,
  overrides: { chunkSize: number; embedder: EmbeddingProvider },
): Promise<PipelineRunResult> {
  const logger = pino({ level: "silent" });
  const parser = new HttpParserClient(E2E_ENV.PARSER_URL, 60_000, undefined);
  const chunker = new CompositeChunker({
    markdown: { chunkSize: overrides.chunkSize, chunkOverlap: 120 },
    table: { chunkSize: overrides.chunkSize, rowOverlap: 2 },
  });

  return runIngestion(
    sourceId,
    connector,
    null, // cursor
    { concurrency: 2, pageSize: 50 },
    {
      db,
      parser,
      chunker,
      embedder: overrides.embedder,
      logger,
      // An undeclared source class fails CLOSED to "D" and quarantines every
      // document. Fixtures are synthetic public content — declare Class A.
      sourceDocClass: "A",
      pack: CPA_PACK,
    },
  );
}
