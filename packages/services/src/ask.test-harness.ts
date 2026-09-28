import { vi } from "vitest";
import type { RetrievalResult } from "@rag/core";
import type { ServiceDeps } from "./deps.js";

export function retrievalResult(
  id: string,
  docId = `doc-${id}`,
): RetrievalResult {
  return {
    chunkId: `chunk-${id}`,
    documentId: docId,
    score: 1,
    text: `text ${id}`,
    document: {
      id: docId,
      sourceId: "src",
      externalId: id,
      title: `Doc ${docId}`,
      url: undefined,
      metadata: {},
    },
    chunk: { id: `chunk-${id}`, ordinal: 0, headingPath: [] },
  } as unknown as RetrievalResult;
}

/** Build ServiceDeps with mockable retriever/generator; other deps unused here. */
export function makeDeps(opts: {
  generator: ServiceDeps["generator"];
  search: ReturnType<typeof vi.fn>;
}): ServiceDeps {
  return {
    db: {} as ServiceDeps["db"],
    queue: {} as ServiceDeps["queue"],
    retriever: { search: opts.search } as unknown as ServiceDeps["retriever"],
    generator: opts.generator,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
}

export const DEFAULT_TOP_K = 8;
