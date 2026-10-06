import { RagError } from "@rag/core";
import { captureException } from "@rag/runtime";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { ZodError } from "zod";

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
/**
 * `RagError.code`s whose MESSAGE is audited safe to show a caller. This is a
 * different question from fault attribution above, and conflating them is what
 * made this guard too permissive: it returned `err.message` for every
 * RagError, including codes whose messages are built by interpolating
 * something internal — `EmbeddingError` at packages/rag/src/embeddings/
 * gemini.ts carries the provider's own error text, on a path every
 * `search_documents` and `ask` call takes.
 *
 * The repo already had the narrower rule, on the HTTP streaming path
 * (apps/api/src/routes/ask.ts): "Only these two codes are echoed... Anything
 * else keeps the generic message, because an arbitrary error here can carry
 * connection details. Adding a code to this set means auditing that error's
 * message." That reasoning applies at least as strongly to the agent-facing
 * surface, so this set is that one plus the three client faults whose messages
 * are caller-authored by construction (a bad argument, a missing id, a busy
 * source).
 *
 * Note this makes MCP stricter than `apps/api/src/error-handler.ts`, which
 * still echoes every RagError message. That is deliberate: of the two policies
 * already in the repo, the agent-facing transport takes the stricter one.
 * Tightening the HTTP non-streaming path the same way belongs in its own
 * change, with its own consumers considered.
 *
 * The CODE is always returned regardless, so an agent can still branch on it.
 */
const ECHOABLE_ERROR_CODES = new Set([
  // Audited on the HTTP streaming path: a hostname, and TRI pattern labels.
  "EGRESS_BLOCKED",
  "COMPLIANCE_VIOLATION",
  // Caller-authored by construction.
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "SYNC_ALREADY_RUNNING",
]);

const CLIENT_FAULT_CODES = new Set([
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
 * internals included. The HTTP API has guarded against exactly this since it
 * had routes (`registerErrorHandler` in `apps/api/src/error-handler.ts`); the
 * MCP surface had no equivalent, so the agent-facing transport was the leaky
 * one.
 *
 * The trust boundary follows the HTTP side's stricter policy (its streaming
 * path), so the two do not drift silently: a `RagError` carries an operator-authored message and is
 * passed through with its code, and anything else is replaced with a generic
 * message while the real error goes to the log and to Sentry.
 *
 * One consequence worth naming: a `RagError` message is trusted, so whatever a
 * provider adapter interpolates into e.g. `EmbeddingError` reaches the client.
 * That is pre-existing HTTP behaviour, not something this wrapper introduces —
 * tightening it belongs at the `throw` sites, in both surfaces at once.
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
      if (err instanceof RagError && CLIENT_FAULT_CODES.has(err.code)) {
        logger.warn(
          { err, resource, code: err.code },
          "mcp resource client error",
        );
        throw new McpError(
          ErrorCode.InvalidParams,
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
