import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@rag/core";
import { ADMIN_SCOPE } from "@rag/core";
import { askQuestion, expandWithNeighbors } from "./ask.js";
import type { ServiceDeps } from "./deps.js";

const { getChunksByOrdinalsMock } = vi.hoisted(() => ({
  getChunksByOrdinalsMock: vi.fn(),
}));
vi.mock("@rag/db", () => ({ getChunksByOrdinals: getChunksByOrdinalsMock }));

function hit(docId: string, ordinal: number, score = 0.9): RetrievalResult {
  return {
    text: `${docId}#${ordinal}`,
    score,
    denseScore: score,
    sparseScore: 0,
    document: {
      id: docId,
      title: `Doc ${docId}`,
      sourceId: "src",
      sourceKind: "sharepoint",
      metadata: {},
    },
    chunk: { id: `${docId}-${ordinal}`, ordinal, headingPath: ["S"] },
  } as RetrievalResult;
}

function row(docId: string, ordinal: number) {
  return {
    id: `${docId}-${ordinal}`,
    documentId: docId,
    ordinal,
    text: `${docId}#${ordinal}`,
    headingPath: ["S"],
    page: null,
  };
}

function deps(): ServiceDeps {
  return {
    db: {} as ServiceDeps["db"],
    queue: {} as ServiceDeps["queue"],
    retriever: { search: vi.fn() } as unknown as ServiceDeps["retriever"],
    generator: null,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("expandWithNeighbors", () => {
  it("fetches the chunks either side of, and between, the retrieved chunks of the top documents", async () => {
    getChunksByOrdinalsMock.mockImplementation(
      async (_db: unknown, docId: string, ordinals: number[]) =>
        ordinals.map((o) => row(docId, o)),
    );
    const results = [hit("A", 2), hit("A", 5), hit("B", 0), hit("C", 7)];

    const out = await expandWithNeighbors(deps(), results, {
      documents: 2,
      chunksPerDocument: 4,
    });

    // A: neighbours 1,3 and 4,6 (gap 3–4 filled); B: 1. C is not a top document.
    expect(getChunksByOrdinalsMock).toHaveBeenCalledTimes(2);
    const aOrdinals = getChunksByOrdinalsMock.mock.calls[0]?.[2] as number[];
    expect([...aOrdinals].sort((x, y) => x - y)).toEqual([1, 3, 4, 6]);
    expect(getChunksByOrdinalsMock.mock.calls[1]?.[2]).toEqual([1]);
    // Originals keep their position and are not duplicated.
    expect(out.slice(0, 4)).toEqual(results);
    expect(out.map((r) => r.chunk.id)).toContain("A-3");
    expect(new Set(out.map((r) => r.chunk.id)).size).toBe(out.length);
  });

  it("prefers the nearest neighbours when the per-document budget is small", async () => {
    getChunksByOrdinalsMock.mockImplementation(
      async (_db: unknown, docId: string, ordinals: number[]) =>
        ordinals.map((o) => row(docId, o)),
    );
    await expandWithNeighbors(deps(), [hit("A", 3), hit("A", 6)], {
      documents: 1,
      chunksPerDocument: 2,
    });
    const asked = getChunksByOrdinalsMock.mock.calls[0]?.[2] as number[];
    expect(asked).toHaveLength(2);
    // Distance-1 neighbours of 3 come before anything further away.
    expect(asked).toEqual([2, 4]);
  });

  it("marks expanded chunks with zero scores and the owning document's metadata", async () => {
    getChunksByOrdinalsMock.mockResolvedValue([row("A", 1)]);
    const out = await expandWithNeighbors(deps(), [hit("A", 0)], {
      documents: 1,
      chunksPerDocument: 1,
    });
    const added = out.find((r) => r.chunk.id === "A-1");
    expect(added?.document).toBe(out[0]?.document);
    expect(added?.score).toBe(0);
    expect(added?.denseScore).toBe(0);
  });

  it("returns the original results unchanged when expansion is disabled", async () => {
    const results = [hit("A", 2)];
    const out = await expandWithNeighbors(deps(), results, {
      documents: 0,
      chunksPerDocument: 4,
    });
    expect(out).toBe(results);
    expect(getChunksByOrdinalsMock).not.toHaveBeenCalled();
  });

  it("degrades to the original results (logging) when the neighbour fetch fails", async () => {
    getChunksByOrdinalsMock.mockRejectedValue(new Error("db down"));
    const d = deps();
    const results = [hit("A", 2)];
    const out = await expandWithNeighbors(d, results, {
      documents: 1,
      chunksPerDocument: 2,
    });
    expect(out).toEqual(results);
    expect(d.logger.warn).toHaveBeenCalled();
  });
});

describe("askQuestion with neighbour expansion", () => {
  it("hands the generator the expanded context", async () => {
    getChunksByOrdinalsMock.mockResolvedValue([row("A", 1)]);
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "a [1]", citations: [] });
    const d = {
      ...deps(),
      retriever: {
        search: vi.fn().mockResolvedValue([hit("A", 0)]),
      } as unknown as ServiceDeps["retriever"],
      generator: { answer } as unknown as ServiceDeps["generator"],
    };

    const result = await askQuestion(d, { question: "q" }, 8, ADMIN_SCOPE, 0, {
      documents: 1,
      chunksPerDocument: 1,
    });

    const context = answer.mock.calls[0]?.[1] as RetrievalResult[];
    expect(context.map((r) => r.chunk.id)).toEqual(["A-0", "A-1"]);
    expect(result.citations[0]?.chunkIds).toEqual(["A-0", "A-1"]);
  });
});
