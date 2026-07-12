import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Config } from "@rag/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

/**
 * P1 fix coverage: `/sources` (list/get/create) previously had ZERO
 * scope/authorization enforcement — any valid bearer token (admin or scoped)
 * could enumerate every source's metadata and create arbitrary new sources.
 * This mirrors `auth-scope.test.ts`'s integration style (real auth hook +
 * real `listPublicSources` scope filtering; only the DB layer is faked) so
 * the actual route-layer wiring is exercised, not just the pure scope math.
 */

const { listSourcesMock, getSourceMock, createSourceMock } = vi.hoisted(() => ({
  listSourcesMock: vi.fn(),
  getSourceMock: vi.fn(),
  createSourceMock: vi.fn(),
}));

vi.mock("@rag/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rag/db")>();
  return {
    ...actual,
    listSources: listSourcesMock,
    getSource: getSourceMock,
    createSource: createSourceMock,
  };
});

const SRC_A = "11111111-1111-1111-1111-111111111111";
const SRC_B = "22222222-2222-2222-2222-222222222222";
const SRC_NEW = "33333333-3333-3333-3333-333333333333";

const ADMIN_TOKEN = "admin-token-aaaaaaaa";
const SCOPED_A_TOKEN = "scoped-a-token-bbbbbbbb";
const DENY_ALL_TOKEN = "deny-all-token-cccccccc";

function sourceRow(id: string, name: string) {
  return {
    id,
    kind: "sharepoint" as const,
    name,
    config: { secret: "should-never-leak" },
    cursor: null,
    lastSyncedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    dataClass: "general" as const,
  };
}

const ROW_A = sourceRow(SRC_A, "Source A");
const ROW_B = sourceRow(SRC_B, "Source B");

function makeDeps(): Deps {
  return {
    db: {} as Deps["db"],
    queue: {} as Deps["queue"],
    retriever: {} as Deps["retriever"],
    embedder: {
      name: "test-provider",
      model: "test-model",
    } as Deps["embedder"],
    generator: null,
    logger: pino({ level: "silent" }),
    close: async () => {},
  };
}

const config = {
  api: {
    tokens: [ADMIN_TOKEN],
    principals: [
      { token: SCOPED_A_TOKEN, allowedSourceIds: [SRC_A] },
      { token: DENY_ALL_TOKEN, allowedSourceIds: [] },
    ],
  },
  auth: { provider: "static-token" },
  retrieval: { defaultTopK: 8 },
} as unknown as Config;

async function buildApp(): Promise<FastifyInstance> {
  const app = await buildServer({
    config,
    logger: pino({ level: "silent" }),
    deps: makeDeps(),
  });
  await app.ready();
  return app;
}

describe("GET /sources — scope enforcement", () => {
  it("an admin token lists ALL sources", async () => {
    listSourcesMock.mockResolvedValue([ROW_A, ROW_B]);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = res
        .json()
        .sources.map((s: { id: string }) => s.id)
        .sort();
      expect(ids).toEqual([SRC_A, SRC_B]);
    } finally {
      await app.close();
    }
  });

  it("a scoped token lists ONLY sources within its allowedSourceIds", async () => {
    listSourcesMock.mockResolvedValue([ROW_A, ROW_B]);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const sources = res.json().sources;
      expect(sources.map((s: { id: string }) => s.id)).toEqual([SRC_A]);
      // config must never be echoed back, even to an admin.
      expect(sources[0].config).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("a deny-all scoped token lists nothing", async () => {
    listSourcesMock.mockResolvedValue([ROW_A, ROW_B]);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { authorization: `Bearer ${DENY_ALL_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sources).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated request (401, never reaches the DB)", async () => {
    listSourcesMock.mockClear();
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/sources" });
      expect(res.statusCode).toBe(401);
      expect(listSourcesMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("GET /sources/:id — scope enforcement", () => {
  it("returns 404 (not 403 — no existence leak) for a scoped token requesting a disallowed source", async () => {
    getSourceMock.mockClear();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/sources/${SRC_B}`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
      expect(getSourceMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows a scoped token to fetch a source WITHIN its allow-list", async () => {
    getSourceMock.mockClear();
    getSourceMock.mockResolvedValue(ROW_A);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/sources/${SRC_A}`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(SRC_A);
      expect(res.json().config).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("allows an admin token to fetch ANY source", async () => {
    getSourceMock.mockClear();
    getSourceMock.mockResolvedValue(ROW_B);
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/sources/${SRC_B}`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(SRC_B);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for a deny-all scoped token on any source", async () => {
    getSourceMock.mockClear();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/sources/${SRC_A}`,
        headers: { authorization: `Bearer ${DENY_ALL_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
      expect(getSourceMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("POST /sources — admin-only", () => {
  const body = {
    kind: "sharepoint" as const,
    name: "New Source",
    config: { siteId: "abc" },
  };

  it("returns 403 for a scoped (non-admin) token, never calling createSource", async () => {
    createSourceMock.mockClear();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sources",
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(createSourceMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 403 for a deny-all scoped token", async () => {
    createSourceMock.mockClear();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sources",
        headers: { authorization: `Bearer ${DENY_ALL_TOKEN}` },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(createSourceMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("succeeds (201) for an admin token, unchanged", async () => {
    createSourceMock.mockClear();
    createSourceMock.mockResolvedValue(sourceRow(SRC_NEW, "New Source"));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sources",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: body,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe(SRC_NEW);
      expect(createSourceMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: "sharepoint", name: "New Source" }),
      );
    } finally {
      await app.close();
    }
  });
});
