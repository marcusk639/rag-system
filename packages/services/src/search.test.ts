import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE, ComplianceError } from "@rag/core";
import { searchDocuments } from "./search.js";
import type { ServiceDeps } from "./deps.js";

function deps(generator: unknown, search = vi.fn().mockResolvedValue([])) {
  return {
    deps: {
      db: {},
      queue: {},
      retriever: { search },
      generator,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    } as unknown as ServiceDeps,
    search,
  };
}

describe("searchDocuments TRI screening", () => {
  it("screens the query with the configured generator's policy before it is embedded", async () => {
    const screen = vi.fn(() => {
      throw new ComplianceError("TRI in query");
    });
    const { deps: d, search } = deps({ screen });
    await expect(
      searchDocuments(d, { query: "SSN 123-45-6789" }, 8, ADMIN_SCOPE),
    ).rejects.toBeInstanceOf(ComplianceError);
    expect(screen).toHaveBeenCalledWith("SSN 123-45-6789", []);
    expect(search).not.toHaveBeenCalled();
  });

  it("searches normally when the query passes screening", async () => {
    const { deps: d, search } = deps({ screen: vi.fn((_q, ctx) => ctx) });
    await searchDocuments(d, { query: "engagement letter" }, 8, ADMIN_SCOPE);
    expect(search).toHaveBeenCalled();
  });

  it("still searches in a deployment with no generator (no policy to apply)", async () => {
    const { deps: d, search } = deps(null);
    await searchDocuments(d, { query: "engagement letter" }, 8, ADMIN_SCOPE);
    expect(search).toHaveBeenCalled();
  });
});

function hit(id: string, documentId: string, text: string) {
  return {
    text,
    score: 1,
    denseScore: 0.8,
    sparseScore: 0,
    document: {
      id: documentId,
      title: `doc ${documentId}`,
      sourceId: "00000000-0000-0000-0000-000000000001",
      sourceKind: "sharepoint",
      hasOriginal: false,
      metadata: {},
    },
    chunk: { id, ordinal: 0, headingPath: [] },
  };
}

describe("searchDocuments duplicate collapse", () => {
  it("returns one copy of a passage indexed in several files and backfills to topK", async () => {
    const search = vi
      .fn()
      .mockResolvedValue([
        hit("c1", "d1", "# Copy A › Setup\nStep 1: open the client file."),
        hit("c2", "d2", "# Copy B › Setup\nStep 1: open the client file."),
        hit("c3", "d3", "# Other › Payroll\nRun payroll on Friday."),
      ]);
    const { deps: d } = deps(null, search);

    const results = await searchDocuments(
      d,
      { query: "client setup", topK: 2 },
      8,
      ADMIN_SCOPE,
    );

    expect(results.map((r) => r.chunk.id)).toEqual(["c1", "c3"]);
    // Over-fetched so the collapsed slot can be backfilled.
    expect(search.mock.calls[0]![0].topK).toBeGreaterThan(2);
  });
});
