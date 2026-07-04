import { describe, expect, it, vi } from "vitest";
import type { AuthorizationScope } from "@rag/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";

const { getSourceMock, triggerSyncMock } = vi.hoisted(() => ({
  getSourceMock: vi.fn(),
  triggerSyncMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({ getSource: getSourceMock }));
vi.mock("@rag/services", () => ({ triggerSync: triggerSyncMock }));

import { registerTriggerSync } from "./trigger-sync.js";

/**
 * Minimal fake McpServer that just captures the handler passed to
 * `registerTool` so it can be invoked directly, exercising the REAL scope
 * check inside trigger-sync.ts's handler — unlike server.test.ts, which only
 * proves the module-level registrar is *called with* the right scope, never
 * that the handler *enforces* it.
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

describe("trigger_sync tool — scope enforcement", () => {
  it("rejects a scoped session syncing a source outside its allow-list, never calling getSource/triggerSync", async () => {
    getSourceMock.mockClear();
    triggerSyncMock.mockClear();
    const { server, handlers } = fakeServer();
    registerTriggerSync(server, makeDeps(), SCOPED_A);

    const result = (await handlers.get("trigger_sync")!({
      sourceId: SRC_B,
      mode: "incremental",
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not found/i);
    expect(getSourceMock).not.toHaveBeenCalled();
    expect(triggerSyncMock).not.toHaveBeenCalled();
  });

  it("rejects a deny-all scoped session on any source", async () => {
    getSourceMock.mockClear();
    triggerSyncMock.mockClear();
    const { server, handlers } = fakeServer();
    registerTriggerSync(server, makeDeps(), DENY_ALL);

    const result = (await handlers.get("trigger_sync")!({
      sourceId: SRC_A,
      mode: "incremental",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(getSourceMock).not.toHaveBeenCalled();
    expect(triggerSyncMock).not.toHaveBeenCalled();
  });

  it("allows a scoped session to sync a source WITHIN its allow-list", async () => {
    getSourceMock.mockClear();
    triggerSyncMock.mockClear();
    getSourceMock.mockResolvedValue({ id: SRC_A, name: "Source A" });
    triggerSyncMock.mockResolvedValue({
      jobId: "job-1",
      ingestionId: "ing-1",
      mode: "incremental",
    });
    const { server, handlers } = fakeServer();
    registerTriggerSync(server, makeDeps(), SCOPED_A);

    const result = (await handlers.get("trigger_sync")!({
      sourceId: SRC_A,
      mode: "incremental",
    })) as { isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(triggerSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceId: SRC_A }),
    );
  });

  it("allows an admin session to sync ANY source", async () => {
    getSourceMock.mockClear();
    triggerSyncMock.mockClear();
    getSourceMock.mockResolvedValue({ id: SRC_B, name: "Source B" });
    triggerSyncMock.mockResolvedValue({
      jobId: "job-2",
      ingestionId: "ing-2",
      mode: "full",
    });
    const { server, handlers } = fakeServer();
    registerTriggerSync(server, makeDeps(), ADMIN_SCOPE);

    const result = (await handlers.get("trigger_sync")!({
      sourceId: SRC_B,
      mode: "full",
    })) as { isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(triggerSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceId: SRC_B, mode: "full" }),
    );
  });
});
