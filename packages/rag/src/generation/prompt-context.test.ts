import { describe, expect, it } from "vitest";
import type { RetrievalResult } from "@rag/core";
import {
  buildCitations,
  buildPrompt,
  groupContextByDocument,
} from "./prompt-context.js";

function chunk(
  docId: string,
  ordinal: number,
  score: number,
  text = `${docId} chunk ${ordinal}`,
): RetrievalResult {
  return {
    text,
    score,
    denseScore: score,
    sparseScore: 0,
    document: {
      id: docId,
      title: `Title ${docId}`,
      sourceId: "s",
      sourceKind: "sharepoint",
      url: `https://x/${docId}`,
      hasOriginal: true,
      metadata: {},
    },
    chunk: { id: `${docId}-c${ordinal}`, ordinal, headingPath: ["Steps"] },
  } as RetrievalResult;
}

// Retrieval order (by score): doc A step 3, doc B, doc A step 1, doc A step 2.
const RESULTS = [
  chunk("A", 3, 0.9),
  chunk("B", 0, 0.8),
  chunk("A", 1, 0.7),
  chunk("A", 2, 0.6),
];

describe("groupContextByDocument", () => {
  it("groups chunks by document, ordered by each document's best-ranked chunk", () => {
    const groups = groupContextByDocument(RESULTS);
    expect(groups.map((g) => g.document.id)).toEqual(["A", "B"]);
    expect(groups.map((g) => g.index)).toEqual([1, 2]);
  });

  it("orders a document's chunks in reading order, not score order", () => {
    const [a] = groupContextByDocument(RESULTS);
    expect(a?.chunks.map((c) => c.chunk.ordinal)).toEqual([1, 2, 3]);
  });

  it("drops a chunk that appears twice", () => {
    const groups = groupContextByDocument([...RESULTS, chunk("A", 1, 0.5)]);
    expect(groups[0]?.chunks).toHaveLength(3);
  });
});

describe("buildPrompt — one block per document", () => {
  it("emits a single <document> per source document with chunks in reading order", () => {
    const prompt = buildPrompt("how?", RESULTS);
    expect(prompt.match(/<document index=/g)).toHaveLength(2);
    const a = prompt.slice(
      prompt.indexOf('<document index="1"'),
      prompt.indexOf('<document index="2"'),
    );
    expect(a.indexOf("A chunk 1")).toBeLessThan(a.indexOf("A chunk 2"));
    expect(a.indexOf("A chunk 2")).toBeLessThan(a.indexOf("A chunk 3"));
  });

  it("marks a gap between non-adjacent chunks and not between adjacent ones", () => {
    const prompt = buildPrompt("how?", [
      chunk("A", 1, 0.9),
      chunk("A", 2, 0.8),
      chunk("A", 5, 0.7),
    ]);
    const body = prompt.slice(prompt.indexOf("A chunk 1"));
    expect(body.slice(0, body.indexOf("A chunk 2"))).not.toContain("[…]");
    expect(
      body.slice(body.indexOf("A chunk 2"), body.indexOf("A chunk 5")),
    ).toContain("[…]");
  });
});

describe("buildCitations — one citation per document", () => {
  it("returns one entry per document, indexed to match the prompt blocks", () => {
    const citations = buildCitations(RESULTS);
    expect(citations.map((c) => [c.index, c.documentId])).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
  });

  it("keeps every contributing chunk id (reading order), the best chunk, and the best score", () => {
    const [a] = buildCitations(RESULTS);
    expect(a?.chunkIds).toEqual(["A-c1", "A-c2", "A-c3"]);
    expect(a?.chunkId).toBe("A-c3");
    expect(a?.score).toBe(0.9);
    expect(a?.downloadable).toBe(true);
  });
});

describe("buildCitations — modified date", () => {
  it("carries the document's modified date (date only) when it is a valid ISO date", () => {
    const r = chunk("A", 0, 0.9);
    r.document.metadata = { modifiedAt: "2025-11-04T10:22:00Z" };
    expect(buildCitations([r])[0]?.modifiedAt).toBe("2025-11-04");
  });

  it("omits a missing or malformed date", () => {
    const r = chunk("A", 0, 0.9);
    r.document.metadata = { modifiedAt: "yesterday" };
    expect(buildCitations([r])[0]?.modifiedAt).toBeUndefined();
  });
});
