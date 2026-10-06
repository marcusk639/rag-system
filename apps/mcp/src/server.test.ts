import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { AuthorizationScope, Config } from "@rag/core";
import type { Deps } from "./deps.js";

/**
 * Smoke tests for the MCP server builder.
 *
 * Strategy: mock the five tool-registrar modules so we don't need real service
 * deps (DB, retriever, generator). The real McpServer from the SDK is used so
 * we verify that the SDK's `registerTool` / `registerResource` calls succeed
 * without throwing. Each mocked registrar is also asserted to have been called
 * exactly once with the correct scope/deps, confirming that `buildServer` wires
 * all five tools and one resource.
 */

// vi.mock calls are hoisted by vitest to run before any import. The mocked
// versions are what buildServer receives when it calls the registrars.
vi.mock("./tools/search-documents.js", () => ({
  registerSearchDocuments: vi.fn(),
}));
vi.mock("./tools/get-document.js", () => ({
  registerGetDocument: vi.fn(),
}));
vi.mock("./tools/list-sources.js", () => ({
  registerListSources: vi.fn(),
}));
vi.mock("./tools/trigger-sync.js", () => ({
  registerTriggerSync: vi.fn(),
}));
vi.mock("./tools/ask.js", () => ({
  registerAsk: vi.fn(),
}));
vi.mock("./tools/purge-source.js", () => ({
  registerPurgeSource: vi.fn(),
}));
// Mock @rag/db so the resource handler's getDocument import resolves without
// a real DB connection or any pg/drizzle side-effects.
const { getDocumentMock, captureExceptionMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));
vi.mock("@rag/db", () => ({ getDocument: getDocumentMock }));
vi.mock("@rag/runtime", () => ({ captureException: captureExceptionMock }));

// These imports resolve to the mocked modules above (hoisting guarantees it).
import { registerSearchDocuments } from "./tools/search-documents.js";
import { registerGetDocument } from "./tools/get-document.js";
import { registerListSources } from "./tools/list-sources.js";
import { registerTriggerSync } from "./tools/trigger-sync.js";
import { registerAsk } from "./tools/ask.js";
import { registerPurgeSource } from "./tools/purge-source.js";
import { buildServer, buildDocumentResourceHandler } from "./server.js";

const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };
const SCOPED_SCOPE: AuthorizationScope = {
  enforcedSourceIds: ["11111111-1111-1111-1111-111111111111"],
};

function makeDeps(): Deps {
  return {
    config: {} as Config,
    db: {} as Deps["db"],
    retriever: {} as Deps["retriever"],
    embedder: {
      name: "test-provider",
      model: "test-model",
    } as Deps["embedder"],
    queue: {} as Deps["queue"],
    generator: null,
    objectStore: null,
    close: async () => {},
    logger: pino({ level: "silent" }),
  };
}

describe("MCP buildServer", () => {
  it("builds without throwing and registers all 6 tools", () => {
    const deps = makeDeps();
    const server = buildServer({
      deps,
      logger: deps.logger,
      scope: ADMIN_SCOPE,
    });

    expect(server).toBeDefined();
    // Each tool registrar must be called exactly once.
    expect(registerSearchDocuments).toHaveBeenCalledOnce();
    expect(registerGetDocument).toHaveBeenCalledOnce();
    expect(registerListSources).toHaveBeenCalledOnce();
    expect(registerTriggerSync).toHaveBeenCalledOnce();
    expect(registerPurgeSource).toHaveBeenCalledOnce();
    expect(registerAsk).toHaveBeenCalledOnce();
  });

  it("passes the authorization scope to scope-aware tools", () => {
    vi.clearAllMocks();
    const deps = makeDeps();
    buildServer({ deps, logger: deps.logger, scope: SCOPED_SCOPE });

    // search, get-document, ask, trigger-sync, purge-source, and (per the P1
    // fix) list-sources all receive the scope — no tool remains scope-agnostic.
    expect(registerSearchDocuments).toHaveBeenCalledWith(
      expect.anything(),
      deps,
      SCOPED_SCOPE,
    );
    expect(registerGetDocument).toHaveBeenCalledWith(
      expect.anything(),
      deps,
      SCOPED_SCOPE,
    );
    expect(registerAsk).toHaveBeenCalledWith(
      expect.anything(),
      deps,
      SCOPED_SCOPE,
    );
    expect(registerListSources).toHaveBeenCalledWith(
      expect.anything(),
      deps,
      SCOPED_SCOPE,
    );
    expect(registerTriggerSync).toHaveBeenCalledWith(
      expect.anything(),
      deps,
      SCOPED_SCOPE,
    );
    expect(registerPurgeSource).toHaveBeenCalledWith(
      expect.anything(),
      deps,
      SCOPED_SCOPE,
    );
  });

  it("builds a distinct server per call (per-session isolation)", () => {
    const deps = makeDeps();
    vi.clearAllMocks();
    const s1 = buildServer({ deps, logger: deps.logger, scope: ADMIN_SCOPE });
    const s2 = buildServer({ deps, logger: deps.logger, scope: ADMIN_SCOPE });
    expect(s1).not.toBe(s2);
    // Both builds registered all tools.
    expect(registerSearchDocuments).toHaveBeenCalledTimes(2);
  });
});

/**
 * The `documents://{id}` resource leaks by a different mechanism than the
 * tools, and wrapping the tools alone did not close it: the SDK's
 * ReadResourceRequestSchema handler calls `readCallback` with no catch
 * (server/mcp.js:376-393), so the throw reaches the protocol layer, which
 * sends `message: error.message ?? 'Internal error'` verbatim
 * (shared/protocol.js:398-399).
 */
describe("documents:// resource — error sanitization", () => {
  const LEAKY =
    'connect ECONNREFUSED 10.0.0.5:5432 (user="rag_admin" password="hunter2")';
  const SRC_ALLOWED = "11111111-1111-1111-1111-111111111111";
  const SRC_OTHER = "99999999-9999-9999-9999-999999999999";
  const DOC = "22222222-2222-2222-2222-222222222222";
  const uri = new URL("documents://22222222-2222-2222-2222-222222222222");

  beforeEach(() => {
    getDocumentMock.mockReset();
    captureExceptionMock.mockReset();
  });

  it("replaces an unexpected DB failure with a generic error", async () => {
    getDocumentMock.mockRejectedValue(new Error(LEAKY));
    const handler = buildDocumentResourceHandler(
      makeDeps(),
      ADMIN_SCOPE,
      pino({ level: "silent" }),
    );

    const err = (await handler(uri, { id: DOC }).catch(
      (e: unknown) => e,
    )) as Error;

    expect(err.message).toContain("Internal server error");
    for (const secret of ["ECONNREFUSED", "10.0.0.5", "rag_admin", "hunter2"]) {
      expect(err.message).not.toContain(secret);
    }
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it("still refuses a missing document with a usable message", async () => {
    getDocumentMock.mockResolvedValue(null);
    const handler = buildDocumentResourceHandler(
      makeDeps(),
      ADMIN_SCOPE,
      pino({ level: "silent" }),
    );

    await expect(handler(uri, { id: DOC })).rejects.toThrow(/not found/);
    // A missing id is not a server fault.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("refuses an out-of-scope document identically to a missing one", async () => {
    // The P1b confidentiality mirror: a scoped session must not be able to
    // tell "exists but forbidden" from "does not exist".
    getDocumentMock.mockResolvedValue({
      id: DOC,
      sourceId: SRC_OTHER,
      markdown: "secret body",
    });
    const handler = buildDocumentResourceHandler(
      makeDeps(),
      { enforcedSourceIds: [SRC_ALLOWED] },
      pino({ level: "silent" }),
    );

    const err = (await handler(uri, { id: DOC }).catch(
      (e: unknown) => e,
    )) as Error;

    expect(err.message).toMatch(/not found/);
    expect(err.message).not.toContain("secret body");
  });

  it("rejects a missing id without reaching the database", async () => {
    const handler = buildDocumentResourceHandler(
      makeDeps(),
      ADMIN_SCOPE,
      pino({ level: "silent" }),
    );

    await expect(handler(uri, {})).rejects.toThrow(/requires an id/);
    expect(getDocumentMock).not.toHaveBeenCalled();
  });
});
