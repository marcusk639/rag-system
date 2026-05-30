import { ConnectorAuthError, ConnectorTransientError } from "@rag/core";

/**
 * Shape of an error coming out of Microsoft Graph / Google APIs.
 * Both wrap an HTTP status code and a message somewhere on the error object.
 */
interface HttpishError {
  status?: number;
  statusCode?: number;
  code?: number | string;
  response?: {
    status?: number;
    statusCode?: number;
    headers?: Record<string, string | string[] | undefined>;
    data?: unknown;
  };
  headers?: Record<string, string | string[] | undefined>;
  message?: string;
  body?: unknown;
}

/** Pull a numeric HTTP status off an unknown error from a remote API. */
export function getHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as HttpishError;
  const candidates = [
    e.status,
    e.statusCode,
    e.response?.status,
    e.response?.statusCode,
    typeof e.code === "number" ? e.code : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

/** Pull a Retry-After header (in seconds) off an error, if present. */
export function getRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as HttpishError;
  const headers = e.response?.headers ?? e.headers;
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map an error from a remote API (Graph or Google) to a typed connector error.
 * Falls back to rethrowing the original error if it's not auth/transient.
 *
 *   401 / 403       → ConnectorAuthError
 *   429 / 5xx / network → ConnectorTransientError
 *   anything else   → original error rethrown
 */
export function mapApiError(err: unknown, context: string): never {
  const status = getHttpStatus(err);

  if (status === 401 || status === 403) {
    throw new ConnectorAuthError(
      `${context}: auth failed (HTTP ${status})`,
      err,
    );
  }

  if (status === 429 || (typeof status === "number" && status >= 500)) {
    const retry = getRetryAfterSeconds(err);
    const suffix = retry !== undefined ? ` (retry-after ${retry}s)` : "";
    throw new ConnectorTransientError(
      `${context}: transient HTTP ${status}${suffix}`,
      err,
    );
  }

  // Network-level errors (ECONNRESET, ETIMEDOUT, etc) — treat as transient.
  const code = (err as { code?: string } | null)?.code;
  if (
    typeof code === "string" &&
    (code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ECONNREFUSED")
  ) {
    throw new ConnectorTransientError(
      `${context}: network error (${code})`,
      err,
    );
  }

  throw err;
}
