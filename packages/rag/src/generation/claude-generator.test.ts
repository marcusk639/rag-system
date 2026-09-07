import { describe, expect, it } from "vitest";
import { ComplianceError, EgressPolicy } from "@rag/core";
import type { RetrievalResult } from "@rag/core";
import { ClaudeGenerator } from "./generator.js";

/**
 * Split out of `generator.test.ts` purely for the 800-line file cap; these
 * cover the Claude provider in `generator.ts` alongside the shared cases that
 * parametrise all three providers there.
 */
function rr(overrides: { text?: string; title?: string }): RetrievalResult {
  return {
    text: overrides.text ?? "safe chunk body",
    score: 1,
    denseScore: 1,
    sparseScore: 0,
    document: {
      id: "doc-1",
      title: overrides.title ?? "Safe Title",
      sourceId: "s",
      metadata: {},
    },
    chunk: { id: "c-1", ordinal: 0, headingPath: [] },
  } as unknown as RetrievalResult;
}

describe("ClaudeGenerator", () => {
  const TRANSPORT_REACHED = "stubbed-transport-reached";
  const ctx: RetrievalResult[] = [];

  function captureRequest(): {
    fetch: typeof fetch;
    body: () => Record<string, unknown>;
    url: () => string;
  } {
    let seenBody: Record<string, unknown> = {};
    let seenUrl = "";
    const f = (async (input: unknown, init?: { body?: string }) => {
      seenUrl = String(
        typeof input === "string" ? input : (input as { url?: string })?.url,
      );
      seenBody = JSON.parse(init?.body ?? "{}");
      throw new Error(TRANSPORT_REACHED);
    }) as unknown as typeof fetch;
    return { fetch: f, body: () => seenBody, url: () => seenUrl };
  }

  const base = (fetchImpl: typeof fetch) => ({
    apiKey: "test-key",
    model: "claude-opus-5",
    egressPolicy: new EgressPolicy(["api.anthropic.com"]),
    triPolicy: "off" as const,
    fetch: fetchImpl,
  });

  async function drive(gen: ClaudeGenerator): Promise<void> {
    try {
      await gen.answer("what is the onboarding process?", ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      const cause = (err as { cause?: unknown })?.cause;
      const causeMsg = cause instanceof Error ? cause.message : "";
      if (
        !msg.includes(TRANSPORT_REACHED) &&
        !causeMsg.includes(TRANSPORT_REACHED)
      ) {
        throw err;
      }
    }
  }

  it("never sends `temperature` — Claude 5 models reject it with a 400", async () => {
    // The other two providers in this module both set temperature: 0.2, so the
    // obvious way to write this class is to copy one of them. That produces a
    // provider that 400s on every request.
    const cap = captureRequest();
    await drive(new ClaudeGenerator(base(cap.fetch)));
    expect(cap.body()).not.toHaveProperty("temperature");
    expect(cap.body()).not.toHaveProperty("top_p");
    expect(cap.body()).not.toHaveProperty("top_k");
  });

  it("always sends max_tokens — the Anthropic API rejects a request without it", async () => {
    // Unlike the OpenAI path, where max_tokens is optional and omitted when
    // maxOutputTokens is unset, this field is required by the API.
    const cap = captureRequest();
    await drive(new ClaudeGenerator(base(cap.fetch)));
    expect(typeof cap.body().max_tokens).toBe("number");
    expect(cap.body().max_tokens as number).toBeGreaterThan(0);
  });

  it("sends the system prompt out-of-band, not as a user message", async () => {
    const cap = captureRequest();
    await drive(new ClaudeGenerator(base(cap.fetch)));
    expect(typeof cap.body().system).toBe("string");
    const messages = cap.body().messages as Array<{ role: string }>;
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("calls the host the egress pre-flight vouched for", async () => {
    const cap = captureRequest();
    await drive(new ClaudeGenerator(base(cap.fetch)));
    expect(new URL(cap.url()).hostname).toBe("api.anthropic.com");
  });

  it("refuses a host outside the egress allow-list", async () => {
    const cap = captureRequest();
    const gen = new ClaudeGenerator({
      ...base(cap.fetch),
      egressPolicy: new EgressPolicy(["api.openai.com"]),
    });
    await expect(gen.answer("q", ctx)).rejects.toThrow();
    expect(cap.url()).toBe("");
  });

  it("still blocks a TRI-matching prompt under triPolicy=block", async () => {
    const cap = captureRequest();
    const gen = new ClaudeGenerator({ ...base(cap.fetch), triPolicy: "block" });
    const triCtx = [
      rr({
        title: "Payroll SOP",
        text: "Confirm the Form 1040 refund does not exceed $25,000 before release.",
      }),
    ];
    await expect(
      gen.answer("what does the 1099 show?", triCtx),
    ).rejects.toBeInstanceOf(ComplianceError);
    expect(cap.url()).toBe("");
  });
});

describe("ClaudeGenerator — streaming", () => {
  const ctx: RetrievalResult[] = [
    rr({ title: "Onboarding SOP", text: "Step 1. Do the thing." }),
  ];

  /** Minimal SSE transport replaying the block shapes the Messages API emits. */
  function sseFetch(events: unknown[]): typeof fetch {
    const body = events
      .map(
        (e) =>
          `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`,
      )
      .join("");
    return (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
  }

  const opts = (fetchImpl: typeof fetch) => ({
    apiKey: "k",
    model: "claude-opus-5",
    egressPolicy: new EgressPolicy(["api.anthropic.com"]),
    triPolicy: "off" as const,
    fetch: fetchImpl,
  });

  it("yields text deltas as strings, and never yields thinking", async () => {
    const gen = new ClaudeGenerator(
      opts(
        sseFetch([
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-opus-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "SECRET REASONING" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Step 1." },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: " Do the thing [1]." },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const chunks: unknown[] = [];
    for await (const c of gen.answerStream("how do I onboard?", ctx)) {
      chunks.push(c);
    }

    expect(chunks.every((c) => typeof c === "string")).toBe(true);
    expect(chunks.join("")).toBe("Step 1. Do the thing [1].");
    expect(chunks.join("")).not.toContain("SECRET REASONING");
  });
});
