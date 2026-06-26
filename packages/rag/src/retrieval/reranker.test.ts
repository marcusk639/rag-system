import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError, type RetrievalResult } from "@rag/core";
import { HttpCrossEncoderReranker, createReranker } from "./reranker.js";

type RerankCfg = Parameters<typeof createReranker>[0];

function cfg(overrides: Partial<RerankCfg>): RerankCfg {
  return { provider: "none", poolMultiplier: 5, ...overrides } as RerankCfg;
}

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

describe("createReranker", () => {
  it("returns null when disabled (provider=none)", () => {
    expect(createReranker(cfg({ provider: "none" }))).toBeNull();
  });

  it("throws when a hosted provider has no API key", () => {
    expect(() => createReranker(cfg({ provider: "cohere" }))).toThrow(
      ValidationError,
    );
    expect(() => createReranker(cfg({ provider: "jina" }))).toThrow(
      ValidationError,
    );
  });

  it("builds cohere/jina rerankers when an API key is present", () => {
    expect(createReranker(cfg({ provider: "cohere", apiKey: "k" }))?.name).toBe(
      "cohere",
    );
    expect(createReranker(cfg({ provider: "jina", apiKey: "k" }))?.name).toBe(
      "jina",
    );
  });

  it("throws for the not-yet-implemented llm provider", () => {
    expect(() => createReranker(cfg({ provider: "llm" }))).toThrow(
      ValidationError,
    );
  });
});

describe("HttpCrossEncoderReranker", () => {
  afterEach(() => vi.unstubAllGlobals());

  function reranker() {
    return new HttpCrossEncoderReranker({
      name: "cohere",
      endpoint: "https://example.test/rerank",
      model: "rerank-v3.5",
      apiKey: "secret",
    });
  }

  it("re-orders candidates by the provider's returned indices and truncates to topK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ index: 2 }, { index: 0 }, { index: 1 }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const candidates = [rr("a"), rr("b"), rr("c")];
    const out = await reranker().rerank("q", candidates, 2);

    expect(out.map((r) => r.document.id)).toEqual(["doc-c", "doc-a"]);
    // It sent only the chunk text + a top_n bounded by candidate count.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.documents).toEqual(["text-a", "text-b", "text-c"]);
    expect(body.top_n).toBe(2);
  });

  it("short-circuits on empty candidates without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await reranker().rerank("q", [], 5)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-ok response (caller degrades to RRF)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      }),
    );
    await expect(reranker().rerank("q", [rr("a")], 1)).rejects.toThrow(
      /cohere rerank failed: 429/,
    );
  });
});
