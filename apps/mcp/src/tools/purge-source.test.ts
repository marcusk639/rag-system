import { describe, expect, it, vi } from "vitest";
import type { AuthorizationScope } from "@rag/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";

const { getSourceMock, purgeSourceMock } = vi.hoisted(() => ({
  getSourceMock: vi.fn(),
  purgeSourceMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({ getSource: getSourceMock }));
vi.mock("@rag/services", () => ({ purgeSource: purgeSourceMock }));

import { registerPurgeSource } from "./purge-source.js";

/**
 * Minimal fake McpServer that captures the handler passed to
 * `registerTool` so it can be invoked directly, exercising the REAL scope
 * check inside purge-source.ts's handler — the single most destructive
 * operation in the system (irreversible deletion of a source and all its data).
 */
function fakeServer() {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (args: unknown) => Promise<unknown>,
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

describe("purge_source tool — scope enforcement", () => {
  it("allows an admin-scoped (enforcedSourceIds: null) session to purge any source", async () => {
    getSourceMock.mockClear();
    purgeSourceMock.mockClear();
    getSourceMock.mockResolvedValue({ id: SRC_B, name: "Source B" });
    purgeSourceMock.mockResolvedValue(undefined);
    const { server, handlers } = fakeServer();
    registerPurgeSource(server, makeDeps(), ADMIN_SCOPE);

    const result = (await handlers.get("purge_source")!({
      sourceId: SRC_B,
    })) as { isError?: boolean; structuredContent?: { purged: boolean } };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.purged).toBe(true);
    expect(purgeSourceMock).toHaveBeenCalledWith(expect.anything(), SRC_B);
  });

  it("allows a scoped session to purge a source within its enforcedSourceIds", async () => {
    getSourceMock.mockClear();
    purgeSourceMock.mockClear();
    getSourceMock.mockResolvedValue({ id: SRC_A, name: "Source A" });
    purgeSourceMock.mockResolvedValue(undefined);
    const { server, handlers } = fakeServer();
    registerPurgeSource(server, makeDeps(), SCOPED_A);

    const result = (await handlers.get("purge_source")!({
      sourceId: SRC_A,
    })) as { isError?: boolean; structuredContent?: { purged: boolean } };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.purged).toBe(true);
    expect(purgeSourceMock).toHaveBeenCalledWith(expect.anything(), SRC_A);
  });

  it("rejects a scoped session from purging a source outside its enforcedSourceIds, never calling purgeSource", async () => {
    getSourceMock.mockClear();
    purgeSourceMock.mockClear();
    const { server, handlers } = fakeServer();
    registerPurgeSource(server, makeDeps(), SCOPED_A);

    const result = (await handlers.get("purge_source")!({
      sourceId: SRC_B,
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not found/i);
    expect(getSourceMock).not.toHaveBeenCalled();
    expect(purgeSourceMock).not.toHaveBeenCalled();
  });

  it("rejects a deny-all scoped session from purging any source", async () => {
    getSourceMock.mockClear();
    purgeSourceMock.mockClear();
    const { server, handlers } = fakeServer();
    registerPurgeSource(server, makeDeps(), DENY_ALL);

    const result = (await handlers.get("purge_source")!({
      sourceId: SRC_A,
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(getSourceMock).not.toHaveBeenCalled();
    expect(purgeSourceMock).not.toHaveBeenCalled();
  });
});
