import { describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@rag/core";
import { ADMIN_SCOPE } from "@rag/core";
import { askQuestion, capChunksPerDocument } from "./ask.js";
import type { ServiceDeps } from "./deps.js";
import { GenerationNotConfiguredError } from "./errors.js";

function retrievalResult(id: string, docId = `doc-${id}`): RetrievalResult {
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
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
}

const DEFAULT_TOP_K = 8;

describe("askQuestion", () => {
  it("throws GenerationNotConfiguredError and never touches the retriever when no generator", async () => {
    const search = vi.fn();
    const deps = makeDeps({ generator: null, search });

    await expect(
      askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE),
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

    const result = await askQuestion(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    );

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

    const result = await askQuestion(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    );

    // topK omitted → falls back to defaultTopK at the retriever; scope is the
    // mandatory second argument.
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "q", topK: DEFAULT_TOP_K }),
      ADMIN_SCOPE,
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
      ADMIN_SCOPE,
    );

    expect(search).toHaveBeenCalledWith(
      {
        query: "q",
        topK: 3,
        sourceIds: ["s1"],
        filter: { tag: ["x"] },
      },
      ADMIN_SCOPE,
    );
  });

  it("caps per-document chunks before generation when maxChunksPerDocument is set", async () => {
    // Six chunks, all from the same document → should be capped to 3.
    const retrieved = [1, 2, 3, 4, 5, 6].map((n) =>
      retrievalResult(`${n}`, "doc-A"),
    );
    const search = vi.fn().mockResolvedValue(retrieved);
    const answer = vi.fn().mockResolvedValue({ answer: "a", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    const result = await askQuestion(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
      3, // maxChunksPerDocument
    );

    // The generator and the returned `retrieved` only ever see the capped set.
    const passedToGenerator = answer.mock.calls[0][1] as RetrievalResult[];
    expect(passedToGenerator).toHaveLength(3);
    expect(result.retrieved).toHaveLength(3);
  });
});

describe("capChunksPerDocument", () => {
  it("keeps at most `cap` chunks per document, preserving order, without mutating", () => {
    const input = [
      retrievalResult("1", "doc-A"),
      retrievalResult("2", "doc-A"),
      retrievalResult("3", "doc-B"),
      retrievalResult("4", "doc-A"),
      retrievalResult("5", "doc-B"),
      retrievalResult("6", "doc-A"),
    ];

    const capped = capChunksPerDocument(input, 2);

    expect(capped).toHaveLength(4); // doc-A ×2, doc-B ×2
    expect(capped.filter((r) => r.document.id === "doc-A")).toHaveLength(2);
    expect(capped.filter((r) => r.document.id === "doc-B")).toHaveLength(2);
    expect(input).toHaveLength(6); // input untouched (no mutation)
  });

  it("is a no-op when cap <= 0", () => {
    const input = [
      retrievalResult("1", "doc-A"),
      retrievalResult("2", "doc-A"),
    ];
    expect(capChunksPerDocument(input, 0)).toBe(input);
  });
});
