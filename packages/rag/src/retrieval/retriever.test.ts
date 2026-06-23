import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE, type Reranker, type RetrievalResult } from "@rag/core";
import { FakeEmbedder } from "@rag/test-fixtures";

const { hybridSearch } = vi.hoisted(() => ({ hybridSearch: vi.fn() }));
vi.mock("@rag/db", () => ({ hybridSearch }));

import { Retriever } from "./retriever.js";

const DEFAULTS = { topK: 4, denseWeight: 0.7, sparseWeight: 0.3 };

function rr(id: string): RetrievalResult {
  return {
    text: `text-${id}`,
    score: 1,
    denseScore: 1,
    sparseScore: 0,
    document: { id: `doc-${id}`, title: id, sourceId: "s", metadata: {} },
    chunk: { id: `c-${id}`, ordinal: 0, headingPath: [] },
  } as unknown as RetrievalResult;
}

describe("Retriever.search", () => {
  it("without a reranker, fetches exactly topK and returns hybrid results unchanged", async () => {
    const results = [rr("1"), rr("2")];
    hybridSearch.mockResolvedValue(results);

    const retriever = new Retriever({} as never, new FakeEmbedder(), DEFAULTS);
    const out = await retriever.search({ query: "q", topK: 4 }, ADMIN_SCOPE);

    expect(out).toBe(results);
    expect(hybridSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ topK: 4 }),
    );
  });

  it("with a reranker, over-fetches the pool and returns the reranked top-k", async () => {
    const pool = [rr("1"), rr("2"), rr("3"), rr("4"), rr("5"), rr("6")];
    hybridSearch.mockResolvedValue(pool);

    const rerank = vi
      .fn()
      .mockImplementation(
        async (_q: string, cands: RetrievalResult[], topK: number) =>
          [...cands].reverse().slice(0, topK),
      );
    const reranker: Reranker = { name: "fake", rerank };

    const retriever = new Retriever({} as never, new FakeEmbedder(), DEFAULTS, {
      reranker,
      poolMultiplier: 3,
    });
    const out = await retriever.search({ query: "q", topK: 2 }, ADMIN_SCOPE);

    // Over-fetch: topK(2) × poolMultiplier(3) = 6 candidates pulled.
    expect(hybridSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ topK: 6 }),
    );
    expect(rerank).toHaveBeenCalledWith("q", pool, 2);
    expect(out.map((r) => r.document.id)).toEqual(["doc-6", "doc-5"]);
  });

  it("falls back to RRF order (truncated) and reports the error when the reranker throws", async () => {
    const pool = [rr("1"), rr("2"), rr("3"), rr("4")];
    hybridSearch.mockResolvedValue(pool);

    const onError = vi.fn();
    const reranker: Reranker = {
      name: "boom",
      rerank: vi.fn().mockRejectedValue(new Error("rerank down")),
    };

    const retriever = new Retriever({} as never, new FakeEmbedder(), DEFAULTS, {
      reranker,
      poolMultiplier: 2,
      onError,
    });
    const out = await retriever.search({ query: "q", topK: 2 }, ADMIN_SCOPE);

    expect(out.map((r) => r.document.id)).toEqual(["doc-1", "doc-2"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
