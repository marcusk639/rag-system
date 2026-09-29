import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE } from "@rag/core";
import { askQuestion, askQuestionStream } from "./ask.js";
import { GenerationNotConfiguredError } from "./errors.js";
import {
  retrievalResult,
  makeDeps,
  DEFAULT_TOP_K,
} from "./ask.test-harness.js";

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
        title: "Doc doc-1",
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
    // mandatory second argument. The retriever is over-fetched (×3) so
    // duplicate collapse and the per-document cap can backfill to topK.
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "q", topK: DEFAULT_TOP_K * 3 }),
      ADMIN_SCOPE,
    );
    expect(answer).toHaveBeenCalledWith("q", retrieved);
    expect(result).toEqual({
      answer: "grounded [1]",
      // Citations are built by the service from `retrieved` (not threaded from
      // the generator) so /ask and /ask/stream cannot drift apart.
      citations: [expect.objectContaining(citations[0])],
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
        title: "Doc doc-1",
        chunkId: "chunk-1",
        score: 1,
      },
      {
        index: 2,
        documentId: "doc-2",
        title: "Doc doc-2",
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

    expect(result.citations).toEqual([expect.objectContaining(citations[0])]);
  });

  it("ignores citations a generator returns that do not match what was retrieved", async () => {
    const retrieved = [retrievalResult("1")];
    const search = vi.fn().mockResolvedValue(retrieved);
    const answer = vi.fn().mockResolvedValue({
      answer: "grounded [1]",
      citations: [
        {
          index: 1,
          documentId: "not-retrieved",
          title: "X",
          chunkId: "x",
          score: 1,
        },
      ],
    });
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

    expect(result.citations.map((c) => c.documentId)).toEqual(["doc-1"]);
    expect(result.citations[0]?.chunkIds).toEqual(["chunk-1"]);
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
        topK: 9, // explicit topK 3, over-fetched ×3
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
        title: "Doc doc-1",
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

describe("review follow-ups", () => {
  it("backfills to topK after collapsing duplicates even with the per-document cap disabled", async () => {
    const dup = (id: string) =>
      ({
        ...retrievalResult(id, `doc-${id}`),
        text: "# T\n\nSame body.",
      }) as RetrievalResult;
    const unique = (id: string) =>
      ({
        ...retrievalResult(id, `doc-${id}`),
        text: `# T\n\nBody ${id}.`,
      }) as RetrievalResult;
    const search = vi
      .fn()
      .mockResolvedValue([
        dup("1"),
        dup("2"),
        dup("3"),
        unique("4"),
        unique("5"),
      ]);
    const answer = vi.fn().mockResolvedValue({ answer: "a", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    await askQuestion(
      deps,
      { question: "q", topK: 3 },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
      0,
    );

    expect(search.mock.calls[0]?.[0].topK).toBeGreaterThan(3);
    const context = answer.mock.calls[0]?.[1] as RetrievalResult[];
    expect(context.map((r) => r.chunk.id)).toEqual([
      "chunk-1",
      "chunk-4",
      "chunk-5",
    ]);
  });
});
