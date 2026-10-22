import { afterEach, describe, expect, it, vi } from "vitest";
import { askStream, type AskStreamHandlers } from "./stream-chat";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join("")));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function handlers() {
  return {
    onToken: vi.fn<AskStreamHandlers["onToken"]>(),
    onDone: vi.fn<AskStreamHandlers["onDone"]>(),
    onError: vi.fn<AskStreamHandlers["onError"]>(),
  };
}

describe("askStream done event", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes citationWarnings from the done frame to onDone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: token\ndata: "Answer [5]"\n\n',
          `event: done\ndata: ${JSON.stringify({
            citations: [],
            answerId: "a-1",
            citationWarnings: [
              { kind: "invalid_citation", indices: [5] },
              { kind: "uncited_answer" },
            ],
          })}\n\n`,
        ]),
      ),
    );
    const h = handlers();
    await askStream({ question: "q" }, h);
    expect(h.onDone).toHaveBeenCalledWith([], "a-1", [
      { kind: "invalid_citation", indices: [5] },
      { kind: "uncited_answer" },
    ]);
  });

  it("defaults citationWarnings to [] for a server that does not send them", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            `event: done\ndata: ${JSON.stringify({ citations: [], answerId: "a-2" })}\n\n`,
          ]),
        ),
    );
    const h = handlers();
    await askStream({ question: "q" }, h);
    expect(h.onDone).toHaveBeenCalledWith([], "a-2", []);
  });
});
