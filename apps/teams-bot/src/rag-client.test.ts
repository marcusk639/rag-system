/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  askKb,
  KbUnavailableError,
  KbUserFacingError,
  submitFeedback,
} from "./rag-client.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("askKb", () => {
  it("posts to /ask with bearer token and X-RAG-Channel: teams, returns the answer", async () => {
    const fetchMock = fakeFetch(200, {
      answer: "Per SOP-1...",
      citations: [
        {
          index: 1,
          title: "SOP",
          documentId: "d1",
          downloadable: false,
          url: "https://contoso.sharepoint.com/sites/kb/SOP.docx",
        },
      ],
      disclaimer: "AI draft",
    });
    const out = await askKb(
      { question: "q?", scopeToken: "tok" },
      { ragApiUrl: "http://api", fetch: fetchMock as any },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://api/ask");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok",
    );
    expect((init.headers as Record<string, string>)["X-RAG-Channel"]).toBe(
      "teams",
    );
    expect(out.answer).toBe("Per SOP-1...");
    expect(out.disclaimer).toBe("AI draft");
    expect(out.citations[0]?.url).toBe(
      "https://contoso.sharepoint.com/sites/kb/SOP.docx",
    );
  });
  it("throws KbUnavailableError on non-2xx without leaking the body", async () => {
    const fetchMock = fakeFetch(500, {
      error: { code: "X", message: "secret detail" },
    });
    await expect(
      askKb(
        { question: "q", scopeToken: "t" },
        { ragApiUrl: "http://api", fetch: fetchMock as any },
      ),
    ).rejects.toBeInstanceOf(KbUnavailableError);
  });
  it("passes an abort signal to fetch (upstream hangs are bounded)", async () => {
    const fetchMock = fakeFetch(200, {
      answer: "a",
      citations: [],
      disclaimer: "d",
    });
    await askKb(
      { question: "q", scopeToken: "t" },
      { ragApiUrl: "http://api", fetch: fetchMock as any },
    );
    const [, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("maps a timed-out fetch to KbUnavailableError (never leaks the abort)", async () => {
    // A fetch that never resolves on its own but honors the abort signal —
    // exactly how a hung upstream behaves under AbortSignal.timeout.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    await expect(
      askKb(
        { question: "q", scopeToken: "t" },
        { ragApiUrl: "http://api", fetch: fetchMock as any, timeoutMs: 10 },
      ),
    ).rejects.toBeInstanceOf(KbUnavailableError);
  });
  it("throws KbUnavailableError when fetch rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      askKb(
        { question: "q", scopeToken: "t" },
        { ragApiUrl: "http://api", fetch: fetchMock as any },
      ),
    ).rejects.toBeInstanceOf(KbUnavailableError);
  });
});

describe("askKb history", () => {
  it("forwards non-empty history and omits an empty one", async () => {
    const fetchMock = fakeFetch(200, { answer: "a", citations: [], disclaimer: "d" });
    await askKb(
      { question: "q", scopeToken: "t", history: [{ role: "user", content: "h" }] },
      { ragApiUrl: "http://api", fetch: fetchMock as any },
    );
    await askKb(
      { question: "q", scopeToken: "t", history: [] },
      { ragApiUrl: "http://api", fetch: fetchMock as any },
    );
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse(String((c as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies[0]).toEqual({ question: "q", history: [{ role: "user", content: "h" }] });
    expect(bodies[1]).toEqual({ question: "q" });
  });
});

describe("submitFeedback", () => {
  it("posts the vote to /feedback with the scope token and X-RAG-Channel: teams", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await submitFeedback(
      { answerId: "a1", rating: "helpful", scopeToken: "tok" },
      { ragApiUrl: "http://api", fetch: fetchMock as any },
    );
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://api/feedback");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect((init.headers as Record<string, string>)["X-RAG-Channel"]).toBe("teams");
    expect(JSON.parse(String(init.body))).toEqual({ answerId: "a1", rating: "helpful" });
  });

  it("throws KbUnavailableError on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(
      submitFeedback(
        { answerId: "a1", rating: "helpful", scopeToken: "tok" },
        { ragApiUrl: "http://api", fetch: fetchMock as any },
      ),
    ).rejects.toBeInstanceOf(KbUnavailableError);
  });
});

describe("askKb error differentiation", () => {
  const cases: Array<[number, RegExp]> = [
    [422, /client identifiers/i],
    [429, /wait/i],
    [401, /credentials|sign/i],
    [403, /credentials|sign/i],
    [400, /rephras/i],
    [500, /temporarily unavailable/i],
    [503, /temporarily unavailable/i],
  ];
  for (const [status, message] of cases) {
    it(`maps HTTP ${status} to a user-safe message`, async () => {
      const fetchMock = fakeFetch(status, { error: { message: "internal detail" } });
      const err = await askKb(
        { question: "q", scopeToken: "t" },
        { ragApiUrl: "http://api", fetch: fetchMock as any },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KbUserFacingError);
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toContain("internal detail");
    });
  }
});
