import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE } from "@rag/core";
import { askQuestion, askQuestionStream, type CitationWarning } from "./ask.js";
import type { ServiceDeps } from "./deps.js";
import {
  retrievalResult,
  makeDeps,
  DEFAULT_TOP_K,
} from "./ask.test-harness.js";
import { EMPTY_ANSWER } from "./refusal.js";

interface Outcome {
  citationWarnings: CitationWarning[];
  warn: ReturnType<typeof vi.fn>;
  answerId: string;
}

/** Run one generated answer through a path; two documents are retrieved ([1], [2]). */
type Path = (answerText: string, retrievedCount?: number) => Promise<Outcome>;

const viaAsk: Path = async (answerText, retrievedCount = 2) => {
  const retrieved = Array.from({ length: retrievedCount }, (_, i) =>
    retrievalResult(String(i + 1)),
  );
  const deps = makeDeps({
    generator: {
      answer: vi.fn().mockResolvedValue({ answer: answerText, citations: [] }),
    } as unknown as ServiceDeps["generator"],
    search: vi.fn().mockResolvedValue(retrieved),
  });
  const result = await askQuestion(
    deps,
    { question: "q" },
    DEFAULT_TOP_K,
    ADMIN_SCOPE,
  );
  return {
    citationWarnings: result.citationWarnings,
    warn: deps.logger.warn as ReturnType<typeof vi.fn>,
    answerId: result.answerId,
  };
};

const viaStream: Path = async (answerText, retrievedCount = 2) => {
  const retrieved = Array.from({ length: retrievedCount }, (_, i) =>
    retrievalResult(String(i + 1)),
  );
  async function* answerStream(): AsyncIterable<string> {
    // Split mid-citation to prove detection runs on the reassembled text.
    const mid = Math.floor(answerText.length / 2);
    yield answerText.slice(0, mid);
    yield answerText.slice(mid);
  }
  const deps = makeDeps({
    generator: { answerStream } as unknown as ServiceDeps["generator"],
    search: vi.fn().mockResolvedValue(retrieved),
  });
  let done;
  for await (const event of askQuestionStream(
    deps,
    { question: "q" },
    DEFAULT_TOP_K,
    ADMIN_SCOPE,
  )) {
    if (event.type === "done") done = event;
  }
  if (!done) throw new Error("stream ended without a done event");
  return {
    citationWarnings: done.citationWarnings,
    warn: deps.logger.warn as ReturnType<typeof vi.fn>,
    answerId: done.answerId,
  };
};

describe.each([
  ["askQuestion", viaAsk],
  ["askQuestionStream", viaStream],
] as const)("%s — citation warnings", (_name, run) => {
  it("reports no warnings for an answer citing only retrieved documents", async () => {
    const { citationWarnings, warn } = await run("A applies [1]; B too [2].");
    expect(citationWarnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a cited index that matches no retrieved document", async () => {
    const { citationWarnings } = await run("A applies [1]; so does C [7].");
    expect(citationWarnings).toEqual([
      { kind: "invalid_citation", indices: [7] },
    ]);
  });

  it("reports an answer with no citations at all", async () => {
    const { citationWarnings } = await run("The deadline is April 15.");
    expect(citationWarnings).toEqual([{ kind: "uncited_answer" }]);
  });

  it("reports both when the only citations are fabricated", async () => {
    const { citationWarnings } = await run("The deadline is April 15 [9].");
    expect(citationWarnings).toEqual([
      { kind: "invalid_citation", indices: [9] },
      { kind: "uncited_answer" },
    ]);
  });

  it("does not flag an uncited model refusal", async () => {
    const { citationWarnings } = await run(EMPTY_ANSWER);
    expect(citationWarnings).toEqual([]);
  });

  it("logs warnings with the answerId and never the answer text", async () => {
    const { warn, answerId } = await run("Secret client figure is 42 [5].");
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toEqual({
      answerId,
      citationWarnings: [
        { kind: "invalid_citation", indices: [5] },
        { kind: "uncited_answer" },
      ],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Secret client");
  });

  it("reports no warnings on the empty-retrieval short-circuit", async () => {
    const { citationWarnings, warn } = await run("unused", 0);
    expect(citationWarnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
