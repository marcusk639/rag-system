import { describe, expect, it } from "vitest";
import { createThrottle } from "./throttle.js";

/**
 * Why this exists.
 *
 * `retryOnRateLimit` reacts to a 429 after it happens. That is the wrong tool
 * when the burst is self-inflicted and predictable: a 453 KB document chunks
 * into several batches which the embedder issued back to back, tripping the
 * per-minute request limit. Every retry then backed off into the same still-full
 * window and the document failed permanently at 0 chunks — while the 47 smaller
 * documents around it embedded fine, and a single manual call succeeded.
 *
 * A throttle prevents the burst instead of recovering from it. The two are
 * complements: pacing for the limit we can predict, backoff for the 429 we
 * cannot.
 *
 * Tests drive a fake clock and a fake sleep so they assert the PACING DECISIONS
 * rather than wall-clock time — same seam `retry.ts` uses.
 */

/** Fake clock + sleep. `sleep` advances `now`, so waits compose correctly. */
function fakeTime(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  advance: (ms: number) => void;
} {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createThrottle", () => {
  it("does not delay when no limit is configured", async () => {
    const clk = fakeTime();
    const run = createThrottle({ ...clk });

    for (let i = 0; i < 5; i++) await run(async () => i);

    expect(clk.slept).toEqual([]);
  });

  it("does not delay the first call", async () => {
    // Paying the interval before the first request would slow every ingest for
    // no benefit — the limit only binds once a window has requests in it.
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 60, ...clk });

    await run(async () => "first");

    expect(clk.slept).toEqual([]);
  });

  it("spaces subsequent calls by the minimum interval", async () => {
    // 60/min => one per 1000ms.
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 60, ...clk });

    await run(async () => 1);
    await run(async () => 2);
    await run(async () => 3);

    expect(clk.slept).toEqual([1000, 1000]);
  });

  it("does not delay when the caller was already slow enough", async () => {
    // The work itself often takes longer than the interval. Sleeping on top of
    // that would halve throughput for nothing.
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 60, ...clk });

    await run(async () => 1);
    clk.advance(5000); // caller did other work
    await run(async () => 2);

    expect(clk.slept).toEqual([]);
  });

  it("waits only the remaining time when partially elapsed", async () => {
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 60, ...clk });

    await run(async () => 1);
    clk.advance(400);
    await run(async () => 2);

    expect(clk.slept).toEqual([600]);
  });

  it("returns the function's value and preserves order", async () => {
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 120, ...clk });

    const out = [
      await run(async () => "a"),
      await run(async () => "b"),
      await run(async () => "c"),
    ];

    expect(out).toEqual(["a", "b", "c"]);
  });

  it("propagates errors without swallowing them", async () => {
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 60, ...clk });

    await expect(
      run(async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });

  it("still paces after a failed call", async () => {
    // A 429 is exactly when pacing matters most. If a throw skipped the
    // interval bookkeeping, a retry storm would hammer the limit it just hit.
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 60, ...clk });

    await expect(
      run(async () => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    await run(async () => "next");

    expect(clk.slept).toEqual([1000]);
  });

  it("serialises concurrent callers rather than letting them burst", async () => {
    // Two callers entering together must not both see an empty window and fire
    // at once — that is the burst this exists to prevent.
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 60, ...clk });

    await Promise.all([
      run(async () => 1),
      run(async () => 2),
      run(async () => 3),
    ]);

    expect(clk.slept).toEqual([1000, 1000]);
  });

  it("treats a non-positive rate as unlimited rather than dividing by zero", async () => {
    const clk = fakeTime();
    const run = createThrottle({ requestsPerMinute: 0, ...clk });

    await run(async () => 1);
    await run(async () => 2);

    expect(clk.slept).toEqual([]);
  });
});
