import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError } from "@rag/core";

// BGE query prefix — must match the constant in local.ts exactly.
const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

// vi.hoisted() ensures these are available inside vi.mock() factories, which
// are hoisted to the top of the module graph by vitest before any imports run.
const { mockPipeFn, mockPipelineFactory, mockHFEnv, mockTokenizerFn } =
  vi.hoisted(() => {
    const mockPipeFn = vi.fn() as ReturnType<typeof vi.fn> & {
      tokenizer?: ReturnType<typeof vi.fn>;
    };
    const mockHFEnv: Record<string, string | boolean | undefined> = {};
    const mockPipelineFactory = vi.fn().mockResolvedValue(mockPipeFn);
    // Real @huggingface/transformers pipeline instances expose their
    // tokenizer as a public `.tokenizer` property (see Pipeline base class in
    // src/pipelines.js) — a callable that returns { input_ids }. There is no
    // truncation option on the FeatureExtractionPipeline call itself (verified
    // against the installed package's own .d.ts: FeatureExtractionPipelineOptions
    // only has pooling/normalize/quantize/precision), so the real fix detects
    // overflow via this tokenizer rather than a nonexistent pipe() option.
    const mockTokenizerFn = vi.fn();
    mockPipeFn.tokenizer = mockTokenizerFn;
    return { mockPipeFn, mockPipelineFactory, mockHFEnv, mockTokenizerFn };
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
    mockPipeFn.tokenizer = mockTokenizerFn;
    // Reset the tokenizer's declared limit. One test below overrides it, and
    // without this the override leaked forward into every later test.
    delete (mockTokenizerFn as unknown as { model_max_length?: number })
      .model_max_length;
    // Default: approximate real BPE tokenization (~4 chars/token) so ordinary
    // short test strings stay well under the 512-token limit and never
    // trigger a spurious truncation warning. Tests that need to exercise
    // overflow override this per-test.
    mockTokenizerFn.mockImplementation((text: string) => ({
      input_ids: new Array(Math.ceil(String(text).length / 4)).fill(0),
    }));
  });

  afterEach(() => {
    // Clean up env side-effects between tests. mockHFEnv is a single shared
    // object, so anything a test writes to it leaks forward otherwise — the
    // same trap the tokenizer's model_max_length hit above.
    delete mockHFEnv["cacheDir"];
    delete mockHFEnv["allowRemoteModels"];
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

  // ── Truncation backstop ───────────────────────────────────────────────────────
  //
  // @huggingface/transformers hardcodes `truncation: true` inside
  // FeatureExtractionPipeline._call with no way to configure it via the public
  // pipe() options (FeatureExtractionPipelineOptions only exposes
  // pooling/normalize/quantize/precision — verified against the installed
  // v3.8.1 .d.ts). So truncation already happens silently today; the fix
  // detects it via pipe.tokenizer (a public property) and logs a warning
  // rather than throwing — one anomalously long chunk should degrade
  // gracefully, not fail the whole ingestion batch.

  describe("truncation backstop", () => {
    it("REGRESSION: a chunk exceeding the 512-token limit no longer embeds with zero signal — it now logs a warning (previously silent)", async () => {
      // 3000 chars / 4 ≈ 750 tokens — well past the 512-token limit.
      const longText = "word ".repeat(600);
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      const results = await p.embedBatch([longText]);

      expect(results).toHaveLength(1);
      // Fixed: the call still succeeds, but is no longer silent.
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("logs a warning identifying an overlong chunk without throwing", async () => {
      mockTokenizerFn.mockReturnValue({ input_ids: new Array(750).fill(0) });
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      const results = await p.embedBatch(["an anomalously long paragraph"]);

      expect(results).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [details, message] = logger.warn.mock.calls[0]!;
      expect(details).toMatchObject({
        overlongCount: 1,
        maxTokenCount: 750,
        limit: 512,
      });
      expect(message).toMatch(/512/);
    });

    it("does not warn for chunks within the token limit", async () => {
      mockTokenizerFn.mockReturnValue({ input_ids: new Array(100).fill(0) });
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await p.embedBatch(["a short chunk"]);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("identifies which specific text in a batch was truncated", async () => {
      mockTokenizerFn.mockImplementation((text: string) => ({
        input_ids: new Array(text === "overlong" ? 900 : 50).fill(0),
      }));
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await p.embedBatch(["short one", "overlong", "short two"]);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [details] = logger.warn.mock.calls[0]!;
      expect(details).toMatchObject({ maxTokenIndex: 1, maxTokenCount: 900 });
    });

    it("still succeeds (does not throw) when a chunk requires truncation", async () => {
      mockTokenizerFn.mockReturnValue({ input_ids: new Array(1000).fill(0) });
      const p = new LocalEmbeddingProvider({ logger: { warn: vi.fn() } });

      await expect(
        p.embedBatch(["a very long anomalous chunk"]),
      ).resolves.toHaveLength(1);
    });

    it("respects the tokenizer's own model_max_length over the constructor default", async () => {
      (
        mockPipeFn.tokenizer as unknown as { model_max_length: number }
      ).model_max_length = 256;
      mockTokenizerFn.mockReturnValue({ input_ids: new Array(300).fill(0) });
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await p.embedBatch(["text tokenizing to 300 tokens"]);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [details] = logger.warn.mock.calls[0]!;
      expect(details).toMatchObject({ maxTokenCount: 300, limit: 256 });

      delete (mockPipeFn.tokenizer as unknown as { model_max_length?: number })
        .model_max_length;
    });

    it("falls back to a no-op console-based logger when none is injected (no logging library in this package)", async () => {
      mockTokenizerFn.mockReturnValue({ input_ids: new Array(700).fill(0) });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const p = new LocalEmbeddingProvider();
        await p.embedBatch(["overlong without an injected logger"]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("never throws even when the pipeline exposes no tokenizer at all", async () => {
      mockPipeFn.tokenizer = undefined;
      const provider = new LocalEmbeddingProvider();
      await expect(provider.embedBatch(["some text"])).resolves.toBeDefined();
    });

    it("detection is best-effort — a tokenizer failure never blocks the actual embed call", async () => {
      mockTokenizerFn.mockImplementation(() => {
        throw new Error("tokenizer explosion");
      });
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await expect(p.embedBatch(["text"])).resolves.toHaveLength(1);
      expect(logger.warn).not.toHaveBeenCalled();
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

  /**
   * COMPLIANCE_MODE=client-data makes `local` the only permitted embedding
   * provider (createEmbeddingProvider throws for gemini/openai), on the
   * grounds that it is the one provider with no egress. That was only true
   * after the weights were already on disk: the first `embed()` call downloads
   * ~430 MB from huggingface.co, and nothing gated it — `_loadPipeline` set
   * `env.cacheDir` and nothing else, while the library defaults
   * `allowRemoteModels` to `true`.
   *
   * `EgressPolicy` cannot be the gate here. @huggingface/transformers calls the
   * global `fetch` itself and exposes no injection point for a custom one (its
   * `env` has no fetch/agent/proxy option in 3.8.1), so the only enforceable
   * control is the library's own switch. Setting it is a stronger guarantee
   * than an allow-list anyway: the request is never attempted.
   */
  describe("compliance mode — offline weight loading", () => {
    it("disables remote model fetches under client-data", async () => {
      const p = new LocalEmbeddingProvider({ complianceMode: "client-data" });
      await p.embed("warmup");
      expect(mockHFEnv["allowRemoteModels"]).toBe(false);
    });

    it("leaves remote fetches enabled when no compliance mode is set", async () => {
      // Default deployments legitimately download on first run; the gate must
      // not become an accidental air-gap for everyone.
      const p = new LocalEmbeddingProvider();
      await p.embed("warmup");
      expect(mockHFEnv["allowRemoteModels"]).toBeUndefined();
    });

    it("leaves remote fetches enabled under complianceMode none", async () => {
      const p = new LocalEmbeddingProvider({ complianceMode: "none" });
      await p.embed("warmup");
      expect(mockHFEnv["allowRemoteModels"]).toBeUndefined();
    });

    it("does not touch allowLocalModels, so a warm cache still loads", async () => {
      // The library tries its cache before consulting either flag, and setting
      // both to false is a hard "Invalid configuration" error.
      const p = new LocalEmbeddingProvider({ complianceMode: "client-data" });
      await p.embed("warmup");
      expect(mockHFEnv["allowLocalModels"]).toBeUndefined();
    });

    it("tells the operator to pre-warm the cache when a cold load is refused", async () => {
      // The real error the library raises once the gate is on and the weights
      // are absent (dist/transformers.node.cjs:32956).
      mockPipelineFactory.mockRejectedValue(
        new Error(
          "`local_files_only=true` or `env.allowRemoteModels=false` and file " +
            'was not found locally at "/root/.cache/huggingface/Xenova/bge-base-en-v1.5".',
        ),
      );
      const p = new LocalEmbeddingProvider({ complianceMode: "client-data" });

      const err = (await p.embed("x").catch((e: unknown) => e)) as Error;

      expect(err.message).toMatch(/warm-model/);
      // The old message sent the operator looking for internet access, which
      // under client-data is the one thing they must not arrange.
      expect(err.message).not.toMatch(/requires internet access/);
    });
  });

  describe("overlong-chunk warnings are aggregated per batch", () => {
    // One warn per oversized chunk saturated Railway's log pipeline in
    // production: 500 logs/sec, ~12,000 messages dropped, during a sync where
    // roughly half the corpus exceeded the limit. Dropped logs are worse than
    // terse ones — the aggregate is what an operator needs anyway ("how much of
    // this document is being truncated"), and per-chunk detail was never
    // actionable at that volume.
    it("emits ONE warning for a batch with many overlong texts", async () => {
      mockTokenizerFn.mockImplementation((text: string) => ({
        input_ids: new Array(text.startsWith("long") ? 900 : 50).fill(0),
      }));
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await p.embedBatch([
        "long a",
        "short",
        "long b",
        "long c",
        "short",
        "long d",
      ]);

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("reports the count, the worst case, and how many were fine", async () => {
      // The numbers an operator acts on: how widespread, and how far past the
      // limit the worst chunk is — which is what decides whether CHUNK_SIZE
      // needs lowering or a document needs splitting.
      mockTokenizerFn.mockImplementation((text: string) => ({
        input_ids: new Array(
          text === "a" ? 900 : text === "b" ? 1400 : 50,
        ).fill(0),
      }));
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await p.embedBatch(["a", "b", "ok", "ok"]);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [details, message] = logger.warn.mock.calls[0]!;
      expect(details).toMatchObject({
        overlongCount: 2,
        batchSize: 4,
        maxTokenCount: 1400,
        limit: 512,
      });
      expect(message).toMatch(/2 of 4/);
    });

    it("still says WHICH text was worst, so a single offender stays findable", async () => {
      // Aggregating must not lose the thread when there is only one bad chunk —
      // that was the useful half of the old per-chunk log.
      mockTokenizerFn.mockImplementation((text: string) => ({
        input_ids: new Array(text === "overlong" ? 900 : 50).fill(0),
      }));
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await p.embedBatch(["short one", "overlong", "short two"]);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [details] = logger.warn.mock.calls[0]!;
      expect(details).toMatchObject({
        overlongCount: 1,
        maxTokenIndex: 1,
        maxTokenCount: 900,
      });
      expect(String(details.maxTokenPreview)).toContain("overlong");
    });

    it("stays silent when every text fits", async () => {
      mockTokenizerFn.mockReturnValue({ input_ids: new Array(100).fill(0) });
      const logger = { warn: vi.fn() };
      const p = new LocalEmbeddingProvider({ logger });

      await p.embedBatch(["a", "b", "c"]);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
