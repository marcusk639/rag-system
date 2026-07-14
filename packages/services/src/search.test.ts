import { describe, expect, it, vi } from "vitest";
import type { AuthorizationScope, RetrievalResult } from "@rag/core";
import { searchDocuments } from "./search.js";
import type { ServiceDeps } from "./deps.js";

function chunk(documentId: string, chunkId: string): RetrievalResult {
  return {
    text: `text for ${chunkId}`,
    score: 1,
    denseScore: 1,
    sparseScore: 1,
    document: {
      id: documentId,
      title: `Doc ${documentId}`,
      sourceId: "src-1",
      sourceKind: "custom",
      hasOriginal: false,
      metadata: {},
    },
    chunk: {
      id: chunkId,
      headingPath: [],
      ordinal: 0,
      page: null,
    },
  } as RetrievalResult;
}

const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };

describe("searchDocuments — per-document diversity cap", () => {
  it("passes results through uncapped when maxChunksPerDocument is 0 (default)", async () => {
    const results = [
      chunk("doc-1", "c1"),
      chunk("doc-1", "c2"),
      chunk("doc-1", "c3"),
    ];
    const deps = {
      retriever: { search: vi.fn(async () => results) },
    } as unknown as ServiceDeps;

    const out = await searchDocuments(deps, { query: "q" }, 10, ADMIN_SCOPE);

    expect(out).toHaveLength(3);
  });

  it("caps chunks per document when maxChunksPerDocument is set", async () => {
    const results = [
      chunk("doc-1", "c1"),
      chunk("doc-1", "c2"),
      chunk("doc-1", "c3"),
      chunk("doc-2", "c4"),
    ];
    const deps = {
      retriever: { search: vi.fn(async () => results) },
    } as unknown as ServiceDeps;

    const out = await searchDocuments(deps, { query: "q" }, 10, ADMIN_SCOPE, 2);

    expect(out.filter((r) => r.document.id === "doc-1")).toHaveLength(2);
    expect(out.filter((r) => r.document.id === "doc-2")).toHaveLength(1);
  });
});
