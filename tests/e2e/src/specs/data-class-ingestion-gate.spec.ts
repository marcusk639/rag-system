import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { createIngestionJob, type Db } from "@rag/db";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import { handleSyncSource } from "@rag/worker";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { env } from "../env.js";

/**
 * End-to-end classification gate: when a source's real `data_class` column is
 * `client_confidential` (which maps to DocumentClass D), the REAL worker
 * handler (`handleSyncSource`) should reject documents before they are
 * written to the database, record the rejection in the ingest_log, and leave
 * zero documents and chunks in the database. This drives the full production
 * path — handler -> mapDataClassToDocumentClass -> runIngestion -> pipeline
 * gate — rather than hand-supplying a doc class or calling runIngestion
 * directly.
 */
describe("E2E: data-class ingestion gate (Phase 3 compliance)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("blocks ingestion and logs blocked action when the source's real data_class is client_confidential", async () => {
    const sourceId = await createCustomSource(
      db,
      "data-class-gate-test",
      {},
      "client_confidential", // <- the REAL sources.data_class column
    );

    const ingestionJob = await createIngestionJob(db, {
      sourceId,
      mode: "full",
    });

    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "blocked-doc-1",
        title: "Confidential Document",
        text: "This document should be blocked.",
      }),
    ]);

    const logger = pino({ level: "silent" });
    const parser = new HttpParserClient(
      env.parserUrl,
      60_000,
      env.parserSecret,
    );
    const chunker = new CompositeChunker({
      markdown: { chunkSize: 800, chunkOverlap: 120 },
      table: { chunkSize: 800, rowOverlap: 2 },
    });
    const embedder = new FakeEmbedder();

    const deps = {
      config: { worker: { concurrency: 2 } },
      logger,
      db,
      parser,
      chunker,
      embedder,
      queue: {},
      objectStore: null,
      makeConnector: () => connector,
      close: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const fakeJob = {
      id: "job-1",
      name: "syncSource",
      priority: 0,
      state: "active" as const,
      retryCount: 0,
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
      startAfter: new Date(),
      startedOn: new Date(),
      singletonKey: null,
      expireInSeconds: 60,
      createdOn: new Date(),
      completedOn: null,
      keepUntil: new Date(),
      on_complete: false,
      output: {},
      data: { sourceId, ingestionId: ingestionJob.id, mode: "full" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // The REAL worker handler — reads the REAL data_class column, calls the
    // REAL mapDataClassToDocumentClass, calls the REAL pipeline gate.
    await handleSyncSource(fakeJob, deps);

    const docCount = await db
      .execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM documents`)
      .then((r) => Number(r.rows[0]?.n ?? "0"));
    expect(docCount).toBe(0);

    const chunkCount = await db
      .execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM chunks`)
      .then((r) => Number(r.rows[0]?.n ?? "0"));
    expect(chunkCount).toBe(0);

    const logEntries = await db
      .execute<{ action: string; doc_class: string; external_id: string }>(
        sql`SELECT action, doc_class, external_id FROM ingest_log WHERE source_id = ${sourceId}`,
      )
      .then((r) => r.rows);

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]?.action).toBe("blocked");
    expect(logEntries[0]?.doc_class).toBe("D");
    expect(logEntries[0]?.external_id).toBe("blocked-doc-1");
  });
});
