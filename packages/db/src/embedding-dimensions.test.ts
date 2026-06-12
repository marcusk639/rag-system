import { describe, it, expect } from "vitest";
import {
  EMBEDDING_COLUMN_DIMENSIONS,
  assertEmbeddingDimensions,
} from "./embedding-dimensions.js";

describe("assertEmbeddingDimensions", () => {
  it("passes silently when configured dimensions match the column", () => {
    expect(() =>
      assertEmbeddingDimensions(EMBEDDING_COLUMN_DIMENSIONS),
    ).not.toThrow();
  });

  it("throws a clear, actionable error when dimensions mismatch", () => {
    const configured = 1536; // e.g. OpenAI text-embedding-3-small
    expect(() => assertEmbeddingDimensions(configured)).toThrowError(
      /Embedding dimension mismatch/,
    );

    // Error names both numbers and the column so the operator knows what to fix.
    let message = "";
    try {
      assertEmbeddingDimensions(configured);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(String(configured));
    expect(message).toContain(String(EMBEDDING_COLUMN_DIMENSIONS));
    expect(message).toContain("chunks.embedding");
  });

  it("rejects a non-positive-integer configured dimension", () => {
    expect(() => assertEmbeddingDimensions(0)).toThrowError(/positive integer/);
    expect(() => assertEmbeddingDimensions(-1)).toThrowError(
      /positive integer/,
    );
    expect(() => assertEmbeddingDimensions(768.5)).toThrowError(
      /positive integer/,
    );
  });

  it("exposes the column dimension as 768 (Gemini text-embedding-004)", () => {
    expect(EMBEDDING_COLUMN_DIMENSIONS).toBe(768);
  });
});
