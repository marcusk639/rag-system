import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type {
  AuthorizationScope,
  Config,
  RetrievalQuery,
  RetrievalResult,
} from "@rag/core";
import type { NewAuditLog } from "@rag/db";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

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
    embedder: {
      name: "test-embedding-provider",
      model: "test-embedding-model",
    } as Deps["embedder"],
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

describe("POST /ask — X-RAG-Channel header", () => {
  it("records channel 'teams' when X-RAG-Channel: teams header is present", async () => {
    const { db, rows } = makeAuditDb();
    const app = await buildApp(makeDeps(db, makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "x-rag-channel": "teams",
        },
        payload: { question: "what is the intake SOP?" },
      });
      expect(res.statusCode).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: "teams",
      });
    } finally {
      await app.close();
    }
  });

  it("defaults channel to 'api' when no X-RAG-Channel header is present", async () => {
    const { db, rows } = makeAuditDb();
    const app = await buildApp(makeDeps(db, makeRetriever(), makeGenerator()));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { question: "what is the intake SOP?" },
      });
      expect(res.statusCode).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: "api",
      });
    } finally {
      await app.close();
    }
  });
});
