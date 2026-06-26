import { RagError } from "@rag/core";
import { captureException } from "@rag/runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/**
 * Map a `RagError.code` to an HTTP status. Anything we don't know about
 * falls through to 500. Keep this list aligned with `packages/core/src/errors.ts`.
 */
const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  // A duplicate sync was rejected by pg-boss's singletonKey dedupe — the
  // request is well-formed, the resource is just busy. (@rag/ingestion's
  // SyncAlreadyRunningError, surfaced from triggerSync.)
  SYNC_ALREADY_RUNNING: 409,
  // /ask was called but no generation provider is configured on the server.
  // (@rag/services' GenerationNotConfiguredError.)
  GENERATION_NOT_CONFIGURED: 503,
  // A document upload arrived but no object store is configured to persist the
  // original bytes — a server misconfiguration, not a client error.
  STORAGE_NOT_CONFIGURED: 503,
  CONNECTOR_AUTH_ERROR: 502,
  CONNECTOR_TRANSIENT_ERROR: 503,
  PARSER_ERROR: 502,
  EMBEDDING_ERROR: 502,
};

interface ErrorPayload {
  error: { code: string; message: string };
}

function payload(code: string, message: string): ErrorPayload {
  return { error: { code, message } };
}

/**
 * Register a single global error handler. We log the full error server-side
 * (with stack + cause) and return a sanitized envelope to the client so we
 * never leak internal details (DB errors, stack frames, secret-laden URLs).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
      // Fastify schema validation failures (zod) — surface field errors.
      if (error instanceof ZodError) {
        request.log.warn({ issues: error.issues }, "zod validation failed");
        return reply.code(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: error.issues
              .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
              .join("; "),
          },
        });
      }

      if (error instanceof RagError) {
        const status = STATUS_BY_CODE[error.code] ?? 500;
        // Log at warn for client errors, error for server/upstream issues.
        const logLevel = status < 500 ? "warn" : "error";
        request.log[logLevel](
          { err: error, code: error.code, cause: error.cause },
          "rag error",
        );
        if (status >= 500) {
          captureException(error, {
            url: request.url,
            method: request.method,
            code: error.code,
          });
        }
        return reply.code(status).send(payload(error.code, error.message));
      }

      // Fastify-native validation error (e.g. malformed JSON body).
      const maybeFastify = error as {
        statusCode?: number;
        validation?: unknown;
        message?: string;
      };
      if (maybeFastify.validation) {
        request.log.warn({ err: error }, "fastify schema validation failed");
        return reply
          .code(400)
          .send(
            payload(
              "VALIDATION_ERROR",
              maybeFastify.message ?? "Invalid request",
            ),
          );
      }
      if (
        typeof maybeFastify.statusCode === "number" &&
        maybeFastify.statusCode >= 400 &&
        maybeFastify.statusCode < 500
      ) {
        request.log.warn({ err: error }, "client error");
        return reply
          .code(maybeFastify.statusCode)
          .send(payload("CLIENT_ERROR", maybeFastify.message ?? "Bad request"));
      }

      // Unknown — log full detail, capture to Sentry, return generic 500.
      request.log.error({ err: error }, "unhandled error");
      captureException(error, { url: request.url, method: request.method });
      return reply
        .code(500)
        .send(payload("INTERNAL_ERROR", "Internal server error"));
    },
  );

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(404)
      .send(
        payload(
          "NOT_FOUND",
          `Route ${request.method} ${request.url} not found`,
        ),
      );
  });
}
