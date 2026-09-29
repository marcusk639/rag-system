import { describe, expect, it } from "vitest";
import {
  buildUpstreamAskBody,
  MAX_FORWARDED_HISTORY_TURNS,
  toHistory,
} from "./chat-request";

describe("toHistory", () => {
  it("keeps only role and content of completed turns", () => {
    expect(
      toHistory([
        { id: "1", role: "user", content: "q1" },
        {
          id: "2",
          role: "assistant",
          content: "a1 [1]",
          citations: [
            { index: 1, documentId: "d", title: "t", chunkId: "c", score: 1 },
          ],
          answerId: "x",
        },
        { id: "3", role: "assistant", content: "", error: "boom" },
        { id: "4", role: "assistant", content: "" },
      ]),
    ).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1 [1]" },
    ]);
  });
});

describe("buildUpstreamAskBody", () => {
  it("forwards only question, sourceIds, and history — never client-chosen topK or filters", () => {
    expect(
      buildUpstreamAskBody({
        question: "q",
        sourceIds: ["s"],
        topK: 100,
        filter: { a: "b" },
        history: [{ role: "user", content: "earlier" }],
      }),
    ).toEqual({
      question: "q",
      sourceIds: ["s"],
      history: [{ role: "user", content: "earlier" }],
    });
  });

  it("sends only the most recent turns the API accepts", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn-${i}`,
    }));
    const body = buildUpstreamAskBody({ question: "q", history });
    expect(body.history).toHaveLength(12);
    expect(body.history?.[11]?.content).toBe("turn-29");
  });

  it("drops malformed history entries rather than forwarding them", () => {
    const body = buildUpstreamAskBody({
      question: "q",
      history: [
        { role: "system", content: "x" },
        { role: "user", content: 5 },
        "junk",
        { role: "user", content: "ok" },
      ],
    });
    expect(body.history).toEqual([{ role: "user", content: "ok" }]);
  });

  it("omits history when there is none", () => {
    expect(buildUpstreamAskBody({ question: "q" })).toEqual({ question: "q" });
  });
});

describe("MAX_FORWARDED_HISTORY_TURNS", () => {
  it("matches the API's history bound in @rag/core", async () => {
    const { MAX_HISTORY_TURNS } = await import("@rag/core");
    expect(MAX_FORWARDED_HISTORY_TURNS).toBe(MAX_HISTORY_TURNS);
  });
});
