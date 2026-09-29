import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "@rag/db";
import { listRetryableIngestFailures, logIngestEvent } from "@rag/db";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";

/** Throws on its first batch, then behaves — a transient embedding outage. */
class FlakyEmbedder extends FakeEmbedder {
  private failuresLeft = 1;
  override async embedBatch(texts: string[]) {
    if (this.failuresLeft-- > 0) throw new Error("embedding API 503");
    return super.embedBatch(texts);
  }
}

describe("E2E: failed documents are retried on the next sync", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
  });
  beforeEach(async () => {
    await truncateAll(db);
    await db.execute(sql`TRUNCATE TABLE ingest_log`);
  });
  afterAll(async () => {
    await close();
  });

  it("a document that failed once is indexed by the next sync's retry pass", async () => {
    const sourceId = await createCustomSource(db, "retry-src");
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "flaky",
        title: "Flaky",
        text: "Retry me later.",
      }),
    ]);
    const embedder = new FlakyEmbedder();

    const first = await runOneIngestion(db, sourceId, connector, { embedder });
    expect(first.documentsFailed).toBe(1);
    expect(
      await listRetryableIngestFailures(db, sourceId, {
        maxAttempts: 5,
        limit: 10,
      }),
    ).toEqual(["flaky"]);

    // The delta feed would not list an unchanged document again; model that
    // with an empty connector for listing but the same document for fetch.
    const retryConnector = new FakeConnector([]);
    retryConnector.fetch = (id: string) => connector.fetch(id);
    const second = await runOneIngestion(db, sourceId, retryConnector, {
      embedder,
      retryFailed: true,
    });

    expect(second.documentsRetried).toBe(1);
    const docs = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM documents WHERE external_id = 'flaky'`,
    );
    expect(Number(docs.rows[0]?.n)).toBe(1);
    expect(
      await listRetryableIngestFailures(db, sourceId, {
        maxAttempts: 5,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("stops listing a document once it has failed maxAttempts times since its last success", async () => {
    const sourceId = await createCustomSource(db, "retry-cap");
    const fail = () =>
      logIngestEvent(db, {
        sourceId,
        docId: null,
        externalId: "broken",
        docClass: "A",
        action: "failed",
        rejectionReason: "ParserError",
      });
    for (let i = 0; i < 4; i++) await fail();
    expect(
      await listRetryableIngestFailures(db, sourceId, {
        maxAttempts: 5,
        limit: 10,
      }),
    ).toEqual(["broken"]);
    await fail();
    expect(
      await listRetryableIngestFailures(db, sourceId, {
        maxAttempts: 5,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("ignores failures older than the document's last successful ingest", async () => {
    const sourceId = await createCustomSource(db, "retry-resolved");
    await logIngestEvent(db, {
      sourceId,
      docId: null,
      externalId: "x",
      docClass: "A",
      action: "failed",
      rejectionReason: "E",
    });
    await logIngestEvent(db, {
      sourceId,
      docId: null,
      externalId: "x",
      docClass: "A",
      action: "ingested",
    });
    expect(
      await listRetryableIngestFailures(db, sourceId, {
        maxAttempts: 5,
        limit: 10,
      }),
    ).toEqual([]);
  });
});
