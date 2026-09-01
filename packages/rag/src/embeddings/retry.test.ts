import { describe, expect, it, vi } from "vitest";
import { isRateLimitError, retryOnRateLimit } from "./retry.js";

const noSleep = () => Promise.resolve();
const noJitter = () => 0; // deterministic backoff in assertions

describe("isRateLimitError", () => {
  it("detects HTTP 429 by status or code", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ code: 429 })).toBe(true);
    expect(isRateLimitError({ code: "429" })).toBe(true);
  });

  it("detects rate-limit / quota messages", () => {
    expect(isRateLimitError(new Error("429 RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isRateLimitError(new Error("You exceeded your rate limit"))).toBe(
      true,
    );
    expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isRateLimitError(new Error("invalid api key"))).toBe(false);
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe("retryOnRateLimit", () => {
  it("returns immediately on success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryOnRateLimit(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a rate-limit error then succeeds", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }),
      )
      .mockResolvedValue("ok");
    await expect(
      retryOnRateLimit(fn, { sleep, random: noJitter }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rethrows immediately for non-rate-limit errors", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn().mockRejectedValue(new Error("bad request"));
    await expect(retryOnRateLimit(fn, { sleep })).rejects.toThrow(
      "bad request",
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const sleep = vi.fn(noSleep);
    const err = Object.assign(new Error("429"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryOnRateLimit(fn, { sleep, maxRetries: 3, random: noJitter }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry when maxRetries is 0", async () => {
    const sleep = vi.fn(noSleep);
    const err = Object.assign(new Error("429"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryOnRateLimit(fn, { sleep, maxRetries: 0 })).rejects.toBe(
      err,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses exponential backoff and honors Retry-After as a floor", async () => {
    const delays: number[] = [];
    const sleep = vi.fn((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const rl = (retryAfter?: string) =>
      Object.assign(new Error("429"), {
        status: 429,
        ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
      });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rl()) // attempt 0 -> base 500 * 1
      .mockRejectedValueOnce(rl()) // attempt 1 -> base 500 * 2 = 1000
      .mockRejectedValueOnce(rl("5")) // attempt 2 -> Retry-After 5s floor beats 2000
      .mockResolvedValue("ok");
    await expect(
      retryOnRateLimit(fn, {
        sleep,
        baseDelayMs: 500,
        random: noJitter, // jitter factor 0.5
      }),
    ).resolves.toBe("ok");
    // full-jitter with random()=0 => delay = expo * 0.5
    expect(delays[0]).toBe(250);
    expect(delays[1]).toBe(500);
    expect(delays[2]).toBe(5000); // Retry-After floor
  });
});

describe("server-provided retry guidance", () => {
  // The helper previously understood only the `Retry-After` HEADER. Google's
  // convention for quota errors is `google.rpc.RetryInfo` in the error BODY,
  // and @google/genai's exported `ApiError` carries `status` but no `headers`
  // at all — so any guidance Gemini sent was discarded and the backoff fell
  // back to its own schedule. OpenAI does send the header, and this same
  // helper serves that path, so both shapes have to work.

  const run = (err: unknown, sleeps: number[]) =>
    retryOnRateLimit(() => Promise.reject(err), {
      maxRetries: 1,
      baseDelayMs: 10, // tiny, so any wait we see came from the server
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0,
    }).catch(() => undefined);

  it("honors RetryInfo in a structured error body", async () => {
    const sleeps: number[] = [];
    await run(
      {
        status: 429,
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "7s",
            },
          ],
        },
      },
      sleeps,
    );
    expect(sleeps).toEqual([7000]);
  });

  it("honors RetryInfo embedded as JSON in the message", async () => {
    // The shape actually observed: the SDK stringifies the response body into
    // the Error message and exposes no structured body.
    const sleeps: number[] = [];
    await run(
      {
        status: 429,
        message:
          'Gemini embedding failed: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}]}}',
      },
      sleeps,
    );
    expect(sleeps).toEqual([12000]);
  });

  it("parses fractional retryDelay", async () => {
    const sleeps: number[] = [];
    await run(
      {
        status: 429,
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "1.5s",
            },
          ],
        },
      },
      sleeps,
    );
    expect(sleeps).toEqual([1500]);
  });

  it("still honors the Retry-After header (OpenAI path)", async () => {
    const sleeps: number[] = [];
    await run({ status: 429, headers: { "retry-after": "9" } }, sleeps);
    expect(sleeps).toEqual([9000]);
  });

  it("takes the larger when both header and RetryInfo are present", async () => {
    // Both are floors, not targets. Waiting the shorter one would ignore
    // guidance the server also gave.
    const sleeps: number[] = [];
    await run(
      {
        status: 429,
        headers: { "retry-after": "3" },
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "8s",
            },
          ],
        },
      },
      sleeps,
    );
    expect(sleeps).toEqual([8000]);
  });

  it("ignores malformed RetryInfo rather than throwing", async () => {
    const sleeps: number[] = [];
    await run(
      {
        status: 429,
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "not-a-duration",
            },
          ],
        },
      },
      sleeps,
    );
    // Falls back to the jittered schedule: base 10ms, random()=0 => 0.5x => 5ms
    expect(sleeps).toEqual([5]);
  });

  it("ignores unrelated detail types", async () => {
    const sleeps: number[] = [];
    await run(
      {
        status: 429,
        error: {
          details: [
            { "@type": "type.googleapis.com/google.rpc.Help", links: [] },
          ],
        },
      },
      sleeps,
    );
    expect(sleeps).toEqual([5]);
  });

  it("is still clamped by maxDelayMs", async () => {
    // A hostile or misconfigured RetryInfo must not stall the worker, same
    // guarantee the header path already had.
    const sleeps: number[] = [];
    await retryOnRateLimit(
      () =>
        Promise.reject({
          status: 429,
          error: {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: "3600s",
              },
            ],
          },
        }),
      {
        maxRetries: 1,
        baseDelayMs: 10,
        maxDelayMs: 30_000,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        random: () => 0,
      },
    ).catch(() => undefined);
    expect(sleeps).toEqual([30_000]);
  });
});
