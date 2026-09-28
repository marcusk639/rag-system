import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Config, RetrievalQuery, RetrievalResult } from "@rag/core";
import { MAX_ASK_TOP_K, MAX_HISTORY_TURNS } from "@rag/core";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

const TOKEN = "test-token-history";

const config = {
  api: { tokens: [TOKEN], principals: [] },
  auth: { provider: "static-token" },
  retrieval: { defaultTopK: 8, maxChunksPerDocument: 0 },
} as unknown as Config;

function harness() {
  const queries: string[] = [];
  const answerQuestions: string[] = [];
  const retriever = {
    search: async (q: RetrievalQuery): Promise<RetrievalResult[]> => {
      queries.push(q.query);
      return [
        {
          text: "retrieved",
          score: 1,
          denseScore: 1,
          sparseScore: 0,
          document: { id: "d1", title: "doc", sourceId: "s1", metadata: {} },
          chunk: { id: "c1", ordinal: 0, headingPath: [] },
        } as unknown as RetrievalResult,
      ];
    },
  };
  const generator = {
    complete: vi.fn(async () => "standalone rewrite"),
    answer: async (question: string) => {
      answerQuestions.push(question);
      return { answer: "ok [1]", citations: [] };
    },
    answerStream: async function* (question: string) {
      answerQuestions.push(question);
      yield "ok [1]";
    },
  };
  const deps = {
    db: {} as Deps["db"],
    queue: {} as Deps["queue"],
    retriever: retriever as unknown as Deps["retriever"],
    embedder: { name: "p", model: "m" } as Deps["embedder"],
    generator: generator as unknown as Deps["generator"],
    objectStore: null,
    logger: pino({ level: "silent" }),
    close: async () => {},
  } as Deps;
  return { deps, queries, answerQuestions, generator };
}

async function post(deps: Deps, url: string, payload: unknown) {
  const app = await buildServer({
    config,
    logger: pino({ level: "silent" }),
    deps,
  });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    payload,
  });
  await app.close();
  return res;
}

const HISTORY = [
  { role: "user", content: "How do I set up a bookkeeping client?" },
  { role: "assistant", content: "Apply BK-CATCHUP [1]." },
];

describe("POST /ask and /ask/stream — conversation history", () => {
  for (const url of ["/ask", "/ask/stream"]) {
    it(`${url}: retrieves with the rewrite, generates from the original question`, async () => {
      const h = harness();
      const res = await post(h.deps, url, {
        question: "and for payroll?",
        history: HISTORY,
      });
      expect(res.statusCode).toBe(200);
      expect(h.queries).toEqual(["standalone rewrite"]);
      expect(h.answerQuestions).toEqual(["and for payroll?"]);
    });
  }

  it("rejects history beyond the DoS bound with 400", async () => {
    const h = harness();
    const res = await post(h.deps, "/ask", {
      question: "q",
      history: Array.from({ length: MAX_HISTORY_TURNS + 1 }, () => ({
        role: "user",
        content: "x",
      })),
    });
    expect(res.statusCode).toBe(400);
    expect(h.queries).toEqual([]);
  });
});

describe("POST /ask — context size bound", () => {
  it(`rejects topK above MAX_ASK_TOP_K (${MAX_ASK_TOP_K}) — each chunk is ~800 tokens of prompt`, async () => {
    const h = harness();
    const res = await post(h.deps, "/ask", {
      question: "q",
      topK: MAX_ASK_TOP_K + 1,
    });
    expect(res.statusCode).toBe(400);
    expect(h.queries).toEqual([]);
  });

  it("accepts topK at the bound", async () => {
    const h = harness();
    const res = await post(h.deps, "/ask", {
      question: "q",
      topK: MAX_ASK_TOP_K,
    });
    expect(res.statusCode).toBe(200);
  });
});
