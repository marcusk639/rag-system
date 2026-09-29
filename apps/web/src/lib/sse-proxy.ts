/**
 * Streaming-proxy guards for the /api/chat BFF.
 *
 * The API commits its 200 and SSE headers before retrieval and generation
 * start, so a fetch timeout alone can only bound the time to headers. A
 * generation that hangs after that would leave the browser spinner running
 * forever; an idle timeout on the body bounds it without cutting off a long
 * answer that is still producing tokens.
 */

/** Time allowed for the API to answer with headers. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;
/** Longest silence tolerated between streamed chunks. */
export const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

const TIMEOUT_EVENT = new TextEncoder().encode(
  `event: error\ndata: ${JSON.stringify({ message: "The answer timed out. Please try again." })}\n\n`,
);

/**
 * Re-emit `source`, but if no chunk arrives for `idleMs`, cancel the source,
 * call `onTimeout` (e.g. to abort the upstream request), and end the stream
 * with an SSE `error` event the chat client already understands.
 */
export function withIdleTimeout(
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  onTimeout: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), idleMs);
      });
      const result = await Promise.race([reader.read(), timedOut]);
      clearTimeout(timer);

      if (result === "timeout") {
        onTimeout();
        await reader.cancel().catch(() => undefined);
        controller.enqueue(TIMEOUT_EVENT);
        controller.close();
        return;
      }
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      clearTimeout(timer);
      await reader.cancel(reason);
    },
  });
}
