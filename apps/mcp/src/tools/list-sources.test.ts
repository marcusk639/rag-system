import { describe, expect, it, vi } from "vitest";
import type { AuthorizationScope } from "@rag/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";

const { listSourcesMock } = vi.hoisted(() => ({
  listSourcesMock: vi.fn(),
}));

vi.mock("@rag/services", () => ({ listPublicSources: listSourcesMock }));

import { registerListSources } from "./list-sources.js";

/**
 * P1 fix coverage: `list_sources` previously called the unscoped
 * `listPublicSources(deps)` — the one MCP tool that omitted the mandatory
 * `AuthorizationScope`, letting any session (scoped or admin) enumerate every
 * registered source. Mirrors `trigger-sync.test.ts`'s fake-server pattern so
 * the REAL handler (not just the module-level registrar call) is exercised.
 */
function fakeServer() {
  const handlers = new Map<string, () => Promise<unknown>>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: () => Promise<unknown>,
    ) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

const SRC_A = "11111111-1111-1111-1111-111111111111";
const SRC_B = "22222222-2222-2222-2222-222222222222";

const SCOPED_A: AuthorizationScope = { enforcedSourceIds: [SRC_A] };
const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };
const DENY_ALL: AuthorizationScope = { enforcedSourceIds: [] };

function makeDeps(): Deps {
  return { db: {} as Deps["db"] } as unknown as Deps;
}

function sourceFixture(id: string, name: string) {
  return { id, kind: "sharepoint" as const, name, lastSyncedAt: null };
}

describe("list_sources tool — scope enforcement", () => {
  it("passes the scope straight through to listPublicSources", async () => {
    listSourcesMock.mockClear();
    listSourcesMock.mockResolvedValue([sourceFixture(SRC_A, "Source A")]);
    const { server, handlers } = fakeServer();
    registerListSources(server, makeDeps(), SCOPED_A);

    await handlers.get("list_sources")!();

    expect(listSourcesMock).toHaveBeenCalledWith(expect.anything(), SCOPED_A);
  });

  it("a scoped session's result only contains sources within its allow-list", async () => {
    listSourcesMock.mockClear();
    // listPublicSources itself enforces scope; the mock simulates the
    // already-filtered result a scoped session would receive.
    listSourcesMock.mockResolvedValue([sourceFixture(SRC_A, "Source A")]);
    const { server, handlers } = fakeServer();
    registerListSources(server, makeDeps(), SCOPED_A);

    const result = (await handlers.get("list_sources")!()) as {
      structuredContent: { sources: Array<{ id: string }> };
    };

    expect(result.structuredContent.sources.map((s) => s.id)).toEqual([SRC_A]);
  });

  it("an admin session sees every source", async () => {
    listSourcesMock.mockClear();
    listSourcesMock.mockResolvedValue([
      sourceFixture(SRC_A, "Source A"),
      sourceFixture(SRC_B, "Source B"),
    ]);
    const { server, handlers } = fakeServer();
    registerListSources(server, makeDeps(), ADMIN_SCOPE);

    const result = (await handlers.get("list_sources")!()) as {
      structuredContent: { sources: Array<{ id: string }> };
    };

    expect(result.structuredContent.sources.map((s) => s.id).sort()).toEqual(
      [SRC_A, SRC_B].sort(),
    );
  });

  it("a deny-all scoped session sees nothing", async () => {
    listSourcesMock.mockClear();
    listSourcesMock.mockResolvedValue([]);
    const { server, handlers } = fakeServer();
    registerListSources(server, makeDeps(), DENY_ALL);

    const result = (await handlers.get("list_sources")!()) as {
      structuredContent: { sources: unknown[] };
    };

    expect(result.structuredContent.sources).toEqual([]);
    expect(listSourcesMock).toHaveBeenCalledWith(expect.anything(), DENY_ALL);
  });
});
