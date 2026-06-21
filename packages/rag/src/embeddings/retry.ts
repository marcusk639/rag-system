/**
 * Bounded exponential-backoff retry for embedding API calls.
 *
 * Embedding providers — the Gemini free tier especially — return
 * `429 RESOURCE_EXHAUSTED` under bursty load (e.g. embedding every chunk of a
 * freshly-synced source at once). Without retry, one rate-limited call fails
 * the whole document. This wraps a call so transient rate-limit errors
 * self-heal: it retries with exponential backoff + full jitter, never waiting
 * less than a server-provided `Retry-After`, and rethrows once attempts are
 * exhausted (or immediately for non-retryable errors).
 */

export interface RetryOptions {
  /** Max retry attempts AFTER the first try. 0 disables retrying. */
  maxRetries?: number;
  /** Base backoff in ms; doubled each attempt before jitter. */
  baseDelayMs?: number;
  /** Cap on any single backoff in ms. */
  maxDelayMs?: number;
  /** Injectable sleeper — tests pass a no-op to avoid real delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1) — tests pass a constant. */
  random?: () => number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** True when an error is a transient rate-limit / quota-exhaustion signal. */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    code?: number | string;
    message?: string;
  };
  if (e.status === 429 || e.code === 429 || e.code === "429") return true;
  const msg = String(e.message ?? err).toUpperCase();
  return (
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("RATE LIMIT") ||
    msg.includes("RATE_LIMIT") ||
    msg.includes("TOO MANY REQUESTS") ||
    // Bare "429" only counts as a rate-limit signal when it sits next to a
    // status-ish word, so a stray "429" in document/metadata text echoed into
    // an unrelated error message is not misclassified and needlessly retried.
    /\b(?:HTTP|STATUS|CODE|ERROR)\b[^0-9]{0,5}429\b/.test(msg)
  );
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, if any. */
function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> | Headers })
    ?.headers;
  if (!headers) return undefined;
  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("retry-after")
      : (headers as Record<string, string>)["retry-after"];
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

/**
 * Run `fn`, retrying transient rate-limit errors with capped exponential
 * backoff + jitter. Non-rate-limit errors propagate immediately.
 */
export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRateLimitError(err)) throw err;
      const expo = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      // Half jitter: a random point in [0.5, 1.0]x the capped exponential —
      // spreads concurrent retries without ever collapsing toward ~0ms.
      const jittered = expo * (0.5 + random() * 0.5);
      // Honor a server Retry-After as a floor, but clamp to maxDelayMs so a
      // hostile/misconfigured `Retry-After: 3600` can't stall the worker.
      const delay = Math.min(
        maxDelayMs,
        Math.max(retryAfterMs(err) ?? 0, jittered),
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}
