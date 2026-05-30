import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeConnector } from "../fakes/fake-connector.js";
import { plainTextDoc } from "../fakes/factories.js";
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
 * Re-ingestion contract:
 *   - Same content twice → second pass is a no-op (no new chunks).
 *   - Same externalId with NEW content → chunks replaced atomically.
 *   - Each chunk's `hash` is a stable SHA-256 of its text + heading path —
 *     re-running the pipeline yields the same hashes.
 */
describe("E2E: idempotency and updates", () => {
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

  it("re-ingesting an unchanged document creates zero new chunks", async () => {
    const sourceId = await createCustomSource(db, "idempotent");
    const doc = plainTextDoc({
      externalId: "stable",
      title: "Stable",
      text: "This is the original text body that should not change between runs.",
    });
    const connector = new FakeConnector([doc]);

    const first = await runOneIngestion(db, sourceId, connector);
    const firstChunkCount = await countChunks(db);
    const firstChunks = await getChunksForExternalId(db, sourceId, "stable");
    expect(first.chunksCreated).toBe(firstChunkCount);
    expect(firstChunkCount).toBeGreaterThan(0);

    connector.reset([doc]); // re-emit the same doc
    const second = await runOneIngestion(db, sourceId, connector);

    // Pipeline must short-circuit: documentsProcessed counts ATTEMPTS, so it
    // is 1 — but chunksCreated MUST be 0 because the upsert detected the
    // unchanged content_hash.
    expect(second.documentsProcessed).toBe(1);
    expect(second.chunksCreated).toBe(0);
    expect(await countChunks(db)).toBe(firstChunkCount);

    const secondChunks = await getChunksForExternalId(db, sourceId, "stable");
    expect(secondChunks.map((c) => c.hash)).toEqual(
      firstChunks.map((c) => c.hash),
    );
    expect(secondChunks.map((c) => c.id)).toEqual(firstChunks.map((c) => c.id));
  });

  it("ingesting changed content replaces all chunks for that document", async () => {
    const sourceId = await createCustomSource(db, "updates");
    const v1 = plainTextDoc({
      externalId: "evolving",
      title: "Evolving",
      text: "Version one of the document. Mentions apples and bananas.",
    });
    const v2 = plainTextDoc({
      externalId: "evolving",
      title: "Evolving",
      text: "Version two of the document. Mentions oranges and grapes.",
    });
    const connector = new FakeConnector([v1]);

    await runOneIngestion(db, sourceId, connector);
    const beforeChunks = await getChunksForExternalId(db, sourceId, "evolving");
    expect(beforeChunks.some((c) => c.text.includes("apples"))).toBe(true);

    connector.reset([v2]);
    const result = await runOneIngestion(db, sourceId, connector);
    expect(result.chunksCreated).toBeGreaterThan(0);

    const afterChunks = await getChunksForExternalId(db, sourceId, "evolving");
    expect(afterChunks.some((c) => c.text.includes("oranges"))).toBe(true);
    // No "apples" chunk survives — replaceChunks deleted the old row set.
    expect(afterChunks.some((c) => c.text.includes("apples"))).toBe(false);

    // Document count stays at 1 (same externalId → upsert, not insert).
    expect(await countDocuments(db)).toBe(1);
    // Chunk hashes are different from v1.
    const beforeHashes = new Set(beforeChunks.map((c) => c.hash));
    expect(afterChunks.every((c) => !beforeHashes.has(c.hash))).toBe(true);
  });
});
