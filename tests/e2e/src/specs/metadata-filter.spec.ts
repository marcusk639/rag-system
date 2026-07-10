import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SCOPE } from "@rag/core";
import { Retriever } from "@rag/rag";
import { FakeConnector, FakeEmbedder, plainTextDoc } from "@rag/test-fixtures";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { runOneIngestion } from "../helpers/ingestion.js";
import type { Db } from "@rag/db";

/**
 * `hybridSearch`'s `metadataFilter` previously had zero test coverage
 * anywhere in the repo (H2, docs/ISSUES-AND-OPTIMIZATIONS.md) — the query
 * shape was changed from `metadata->>'key' IN (...)` to `metadata @>
 * jsonb_build_object(...)` so the existing `documents_metadata_gin_idx` GIN
 * index actually accelerates it (verified separately via EXPLAIN ANALYZE;
 * not re-verified here since these specs don't assert query plans). This
 * file locks in the observable behavior across the query rewrite: string
 * values, multi-value (OR) filtering, multiple keys (AND), no match, and the
 * numeric-metadata edge case (`@>` is type-sensitive — `{"k":"5"}` doesn't
 * contain `{"k":5}` — the fix also tries the filter value as a JSON number).
 */
describe("E2E: hybridSearch metadataFilter", () => {
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
    sourceId = await createCustomSource(db, "metadata-filter");
    retriever = new Retriever(db, new FakeEmbedder(), {
      topK: 10,
      denseWeight: 0.7,
      sparseWeight: 0.3,
    });
  });

  it("matches a single string metadata value", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "sop-1",
        title: "SOP Doc",
        text: "Onboarding checklist for new hires covers badge access and payroll setup.",
        metadata: { contentType: "sop" },
      }),
      plainTextDoc({
        externalId: "note-1",
        title: "Onboarding Notes",
        text: "Onboarding checklist for new hires covers badge access and payroll setup.",
        metadata: { contentType: "research_note" },
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);

    const results = await retriever.search(
      {
        query: "onboarding checklist",
        topK: 10,
        filter: { contentType: "sop" },
      },
      ADMIN_SCOPE,
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.document.title).toBe("SOP Doc");
    }
  });

  it("matches any value in a multi-value (array) filter — OR semantics", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "sop-1",
        title: "SOP Doc",
        text: "Quarterly review process for client engagements and deliverables.",
        metadata: { contentType: "sop" },
      }),
      plainTextDoc({
        externalId: "template-1",
        title: "Template Doc",
        text: "Quarterly review process for client engagements and deliverables.",
        metadata: { contentType: "template" },
      }),
      plainTextDoc({
        externalId: "example-1",
        title: "Example Doc",
        text: "Quarterly review process for client engagements and deliverables.",
        metadata: { contentType: "example" },
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);

    const results = await retriever.search(
      {
        query: "quarterly review process",
        topK: 10,
        filter: { contentType: ["sop", "template"] },
      },
      ADMIN_SCOPE,
    );

    const titles = new Set(results.map((r) => r.document.title));
    expect(titles.has("SOP Doc")).toBe(true);
    expect(titles.has("Template Doc")).toBe(true);
    expect(titles.has("Example Doc")).toBe(false);
  });

  it("ANDs multiple filter keys together", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "match",
        title: "Matching Doc",
        text: "Annual budget planning workshop notes and action items.",
        metadata: { contentType: "sop", ownerId: "chris" },
      }),
      plainTextDoc({
        externalId: "wrong-owner",
        title: "Wrong Owner Doc",
        text: "Annual budget planning workshop notes and action items.",
        metadata: { contentType: "sop", ownerId: "doug" },
      }),
      plainTextDoc({
        externalId: "wrong-type",
        title: "Wrong Type Doc",
        text: "Annual budget planning workshop notes and action items.",
        metadata: { contentType: "template", ownerId: "chris" },
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);

    const results = await retriever.search(
      {
        query: "annual budget planning",
        topK: 10,
        filter: { contentType: "sop", ownerId: "chris" },
      },
      ADMIN_SCOPE,
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.document.title).toBe("Matching Doc");
    }
  });

  it("returns nothing when the filter matches no document", async () => {
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "doc-1",
        title: "Doc A",
        text: "Client engagement letter template for new tax clients.",
        metadata: { contentType: "template" },
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);

    const results = await retriever.search(
      {
        query: "client engagement letter",
        topK: 10,
        filter: { contentType: "example" },
      },
      ADMIN_SCOPE,
    );

    expect(results).toEqual([]);
  });

  it("matches a numeric metadata value against a string filter value", async () => {
    // DocumentMetadata.sizeBytes is typed as a JSON number. The filter API
    // (packages/core/src/validation.ts) only ever sends strings, and `@>`
    // containment is type-sensitive, so this exercises the fix's numeric
    // fallback (metadata @> {"k": <value>::numeric}) rather than relying on
    // `->>`'s old implicit text coercion.
    const connector = new FakeConnector([
      plainTextDoc({
        externalId: "sized",
        title: "Sized Doc",
        text: "Vendor contract renewal terms and pricing schedule for next year.",
        metadata: { sizeBytes: 12345 },
      }),
      plainTextDoc({
        externalId: "other-size",
        title: "Other Size Doc",
        text: "Vendor contract renewal terms and pricing schedule for next year.",
        metadata: { sizeBytes: 999 },
      }),
    ]);
    await runOneIngestion(db, sourceId, connector);

    const results = await retriever.search(
      {
        query: "vendor contract renewal",
        topK: 10,
        filter: { sizeBytes: "12345" },
      },
      ADMIN_SCOPE,
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.document.title).toBe("Sized Doc");
    }
  });
});
