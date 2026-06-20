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
