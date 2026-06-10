import { describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@rag/core";
import { askQuestion } from "./ask.js";
import type { ServiceDeps } from "./deps.js";
import { GenerationNotConfiguredError } from "./errors.js";

function retrievalResult(id: string): RetrievalResult {
  return {
    chunkId: `chunk-${id}`,
    documentId: `doc-${id}`,
    score: 1,
    text: `text ${id}`,
    document: {
      id: `doc-${id}`,
      sourceId: "src",
      externalId: id,
      title: `Doc ${id}`,
      url: undefined,
      metadata: {},
    },
  } as unknown as RetrievalResult;
}

/** Build ServiceDeps with mockable retriever/generator; other deps unused here. */
function makeDeps(opts: {
  generator: ServiceDeps["generator"];
  search: ReturnType<typeof vi.fn>;
}): ServiceDeps {
  return {
    db: {} as ServiceDeps["db"],
    queue: {} as ServiceDeps["queue"],
    retriever: { search: opts.search } as unknown as ServiceDeps["retriever"],
    generator: opts.generator,
  };
}

const DEFAULT_TOP_K = 8;

describe("askQuestion", () => {
  it("throws GenerationNotConfiguredError and never touches the retriever when no generator", async () => {
    const search = vi.fn();
    const deps = makeDeps({ generator: null, search });

    await expect(
      askQuestion(deps, { question: "q" }, DEFAULT_TOP_K),
    ).rejects.toBeInstanceOf(GenerationNotConfiguredError);
    expect(search).not.toHaveBeenCalled();
  });

  it("short-circuits to the fixed EMPTY_ANSWER without invoking the generator on empty retrieval", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const answer = vi.fn();
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    const result = await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K);

    expect(result.answer).toMatch(/do not contain enough information/i);
    expect(result.citations).toEqual([]);
    expect(result.retrieved).toEqual([]);
    expect(answer).not.toHaveBeenCalled();
  });

  it("threads the generator output through and falls back to defaultTopK", async () => {
    const retrieved = [retrievalResult("1")];
    const search = vi.fn().mockResolvedValue(retrieved);
    const citations = [
      {
        index: 1,
        documentId: "doc-1",
        title: "Doc 1",
        chunkId: "chunk-1",
        score: 1,
      },
    ];
    const answer = vi.fn().mockResolvedValue({ answer: "grounded", citations });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    const result = await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K);

    // topK omitted → falls back to defaultTopK at the retriever.
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "q", topK: DEFAULT_TOP_K }),
    );
    expect(answer).toHaveBeenCalledWith("q", retrieved);
    expect(result).toEqual({ answer: "grounded", citations, retrieved });
  });

  it("uses an explicit topK over the default and forwards sourceIds/filter", async () => {
    const search = vi.fn().mockResolvedValue([retrievalResult("1")]);
    const answer = vi.fn().mockResolvedValue({ answer: "a", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    await askQuestion(
      deps,
      { question: "q", topK: 3, sourceIds: ["s1"], filter: { tag: ["x"] } },
      DEFAULT_TOP_K,
    );

    expect(search).toHaveBeenCalledWith({
      query: "q",
      topK: 3,
      sourceIds: ["s1"],
      filter: { tag: ["x"] },
    });
  });
});
