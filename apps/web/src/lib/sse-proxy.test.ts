import { describe, expect, it, vi } from "vitest";
import { withIdleTimeout } from "./sse-proxy";

const enc = new TextEncoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}

describe("withIdleTimeout", () => {
  it("passes a live stream through unchanged", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: token\ndata: "a"\n\n'));
        c.close();
      },
    });
    const onTimeout = vi.fn();
    expect(await readAll(withIdleTimeout(source, 1_000, onTimeout))).toBe(
      'event: token\ndata: "a"\n\n',
    );
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("ends a stalled stream with an SSE error event and reports the timeout", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: token\ndata: "a"\n\n'));
        // …then nothing, ever.
      },
      cancel() {
        cancelled = true;
      },
    });
    const onTimeout = vi.fn();
    const body = await readAll(withIdleTimeout(source, 20, onTimeout));
    expect(body).toContain('event: token\ndata: "a"');
    expect(body).toContain("event: error");
    expect(body).toMatch(/timed out/i);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });
});
