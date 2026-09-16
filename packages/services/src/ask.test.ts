import { describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@rag/core";
import { ADMIN_SCOPE } from "@rag/core";
import { askQuestion, askQuestionStream, capChunksPerDocument } from "./ask.js";
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
    chunk: { id: `chunk-${id}`, ordinal: 0, headingPath: [] },
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
    // Answer text must actually reference [1] — citations are now filtered to
    // only the indices the answer cites (see filterCitationsToAnswer).
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "grounded [1]", citations });
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
    expect(result).toEqual({
      answer: "grounded [1]",
      citations,
      retrieved,
      reviewStatus: "draft_requires_practitioner_review",
      disclaimer: expect.any(String),
      answerId: expect.any(String),
    });
  });

  it("drops citations the answer text doesn't actually reference via [N]", async () => {
    const retrieved = [retrievalResult("1"), retrievalResult("2")];
    const search = vi.fn().mockResolvedValue(retrieved);
    const citations = [
      {
        index: 1,
        documentId: "doc-1",
        title: "Doc 1",
        chunkId: "chunk-1",
        score: 1,
      },
      {
        index: 2,
        documentId: "doc-2",
        title: "Doc 2",
        chunkId: "chunk-2",
        score: 0.9,
      },
    ];
    // Only cites [1] — [2] was retrieved but never referenced in the answer.
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "grounded, per [1]", citations });
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

    expect(result.citations).toEqual([citations[0]]);
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

  it("askQuestion returns a non-empty answerId (uuid) on a normal answer", async () => {
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
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "grounded [1]", citations });
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

    expect(result.answerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("askQuestion returns an answerId even on the empty-retrieval short-circuit", async () => {
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
    expect(result.answerId).toBeTruthy();
  });
});

describe("askQuestionStream", () => {
  it("accumulates streamed tokens and filters the terminal citations to what the answer actually references", async () => {
    const retrieved = [retrievalResult("1"), retrievalResult("2")];
    const search = vi.fn().mockResolvedValue(retrieved);

    async function* answerStream(): AsyncIterable<string> {
      yield "grounded, ";
      yield "per [1]";
    }
    const deps = makeDeps({
      generator: { answerStream } as unknown as ServiceDeps["generator"],
      search,
    });

    const events = [];
    for await (const event of askQuestionStream(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    )) {
      events.push(event);
    }

    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.map((e) => e.text).join("")).toBe("grounded, per [1]");

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent?.citations).toHaveLength(1);
    expect(doneEvent?.citations[0]?.documentId).toBe("doc-1");
  });

  it("askQuestionStream's done event carries an answerId", async () => {
    const retrieved = [retrievalResult("1")];
    const search = vi.fn().mockResolvedValue(retrieved);

    async function* answerStream(): AsyncIterable<string> {
      yield "grounded [1]";
    }
    const deps = makeDeps({
      generator: { answerStream } as unknown as ServiceDeps["generator"],
      search,
    });

    const events = [];
    for await (const e of askQuestionStream(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    ))
      events.push(e);
    const done = events.find((e) => e.type === "done");
    expect(done?.answerId).toBeTruthy();
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

describe("per-document cap keeps the context window full", () => {
  // One dominant document fills the first 12 ranks, others follow. Without
  // over-fetching, a cap of 3 turns 8 requested chunks into 3+… far fewer.
  const ranked = [
    ...Array.from({ length: 12 }, (_, i) => retrievalResult(`a${i}`, "doc-A")),
    ...Array.from({ length: 12 }, (_, i) =>
      retrievalResult(`o${i}`, `doc-O${i}`),
    ),
  ];

  function searchReturningTopK() {
    return vi.fn(async (q: { topK: number }) => ranked.slice(0, q.topK));
  }

  it("askQuestion over-fetches when capping, then returns exactly topK capped chunks", async () => {
    const search = searchReturningTopK();
    const answer = vi.fn().mockResolvedValue({ answer: "x", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE, 3);

    expect(search.mock.calls[0]![0].topK).toBeGreaterThan(DEFAULT_TOP_K);
    const context = answer.mock.calls[0]![1] as RetrievalResult[];
    expect(context).toHaveLength(DEFAULT_TOP_K);
    expect(
      context.filter((r) => r.document.id === "doc-A").length,
    ).toBeLessThanOrEqual(3);
    // Relevance order preserved: the dominant doc's best chunks come first.
    expect(context[0]!.document.id).toBe("doc-A");
  });

  it("askQuestionStream applies the same over-fetch", async () => {
    const search = searchReturningTopK();
    let seen: RetrievalResult[] = [];
    async function* answerStream(
      _q: string,
      retrieved: RetrievalResult[],
    ): AsyncIterable<string> {
      seen = retrieved;
      yield "x";
    }
    const deps = makeDeps({
      generator: { answerStream } as unknown as ServiceDeps["generator"],
      search,
    });

    for await (const _ of askQuestionStream(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
      3,
    )) {
      // drain
    }

    expect(seen).toHaveLength(DEFAULT_TOP_K);
  });

  it("does not over-fetch when the cap is disabled", async () => {
    const search = searchReturningTopK();
    const answer = vi.fn().mockResolvedValue({ answer: "x", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE, 0);

    expect(search.mock.calls[0]![0].topK).toBe(DEFAULT_TOP_K);
  });
});
