import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE, ComplianceError } from "@rag/core";
import {
  askQuestion,
  askQuestionStream,
  capChunksPerDocument,
  dropDuplicateChunks,
  EMPTY_ANSWER,
} from "./ask.js";
import {
  retrievalResult,
  makeDeps,
  DEFAULT_TOP_K,
} from "./ask.test-harness.js";

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

  it("still over-fetches with the cap disabled (duplicate collapse needs backfill) but returns at most topK", async () => {
    const search = searchReturningTopK();
    const answer = vi.fn().mockResolvedValue({ answer: "x", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });

    await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE, 0);

    expect(search.mock.calls[0]![0].topK).toBe(DEFAULT_TOP_K * 3);
    expect(
      (answer.mock.calls[0]![1] as RetrievalResult[]).length,
    ).toBeLessThanOrEqual(DEFAULT_TOP_K);
  });
});

describe("generator screening", () => {
  it("generates, cites, and returns only the context the generator's screen() kept", async () => {
    const kept = retrievalResult("2");
    const retrieved = [retrievalResult("1"), kept];
    const screen = vi.fn().mockReturnValue([kept]);
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "ok [1]", citations: [] });
    const deps = makeDeps({
      generator: { answer, screen } as unknown as ServiceDeps["generator"],
      search: vi.fn().mockResolvedValue(retrieved),
    });

    const result = await askQuestion(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    );

    expect(screen).toHaveBeenCalledWith("q", retrieved);
    expect(answer).toHaveBeenCalledWith("q", [kept]);
    // [1] now refers to the first SCREENED document, doc-2 — not doc-1.
    expect(result.citations.map((c) => c.documentId)).toEqual(["doc-2"]);
    expect(result.retrieved.map((r) => r.document.id)).toEqual(["doc-2"]);
  });

  it("applies the same screening on the streaming path", async () => {
    const kept = retrievalResult("2");
    const screen = vi.fn().mockReturnValue([kept]);
    async function* answerStream() {
      yield "ok [1]";
    }
    const deps = makeDeps({
      generator: {
        answerStream: vi.fn(answerStream),
        screen,
      } as unknown as ServiceDeps["generator"],
      search: vi.fn().mockResolvedValue([retrievalResult("1"), kept]),
    });

    const events = [];
    for await (const e of askQuestionStream(
      deps,
      { question: "q" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    )) {
      events.push(e);
    }
    const done = events.find((e) => e.type === "done");
    expect(
      done?.type === "done" && done.citations.map((c) => c.documentId),
    ).toEqual(["doc-2"]);
  });
});

describe("follow-up condensation (history)", () => {
  const HISTORY = [
    { role: "user" as const, content: "How do I set up a bookkeeping client?" },
    { role: "assistant" as const, content: "Apply BK-CATCHUP [1]." },
  ];

  function depsWith(complete: ReturnType<typeof vi.fn>) {
    const search = vi.fn().mockResolvedValue([retrievalResult("1")]);
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "a [1]", citations: [] });
    async function* answerStream() {
      yield "a [1]";
    }
    const deps = makeDeps({
      generator: {
        answer,
        answerStream: vi.fn(answerStream),
        complete,
      } as unknown as ServiceDeps["generator"],
      search,
    });
    return { deps, search, answer };
  }

  it("retrieves with the rewritten question but generates from the ORIGINAL one", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue("How do I set up a payroll client?");
    const { deps, search, answer } = depsWith(complete);

    await askQuestion(
      deps,
      { question: "and for payroll?", history: HISTORY },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    );

    expect(search.mock.calls[0]?.[0].query).toBe(
      "How do I set up a payroll client?",
    );
    expect(answer.mock.calls[0]?.[0]).toBe("and for payroll?");
  });

  it("does not call the model when there is no history", async () => {
    const complete = vi.fn();
    const { deps, search } = depsWith(complete);
    await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE);
    expect(complete).not.toHaveBeenCalled();
    expect(search.mock.calls[0]?.[0].query).toBe("q");
  });

  it("falls back to the original question when condensation fails", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("blocked"));
    const { deps, search } = depsWith(complete);
    await askQuestion(
      deps,
      { question: "and for payroll?", history: HISTORY },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    );
    expect(search.mock.calls[0]?.[0].query).toBe("and for payroll?");
  });

  it("applies the same rewrite on the streaming path", async () => {
    const complete = vi.fn().mockResolvedValue("rewritten");
    const { deps, search } = depsWith(complete);
    for await (const _ of askQuestionStream(
      deps,
      { question: "and payroll?", history: HISTORY },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    )) {
      // drain
    }
    expect(search.mock.calls[0]?.[0].query).toBe("rewritten");
    const streamCall = (
      deps.generator as unknown as { answerStream: ReturnType<typeof vi.fn> }
    ).answerStream.mock.calls[0];
    expect(streamCall?.[0]).toBe("and payroll?");
  });
});

describe("relevance floor (minDenseSimilarity)", () => {
  function scored(id: string, dense: number, sparse: number): RetrievalResult {
    return {
      ...retrievalResult(id),
      denseScore: dense,
      sparseScore: sparse,
    } as RetrievalResult;
  }

  it("drops chunks with no keyword match and dense similarity below the floor", async () => {
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "a [1]", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search: vi
        .fn()
        .mockResolvedValue([
          scored("strong", 0.8, 0),
          scored("keyword", 0.2, 0.4),
          scored("weak", 0.3, 0),
        ]),
    });

    await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE, 0, {
      minDenseSimilarity: 0.5,
    });

    const context = answer.mock.calls[0]?.[1] as RetrievalResult[];
    expect(context.map((r) => r.chunk.id)).toEqual([
      "chunk-strong",
      "chunk-keyword",
    ]);
  });

  it("answers with the fixed refusal and no model call when nothing clears the floor", async () => {
    const answer = vi.fn();
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search: vi.fn().mockResolvedValue([scored("weak", 0.1, 0)]),
    });

    const result = await askQuestion(
      deps,
      { question: "what's the weather?" },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
      0,
      { minDenseSimilarity: 0.5 },
    );

    expect(result.answer).toBe(EMPTY_ANSWER);
    expect(answer).not.toHaveBeenCalled();
  });

  it("is off when no floor is configured", async () => {
    const answer = vi.fn().mockResolvedValue({ answer: "a", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search: vi.fn().mockResolvedValue([scored("weak", 0.01, 0)]),
    });
    await askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE);
    expect(answer).toHaveBeenCalled();
  });
});

describe("dropDuplicateChunks", () => {
  function withText(id: string, docId: string, text: string): RetrievalResult {
    return { ...retrievalResult(id, docId), text } as RetrievalResult;
  }

  it("keeps the best-ranked copy of a chunk whose body appears in several documents", () => {
    const out = dropDuplicateChunks([
      withText(
        "1",
        "sop-v2",
        "# SOP v2 › Steps\n\n1. Create the client in Karbon.",
      ),
      withText("2", "other", "# Other\n\nSomething else."),
      withText(
        "3",
        "sop-copy",
        "# SOP (copy) › Steps\n\n1.  Create the client in   Karbon.",
      ),
    ]);
    expect(out.map((r) => r.chunk.id)).toEqual(["chunk-1", "chunk-2"]);
  });

  it("does not collapse chunks whose bodies differ", () => {
    const out = dropDuplicateChunks([
      withText("1", "a", "# A\n\nStep one."),
      withText("2", "b", "# B\n\nStep two."),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("TRI screening before retrieval (embedding egress)", () => {
  const HISTORY = [
    { role: "user" as const, content: "earlier turn" },
    { role: "assistant" as const, content: "earlier answer" },
  ];

  it("screens the question BEFORE retrieval, so a blocked question never reaches the embedder", async () => {
    const search = vi.fn();
    const screen = vi.fn(() => {
      throw new ComplianceError("TRI detected in the question");
    });
    const deps = makeDeps({
      generator: {
        answer: vi.fn(),
        screen,
      } as unknown as ServiceDeps["generator"],
      search,
    });

    await expect(
      askQuestion(
        deps,
        { question: "SSN 123-45-6789?" },
        DEFAULT_TOP_K,
        ADMIN_SCOPE,
      ),
    ).rejects.toBeInstanceOf(ComplianceError);
    expect(screen).toHaveBeenCalledWith("SSN 123-45-6789?", []);
    expect(search).not.toHaveBeenCalled();
  });

  it("falls back to the original question, and logs, when the REWRITE would be blocked", async () => {
    const search = vi.fn().mockResolvedValue([retrievalResult("1")]);
    const screen = vi.fn((q: string, ctx: RetrievalResult[]) => {
      if (q.includes("123-45-6789"))
        throw new ComplianceError("TRI in rewrite");
      return ctx;
    });
    const deps = makeDeps({
      generator: {
        answer: vi.fn().mockResolvedValue({ answer: "a", citations: [] }),
        complete: vi.fn().mockResolvedValue("setup for client SSN 123-45-6789"),
        screen,
      } as unknown as ServiceDeps["generator"],
      search,
    });

    await askQuestion(
      deps,
      { question: "and for them?", history: HISTORY },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    );

    expect(search.mock.calls[0]?.[0].query).toBe("and for them?");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "ask.rewrite_blocked" }),
      expect.any(String),
    );
  });

  it("logs a compliance block inside condensation instead of swallowing it", async () => {
    const search = vi.fn().mockResolvedValue([retrievalResult("1")]);
    const deps = makeDeps({
      generator: {
        answer: vi.fn().mockResolvedValue({ answer: "a", citations: [] }),
        complete: vi
          .fn()
          .mockRejectedValue(new ComplianceError("TRI in history")),
        screen: (_q: string, ctx: RetrievalResult[]) => ctx,
      } as unknown as ServiceDeps["generator"],
      search,
    });

    await askQuestion(
      deps,
      { question: "and for them?", history: HISTORY },
      DEFAULT_TOP_K,
      ADMIN_SCOPE,
    );

    expect(search.mock.calls[0]?.[0].query).toBe("and for them?");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "ask.condensation_blocked" }),
      expect.any(String),
    );
  });
});
