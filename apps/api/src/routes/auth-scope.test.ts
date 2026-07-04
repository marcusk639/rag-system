import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  effectiveSourceFilter,
  type AuthorizationScope,
  type Config,
  type RetrievalQuery,
  type RetrievalResult,
} from "@rag/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

// Override ONLY triggerSync from @rag/services (via importOriginal passthrough)
// so the /sources/:id/sync tests below don't need a real DB/queue, while the
// existing /search and /ask tests keep running against the REAL askQuestion/
// searchDocuments services, untouched.
const { triggerSyncMock } = vi.hoisted(() => ({ triggerSyncMock: vi.fn() }));
vi.mock("@rag/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rag/services")>();
  return { ...actual, triggerSync: triggerSyncMock };
});

/**
 * Integration coverage for the P1 confidentiality boundary as it is actually
 * wired in the HTTP transport: bearer token -> AuthProvider -> Principal ->
 * AuthorizationScope -> service -> retriever. The pure scope math
 * (`effectiveSourceFilter`, `principalToScope`) and the DB `IN`-filter are unit
 * tested elsewhere (core/access-control.test.ts, db/queries.access-control.test.ts);
 * this proves the route layer threads the scope correctly and fails closed, so a
 * scoped token can never read — or generate an answer from — sources it isn't
 * granted.
 *
 * The retriever is faked but runs the REAL `effectiveSourceFilter` against a
 * fixed two-source corpus, so the intersection / admin-bypass / fail-closed
 * semantics are exercised exactly as production hits them.
 */

const SRC_A = "11111111-1111-1111-1111-111111111111";
const SRC_B = "22222222-2222-2222-2222-222222222222";

const ADMIN_TOKEN = "admin-token-aaaaaaaa";
const SCOPED_A_TOKEN = "scoped-a-token-bbbbbbbb";
const DENY_ALL_TOKEN = "deny-all-token-cccccccc";

function chunk(sourceId: string, id: string): RetrievalResult {
  return {
    text: `text ${id}`,
    score: 1,
    denseScore: 1,
    sparseScore: 1,
    document: {
      id: `doc-${id}`,
      title: `Doc ${id}`,
      sourceId,
      sourceKind: "upload",
      url: undefined,
      metadata: {},
    },
    chunk: {
      id: `chunk-${id}`,
      ordinal: 0,
      headingPath: [],
      page: undefined,
    },
  } as unknown as RetrievalResult;
}

const CORPUS: RetrievalResult[] = [chunk(SRC_A, "a"), chunk(SRC_B, "b")];

/**
 * Fake retriever that honors the scope via the production `effectiveSourceFilter`
 * and records every scope it is handed so tests can assert the exact boundary
 * the route resolved.
 */
function makeRetriever() {
  const scopes: AuthorizationScope[] = [];
  const search = vi.fn(
    async (
      query: RetrievalQuery,
      scope: AuthorizationScope,
    ): Promise<RetrievalResult[]> => {
      scopes.push(scope);
      const effective = effectiveSourceFilter(
        query.sourceIds,
        scope.enforcedSourceIds,
      );
      if (effective === null) return CORPUS; // admin / unrestricted
      if (effective.length === 0) return []; // fail closed
      const allowed = new Set(effective);
      return CORPUS.filter((r) => allowed.has(r.document.sourceId));
    },
  );
  return { search, scopes };
}

function makeGenerator() {
  const answer = vi.fn(
    async (_question: string, retrieved: RetrievalResult[]) => ({
      // Real generators cite via [N] notation; citations are now filtered to
      // only the indices the answer text references (see
      // filterCitationsToAnswer), so the fixture must actually cite them all
      // to keep asserting "every retrieved doc surfaces as a citation".
      answer: `grounded on ${retrieved.length} doc(s) ${retrieved.map((_, i) => `[${i + 1}]`).join(" ")}`,
      citations: retrieved.map((r, i) => ({
        index: i + 1,
        documentId: r.document.id,
        title: r.document.title,
        chunkId: r.chunk.id,
        score: r.score,
      })),
    }),
  );
  return { answer };
}

function makeDeps(
  retriever: ReturnType<typeof makeRetriever>,
  generator: ReturnType<typeof makeGenerator> | null,
): Deps {
  return {
    db: {} as Deps["db"],
    queue: {} as Deps["queue"],
    retriever: retriever as unknown as Deps["retriever"],
    generator: generator as unknown as Deps["generator"],
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

async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = await buildServer({
    config,
    logger: pino({ level: "silent" }),
    deps,
  });
  await app.ready();
  return app;
}

function sourceIdsOf(body: {
  results: Array<{ document: { sourceId: string } }>;
}) {
  return body.results.map((r) => r.document.sourceId);
}

describe("auth scope enforcement — /search", () => {
  it("rejects a request with no bearer token (401, never reaches the retriever)", async () => {
    const retriever = makeRetriever();
    const app = await buildApp(makeDeps(retriever, makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(401);
      expect(retriever.search).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an unrecognized token (401, fail closed)", async () => {
    const retriever = makeRetriever();
    const app = await buildApp(makeDeps(retriever, makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: "Bearer not-a-real-token" },
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(401);
      expect(retriever.search).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("an admin token (API_TOKENS) retrieves across ALL sources with an unrestricted scope", async () => {
    const retriever = makeRetriever();
    const app = await buildApp(makeDeps(retriever, makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(200);
      expect(sourceIdsOf(res.json()).sort()).toEqual([SRC_A, SRC_B]);
      expect(retriever.scopes[0]).toEqual({ enforcedSourceIds: null });
    } finally {
      await app.close();
    }
  });

  it("a scoped token retrieves ONLY its granted source", async () => {
    const retriever = makeRetriever();
    const app = await buildApp(makeDeps(retriever, makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(200);
      expect(sourceIdsOf(res.json())).toEqual([SRC_A]);
      expect(retriever.scopes[0]).toEqual({ enforcedSourceIds: [SRC_A] });
    } finally {
      await app.close();
    }
  });

  it("a scoped token CANNOT widen to another source via the caller sourceIds filter (fail closed, zero rows)", async () => {
    const retriever = makeRetriever();
    const app = await buildApp(makeDeps(retriever, makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
        // Caller explicitly asks for SRC_B — outside its grant. The intersection
        // is empty; it must get nothing, not SRC_B's documents.
        payload: { query: "q", sourceIds: [SRC_B] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toEqual([]);
      expect(retriever.scopes[0]).toEqual({ enforcedSourceIds: [SRC_A] });
    } finally {
      await app.close();
    }
  });

  it("a deny-all scoped principal (empty allowedSourceIds) retrieves nothing", async () => {
    const retriever = makeRetriever();
    const app = await buildApp(makeDeps(retriever, makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${DENY_ALL_TOKEN}` },
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toEqual([]);
      expect(retriever.scopes[0]).toEqual({ enforcedSourceIds: [] });
    } finally {
      await app.close();
    }
  });
});

describe("auth scope enforcement — /ask", () => {
  it("generates an answer grounded ONLY in the scoped token's source", async () => {
    const retriever = makeRetriever();
    const generator = makeGenerator();
    const app = await buildApp(makeDeps(retriever, generator));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
        payload: { question: "q" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Retrieval was scoped to SRC_A, so the generator only ever saw SRC_A docs.
      expect(retriever.scopes[0]).toEqual({ enforcedSourceIds: [SRC_A] });
      const [, retrieved] = generator.answer.mock.calls[0]!;
      expect(
        retrieved.map((r: RetrievalResult) => r.document.sourceId),
      ).toEqual([SRC_A]);
      expect(
        body.citations.map((c: { documentId: string }) => c.documentId),
      ).toEqual(["doc-a"]);
    } finally {
      await app.close();
    }
  });

  it("short-circuits to the empty answer (generator untouched) when the scope excludes the requested source", async () => {
    const retriever = makeRetriever();
    const generator = makeGenerator();
    const app = await buildApp(makeDeps(retriever, generator));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
        payload: { question: "q", sourceIds: [SRC_B] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.answer).toMatch(/do not contain enough information/i);
      expect(body.citations).toEqual([]);
      // The confidentiality boundary held BEFORE generation: no LLM call on
      // out-of-scope retrieval.
      expect(generator.answer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated /ask request (401)", async () => {
    const retriever = makeRetriever();
    const generator = makeGenerator();
    const app = await buildApp(makeDeps(retriever, generator));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        payload: { question: "q" },
      });
      expect(res.statusCode).toBe(401);
      expect(retriever.search).not.toHaveBeenCalled();
      expect(generator.answer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("auth scope enforcement — POST /sources/:id/sync", () => {
  it("returns 404 for a scoped token attempting to sync a source outside its allow-list (never calls triggerSync)", async () => {
    triggerSyncMock.mockClear();
    const app = await buildApp(makeDeps(makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: `/sources/${SRC_B}/sync`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(triggerSyncMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows a scoped token to sync a source WITHIN its allow-list", async () => {
    triggerSyncMock.mockClear();
    triggerSyncMock.mockResolvedValue({
      jobId: "job-1",
      ingestionId: "ing-1",
      mode: "incremental",
    });
    const app = await buildApp(makeDeps(makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: `/sources/${SRC_A}/sync`,
        headers: { authorization: `Bearer ${SCOPED_A_TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      expect(triggerSyncMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sourceId: SRC_A }),
      );
    } finally {
      await app.close();
    }
  });

  it("allows an admin token to sync ANY source", async () => {
    triggerSyncMock.mockClear();
    triggerSyncMock.mockResolvedValue({
      jobId: "job-2",
      ingestionId: "ing-2",
      mode: "full",
    });
    const app = await buildApp(makeDeps(makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: `/sources/${SRC_B}/sync`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { mode: "full" },
      });
      expect(res.statusCode).toBe(202);
      expect(triggerSyncMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sourceId: SRC_B, mode: "full" }),
      );
    } finally {
      await app.close();
    }
  });

  it("returns 404 for a deny-all scoped token on any source", async () => {
    triggerSyncMock.mockClear();
    const app = await buildApp(makeDeps(makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: `/sources/${SRC_A}/sync`,
        headers: { authorization: `Bearer ${DENY_ALL_TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(triggerSyncMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
