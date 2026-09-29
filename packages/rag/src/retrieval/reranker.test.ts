import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComplianceError,
  EgressError,
  EgressPolicy,
  ValidationError,
  type RetrievalResult,
} from "@rag/core";
import { HttpCrossEncoderReranker, createReranker } from "./reranker.js";

/**
 * Allow-list covering the fake endpoint the suite reranks against. Passed
 * explicitly rather than relying on `EgressPolicy.fromEnv()`, which reads
 * `EGRESS_ALLOWED_HOSTS` and would make these tests depend on the runner's
 * environment.
 */
const ALLOW_TEST_HOST = () => new EgressPolicy(["example.test"]);

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
      egressPolicy: ALLOW_TEST_HOST(),
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

/**
 * The reranker ships firm document text to a third-party vendor, so it must sit
 * behind the SAME `EgressPolicy` allow-list that governs embeddings, generation,
 * and audit-log shipping. Before this suite existed it was the only outbound
 * path in the system with no egress control at all — enabling
 * `RERANK_PROVIDER=cohere` would have sent SOP chunk text to Cohere without the
 * allow-list check that exists so no provider call happens without a DPA
 * decision.
 */
describe("HttpCrossEncoderReranker — egress boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  function withPolicy(hosts: string[]) {
    return new HttpCrossEncoderReranker({
      name: "cohere",
      endpoint: "https://example.test/rerank",
      model: "rerank-v3.5",
      apiKey: "secret",
      egressPolicy: new EgressPolicy(hosts),
    });
  }

  it("refuses a host that is not allow-listed, and never reaches fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(withPolicy([]).rerank("q", [rr("a")], 1)).rejects.toThrow(
      EgressError,
    );
    // The assertion that matters: the refusal happens BEFORE the network call,
    // so no document text leaves the process.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proceeds when the endpoint host is allow-listed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 0 }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await withPolicy(["example.test"]).rerank("q", [rr("a")], 1);
    expect(out.map((r) => r.document.id)).toEqual(["doc-a"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("short-circuits empty candidates BEFORE the egress check", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Deny-all policy, but zero candidates means zero network calls. Throwing
    // here would fail a query that was never going to leave the process — the
    // ordering of the two guards is load-bearing, not incidental.
    expect(await withPolicy([]).rerank("q", [], 5)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createReranker threads the injected policy into the built reranker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Proves the runtime's `egressPolicy` actually reaches the instance rather
    // than the instance silently falling back to `EgressPolicy.fromEnv()`.
    const built = createReranker(cfg({ provider: "cohere", apiKey: "k" }), {
      egressPolicy: new EgressPolicy([]),
    });
    await expect(built!.rerank("q", [rr("a")], 1)).rejects.toThrow(EgressError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("rerank wire contract, score, and compliance (plan tasks A2-A4)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(
    results: Array<{ index: number; relevance_score: number }>,
  ) {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const reranker = (name: "cohere" | "jina") =>
    createReranker(cfg({ provider: name, apiKey: "k" }), {
      egressPolicy: new EgressPolicy(["api.cohere.com", "api.jina.ai"]),
    })!;

  it("pins the exact request body per provider; Jina must not echo documents back", async () => {
    const fetchMock = stubFetch([{ index: 0, relevance_score: 0.9 }]);
    await reranker("cohere").rerank("q", [rr("a")], 1);
    await reranker("jina").rerank("q", [rr("a")], 1);
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse(String((c as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies[0]).toEqual({
      model: "rerank-v3.5",
      query: "q",
      documents: ["text-a"],
      top_n: 1,
    });
    expect(bodies[1]).toEqual({
      model: "jina-reranker-v2-base-multilingual",
      query: "q",
      documents: ["text-a"],
      top_n: 1,
      return_documents: false,
    });
  });

  it("carries the provider's relevance score as rerankScore, leaving the RRF score untouched", async () => {
    stubFetch([
      { index: 1, relevance_score: 0.93 },
      { index: 0, relevance_score: 0.41 },
    ]);
    const out = await reranker("cohere").rerank("q", [rr("a"), rr("b")], 2);
    expect(out.map((r) => [r.chunk.id, r.rerankScore, r.score])).toEqual([
      ["c-b", 0.93, 1],
      ["c-a", 0.41, 1],
    ]);
  });

  it("refuses a hosted reranker under COMPLIANCE_MODE=client-data", () => {
    expect(() =>
      createReranker(cfg({ provider: "cohere", apiKey: "k" }), {
        complianceMode: "client-data",
      }),
    ).toThrow(ComplianceError);
    expect(
      createReranker(cfg({ provider: "none" }), {
        complianceMode: "client-data",
      }),
    ).toBeNull();
  });
});
