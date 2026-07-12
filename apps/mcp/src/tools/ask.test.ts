import { describe, expect, it, vi } from "vitest";
import type { AuthorizationScope } from "@rag/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";

const { askQuestionMock, logAskEventMock } = vi.hoisted(() => ({
  askQuestionMock: vi.fn(),
  logAskEventMock: vi.fn(async (_db: unknown, _row: unknown) => {}),
}));

vi.mock("@rag/services", () => ({
  askQuestion: askQuestionMock,
  GenerationNotConfiguredError: class GenerationNotConfiguredError extends Error {},
}));
vi.mock("@rag/db", () => ({ logAskEvent: logAskEventMock }));

import { registerAsk } from "./ask.js";

/**
 * P3 fix coverage: `ask` previously wrote NO audit_log row at all, same gap
 * as `search_documents` (see that file's test for the fuller rationale).
 */
function fakeServer() {
  const handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

const SRC_A = "11111111-1111-1111-1111-111111111111";
const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };

function makeDeps(): Deps {
  return {
    db: {} as Deps["db"],
    embedder: {
      name: "gemini",
      model: "gemini-embedding-001",
    } as Deps["embedder"],
    logger: { error: vi.fn() } as unknown as Deps["logger"],
    config: {
      retrieval: { defaultTopK: 8, maxChunksPerDocument: 3 },
      generation: { model: "gemini-2.0-flash" },
    } as unknown as Deps["config"],
  } as unknown as Deps;
}

function askResultFixture() {
  return {
    answer: "grounded answer [1]",
    citations: [{ index: 1, title: "Doc", documentId: "doc-1" }],
    retrieved: [
      {
        document: { id: "doc-1", sourceId: SRC_A, title: "Doc" },
        chunk: { id: "chunk-1" },
        score: 0.8,
      },
    ],
    reviewStatus: "pending" as const,
    disclaimer: "Draft — review before use.",
  };
}

describe("ask tool — audit logging", () => {
  it("writes an audit_log row with channel='mcp', the generation model, and embedding provider/model", async () => {
    askQuestionMock.mockClear();
    logAskEventMock.mockClear();
    askQuestionMock.mockResolvedValue(askResultFixture());
    const { server, handlers } = fakeServer();
    registerAsk(server, makeDeps(), ADMIN_SCOPE);

    await handlers.get("ask")!({ question: "what is our refund policy" });
    await new Promise((r) => setImmediate(r));

    expect(logAskEventMock).toHaveBeenCalledTimes(1);
    const row = logAskEventMock.mock.calls[0]![1];
    expect(row).toMatchObject({
      channel: "mcp",
      endpoint: "ask",
      principalKind: "admin",
      model: "gemini-2.0-flash",
      embeddingProvider: "gemini",
      embeddingModel: "gemini-embedding-001",
      retrievedCount: 1,
      topScore: 0.8,
    });
    expect(JSON.stringify(row)).not.toContain("refund policy");
  });

  it("does not audit-log when generation is not configured (isError short-circuit)", async () => {
    askQuestionMock.mockClear();
    logAskEventMock.mockClear();
    const { GenerationNotConfiguredError } = await import("@rag/services");
    askQuestionMock.mockRejectedValue(new GenerationNotConfiguredError());
    const { server, handlers } = fakeServer();
    registerAsk(server, makeDeps(), ADMIN_SCOPE);

    const result = (await handlers.get("ask")!({ question: "q" })) as {
      isError?: boolean;
    };
    await new Promise((r) => setImmediate(r));

    expect(result.isError).toBe(true);
    expect(logAskEventMock).not.toHaveBeenCalled();
  });

  it("does not block the tool response if the audit insert fails", async () => {
    askQuestionMock.mockClear();
    logAskEventMock.mockClear();
    logAskEventMock.mockRejectedValueOnce(new Error("insert failed"));
    askQuestionMock.mockResolvedValue(askResultFixture());
    const { server, handlers } = fakeServer();
    const deps = makeDeps();
    registerAsk(server, deps, ADMIN_SCOPE);

    const result = await handlers.get("ask")!({ question: "q" });
    await new Promise((r) => setImmediate(r));

    expect(result).toBeDefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
