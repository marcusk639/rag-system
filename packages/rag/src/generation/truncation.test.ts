import { describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@rag/core";
import { EgressPolicy } from "@rag/core";
import {
  ClaudeGenerator,
  GeminiGenerator,
  OpenAIGenerator,
  TRUNCATION_NOTICE,
} from "./generator.js";

const CONTEXT = [
  {
    text: "File the engagement letter.",
    score: 1,
    denseScore: 1,
    sparseScore: 0,
    document: { id: "d", title: "SOP", sourceId: "s", metadata: {} },
    chunk: { id: "c", ordinal: 0, headingPath: [] },
  },
] as unknown as RetrievalResult[];

const base = {
  apiKey: "k",
  model: "m",
  egressPolicy: new EgressPolicy([
    "generativelanguage.googleapis.com",
    "api.openai.com",
    "api.anthropic.com",
  ]),
  triPolicy: "warn" as const,
};

/** Reach the SDK client a generator wraps, to stub its network call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = (gen: unknown): any => (gen as { client: unknown }).client;

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const t of stream) out += t;
  return out;
}

describe("Gemini truncation", () => {
  it("appends the truncation notice and reports it when finishReason is MAX_TOKENS", async () => {
    const onTruncated = vi.fn();
    const gen = new GeminiGenerator({ ...base, onTruncated });
    client(gen).models.generateContent = vi.fn().mockResolvedValue({
      text: "1. Create the record [1]",
      candidates: [{ finishReason: "MAX_TOKENS" }],
    });

    const r = await gen.answer("q", CONTEXT);

    expect(r.answer).toBe(`1. Create the record [1]${TRUNCATION_NOTICE}`);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it("leaves a normally finished answer alone", async () => {
    const onTruncated = vi.fn();
    const gen = new GeminiGenerator({ ...base, onTruncated });
    client(gen).models.generateContent = vi.fn().mockResolvedValue({
      text: "done [1]",
      candidates: [{ finishReason: "STOP" }],
    });
    expect((await gen.answer("q", CONTEXT)).answer).toBe("done [1]");
    expect(onTruncated).not.toHaveBeenCalled();
  });

  it("streams the notice after the last token when the stream ends on MAX_TOKENS", async () => {
    const gen = new GeminiGenerator(base);
    client(gen).models.generateContentStream = vi.fn().mockResolvedValue(
      (async function* () {
        yield { text: "part one ", candidates: [{}] };
        yield {
          text: "part two",
          candidates: [{ finishReason: "MAX_TOKENS" }],
        };
      })(),
    );
    expect(await collect(gen.answerStream("q", CONTEXT))).toBe(
      `part one part two${TRUNCATION_NOTICE}`,
    );
  });

  it("sends an explicit thinking budget when one is configured", async () => {
    const gen = new GeminiGenerator({ ...base, thinkingBudget: 512 });
    const generateContent = vi
      .fn()
      .mockResolvedValue({ text: "x", candidates: [{ finishReason: "STOP" }] });
    client(gen).models.generateContent = generateContent;
    await gen.answer("q", CONTEXT);
    expect(generateContent.mock.calls[0]?.[0].config.thinkingConfig).toEqual({
      thinkingBudget: 512,
    });
  });
});

describe("OpenAI truncation", () => {
  it("appends the notice when finish_reason is length", async () => {
    const gen = new OpenAIGenerator(base);
    client(gen).chat.completions.create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "partial" }, finish_reason: "length" }],
    });
    expect((await gen.answer("q", CONTEXT)).answer).toBe(
      `partial${TRUNCATION_NOTICE}`,
    );
  });

  it("streams the notice when a chunk reports finish_reason length", async () => {
    const gen = new OpenAIGenerator(base);
    client(gen).chat.completions.create = vi.fn().mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { content: "partial" } }] };
        yield { choices: [{ delta: {}, finish_reason: "length" }] };
      })(),
    );
    expect(await collect(gen.answerStream("q", CONTEXT))).toBe(
      `partial${TRUNCATION_NOTICE}`,
    );
  });
});

describe("Claude truncation", () => {
  it("appends the notice when stop_reason is max_tokens", async () => {
    const gen = new ClaudeGenerator(base);
    client(gen).messages.create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
    });
    expect((await gen.answer("q", CONTEXT)).answer).toBe(
      `partial${TRUNCATION_NOTICE}`,
    );
  });

  it("streams the notice when the message_delta stop_reason is max_tokens", async () => {
    const gen = new ClaudeGenerator(base);
    client(gen).messages.stream = vi.fn().mockReturnValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial" },
        };
        yield { type: "message_delta", delta: { stop_reason: "max_tokens" } };
      })(),
    );
    expect(await collect(gen.answerStream("q", CONTEXT))).toBe(
      `partial${TRUNCATION_NOTICE}`,
    );
  });
});
