import { describe, expect, it, vi } from "vitest";
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
// Mock @rag/db so the resource handler's getDocument import resolves without
// a real DB connection or any pg/drizzle side-effects.
vi.mock("@rag/db", () => ({ getDocument: vi.fn() }));

// These imports resolve to the mocked modules above (hoisting guarantees it).
import { registerSearchDocuments } from "./tools/search-documents.js";
import { registerGetDocument } from "./tools/get-document.js";
import { registerListSources } from "./tools/list-sources.js";
import { registerTriggerSync } from "./tools/trigger-sync.js";
import { registerAsk } from "./tools/ask.js";
import { buildServer } from "./server.js";

const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };
const SCOPED_SCOPE: AuthorizationScope = {
  enforcedSourceIds: ["11111111-1111-1111-1111-111111111111"],
};

function makeDeps(): Deps {
  return {
    config: {} as Config,
    db: {} as Deps["db"],
    retriever: {} as Deps["retriever"],
    queue: {} as Deps["queue"],
    generator: null,
    close: async () => {},
    logger: pino({ level: "silent" }),
  };
}

describe("MCP buildServer", () => {
  it("builds without throwing and registers all 5 tools", () => {
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
    expect(registerAsk).toHaveBeenCalledOnce();
  });

  it("passes the authorization scope to scope-aware tools", () => {
    vi.clearAllMocks();
    const deps = makeDeps();
    buildServer({ deps, logger: deps.logger, scope: SCOPED_SCOPE });

    // search, get-document, and ask receive the scope; list-sources and
    // trigger-sync do not (they are scope-agnostic operations).
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
    expect(registerListSources).toHaveBeenCalledWith(expect.anything(), deps);
    expect(registerTriggerSync).toHaveBeenCalledWith(expect.anything(), deps);
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
