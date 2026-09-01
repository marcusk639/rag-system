/**
 * Bounded exponential-backoff retry for embedding API calls.
 *
 * Embedding providers — the Gemini free tier especially — return
 * `429 RESOURCE_EXHAUSTED` under bursty load (e.g. embedding every chunk of a
 * freshly-synced source at once). Without retry, one rate-limited call fails
 * the whole document. This wraps a call so transient rate-limit errors
 * self-heal: it retries with exponential backoff + half jitter, never waiting
 * less than the server asked for, and rethrows once attempts are exhausted (or
 * immediately for non-retryable errors).
 *
 * "What the server asked for" has two conventions and both are honored: a
 * `Retry-After` header (OpenAI) and a `google.rpc.RetryInfo` detail in the
 * error BODY (Google). The second matters because @google/genai's exported
 * `ApiError` carries `status` but no `headers` at all, so a header-only reader
 * discards Gemini's guidance entirely.
 *
 * NOTE: backoff is the net for a 429 you could not predict. It does not help
 * against a burst you are about to cause yourself — every retry spends another
 * request against the same exhausted window, and the default budget
 * (~8-15s across 5 attempts) is far shorter than a per-minute window anyway.
 * See `throttle.ts`, which paces requests so the limit is never reached.
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
function retryAfterHeaderMs(err: unknown): number | undefined {
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
 * Parse a protobuf Duration (`"7s"`, `"1.5s"`, or `{seconds, nanos}`) into ms.
 */
function durationMs(d: unknown): number | undefined {
  if (typeof d === "string") {
    const m = /^([0-9]*\.?[0-9]+)s$/.exec(d.trim());
    if (!m) return undefined;
    const secs = Number(m[1]);
    return Number.isFinite(secs) ? Math.max(0, secs * 1000) : undefined;
  }
  if (d && typeof d === "object") {
    const o = d as { seconds?: number | string; nanos?: number };
    const secs = Number(o.seconds ?? 0);
    const nanos = Number(o.nanos ?? 0);
    if (!Number.isFinite(secs) || !Number.isFinite(nanos)) return undefined;
    return Math.max(0, secs * 1000 + nanos / 1e6);
  }
  return undefined;
}

/** Pull `details[]` out of the several shapes an error body arrives in. */
function errorDetails(err: unknown): unknown[] {
  const e = err as {
    error?: { details?: unknown[] };
    response?: { data?: { error?: { details?: unknown[] } } };
    message?: string;
  };
  if (Array.isArray(e?.error?.details)) return e.error.details;
  if (Array.isArray(e?.response?.data?.error?.details))
    return e.response.data.error.details;
  // @google/genai's exported `ApiError` carries `status` but NO structured
  // body — it stringifies the response into the message. Without this branch
  // the server's own guidance is unreachable on the Gemini path.
  const msg = e?.message;
  if (typeof msg === "string") {
    const start = msg.indexOf("{");
    if (start !== -1) {
      try {
        const parsed = JSON.parse(msg.slice(start)) as {
          error?: { details?: unknown[] };
        };
        if (Array.isArray(parsed?.error?.details)) return parsed.error.details;
      } catch {
        // Not JSON, or truncated. No guidance available; fall through.
      }
    }
  }
  return [];
}

/**
 * `google.rpc.RetryInfo.retryDelay`, if the server sent one.
 *
 * Google's quota errors put retry guidance in the error BODY rather than a
 * `Retry-After` header, so a header-only reader silently discards it.
 */
function retryInfoMs(err: unknown): number | undefined {
  for (const d of errorDetails(err)) {
    const detail = d as { "@type"?: string; retryDelay?: unknown };
    if (
      typeof detail?.["@type"] === "string" &&
      detail["@type"].endsWith("google.rpc.RetryInfo")
    ) {
      const ms = durationMs(detail.retryDelay);
      if (ms !== undefined) return ms;
    }
  }
  return undefined;
}

/**
 * The longest server-provided floor available, across both conventions.
 *
 * Both a `Retry-After` header and a `RetryInfo` body are floors rather than
 * targets, so when a server sends both, honoring the shorter would ignore
 * guidance it also gave.
 */
function retryAfterMs(err: unknown): number | undefined {
  const candidates = [retryAfterHeaderMs(err), retryInfoMs(err)].filter(
    (v): v is number => v !== undefined,
  );
  return candidates.length ? Math.max(...candidates) : undefined;
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
