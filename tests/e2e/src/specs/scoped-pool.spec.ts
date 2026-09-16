import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@rag/db";
import { hybridSearch } from "@rag/db";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";

/**
 * Scope and metadata filters run AFTER each retrieval arm has been truncated
 * to its candidate pool (`topK × multiplier`), so the HNSW and GIN indexes can
 * serve the arms unfiltered. A principal scoped to a small source can then see
 * its relevant chunks crowded out of the pool by chunks from sources it cannot
 * read — getting fewer than topK results, or none, with no error.
 *
 * Setup: 30 out-of-scope documents that match the query better than the one
 * in-scope document, and a topK of 1 so the default pool (8) cannot reach it.
 */
describe("E2E: scoped retrieval is not starved by out-of-scope candidates", () => {
  let db: Db;
  let close: () => Promise<void>;
  let smallSource: string;
  const embedder = new FakeEmbedder();
  const QUERY = "catch-up bookkeeping engagement checklist";

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    close = handle.close;
    await truncateAll(db);

    const bigSource = await createCustomSource(db, "scoped-pool-big");
    smallSource = await createCustomSource(db, "scoped-pool-small");

    await runOneIngestion(
      db,
      bigSource,
      new FakeConnector(
        Array.from({ length: 30 }, (_, i) =>
          plainTextDoc({
            externalId: `big-${i}`,
            title: `Checklist ${i}`,
            text: `Catch-up bookkeeping engagement checklist ${i}: catch-up bookkeeping engagement checklist.`,
          }),
        ),
      ),
      { embedder },
    );
    await runOneIngestion(
      db,
      smallSource,
      new FakeConnector([
        plainTextDoc({
          externalId: "small-1",
          title: "Payroll notes",
          text: "Payroll notes that mention a bookkeeping engagement once, among many unrelated words about timesheets and approvals.",
        }),
      ]),
      { embedder },
    );
  });

  afterAll(async () => {
    await close();
  });

  it("returns the in-scope chunk even when out-of-scope chunks fill the default pool", async () => {
    const q = await embedder.embed(QUERY);
    const results = await hybridSearch(db, {
      query: QUERY,
      queryEmbedding: q.vector,
      topK: 1,
      embeddingProvider: embedder.name,
      embeddingModel: embedder.model,
      enforcedSourceIds: [smallSource],
    });
    expect(results.map((r) => r.document.sourceId)).toEqual([smallSource]);
  });

  it("an unscoped query is unaffected", async () => {
    const q = await embedder.embed(QUERY);
    const results = await hybridSearch(db, {
      query: QUERY,
      queryEmbedding: q.vector,
      topK: 3,
      embeddingProvider: embedder.name,
      embeddingModel: embedder.model,
      enforcedSourceIds: null,
    });
    expect(results).toHaveLength(3);
  });
});
