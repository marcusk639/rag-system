import { describe, expect, it, vi, beforeEach } from "vitest";
import { type AuthorizationScope, RagError } from "@rag/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";

/**
 * Regression suite for the MCP error-leak finding: every registered tool must
 * route an unexpected failure through `guardToolHandler`, so the client never
 * receives a raw `Error.message`.
 *
 * `tool-error.test.ts` covers the guard's own behaviour. This file covers the
 * thing that unit test cannot: that each of the six registrations is actually
 * wrapped. A new tool that forgets the wrapper fails here, not in production.
 *
 * It is one file rather than a case bolted onto each tool's spec because the
 * property under test is cross-cutting and identical for all six — keeping it
 * together is what makes "are they all covered?" answerable at a glance.
 */
const mocks = vi.hoisted(() => {
  // ask.ts does `err instanceof GenerationNotConfiguredError`, so the mocked
  // module has to supply a real constructor, not a vi.fn().
  class GenerationNotConfiguredError extends Error {}
  return {
    askQuestion: vi.fn(),
    searchDocuments: vi.fn(),
    getDocumentById: vi.fn(),
    listPublicSources: vi.fn(),
    triggerSync: vi.fn(),
    purgeSource: vi.fn(),
    getSource: vi.fn(),
    getDocument: vi.fn(),
    logAskEvent: vi.fn(),
    captureException: vi.fn(),
    GenerationNotConfiguredError,
  };
});

vi.mock("@rag/services", () => ({
  askQuestion: mocks.askQuestion,
  searchDocuments: mocks.searchDocuments,
  getDocumentById: mocks.getDocumentById,
  listPublicSources: mocks.listPublicSources,
  triggerSync: mocks.triggerSync,
  purgeSource: mocks.purgeSource,
  GenerationNotConfiguredError: mocks.GenerationNotConfiguredError,
}));
vi.mock("@rag/db", () => ({
  getSource: mocks.getSource,
  getDocument: mocks.getDocument,
  logAskEvent: mocks.logAskEvent,
}));
vi.mock("@rag/runtime", () => ({ captureException: mocks.captureException }));

import { registerAsk } from "./ask.js";
import { registerGetDocument } from "./get-document.js";
import { registerListSources } from "./list-sources.js";
import { registerPurgeSource } from "./purge-source.js";
import { registerSearchDocuments } from "./search-documents.js";
import { registerTriggerSync } from "./trigger-sync.js";

/**
 * The internals a leak would expose: private host, port, DB role, password.
 * A real `pg` connection failure reads almost exactly like this.
 */
const LEAKY =
  'connect ECONNREFUSED 10.0.0.5:5432 (user="rag_admin" password="hunter2")';
const SECRETS = ["ECONNREFUSED", "10.0.0.5", "5432", "rag_admin", "hunter2"];

const SRC = "11111111-1111-1111-1111-111111111111";
const DOC = "22222222-2222-2222-2222-222222222222";
const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };

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

function makeDeps(): Deps {
  return {
    db: {} as Deps["db"],
    embedder: {
      name: "gemini",
      model: "gemini-embedding-001",
    } as Deps["embedder"],
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as Deps["logger"],
    config: {
      retrieval: { defaultTopK: 8, maxChunksPerDocument: 3 },
      generation: { model: "gemini-2.0-flash" },
    } as unknown as Deps["config"],
  } as unknown as Deps;
}

type Registrar = (
  server: McpServer,
  deps: Deps,
  scope: AuthorizationScope,
) => void;

interface Case {
  tool: string;
  register: Registrar;
  args: Record<string, unknown>;
  /** Make the dependency this tool calls fail with an internal error. */
  breakIt: () => void;
}

const CASES: Case[] = [
  {
    tool: "ask",
    register: registerAsk,
    args: { question: "what is the policy?" },
    breakIt: () => mocks.askQuestion.mockRejectedValue(new Error(LEAKY)),
  },
  {
    tool: "search_documents",
    register: registerSearchDocuments,
    args: { query: "policy" },
    breakIt: () => mocks.searchDocuments.mockRejectedValue(new Error(LEAKY)),
  },
  {
    tool: "get_document",
    register: registerGetDocument,
    args: { documentId: DOC },
    breakIt: () => mocks.getDocumentById.mockRejectedValue(new Error(LEAKY)),
  },
  {
    tool: "list_sources",
    register: registerListSources,
    args: {},
    breakIt: () => mocks.listPublicSources.mockRejectedValue(new Error(LEAKY)),
  },
  {
    tool: "trigger_sync",
    register: registerTriggerSync,
    args: { sourceId: SRC },
    breakIt: () => {
      mocks.getSource.mockResolvedValue({ id: SRC, name: "Source A" });
      mocks.triggerSync.mockRejectedValue(new Error(LEAKY));
    },
  },
  {
    tool: "purge_source",
    register: registerPurgeSource,
    args: { sourceId: SRC },
    breakIt: () => {
      mocks.getSource.mockResolvedValue({ id: SRC, name: "Source A" });
      mocks.purgeSource.mockRejectedValue(new Error(LEAKY));
    },
  },
];

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    if (typeof m === "function" && "mockReset" in m) m.mockReset();
  }
});

describe("MCP tools never leak an internal error message", () => {
  for (const { tool, register, args, breakIt } of CASES) {
    it(`${tool} returns a sanitized tool error`, async () => {
      breakIt();
      const { server, handlers } = fakeServer();
      register(server, makeDeps(), ADMIN_SCOPE);

      const handler = handlers.get(tool);
      expect(handler, `${tool} was not registered`).toBeDefined();

      const result = (await handler!(args)) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe("Internal server error");

      const serialized = JSON.stringify(result);
      for (const secret of SECRETS) {
        expect(serialized, `${tool} leaked ${secret}`).not.toContain(secret);
      }
    });
  }

  it("still surfaces a duplicate sync's own message to the caller", async () => {
    // trigger_sync documented this case before the guard existed, and it is the
    // reason the guard cannot simply genericize everything: SYNC_ALREADY_RUNNING
    // is the caller's answer, not an internal detail. (Constructed as a bare
    // RagError because @rag/services is mocked in this file; @rag/ingestion's
    // SyncAlreadyRunningError carries exactly this code.)
    mocks.getSource.mockResolvedValue({ id: SRC, name: "Source A" });
    mocks.triggerSync.mockRejectedValue(
      new RagError(
        `A sync is already pending or running for source ${SRC}`,
        "SYNC_ALREADY_RUNNING",
      ),
    );
    const { server, handlers } = fakeServer();
    registerTriggerSync(server, makeDeps(), ADMIN_SCOPE);

    const result = (await handlers.get("trigger_sync")!({
      sourceId: SRC,
    })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: { error: { code: string } };
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("already pending or running");
    expect(result.structuredContent?.error.code).toBe("SYNC_ALREADY_RUNNING");
    // A busy resource is not a crash — it must not page anyone.
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("covers every tool the server registers", async () => {
    // Guards against a seventh tool being added and silently skipping the
    // wrapper: server.ts's registration list and CASES must stay in step.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../server.ts", import.meta.url), "utf8"),
    );
    const registered = [...source.matchAll(/register(\w+)\(server/g)].map(
      (m) => m[1],
    );
    expect(registered.length).toBe(CASES.length);
  });
});
