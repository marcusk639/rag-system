import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError } from "@rag/core";

// BGE query prefix — must match the constant in local.ts exactly.
const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

// vi.hoisted() ensures these are available inside vi.mock() factories, which
// are hoisted to the top of the module graph by vitest before any imports run.
const { mockPipeFn, mockPipelineFactory, mockHFEnv } = vi.hoisted(() => {
  const mockPipeFn = vi.fn();
  const mockHFEnv: Record<string, string | undefined> = {};
  const mockPipelineFactory = vi.fn().mockResolvedValue(mockPipeFn);
  return { mockPipeFn, mockPipelineFactory, mockHFEnv };
});

// Intercept the dynamic import("@huggingface/transformers") inside _loadPipeline.
vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
  env: mockHFEnv,
}));

import { LocalEmbeddingProvider } from "./local.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns a minimal HFTensor-like object with `batchSize × dims` layout. */
function makeTensor(
  batchSize: number,
  dims: number,
): { dims: number[]; data: Float32Array } {
  return {
    dims: [batchSize, dims],
    data: new Float32Array(batchSize * dims).fill(0.1),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("LocalEmbeddingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pipeline factory resolves with a mock pipe that returns valid
    // 768-d tensors matching the default configured dimensions.
    mockPipelineFactory.mockResolvedValue(mockPipeFn);
    mockPipeFn.mockImplementation((inputs: string | string[]) => {
      const texts = Array.isArray(inputs) ? inputs : [inputs];
      return Promise.resolve(makeTensor(texts.length, 768));
    });
  });

  afterEach(() => {
    // Clean up env side-effects between tests
    delete mockHFEnv["cacheDir"];
    delete process.env["HF_CACHE_DIR"];
  });

  // ── Construction ──────────────────────────────────────────────────────────────

  it("does not load the pipeline at construction time — no network call on init", () => {
    new LocalEmbeddingProvider();
    expect(mockPipelineFactory).not.toHaveBeenCalled();
  });

  it("uses Xenova/bge-base-en-v1.5 and 768 dimensions by default", () => {
    const p = new LocalEmbeddingProvider();
    expect(p.name).toBe("local");
    expect(p.model).toBe("Xenova/bge-base-en-v1.5");
    expect(p.dimensions).toBe(768);
  });

  it("accepts custom model and dimensions overrides", () => {
    const p = new LocalEmbeddingProvider({
      model: "custom/model",
      dimensions: 512,
    });
    expect(p.model).toBe("custom/model");
    expect(p.dimensions).toBe(512);
  });

  // ── embed() ───────────────────────────────────────────────────────────────────

  describe("embed()", () => {
    it("returns a single 768-d vector with correct metadata", async () => {
      const p = new LocalEmbeddingProvider();
      const result = await p.embed("annual recurring revenue");
      expect(result.vector).toHaveLength(768);
      expect(result.provider).toBe("local");
      expect(result.model).toBe("Xenova/bge-base-en-v1.5");
      expect(result.dimensions).toBe(768);
    });
  });

  // ── embedBatch() ──────────────────────────────────────────────────────────────

  describe("embedBatch()", () => {
    it("returns one vector per input", async () => {
      const p = new LocalEmbeddingProvider();
      const results = await p.embedBatch(["alpha", "beta", "gamma"]);
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.vector).toHaveLength(768);
      }
    });

    it("preserves input order — each vector encodes its source position", async () => {
      mockPipeFn.mockImplementationOnce((inputs: string[]) => {
        const data = new Float32Array(inputs.length * 768);
        // Encode position in the first element so we can assert ordering
        for (let i = 0; i < inputs.length; i++) data[i * 768] = i + 1;
        return Promise.resolve({ dims: [inputs.length, 768], data });
      });

      const p = new LocalEmbeddingProvider();
      const results = await p.embedBatch(["first", "second", "third"]);
      expect(results[0]!.vector[0]).toBe(1);
      expect(results[1]!.vector[0]).toBe(2);
      expect(results[2]!.vector[0]).toBe(3);
    });

    it("returns an empty array without invoking the pipeline", async () => {
      const p = new LocalEmbeddingProvider();
      await expect(p.embedBatch([])).resolves.toEqual([]);
      expect(mockPipeFn).not.toHaveBeenCalled();
    });

    it("makes no HTTP calls — all inference is handled in-process (no egress)", async () => {
      // Spy on globalThis.fetch: if anything tries to hit the network, the test
      // fails here rather than hanging on a real HTTP request.
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(
          new Error("fetch must not be called during local embedding"),
        );

      try {
        const p = new LocalEmbeddingProvider();
        const results = await p.embedBatch(["client confidential SOP"]);
        expect(results).toHaveLength(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  // ── embedQuery() ──────────────────────────────────────────────────────────────

  describe("embedQuery()", () => {
    it("prepends the BGE query instruction prefix before embedding", async () => {
      const captured: string[] = [];
      mockPipeFn.mockImplementation((inputs: string | string[]) => {
        const texts = Array.isArray(inputs) ? inputs : [inputs];
        captured.push(...texts);
        return Promise.resolve(makeTensor(texts.length, 768));
      });

      const p = new LocalEmbeddingProvider();
      await p.embedQuery("what is the depreciation schedule for Section 179?");

      expect(captured[0]).toBe(
        `${BGE_QUERY_PREFIX}what is the depreciation schedule for Section 179?`,
      );
    });

    it("returns a 768-d vector", async () => {
      const p = new LocalEmbeddingProvider();
      const result = await p.embedQuery("query text");
      expect(result.vector).toHaveLength(768);
    });
  });

  // ── Shape mismatches ──────────────────────────────────────────────────────────

  describe("shape mismatches", () => {
    it("throws EmbeddingError when model output dims differ from configured dimensions", async () => {
      // Model outputs 512-d but provider is configured for 768-d
      mockPipeFn.mockResolvedValue(makeTensor(1, 512));
      const p = new LocalEmbeddingProvider({ dimensions: 768 });
      await expect(p.embed("text")).rejects.toThrow(EmbeddingError);
      await expect(p.embed("text")).rejects.toThrow(/512.*768|768.*512/);
    });

    it("throws EmbeddingError when batch output size differs from input count", async () => {
      // Model returns 2 vectors for 3 inputs
      mockPipeFn.mockResolvedValue(makeTensor(2, 768));
      const p = new LocalEmbeddingProvider();
      await expect(p.embedBatch(["a", "b", "c"])).rejects.toThrow(
        EmbeddingError,
      );
    });
  });

  // ── Pipeline lifecycle ────────────────────────────────────────────────────────

  describe("pipeline lifecycle", () => {
    it("loads the pipeline exactly once for concurrent embed calls", async () => {
      const p = new LocalEmbeddingProvider();
      // Fire 3 concurrent embeds — only one pipeline load must occur
      await Promise.all([p.embed("doc1"), p.embed("doc2"), p.embed("doc3")]);
      expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    });

    it("resets the pipeline promise after a load failure so the caller can retry", async () => {
      mockPipelineFactory
        .mockRejectedValueOnce(new Error("transient download error"))
        .mockResolvedValue(mockPipeFn);

      const p = new LocalEmbeddingProvider();
      // First attempt — load fails
      await expect(p.embed("test")).rejects.toThrow(EmbeddingError);
      // Second attempt — retry succeeds (promise was reset after the failure)
      await expect(p.embed("test")).resolves.toBeDefined();
      expect(mockPipelineFactory).toHaveBeenCalledTimes(2);
    });

    it("sets env.cacheDir from HF_CACHE_DIR environment variable", async () => {
      process.env["HF_CACHE_DIR"] = "/opt/models/hf";
      const p = new LocalEmbeddingProvider();
      await p.embed("warmup");
      expect(mockHFEnv["cacheDir"]).toBe("/opt/models/hf");
    });
  });
});
