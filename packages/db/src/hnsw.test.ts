import { describe, expect, it } from "vitest";
import { resolveEfSearch } from "./hnsw.js";

describe("resolveEfSearch", () => {
  it("defaults to 100 when the candidate pool fits", () => {
    expect(resolveEfSearch(96)).toBe(100);
  });

  it("raises ef_search to the dense pool size — HNSW returns at most ef_search rows", () => {
    // topK 12 × rerank pool 5 × candidate multiplier 8
    expect(resolveEfSearch(480)).toBe(480);
  });

  it("never goes below pgvector's default of 40, even with a low override", () => {
    expect(resolveEfSearch(10, 5)).toBe(40);
  });

  it("honours a larger explicit override", () => {
    expect(resolveEfSearch(96, 400)).toBe(400);
  });

  it("clamps to pgvector's maximum of 1000 (SET would otherwise error)", () => {
    expect(resolveEfSearch(2400)).toBe(1000);
    expect(resolveEfSearch(10, 5000)).toBe(1000);
  });

  it("always yields an integer (it is interpolated raw into SET LOCAL)", () => {
    expect(Number.isInteger(resolveEfSearch(96, 120.7))).toBe(true);
  });
});
