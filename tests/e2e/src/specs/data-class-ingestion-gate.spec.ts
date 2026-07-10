import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { CompositeChunker, HttpParserClient } from "@rag/rag";
import { runIngestion } from "@rag/ingestion";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import type { Db } from "@rag/db";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { env } from "../env.js";

/**
 * End-to-end classification gate: when a source is marked `dataClass:
 * "client_confidential"` (which maps to DocumentClass C), the pipeline
 * should reject documents before they are written to the database,
 * record the rejection in the ingest_log, and leave zero documents
 * and chunks in the database.
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

  it("blocks ingestion and logs blocked action when sourceDocClass is C", async () => {
    const sourceId = await createCustomSource(db, "data-class-gate-test", {
      dataClass: "client_confidential",
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

    // Call runIngestion with sourceDocClass mapped to "C" (client_confidential).
    await runIngestion(
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
        sourceDocClass: "C",
      },
    );

    // Assert zero documents created.
    const docCount = await db
      .execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM documents`)
      .then((r) => Number(r.rows[0]?.n ?? "0"));
    expect(docCount).toBe(0);

    // Assert zero chunks created.
    const chunkCount = await db
      .execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM chunks`)
      .then((r) => Number(r.rows[0]?.n ?? "0"));
    expect(chunkCount).toBe(0);

    // Assert ingest_log has a blocked action with docClass "C".
    const logEntries = await db
      .execute<{
        action: string;
        doc_class: string;
        external_id: string;
      }>(
        sql`
        SELECT action, doc_class, external_id
        FROM ingest_log
        WHERE source_id = ${sourceId}
      `,
      )
      .then((r) => r.rows);

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]?.action).toBe("blocked");
    expect(logEntries[0]?.doc_class).toBe("C");
    expect(logEntries[0]?.external_id).toBe("blocked-doc-1");
  });
});
