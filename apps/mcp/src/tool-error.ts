import { RagError } from "@rag/core";
import { captureException } from "@rag/runtime";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
 * The trust boundary matches the HTTP side deliberately, so the two surfaces
 * cannot diverge: a `RagError` carries an operator-authored message and is
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
        return toolError(err.code, err.message);
      }

      logger.error({ err, tool }, "mcp tool unhandled error");
      captureException(err, { tool });
      return toolError("INTERNAL_ERROR", "Internal server error");
    }
  };
}
