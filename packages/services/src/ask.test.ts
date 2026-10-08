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

/**
 * The both-gates-at-once seam. `askQuestion` builds `citations` from the RAW
 * `retrieved` and sanitizes the `retrieved` payload separately, three lines
 * apart (`ask.ts:447-451`). Two independent gates, one object literal.
 *
 * Neither was exercised before: the shared fixture is blank
 * (`ask.test-harness.ts:19-20` sets `url: undefined`, `metadata: {}`), so
 * every other test here runs against an untagged document with no link. That
 * made `sanitizeRetrievalResults` deletable with NO test in the repo failing —
 * verified by mutation, 70/70 services tests and the whole non-e2e suite still
 * green with the call removed. A shared predicate change is caught by the core
 * and rag suites; removing a CALL SITE was caught by nothing.
 *
 * Do not move this url/class onto the `retrievalResult` factory: `ask.test.ts`'s
 * `toEqual` against the raw `retrieved` array (above) would start failing,
 * because sanitization would then have something to strip.
 */
describe("askQuestion — source URL class gate at the service seam", () => {
  const SHAREPOINT_WEBURL =
    "https://firm.sharepoint.com/sites/Tax/Shared%20Documents/Clients/Smith%20Family/2024/return.pdf";
  const CLIENT_PATH_SEGMENT = "Smith%20Family";

  async function askTagged(docClass: string) {
    const r = retrievalResult("1");
    r.document.url = SHAREPOINT_WEBURL;
    r.document.metadata = { url: SHAREPOINT_WEBURL, docClass } as never;
    const search = vi.fn().mockResolvedValue([r]);
    // The answer MUST cite `[1]`: `filterCitationsToAnswer` drops uncited
    // citations, and an empty citation list would make every assertion below
    // vacuously true.
    const answer = vi
      .fn()
      .mockResolvedValue({ answer: "grounded [1]", citations: [] });
    const deps = makeDeps({
      generator: { answer } as unknown as ServiceDeps["generator"],
      search,
    });
    return askQuestion(deps, { question: "q" }, DEFAULT_TOP_K, ADMIN_SCOPE);
  }

  it("withholds the source URL from both payloads for a class B document", async () => {
    const result = await askTagged("B");

    // Citation survives — only the link is withheld. Asserting length first
    // keeps the `in` check below from passing against an empty list.
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      index: 1,
      documentId: "doc-1",
    });
    expect("url" in result.citations[0]!).toBe(false);
    expect(result.retrieved[0]!.document.url).toBeUndefined();

    // Key-name-independent, and the assertion that actually fails if EITHER
    // gate is removed — it covers `citations[].url`, `retrieved[].document.url`
    // and `retrieved[].document.metadata.url` at once.
    expect(JSON.stringify(result)).not.toContain(CLIENT_PATH_SEGMENT);
  });

  it("keeps the source URL on both payloads for a class A document", async () => {
    const result = await askTagged("A");

    expect(result.citations[0]?.url).toBe(SHAREPOINT_WEBURL);
    expect(result.retrieved[0]?.document.url).toBe(SHAREPOINT_WEBURL);
  });
});
