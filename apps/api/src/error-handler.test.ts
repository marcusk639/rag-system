import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyBaseLogger } from "fastify";
import pino from "pino";
import { ECHOABLE_ERROR_CODES, RagError } from "@rag/core";
import { captureException } from "@rag/runtime";
import { registerErrorHandler, STATUS_BY_CODE } from "./error-handler.js";

vi.mock("@rag/runtime", () => ({ captureException: vi.fn() }));

/**
 * Regression cover for a client-facing leak: the handler sent `error.message`
 * for EVERY `RagError`, including the ones that map to 5xx. Those messages are
 * built from internal detail — a failed connection string, a parser sidecar
 * URL, a provider's raw rejection — so the response contradicted this
 * function's own contract ("return a sanitized envelope to the client so we
 * never leak internal details (DB errors, stack frames, secret-laden URLs)").
 *
 * The 4xx echo is NOT a leak and is deliberately preserved: those messages are
 * about the caller's own request, and `COMPLIANCE_VIOLATION` in particular
 * exists so a blocked request can say something true instead of "Internal
 * server error".
 *
 * The sentinel below is asserted against the raw serialized body rather than a
 * parsed field, so a leak that lands in some other part of the envelope still
 * fails the test.
 */

const SENTINEL = "tr0ub4dorHORSEstaple";
const LEAKY_MESSAGE = `connect ECONNREFUSED postgres://rag:${SENTINEL}@db.internal:5432/rag`;

function buildApp(thrown: unknown) {
  const logLines: string[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write(line: string) {
        logLines.push(line);
      },
    },
  );
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
  });
  registerErrorHandler(app);
  app.get("/boom", async () => {
    throw thrown;
  });
  return { app, logLines };
}

async function inject(thrown: unknown) {
  const { app, logLines } = buildApp(thrown);
  const res = await app.inject({ method: "GET", url: "/boom" });
  await app.close();
  return { res, logLines };
}

describe("registerErrorHandler — unaudited RagError messages are not echoed", () => {
  // Every code in STATUS_BY_CODE that is NOT in ECHOABLE_ERROR_CODES, with
  // its status and the generic text the client should get instead.
  const suppressed: Array<[string, number, string]> = [
    ["CONNECTOR_AUTH_ERROR", 502, "Upstream service error"],
    ["PARSER_ERROR", 502, "Upstream service error"],
    ["EMBEDDING_ERROR", 502, "Upstream service error"],
    ["CONNECTOR_TRANSIENT_ERROR", 503, "Service temporarily unavailable"],
  ];

  it.each(suppressed)(
    "%s -> %i with a generic message and no internal detail",
    async (code, status, generic) => {
      const { res } = await inject(new RagError(LEAKY_MESSAGE, code));

      expect(res.statusCode).toBe(status);
      expect(res.body).not.toContain(SENTINEL);
      expect(res.body).not.toContain("db.internal");
      expect(res.json()).toEqual({ error: { code, message: generic } });
    },
  );

  it("maps an unknown RagError code to a generic 500", async () => {
    const { res } = await inject(
      new RagError(LEAKY_MESSAGE, "SOME_FUTURE_CODE"),
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SENTINEL);
    expect(res.json()).toEqual({
      error: { code: "SOME_FUTURE_CODE", message: "Internal server error" },
    });
  });

  it("still logs the full message server-side", async () => {
    const { res, logLines } = await inject(
      new RagError(LEAKY_MESSAGE, "PARSER_ERROR"),
    );

    expect(res.body).not.toContain(SENTINEL);
    expect(logLines.join("\n")).toContain(SENTINEL);
  });
});

describe("registerErrorHandler — audited RagError messages are echoed", () => {
  /**
   * `ECHOABLE_ERROR_CODES` (`@rag/core`), not a status threshold. `EGRESS_BLOCKED`
   * is the case that makes the difference: it maps to 503, but its message is a
   * hostname audited as safe, and `/ask`'s streaming path and the MCP surface
   * both already show it. Suppressing it here would make the non-streaming
   * response disagree with the stream for one and the same error.
   */
  const echoable: Array<[string, number]> = [
    ["VALIDATION_ERROR", 400],
    ["NOT_FOUND", 404],
    ["SYNC_ALREADY_RUNNING", 409],
    ["COMPLIANCE_VIOLATION", 422],
    ["EGRESS_BLOCKED", 503],
    // Static strings naming env vars. Suppressing these reported a permanent
    // misconfiguration as "temporarily unavailable".
    ["GENERATION_NOT_CONFIGURED", 503],
    ["STORAGE_NOT_CONFIGURED", 503],
  ];

  it.each(echoable)("%s -> %i keeps its message", async (code, status) => {
    const message = "sourceId must be a uuid";
    const { res } = await inject(new RagError(message, code));

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message } });
  });
});

describe("registerErrorHandler — the suppression policy is closed", () => {
  /**
   * Growing `ECHOABLE_ERROR_CODES` or `STATUS_BY_CODE` without a test row was
   * the one way to reopen the leak while this file stayed green: neither table
   * above enumerates itself, so a new `DB_ERROR: 500` plus an allow-list entry
   * would have gone unnoticed. This asserts the two tables PARTITION
   * STATUS_BY_CODE exactly, so any added code fails here until it is
   * classified deliberately.
   */
  it("every STATUS_BY_CODE code is covered by exactly one table above", () => {
    const echoed = Object.keys(STATUS_BY_CODE).filter((c) =>
      ECHOABLE_ERROR_CODES.has(c),
    );
    const suppressedCodes = Object.keys(STATUS_BY_CODE).filter(
      (c) => !ECHOABLE_ERROR_CODES.has(c),
    );

    expect(suppressedCodes.sort()).toEqual(
      [
        "CONNECTOR_AUTH_ERROR",
        "CONNECTOR_TRANSIENT_ERROR",
        "EMBEDDING_ERROR",
        "PARSER_ERROR",
      ].sort(),
    );
    expect(echoed.sort()).toEqual(
      [
        "COMPLIANCE_VIOLATION",
        "EGRESS_BLOCKED",
        "GENERATION_NOT_CONFIGURED",
        "NOT_FOUND",
        "STORAGE_NOT_CONFIGURED",
        "SYNC_ALREADY_RUNNING",
        "VALIDATION_ERROR",
      ].sort(),
    );
  });

  it("every echoable code has a status mapping", () => {
    // The partition test above iterates STATUS_BY_CODE, so it cannot see a
    // code added to ECHOABLE_ERROR_CODES and nowhere else. That code would
    // fall to `?? 500` and echo its message -- suppression bypassed by
    // omission rather than by edit.
    const unmapped = [...ECHOABLE_ERROR_CODES].filter(
      (c) => !(c in STATUS_BY_CODE),
    );
    expect(unmapped).toEqual([]);
  });

  it("never sends error.cause to the client, even for an echoable code", async () => {
    // At packages/rag/src/parser/parser-client.ts:50 the MESSAGE is already
    // generic and the whole exposure sits in `cause` (an undici error carrying
    // PARSER_URL). Every other case here builds errors without a cause, so a
    // `clientMessage` that appended it would keep this file green.
    const suppressed = await inject(
      new RagError("Parser request failed (500)", "PARSER_ERROR", {
        detail: LEAKY_MESSAGE,
      }),
    );
    expect(suppressed.res.body).not.toContain(SENTINEL);

    const echoable = await inject(
      new RagError("sourceId must be a uuid", "VALIDATION_ERROR", {
        detail: LEAKY_MESSAGE,
      }),
    );
    expect(echoable.res.body).not.toContain(SENTINEL);
    expect(echoable.res.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "sourceId must be a uuid" },
    });
  });

  it("reports 5xx to Sentry and leaves 4xx alone", async () => {
    // Narrowing what the client sees makes the server-side record the only
    // record, so the record itself needs pinning.
    vi.mocked(captureException).mockClear();
    await inject(new RagError(LEAKY_MESSAGE, "PARSER_ERROR"));
    expect(captureException).toHaveBeenCalledTimes(1);

    vi.mocked(captureException).mockClear();
    await inject(new RagError("sourceId must be a uuid", "VALIDATION_ERROR"));
    expect(captureException).not.toHaveBeenCalled();
  });
});
