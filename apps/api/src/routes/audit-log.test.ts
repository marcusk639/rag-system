import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type {
  AuthorizationScope,
  Config,
  RetrievalQuery,
  RetrievalResult,
} from "@rag/core";
import { signInternalScopeToken } from "@rag/core";
import type { NewAuditLog } from "@rag/db";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

/**
 * Phase 3 (docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md): search-path audit
 * logging parity. `/ask` already wrote one `audit_log` row per call; this
 * closes the same gap for `/search` and adds the `topScore` signal to both.
 *
 * `logAskEvent` (`packages/db/src/queries.ts`) issues a real
 * `db.insert(auditLog).values(...)` — rather than stand up Postgres here
 * (this repo's `apps/api` route tests are DB-free, mirroring
 * `auth-scope.test.ts`), `deps.db` is faked with an `insert` that records
 * every row passed to `.values(...)`. Since `auditAsk`/`auditSearch` invoke
 * `logAskEvent` synchronously (fire-and-forget, not awaited) before the route
 * handler returns, and `db.insert(...).values(...)` executes synchronously up
 * to its first internal `await`, the fake's `.values` call is recorded by the
 * time `app.inject(...)` resolves — no extra tick-waiting needed.
 */

const SRC_A = "11111111-1111-1111-1111-111111111111";
const ADMIN_TOKEN = "admin-token-aaaaaaaa";

function result(id: string, score: number): RetrievalResult {
  return {
    text: `text ${id}`,
    score,
    denseScore: score,
    sparseScore: score,
    document: {
      id: `doc-${id}`,
      title: `Doc ${id}`,
      sourceId: SRC_A,
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

const CORPUS: RetrievalResult[] = [result("a", 0.91), result("b", 0.42)];

function makeRetriever() {
  const search = vi.fn(
    async (
      _query: RetrievalQuery,
      _scope: AuthorizationScope,
    ): Promise<RetrievalResult[]> => CORPUS,
  );
  return { search };
}

function makeGenerator() {
  const answer = vi.fn(
    async (_question: string, retrieved: RetrievalResult[]) => ({
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

/** Fake `Deps["db"]` capturing every row inserted via `logAskEvent`. */
function makeAuditDb(): { db: Deps["db"]; rows: NewAuditLog[] } {
  const rows: NewAuditLog[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((row: NewAuditLog) => {
        rows.push(row);
        return Promise.resolve();
      }),
    })),
  } as unknown as Deps["db"];
  return { db, rows };
}

function makeDeps(
  db: Deps["db"],
  retriever: ReturnType<typeof makeRetriever>,
  generator: ReturnType<typeof makeGenerator> | null,
): Deps {
  return {
    db,
    queue: {} as Deps["queue"],
    retriever: retriever as unknown as Deps["retriever"],
    generator: generator as unknown as Deps["generator"],
    logger: pino({ level: "silent" }),
    close: async () => {},
  };
}

const config = {
  api: { tokens: [ADMIN_TOKEN], principals: [] },
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

describe("audit_log parity — POST /search", () => {
  it("inserts a row with endpoint='search' and a populated topScore when results exist", async () => {
    const { db, rows } = makeAuditDb();
    const app = await buildApp(makeDeps(db, makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { query: "what is our refund policy" },
      });
      expect(res.statusCode).toBe(200);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        endpoint: "search",
        topScore: 0.91,
        retrievedCount: 2,
        channel: "api",
        principalKind: "admin",
      });
      // No raw query text anywhere on the row — only a one-way hash.
      expect(rows[0]!.questionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows[0])).not.toContain("refund policy");
    } finally {
      await app.close();
    }
  });

  it("does not block the response if the audit insert fails", async () => {
    const { db } = makeAuditDb();
    (db.insert as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.reject(new Error("insert failed"))),
    }));
    const app = await buildApp(makeDeps(db, makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("audit_log parity — POST /ask", () => {
  it("existing behavior is unchanged; the new row has endpoint='ask' and a populated topScore", async () => {
    const { db, rows } = makeAuditDb();
    const generator = makeGenerator();
    const app = await buildApp(makeDeps(db, makeRetriever(), generator));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { question: "what is our refund policy" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.answer).toContain("grounded on 2 doc(s)");
      expect(body.citations).toHaveLength(2);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        endpoint: "ask",
        topScore: 0.91,
        retrievedCount: 2,
        channel: "api",
        principalKind: "admin",
      });
      expect(JSON.stringify(rows[0])).not.toContain("refund policy");
    } finally {
      await app.close();
    }
  });

  it("topScore is null when retrieval returns nothing", async () => {
    const { db, rows } = makeAuditDb();
    const emptyRetriever = { search: vi.fn(async () => []) };
    const generator = makeGenerator();
    const app = await buildApp(
      makeDeps(
        db,
        emptyRetriever as unknown as ReturnType<typeof makeRetriever>,
        generator,
      ),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { question: "anything" },
      });
      expect(res.statusCode).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        endpoint: "ask",
        topScore: null,
        retrievedCount: 0,
      });
      expect(generator.answer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

/**
 * SDD Task 4 (per-user-auth follow-ups): the scope-assertion JWT's verified
 * `sub` (AAD oid) is threaded through Principal -> `auditAsk`/`auditSearch`
 * -> `principal_subject`. Uses the composite auth provider (static-token +
 * InternalScopeAuthProvider) so a real signed JWT exercises the full
 * `request.principal.subject` -> row plumbing without needing Postgres (the
 * `db` fake here mirrors the rest of this file).
 */
const INTERNAL_SCOPE_SECRET = "audit-log-test-internal-scope-secret-32bytes+";

const compositeConfig = {
  api: { tokens: [ADMIN_TOKEN], principals: [] },
  auth: {
    provider: "composite",
    internalScopeSecrets: [INTERNAL_SCOPE_SECRET],
  },
  retrieval: { defaultTopK: 8 },
} as unknown as Config;

async function buildCompositeApp(deps: Deps): Promise<FastifyInstance> {
  const app = await buildServer({
    config: compositeConfig,
    logger: pino({ level: "silent" }),
    deps,
  });
  await app.ready();
  return app;
}

describe("audit_log principal_subject — scope-assertion JWT plumbing", () => {
  it("POST /ask populates principal_subject from the JWT's verified sub", async () => {
    const { db, rows } = makeAuditDb();
    const app = await buildCompositeApp(
      makeDeps(db, makeRetriever(), makeGenerator()),
    );
    try {
      const token = await signInternalScopeToken(
        { sub: "aad-oid-plumbing-1", allowedSourceIds: [SRC_A] },
        INTERNAL_SCOPE_SECRET,
      );
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${token}` },
        payload: { question: "what is our refund policy" },
      });
      expect(res.statusCode).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        principalKind: "scoped",
        principalSubject: "aad-oid-plumbing-1",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /search populates principal_subject from the JWT's verified sub", async () => {
    const { db, rows } = makeAuditDb();
    const app = await buildCompositeApp(
      makeDeps(db, makeRetriever(), makeGenerator()),
    );
    try {
      const token = await signInternalScopeToken(
        { sub: "aad-oid-plumbing-2", allowedSourceIds: [SRC_A] },
        INTERNAL_SCOPE_SECRET,
      );
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${token}` },
        payload: { query: "what is our refund policy" },
      });
      expect(res.statusCode).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        principalKind: "scoped",
        principalSubject: "aad-oid-plumbing-2",
      });
    } finally {
      await app.close();
    }
  });

  it("an admin (static-token) principal still writes a null principal_subject", async () => {
    const { db, rows } = makeAuditDb();
    const app = await buildCompositeApp(
      makeDeps(db, makeRetriever(), makeGenerator()),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { question: "what is our refund policy" },
      });
      expect(res.statusCode).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        principalKind: "admin",
        principalSubject: null,
      });
    } finally {
      await app.close();
    }
  });
});
