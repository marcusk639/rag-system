import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ADMIN_SCOPE } from "@rag/core";
import { Retriever } from "@rag/rag";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";
import type { Db } from "@rag/db";

/**
 * P0 gate #1 enforcement: a document withdrawn by the content audit must stop
 * being retrievable.
 *
 * These assertions live here, against a real Postgres, rather than in
 * `packages/db`, because that package's unit tests have no database — as
 * `queries.access-control.test.ts` says of the sibling source-id filter, the
 * SQL enforcement itself "needs Postgres" and was otherwise "verified by
 * reading + typecheck". For a compliance gate, a unit test asserting that a
 * SQL fragment is present would pass whether or not the fragment works.
 *
 * Each test asserts in BOTH directions — that the document IS retrievable
 * while active, and is NOT once withdrawn — so the test cannot pass by
 * retrieving nothing at all.
 */
describe("E2E: withdrawn documents are not retrievable (P0 gate #1)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let sourceId: string;
  let retriever: Retriever;

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
    sourceId = await createCustomSource(db, "lifecycle");
    retriever = new Retriever(db, new FakeEmbedder(), {
      topK: 10,
      denseWeight: 0.7,
      sparseWeight: 0.3,
    });
  });

  const seedTwo = async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "keep-1",
        title: "Engagement Letter Procedure",
        text: "The engagement letter procedure covers scope and fees for every new client file.",
      }),
      plainTextDoc({
        externalId: "withdraw-1",
        title: "Withdrawn Procedure",
        text: "The engagement letter procedure covers scope and fees for every new client file.",
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);
  };

  const titles = async (query: string) => {
    const results = await retriever.search({ query, topK: 10 }, ADMIN_SCOPE);
    return results.map((r) => r.document.title).sort();
  };

  const withdraw = async (externalId: string) => {
    await db.execute(sql`
      UPDATE documents SET lifecycle_status = 'withdrawn'
      WHERE external_id = ${externalId}
    `);
  };

  it("retrieves both documents while both are active (control)", async () => {
    await seedTwo();
    expect(await titles("engagement letter procedure")).toEqual([
      "Engagement Letter Procedure",
      "Withdrawn Procedure",
    ]);
  });

  it("omits a withdrawn document and keeps the active one", async () => {
    await seedTwo();
    await withdraw("withdraw-1");
    expect(await titles("engagement letter procedure")).toEqual([
      "Engagement Letter Procedure",
    ]);
  });

  it("omits a withdrawn document from the SPARSE arm too", async () => {
    await seedTwo();
    await withdraw("withdraw-1");
    // An exact-token query the sparse (tsvector) arm answers. The filter sits
    // in the final SELECT after the RRF merge, so one fragment covers both
    // arms — this test is what proves that rather than assuming it.
    const found = await titles("engagement");
    expect(found).not.toContain("Withdrawn Procedure");
    expect(found).toContain("Engagement Letter Procedure");
  });

  it("a re-sync of CHANGED content does NOT resurrect a withdrawn document", async () => {
    await seedTwo();
    await withdraw("withdraw-1");
    // Different text for the same externalId, so the content hash moves and the
    // upsert takes its ON CONFLICT ... DO UPDATE branch. That SET list omits
    // lifecycle_status on purpose; this test is what keeps it omitted.
    const edited = new FakeConnector([
      plainTextDoc({
        externalId: "withdraw-1",
        title: "Withdrawn Procedure",
        text: "The engagement letter procedure was revised this quarter with new scope and fees language.",
      }),
    ]);
    await runOneIngestion(db, sourceId, edited);
    const found = await titles("engagement letter procedure");
    expect(found).not.toContain("Withdrawn Procedure");
  });

  it("a re-sync of unchanged content does NOT resurrect a withdrawn document", async () => {
    await seedTwo();
    await withdraw("withdraw-1");
    // Same connector, same content hashes — the idempotent re-ingest path.
    await seedTwo();
    expect(await titles("engagement letter procedure")).toEqual([
      "Engagement Letter Procedure",
    ]);
  });
});
