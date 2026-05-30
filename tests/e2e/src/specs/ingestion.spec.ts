import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { FakeConnector } from "../fakes/fake-connector.js";
import { markdownDoc, plainTextDoc } from "../fakes/factories.js";
import {
  countChunks,
  countDocuments,
  createCustomSource,
  getChunksForExternalId,
  openTestDb,
  truncateAll,
} from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";
import type { Db } from "@rag/db";

/**
 * End-to-end ingestion: connector → parser-py → CompositeChunker → FakeEmbedder
 * → Postgres (documents + chunks).
 *
 * The spec asserts on the visible DB end-state, not pipeline internals — same
 * surface a downstream service (the worker) would observe.
 */
describe("E2E: ingestion pipeline", () => {
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

  it("ingests a single markdown document end-to-end", async () => {
    const sourceId = await createCustomSource(db, "ingestion-single");
    const connector = new FakeConnector([
      markdownDoc({
        externalId: "doc-1",
        title: "Coffee Brewing Guide",
        markdown:
          "# Coffee Brewing\n\nMaking great coffee starts with fresh beans and the right grind size.\n\n## Pour Over\n\nPour over methods extract bright, clean flavors.\n\n## French Press\n\nFrench press yields a heavier, fuller body.",
      }),
    ]);

    const result = await runOneIngestion(db, sourceId, connector);

    expect(result.documentsProcessed).toBe(1);
    expect(result.documentsFailed).toBe(0);
    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.done).toBe(true);

    expect(await countDocuments(db)).toBe(1);
    expect(await countChunks(db)).toBe(result.chunksCreated);

    const chunks = await getChunksForExternalId(db, sourceId, "doc-1");
    expect(chunks.length).toBeGreaterThan(0);
    // The whole document is small enough that chunks should cover at least one
    // section with its heading attached.
    const allText = chunks.map((c) => c.text).join("\n");
    expect(allText).toContain("Coffee Brewing");
    expect(allText).toContain("French Press");
    // Token counts must be populated and positive.
    for (const c of chunks) {
      expect(c.tokenCount).toBeGreaterThan(0);
      expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Ordinals are 0..n-1 contiguously.
    expect(chunks.map((c) => c.ordinal)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
  });

  it("ingests multiple documents in one run", async () => {
    const sourceId = await createCustomSource(db, "ingestion-multi");
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "tea",
        title: "Tea Notes",
        text: "Green tea is steeped in water at 80C. Black tea uses boiling water.",
      }),
      plainTextDoc({
        externalId: "wine",
        title: "Wine Notes",
        text: "Red wine pairs with red meat. White wine pairs with fish.",
      }),
      plainTextDoc({
        externalId: "beer",
        title: "Beer Notes",
        text: "Lagers are bottom-fermented at cool temperatures. Ales are top-fermented.",
      }),
    ]);

    const result = await runOneIngestion(db, sourceId, connector);

    expect(result.documentsProcessed).toBe(3);
    expect(result.documentsFailed).toBe(0);
    expect(await countDocuments(db)).toBe(3);

    const tea = await getChunksForExternalId(db, sourceId, "tea");
    const wine = await getChunksForExternalId(db, sourceId, "wine");
    const beer = await getChunksForExternalId(db, sourceId, "beer");
    expect(tea.length).toBeGreaterThan(0);
    expect(wine.length).toBeGreaterThan(0);
    expect(beer.length).toBeGreaterThan(0);
  });

  it("persists the cursor returned by the connector", async () => {
    const sourceId = await createCustomSource(db, "ingestion-cursor");
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "any",
        title: "Any",
        text: "Anything.",
      }),
    ]);

    await runOneIngestion(db, sourceId, connector);

    const res = await db.execute<{ cursor: string | null }>(
      sql`SELECT cursor FROM sources WHERE id = ${sourceId}`,
    );
    expect(res.rows[0]?.cursor).toBe("e2e-cursor-1");
  });
});
