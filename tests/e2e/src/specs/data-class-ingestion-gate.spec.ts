import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { createIngestionJob, type Db } from "@rag/db";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import { handleSyncSource } from "@rag/worker";
import { loadPack } from "@rag/core";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { env, TEST_SCANNER_PACK_DIR } from "../env.js";
import { runOneIngestion } from "../helpers/ingestion.js";

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
      // The real pack too — the pipeline refuses to ingest without one, and
      // this spec's whole point is that nothing about the path is faked.
      pack: loadPack(TEST_SCANNER_PACK_DIR),
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

  // Class C has no sources.data_class mapping today (client_confidential maps
  // to D), so the handler test above can never exercise it. C and D share one
  // enum path in places, so a change that lets C through could let D through:
  // prove C is blocked end to end too, through the real pipeline and database.
  it("blocks a Class C source end to end and records it as Class C", async () => {
    const sourceId = await createCustomSource(db, "class-c-gate-test");
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "class-c-doc",
        title: "Class C Document",
        text: "This document should be blocked as Class C.",
      }),
    ]);

    const result = await runOneIngestion(db, sourceId, connector, {
      sourceDocClass: "C",
    });

    expect(result.chunksCreated).toBe(0);
    const counts = await db
      .execute<{ docs: string; chunks: string }>(
        sql`SELECT (SELECT COUNT(*) FROM documents)::text AS docs,
                   (SELECT COUNT(*) FROM chunks)::text AS chunks`,
      )
      .then((r) => r.rows[0]);
    expect(Number(counts?.docs)).toBe(0);
    expect(Number(counts?.chunks)).toBe(0);

    const log = await db
      .execute<{ action: string; doc_class: string }>(
        sql`SELECT action, doc_class FROM ingest_log WHERE source_id = ${sourceId}`,
      )
      .then((r) => r.rows);
    expect(log).toEqual([{ action: "blocked", doc_class: "C" }]);
  });
});
