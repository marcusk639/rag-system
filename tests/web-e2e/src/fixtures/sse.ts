import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __sse: string[];
  }
}

/**
 * Captures the raw bytes of the `/api/chat` SSE stream without disturbing
 * the app's own consumption of it.
 *
 * `page.route()` + `route.fetch()` was rejected: it BUFFERS the entire
 * response body before handing it back, which destroys the very streaming
 * behavior this suite exists to observe, and exercises a code path real
 * users never hit. Instead this wraps `window.fetch` in an init script and
 * calls `.tee()` on the response body — one branch is handed to the app
 * completely untouched (so the UI streams exactly as it would for a real
 * user), the other is drained here for the test to inspect.
 *
 * The test branch MUST be actively read in a loop: an unread
 * ReadableStream branch from `tee()` buffers internally without bound and
 * provides no backpressure relief, which would eventually stall the shared
 * source stream that the app branch also reads from.
 */
export async function captureSse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__sse = [];
    const originalFetch = window.fetch;
    window.fetch = async (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> => {
      const res = await originalFetch(...args);
      const [input] = args;
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (!url.includes("/api/chat") || !res.body) return res;

      const [appBranch, testBranch] = res.body.tee();

      // Drain loop: read to completion so the tee'd branch never backs up.
      void (async () => {
        const reader = testBranch.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          window.__sse.push(decoder.decode(value, { stream: true }));
        }
      })();

      return new Response(appBranch, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };
  });
}

/** Reads back the frames accumulated by {@link captureSse}'s drain loop. */
export async function readSse(page: Page): Promise<string> {
  return page.evaluate(() => window.__sse.join(""));
}
