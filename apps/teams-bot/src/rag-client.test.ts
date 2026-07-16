/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { askKb, KbUnavailableError } from "./rag-client.js";

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
