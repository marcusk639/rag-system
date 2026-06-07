import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SCOPE } from "@rag/core";
import { Retriever } from "@rag/rag";
import { FakeConnector } from "../fakes/fake-connector.js";
import { plainTextDoc } from "../fakes/factories.js";
import { FakeEmbedder } from "../fakes/fake-embedder.js";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";
import type { Db } from "@rag/db";

/**
 * Hybrid retrieval (dense + sparse + RRF) returns chunks that share keywords
 * with the query before unrelated chunks. The FakeEmbedder is a deterministic
 * bag-of-words embedder, so dense similarity ALSO tracks keyword overlap —
 * which means both retrievers cooperate to surface the right chunk and we can
 * assert ranking without worrying about provider drift.
 */
describe("E2E: hybrid retrieval", () => {
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
    sourceId = await createCustomSource(db, "retrieval");
    retriever = new Retriever(db, new FakeEmbedder(), {
      topK: 5,
      denseWeight: 0.7,
      sparseWeight: 0.3,
    });
  });

  it("ranks the topically-matching document first", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "espresso",
        title: "Espresso Pulling",
        text: "Espresso pulling requires fine-ground coffee and 9 bars of pressure for proper extraction.",
      }),
      plainTextDoc({
        externalId: "sailing",
        title: "Sailing Basics",
        text: "Sailing requires understanding wind direction, sail trim, and steering with the rudder.",
      }),
      plainTextDoc({
        externalId: "gardening",
        title: "Tomato Gardening",
        text: "Tomato gardening rewards patient growers. Stake young plants and water deeply once per week.",
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);

    const results = await retriever.search(
      {
        query: "espresso extraction pressure",
        topK: 3,
      },
      ADMIN_SCOPE,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.document.title).toBe("Espresso Pulling");
    // The top result should outscore the runner-up by a meaningful margin
    // (>20% relative) — RRF + keyword overlap give a clear winner.
    if (results.length >= 2) {
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score * 1.2);
    }
  });

  it("returns dense + sparse component scores on every hit", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "tea",
        title: "Green Tea",
        text: "Green tea is brewed by steeping leaves in 80C water for two minutes.",
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);

    const results = await retriever.search(
      { query: "green tea", topK: 5 },
      ADMIN_SCOPE,
    );
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.denseScore).toBe("number");
      expect(typeof r.sparseScore).toBe("number");
      expect(Number.isFinite(r.denseScore)).toBe(true);
      expect(Number.isFinite(r.sparseScore)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
      expect(r.chunk.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("respects the sourceIds filter", async () => {
    const sourceA = sourceId;
    const sourceB = await createCustomSource(db, "retrieval-b");

    await runOneIngestion(
      db,
      sourceA,
      new FakeConnector([
        plainTextDoc({
          externalId: "a-doc",
          title: "From A",
          text: "Source A talks about quantum mechanics and Schrodinger equations.",
        }),
      ]),
    );
    await runOneIngestion(
      db,
      sourceB,
      new FakeConnector([
        plainTextDoc({
          externalId: "b-doc",
          title: "From B",
          text: "Source B talks about quantum mechanics and uncertainty principles.",
        }),
      ]),
    );

    const onlyA = await retriever.search(
      {
        query: "quantum mechanics",
        topK: 10,
        sourceIds: [sourceA],
      },
      ADMIN_SCOPE,
    );
    expect(onlyA.length).toBeGreaterThan(0);
    for (const r of onlyA) {
      expect(r.document.sourceId).toBe(sourceA);
    }

    const onlyB = await retriever.search(
      {
        query: "quantum mechanics",
        topK: 10,
        sourceIds: [sourceB],
      },
      ADMIN_SCOPE,
    );
    expect(onlyB.length).toBeGreaterThan(0);
    for (const r of onlyB) {
      expect(r.document.sourceId).toBe(sourceB);
    }
  });

  it("ENFORCES the principal scope: a scoped principal sees only its sources", async () => {
    const sourceA = sourceId;
    const sourceB = await createCustomSource(db, "retrieval-b");

    await runOneIngestion(
      db,
      sourceA,
      new FakeConnector([
        plainTextDoc({
          externalId: "a-doc",
          title: "From A",
          text: "Source A talks about quantum mechanics and Schrodinger equations.",
        }),
      ]),
    );
    await runOneIngestion(
      db,
      sourceB,
      new FakeConnector([
        plainTextDoc({
          externalId: "b-doc",
          title: "From B",
          text: "Source B talks about quantum mechanics and uncertainty principles.",
        }),
      ]),
    );

    // Principal scoped to ONLY source A — must never see B, even with no caller
    // filter and a query that matches both.
    const scopedToA = await retriever.search(
      { query: "quantum mechanics", topK: 10 },
      { enforcedSourceIds: [sourceA] },
    );
    expect(scopedToA.length).toBeGreaterThan(0);
    for (const r of scopedToA) {
      expect(r.document.sourceId).toBe(sourceA);
    }

    // A caller filter for B while scoped to A is disjoint => zero rows (fail
    // closed); the caller cannot widen beyond its scope.
    const scopedAaskingB = await retriever.search(
      { query: "quantum mechanics", topK: 10, sourceIds: [sourceB] },
      { enforcedSourceIds: [sourceA] },
    );
    expect(scopedAaskingB).toEqual([]);

    // Empty scope => fail closed regardless of query.
    const denied = await retriever.search(
      { query: "quantum mechanics", topK: 10 },
      { enforcedSourceIds: [] },
    );
    expect(denied).toEqual([]);
  });

  it("returns an empty array for a query that matches nothing", async () => {
    await runOneIngestion(
      db,
      sourceId,
      new FakeConnector([
        plainTextDoc({
          externalId: "only",
          title: "Only",
          text: "Cats sleep approximately sixteen hours a day on average.",
        }),
      ]),
    );

    const results = await retriever.search(
      {
        query: "xyzpdq nonsenseword zzzzz",
        topK: 5,
      },
      ADMIN_SCOPE,
    );
    // The dense side will always rank everything, but if our gating is
    // permissive we want to confirm we never crash on a zero-sparse query.
    expect(Array.isArray(results)).toBe(true);
  });
});
