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

// Every code in STATUS_BY_CODE that is NOT in ECHOABLE_ERROR_CODES, with its
// status and the generic text the client should get instead. The partition test
// derives from THIS table, so a new code cannot be classified without also
// stating what body it returns.
const suppressed: Array<[string, number, string]> = [
  ["CONNECTOR_AUTH_ERROR", 502, "Upstream service error"],
  ["PARSER_ERROR", 502, "Upstream service error"],
  ["EMBEDDING_ERROR", 502, "Upstream service error"],
  ["CONNECTOR_TRANSIENT_ERROR", 503, "Service temporarily unavailable"],
];

/**
 * Gated on `ECHOABLE_ERROR_CODES` (`@rag/core`), not a status threshold.
 * `EGRESS_BLOCKED` is the case that makes the difference: it maps to 503, but
 * its message is a hostname audited as safe, and `/ask`'s streaming path and
 * the MCP surface both already show it. Suppressing it here would make the
 * non-streaming response disagree with the stream for one and the same error.
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

describe("registerErrorHandler — unaudited RagError messages are not echoed", () => {
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
   * would have gone unnoticed. This asserts the two `it.each` tables PARTITION
   * STATUS_BY_CODE exactly — derived FROM those tables, so a new code must gain
   * a row asserting its actual response body, not merely a name in a list.
   */
  it("every STATUS_BY_CODE code is covered by exactly one table above", () => {
    const echoed = Object.keys(STATUS_BY_CODE).filter((c) =>
      ECHOABLE_ERROR_CODES.has(c),
    );
    const suppressedCodes = Object.keys(STATUS_BY_CODE).filter(
      (c) => !ECHOABLE_ERROR_CODES.has(c),
    );

    // Compared against the it.each tables themselves, NOT a second copy of the
    // code names. That is what makes the claim above true: a new code must gain
    // a behavioral row, not merely a name in a list here.
    expect(suppressedCodes.sort()).toEqual(suppressed.map((r) => r[0]).sort());
    expect(echoed.sort()).toEqual(echoable.map((r) => r[0]).sort());
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
    // The cause MUST be a real Error: production causes always are (an undici
    // error at parser-client.ts:50, `new Error(text.slice(0,500))` at :87, the
    // provider's object at openai.ts:106). A plain object would make this test
    // pass for the wrong reason -- `String({detail})` is "[object Object]" and
    // `({detail}).message` is undefined, so both natural ways to leak a cause
    // would stay green here while leaking in production.
    //
    // At parser-client.ts:50 the MESSAGE is already generic and the whole
    // exposure sits in the cause, so this is the realistic leak shape.
    const cause = new Error(LEAKY_MESSAGE);

    const suppressed = await inject(
      new RagError("Parser request failed (500)", "PARSER_ERROR", cause),
    );
    // Positive control FIRST: prove the cause was attached and reachable, so
    // this cannot go vacuous if RagError ever stops forwarding a cause.
    expect(suppressed.logLines.join("\n")).toContain(SENTINEL);
    expect(suppressed.res.body).not.toContain(SENTINEL);
    expect(JSON.stringify(suppressed.res.headers)).not.toContain(SENTINEL);
    // toEqual fails on ANY appended text, sentinel-bearing or not.
    expect(suppressed.res.json()).toEqual({
      error: { code: "PARSER_ERROR", message: "Upstream service error" },
    });

    const echoable = await inject(
      new RagError("sourceId must be a uuid", "VALIDATION_ERROR", cause),
    );
    expect(echoable.res.body).not.toContain(SENTINEL);
    expect(JSON.stringify(echoable.res.headers)).not.toContain(SENTINEL);
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
