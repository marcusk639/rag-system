import { describe, expect, it, vi } from "vitest";
import { EgressPolicy } from "@rag/core";
import { GeminiEmbeddingProvider } from "./gemini.js";

const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));

function embedder(values: number[][]) {
  const e = new GeminiEmbeddingProvider({
    apiKey: "k",
    egressPolicy: new EgressPolicy(["generativelanguage.googleapis.com"]),
    dimensions: 3,
  });
  (e as unknown as { client: { models: { embedContent: unknown } } }).client.models.embedContent =
    vi.fn().mockResolvedValue({ embeddings: values.map((v) => ({ values: v })) });
  return e;
}

describe("GeminiEmbeddingProvider normalization", () => {
  it("L2-normalizes truncated (non-unit) Gemini vectors on the document side", async () => {
    const [v] = await embedder([[3, 4, 0]]).embedBatch(["doc"]);
    expect(norm(v!.vector)).toBeCloseTo(1, 10);
    expect(v!.vector).toEqual([0.6, 0.8, 0]);
  });

  it("normalizes the query side identically", async () => {
    const v = await embedder([[0, 0, 5]]).embedQuery("q");
    expect(v.vector).toEqual([0, 0, 1]);
  });

  it("rejects an all-zero vector instead of dividing by zero", async () => {
    await expect(embedder([[0, 0, 0]]).embedBatch(["doc"])).rejects.toThrow(
      /zero/i,
    );
  });
});
