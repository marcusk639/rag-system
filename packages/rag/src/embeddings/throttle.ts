/**
 * Client-side pacing for embedding requests.
 *
 * `retryOnRateLimit` handles the 429 we could not predict. This handles the one
 * we can: chunking a large document produces several batch calls that the
 * providers issue back to back, and a provider's per-minute request limit is
 * tripped by our own burst. Backoff does not help there — every retry lands in
 * the same still-full window — so the document fails permanently while smaller
 * documents around it succeed.
 *
 * Deliberately a MINIMUM INTERVAL rather than a token bucket. A bucket permits a
 * burst up to its capacity, which is exactly the shape that trips the limit; a
 * fixed floor between requests spends the same budget without ever spiking. It
 * is also the version an operator can reason about: `requestsPerMinute: 60`
 * means one request per second, always.
 */

export interface ThrottleOptions {
  /**
   * Requests per minute to pace to. Undefined, zero or negative disables
   * pacing entirely — the default, so nothing changes for deployments that
   * were not hitting a limit.
   */
  requestsPerMinute?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a `run(fn)` that paces its calls.
 *
 * Calls are serialised: each waits for the previous one to have STARTED at
 * least `interval` ago. Without that chaining, callers entering together would
 * each observe an empty window and fire simultaneously — the burst this exists
 * to prevent.
 */
export function createThrottle(
  opts: ThrottleOptions = {},
): <T>(fn: () => Promise<T>) => Promise<T> {
  const rpm = opts.requestsPerMinute ?? 0;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  if (!Number.isFinite(rpm) || rpm <= 0) {
    return <T>(fn: () => Promise<T>): Promise<T> => fn();
  }

  const intervalMs = 60_000 / rpm;
  let lastStart: number | undefined;
  // Chain of pending admissions. Awaiting the tail is what serialises callers.
  let gate: Promise<void> = Promise.resolve();

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const admitted = gate.then(async () => {
      if (lastStart !== undefined) {
        const elapsed = now() - lastStart;
        const wait = intervalMs - elapsed;
        // Only the REMAINING time: work that already took longer than the
        // interval has paid it, and sleeping again would halve throughput.
        if (wait > 0) await sleep(wait);
      }
      // Stamped before `fn` runs, so the interval measures start-to-start.
      // Measuring end-to-start would make pacing depend on latency and drift
      // slower than the configured rate under load.
      lastStart = now();
    });
    // Later callers queue behind this admission even if `fn` throws — a failed
    // call is usually the 429 itself, and dropping the pacing there would turn
    // a retry into a storm against the limit that just rejected us.
    gate = admitted.then(
      () => undefined,
      () => undefined,
    );
    await admitted;
    return fn();
  };
}
