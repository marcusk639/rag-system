import { describe, expect, it, vi } from "vitest";
import type { AuthorizationScope } from "@rag/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";

const { searchDocumentsMock, logAskEventMock } = vi.hoisted(() => ({
  searchDocumentsMock: vi.fn(),
  logAskEventMock: vi.fn(async (_db: unknown, _row: unknown) => {}),
}));

vi.mock("@rag/services", () => ({ searchDocuments: searchDocumentsMock }));
vi.mock("@rag/db", () => ({ logAskEvent: logAskEventMock }));

import { registerSearchDocuments } from "./search-documents.js";

/**
 * P3 fix coverage: `search_documents` previously wrote NO audit_log row at
 * all — the agent-facing MCP surface (per root CLAUDE.md) had zero §7216/
 * §10.22 disclosure recordkeeping, unlike the HTTP API's `/search` route.
 * Mirrors `list-sources.test.ts`'s fake-server pattern so the REAL handler
 * (not just the module-level registrar call) is exercised.
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
const SCOPED_A: AuthorizationScope = { enforcedSourceIds: [SRC_A] };

function makeDeps(): Deps {
  return {
    db: {} as Deps["db"],
    embedder: {
      name: "gemini",
      model: "gemini-embedding-001",
    } as Deps["embedder"],
    logger: { error: vi.fn() } as unknown as Deps["logger"],
    config: { retrieval: { defaultTopK: 8 } } as unknown as Deps["config"],
  } as unknown as Deps;
}

function resultFixture() {
  return {
    document: { id: "doc-1", sourceId: SRC_A, title: "Doc" },
    chunk: { id: "chunk-1", headingPath: [], page: null },
    text: "some retrieved text",
    score: 1,
    denseScore: 0.8,
  };
}

describe("search_documents tool — audit logging", () => {
  it("writes an audit_log row with channel='mcp' and the embedding provider/model", async () => {
    searchDocumentsMock.mockClear();
    logAskEventMock.mockClear();
    searchDocumentsMock.mockResolvedValue([resultFixture()]);
    const { server, handlers } = fakeServer();
    const deps = makeDeps();
    registerSearchDocuments(server, deps, ADMIN_SCOPE);

    await handlers.get("search_documents")!({ query: "refund policy" });

    // Fire-and-forget — allow the microtask queue to flush before asserting.
    await new Promise((r) => setImmediate(r));

    expect(logAskEventMock).toHaveBeenCalledTimes(1);
    const row = logAskEventMock.mock.calls[0]![1];
    expect(row).toMatchObject({
      channel: "mcp",
      endpoint: "search",
      principalKind: "admin",
      principalSources: null,
      embeddingProvider: "gemini",
      embeddingModel: "gemini-embedding-001",
      retrievedCount: 1,
      topScore: 0.8,
    });
    // No raw query text anywhere on the row — only a one-way hash.
    expect(JSON.stringify(row)).not.toContain("refund policy");
  });

  it("derives principalKind='scoped' and principalSources from a non-admin AuthorizationScope", async () => {
    searchDocumentsMock.mockClear();
    logAskEventMock.mockClear();
    searchDocumentsMock.mockResolvedValue([]);
    const { server, handlers } = fakeServer();
    registerSearchDocuments(server, makeDeps(), SCOPED_A);

    await handlers.get("search_documents")!({ query: "q" });
    await new Promise((r) => setImmediate(r));

    const row = logAskEventMock.mock.calls[0]![1];
    expect(row).toMatchObject({
      principalKind: "scoped",
      principalSources: [SRC_A],
      principalSubject: null,
    });
  });

  it("does not block the tool response if the audit insert fails", async () => {
    searchDocumentsMock.mockClear();
    logAskEventMock.mockClear();
    logAskEventMock.mockRejectedValueOnce(new Error("insert failed"));
    searchDocumentsMock.mockResolvedValue([]);
    const { server, handlers } = fakeServer();
    const deps = makeDeps();
    registerSearchDocuments(server, deps, ADMIN_SCOPE);

    const result = await handlers.get("search_documents")!({ query: "q" });
    await new Promise((r) => setImmediate(r));

    expect(result).toBeDefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
