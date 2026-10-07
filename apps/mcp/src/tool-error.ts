import { ECHOABLE_ERROR_CODES, RagError } from "@rag/core";
import { captureException } from "@rag/runtime";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { ZodError } from "zod";

// The audited showable-message set lives in `@rag/core` as
// `ECHOABLE_ERROR_CODES`, because `apps/api/src/error-handler.ts` enforces the
// same list and a security allow-list duplicated per transport drifts. The
// rationale, and what must stay out of it, is documented there.

/**
 * `RagError.code`s that describe a fault in the *call* rather than in the
 * server — the agent sent something wrong, asked for something absent, or hit
 * a deliberate policy refusal. These are logged at `warn` and not reported to
 * Sentry; every other code is treated as a server fault.
 *
 * This is the MCP-side expression of the same split `STATUS_BY_CODE` encodes in
 * `apps/api/src/error-handler.ts` (exactly its sub-500 entries: 400, 404, 409,
 * 422). MCP has no status codes, so only the fault attribution survives the
 * translation. Keep the two aligned when adding a `RagError` subclass.
 */
export const CLIENT_FAULT_CODES = new Set([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "SYNC_ALREADY_RUNNING",
  "COMPLIANCE_VIOLATION",
]);

function toolError(code: string, message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

/**
 * Wrap an MCP tool handler so a thrown error can never reach the client as a
 * raw `Error.message`.
 *
 * Without this, any error a handler does not catch itself is converted by the
 * SDK into `createToolError(error.message)` (see
 * `@modelcontextprotocol/sdk/dist/esm/server/mcp.js:141`) and sent verbatim —
 * Postgres connection strings, provider response bodies, and stack-adjacent
 * internals included. Neither transport guarded this originally:
 * `registerErrorHandler` (`apps/api/src/error-handler.ts`) echoed every
 * `RagError.message`, including the codes that map to 5xx, and the MCP surface
 * had no equivalent at all. Both now gate on the same audited set.
 *
 * Two independent questions, deliberately kept apart — conflating them is what
 * made an earlier version of this guard too permissive:
 *
 *   - WHOSE FAULT is it (`CLIENT_FAULT_CODES`) decides the log level and
 *     whether Sentry hears about it.
 *   - IS THE MESSAGE SHOWABLE (`ECHOABLE_ERROR_CODES`) decides whether the
 *     caller sees `err.message` or a generic string. The code is always
 *     returned either way.
 *
 * So a `RagError` message is NOT trusted by default. An `EmbeddingError`
 * interpolates the provider's own error text and is reachable on every
 * `search_documents`/`ask` call, so it is logged and reported in full and the
 * caller gets the code with a generic message.
 *
 * `apps/api/src/error-handler.ts` enforces this same set, so the two
 * non-streaming transports no longer disagree about which messages are
 * showable. The SSE path on `/ask` is deliberately stricter still
 * (`STREAMABLE_ERROR_CODES`, `apps/api/src/routes/ask.ts`): that payload
 * carries no status and drops a non-member's code as well as its message, so
 * it admits only two of these codes. `ECHOABLE_ERROR_CODES` in
 * `packages/core/src/errors.ts` records why.
 *
 * Every tool registration goes through this. A new tool that skips it is a
 * leak, so wrap the handler as the existing six do.
 */
export function guardToolHandler<Args extends unknown[]>(
  tool: string,
  logger: Logger,
  handler: (...args: Args) => CallToolResult | Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args): Promise<CallToolResult> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ZodError) {
        logger.warn({ tool, issues: err.issues }, "mcp tool input invalid");
        return toolError(
          "VALIDATION_ERROR",
          err.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; "),
        );
      }

      if (err instanceof RagError) {
        if (CLIENT_FAULT_CODES.has(err.code)) {
          logger.warn({ err, tool, code: err.code }, "mcp tool client error");
        } else {
          logger.error(
            { err, tool, code: err.code, cause: err.cause },
            "mcp tool server error",
          );
          captureException(err, { tool, code: err.code });
        }
        // Code always; message only if audited. A non-echoable message is
        // replaced rather than dropped, so the agent still learns the
        // category from the code.
        return toolError(
          err.code,
          ECHOABLE_ERROR_CODES.has(err.code)
            ? err.message
            : "Internal server error",
        );
      }

      logger.error({ err, tool }, "mcp tool unhandled error");
      captureException(err, { tool });
      return toolError("INTERNAL_ERROR", "Internal server error");
    }
  };
}

/**
 * The resource-read counterpart of `guardToolHandler`.
 *
 * Resource reads need their own guard because the SDK treats them differently
 * from tool calls: the tool path catches everything and converts it to an
 * `isError` result (`server/mcp.js:141`), but the `ReadResourceRequestSchema`
 * handler calls `readCallback` with no catch at all (`server/mcp.js:376-393`),
 * so the throw lands in the protocol layer, which serializes
 * `message: error.message ?? 'Internal error'` verbatim
 * (`shared/protocol.js:398-399`). A resource handler therefore leaks by
 * exactly the same mechanism, and wrapping the tools alone left it open.
 *
 * There is no result envelope to return here, so sanitizing means throwing a
 * sanitized error: a client-fault `RagError` keeps its message as an
 * `InvalidParams` McpError, and anything else becomes a generic
 * `InternalError` with the real cause logged and reported.
 */
export function guardResourceHandler<Args extends unknown[], R>(
  resource: string,
  logger: Logger,
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof RagError) {
        // The two tests are independent here exactly as in guardToolHandler.
        // Nesting echoability inside the client-fault check made the inner
        // branch unreachable (CLIENT_FAULT_CODES is a subset of
        // ECHOABLE_ERROR_CODES) and gave this path a different echo policy
        // than the tool path -- EGRESS_BLOCKED is echoable but not a client
        // fault, so it was genericized here and not there.
        const clientFault = CLIENT_FAULT_CODES.has(err.code);
        if (clientFault) {
          logger.warn(
            { err, resource, code: err.code },
            "mcp resource client error",
          );
        } else {
          logger.error(
            { err, resource, code: err.code, cause: err.cause },
            "mcp resource server error",
          );
          captureException(err, { resource, code: err.code });
        }
        throw new McpError(
          clientFault ? ErrorCode.InvalidParams : ErrorCode.InternalError,
          ECHOABLE_ERROR_CODES.has(err.code)
            ? err.message
            : "Internal server error",
        );
      }

      logger.error({ err, resource }, "mcp resource unhandled error");
      captureException(err, { resource });
      throw new McpError(ErrorCode.InternalError, "Internal server error");
    }
  };
}
