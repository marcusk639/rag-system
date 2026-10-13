import { describe, expect, it, vi } from "vitest";
import type { AskStreamEvent } from "@rag/services";
import { pumpAskStream } from "./ask.js";

function events(): {
  iterable: AsyncGenerator<AskStreamEvent>;
  produced: string[];
  returned: () => boolean;
} {
  const produced: string[] = [];
  let returned = false;
  async function* gen(): AsyncGenerator<AskStreamEvent> {
    try {
      for (const t of ["a", "b", "c", "d"]) {
        produced.push(t);
        yield { type: "token", text: t };
      }
    } finally {
      returned = true;
    }
  }
  return { iterable: gen(), produced, returned: () => returned };
}

describe("pumpAskStream", () => {
  it("writes every event while the client is connected", async () => {
    const e = events();
    const write = vi.fn();
    const onDone = vi.fn();
    await pumpAskStream(e.iterable, { write, isClosed: () => false, onDone });
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("stops pulling from the generator once the client disconnects, releasing the provider stream", async () => {
    const e = events();
    let closed = false;
    const write = vi.fn(() => {
      if (write.mock.calls.length === 2) closed = true;
    });
    await pumpAskStream(e.iterable, {
      write,
      isClosed: () => closed,
      onDone: vi.fn(),
    });
    expect(write).toHaveBeenCalledTimes(2);
    // The generator was finalized (its `finally` ran) instead of being drained.
    expect(e.returned()).toBe(true);
    expect(e.produced).toEqual(["a", "b"]);
  });

  it("still audits a completed answer when the client closed just before the done event", async () => {
    async function* gen(): AsyncGenerator<AskStreamEvent> {
      yield {
        type: "done",
        citations: [],
        citationWarnings: [],
        retrieved: [],
        reviewStatus: "draft_requires_practitioner_review",
        disclaimer: "d",
        answerId: "a",
      };
    }
    const write = vi.fn();
    const onDone = vi.fn();
    await pumpAskStream(gen(), { write, isClosed: () => true, onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("forwards citationWarnings on the SSE done event", async () => {
    async function* gen(): AsyncGenerator<AskStreamEvent> {
      yield {
        type: "done",
        citations: [],
        citationWarnings: [{ kind: "invalid_citation", indices: [7] }],
        retrieved: [],
        reviewStatus: "draft_requires_practitioner_review",
        disclaimer: "d",
        answerId: "a",
      };
    }
    const write = vi.fn();
    await pumpAskStream(gen(), {
      write,
      isClosed: () => false,
      onDone: vi.fn(),
    });
    const frame = String(write.mock.calls[0]?.[0]);
    const data = JSON.parse(frame.slice(frame.indexOf("data: ") + 6).trim());
    expect(data.citationWarnings).toEqual([
      { kind: "invalid_citation", indices: [7] },
    ]);
  });
});
