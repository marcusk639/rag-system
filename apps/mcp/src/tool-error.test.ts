import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComplianceError,
  EgressError,
  EmbeddingError,
  NotFoundError,
} from "@rag/core";
import type { Logger } from "pino";
import { z } from "zod";

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("@rag/runtime", () => ({ captureException: captureExceptionMock }));

import { guardResourceHandler, guardToolHandler } from "./tool-error.js";

function fakeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger & { error: ReturnType<typeof vi.fn> } & {
    warn: ReturnType<typeof vi.fn>;
  };
}

/** Shape the MCP SDK sends to the client for a failed tool call. */
type ToolError = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: { error: { code: string; message: string } };
};

/**
 * A message with the shape of a real internal failure: a Postgres connection
 * error naming the private host, port, user and password. This is exactly what
 * the SDK forwards verbatim today — `createToolError(error.message)` at
 * node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:141 — for any
 * error a tool handler does not catch itself.
 */
const LEAKY =
  'connect ECONNREFUSED 10.0.0.5:5432 (user="rag_admin" password="hunter2")';

beforeEach(() => {
  captureExceptionMock.mockClear();
});

describe("guardResourceHandler", () => {
  // The resource guard used to nest echoability inside the client-fault check,
  // which made the inner branch unreachable and left this path with a
  // different echo policy than the tool path. EGRESS_BLOCKED is the code that
  // exposes the difference: echoable, but not a client fault.
  it("echoes an echoable non-client-fault and still reports it", async () => {
    const logger = fakeLogger();
    const guarded = guardResourceHandler("documents", logger, () => {
      throw new EgressError(
        "host not in EGRESS_ALLOWED_HOSTS: ollama.railway.internal",
      );
    });

    const err = (await guarded().catch((e: unknown) => e)) as Error;

    expect(err.message).toContain("EGRESS_ALLOWED_HOSTS");
    // Not a client fault, so it is a server error and Sentry hears about it.
    expect(logger.error).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it("does not echo a non-echoable message", async () => {
    const guarded = guardResourceHandler("documents", fakeLogger(), () => {
      throw new EmbeddingError("Gemini failed: quota for project 12345");
    });

    const err = (await guarded().catch((e: unknown) => e)) as Error;

    // McpError prefixes its message with the JSON-RPC code.
    expect(err.message).toContain("Internal server error");
    expect(err.message).not.toContain("12345");
  });
});

describe("guardToolHandler", () => {
  it("replaces an unknown error's message with a generic one", async () => {
    const logger = fakeLogger();
    const guarded = guardToolHandler(
      "search_documents",
      logger,
      (_args: unknown) => {
        throw new Error(LEAKY);
      },
    );

    const result = (await guarded({})) as ToolError;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Internal server error");
    expect(result.structuredContent?.error.code).toBe("INTERNAL_ERROR");
    // The whole payload, not just the text field — nothing may carry it.
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("still logs the real error server-side and reports it", async () => {
    const logger = fakeLogger();
    const err = new Error(LEAKY);
    const guarded = guardToolHandler(
      "search_documents",
      logger,
      (_args: unknown) => {
        throw err;
      },
    );

    await guarded({});

    // Sanitizing the client payload must not cost us the diagnosis.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err, tool: "search_documents" }),
      expect.any(String),
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tool: "search_documents" }),
    );
  });

  it("sanitizes a thrown non-Error the same way", async () => {
    const logger = fakeLogger();
    const guarded = guardToolHandler("ask", logger, (_args: unknown) => {
      throw `string throw carrying ${LEAKY}`;
    });

    const result = (await guarded({})) as ToolError;

    expect(result.content[0]?.text).toBe("Internal server error");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("passes a client-facing RagError's own message and code through", async () => {
    const logger = fakeLogger();
    const guarded = guardToolHandler(
      "get_document",
      logger,
      (_args: unknown) => {
        throw new NotFoundError("Document 123 not found.");
      },
    );

    const result = (await guarded({})) as ToolError;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Document 123 not found.");
    expect(result.structuredContent?.error.code).toBe("NOT_FOUND");
    // A 404 is not a crash: warn, and do not page anyone.
    expect(logger.warn).toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("does not echo an EmbeddingError's message, only its code", async () => {
    // EmbeddingError's message interpolates the provider's own error text
    // (packages/rag/src/embeddings/gemini.ts), and search_documents/ask take
    // that path on every call. The repo's HTTP streaming path already refuses
    // to echo an unaudited RagError message for exactly this reason
    // (apps/api/src/routes/ask.ts); this is the agent-facing equivalent.
    const logger = fakeLogger();
    const guarded = guardToolHandler(
      "search_documents",
      logger,
      (_args: unknown) => {
        throw new EmbeddingError(
          'Gemini embedding failed: 429 {"error":{"message":"quota for project 12345 exceeded"}}',
        );
      },
    );

    const result = (await guarded({})) as ToolError;

    expect(result.structuredContent?.error.code).toBe("EMBEDDING_ERROR");
    expect(result.content[0]?.text).toBe("Internal server error");
    expect(JSON.stringify(result)).not.toContain("project 12345");
    // Still a server fault: logged at error and reported.
    expect(logger.error).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it("echoes the codes the HTTP streaming path already audited", async () => {
    for (const err of [
      new ComplianceError("TRI pre-flight refused: ssn, ein"),
      new EgressError("host not in EGRESS_ALLOWED_HOSTS: ollama.internal"),
    ]) {
      const guarded = guardToolHandler("ask", fakeLogger(), (_a: unknown) => {
        throw err;
      });
      const result = (await guarded({})) as ToolError;
      expect(result.content[0]?.text).toBe(err.message);
    }
  });

  it("reports a server-side RagError without echoing its message", async () => {
    const logger = fakeLogger();
    const guarded = guardToolHandler(
      "search_documents",
      logger,
      (_args: unknown) => {
        throw new EmbeddingError("Gemini embedding request failed.");
      },
    );

    const result = (await guarded({})) as ToolError;

    // EMBEDDING_ERROR maps to 502 in apps/api/src/error-handler.ts: a server
    // fault worth reporting, and not an audited-echoable message.
    expect(result.structuredContent?.error.code).toBe("EMBEDDING_ERROR");
    expect(result.content[0]?.text).toBe("Internal server error");
    expect(logger.error).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it("summarizes a ZodError as a validation failure", async () => {
    const logger = fakeLogger();
    const schema = z.object({ topK: z.number() });
    const guarded = guardToolHandler(
      "search_documents",
      logger,
      (_args: unknown) => {
        schema.parse({ topK: "not a number" });
        return Promise.resolve({ content: [] });
      },
    );

    const result = (await guarded({})) as ToolError;

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe("VALIDATION_ERROR");
    expect(result.content[0]?.text).toContain("topK");
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("returns a successful result untouched", async () => {
    const logger = fakeLogger();
    const payload = {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { total: 1 },
    };
    const guarded = guardToolHandler("list_sources", logger, (_args: unknown) =>
      Promise.resolve(payload),
    );

    await expect(guarded({})).resolves.toEqual(payload);
    expect(logger.error).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("passes the handler's arguments through", async () => {
    const logger = fakeLogger();
    const handler = vi.fn((_args: unknown) => Promise.resolve({ content: [] }));
    const guarded = guardToolHandler("get_document", logger, handler);

    await guarded({ documentId: "abc" });

    expect(handler).toHaveBeenCalledWith({ documentId: "abc" });
  });
});
