import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyBaseLogger } from "fastify";
import pino from "pino";
import { RagError } from "@rag/core";
import { registerErrorHandler } from "./error-handler.js";

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
    ["GENERATION_NOT_CONFIGURED", 503, "Service temporarily unavailable"],
    ["STORAGE_NOT_CONFIGURED", 503, "Service temporarily unavailable"],
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
  ];

  it.each(echoable)("%s -> %i keeps its message", async (code, status) => {
    const message = "sourceId must be a uuid";
    const { res } = await inject(new RagError(message, code));

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message } });
  });
});
