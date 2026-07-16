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
        { index: 1, title: "SOP", documentId: "d1", downloadable: false },
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
