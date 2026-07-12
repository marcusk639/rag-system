import { describe, expect, it } from "vitest";
import pino from "pino";
import type { Config, RetrievalQuery, RetrievalResult } from "@rag/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

/**
 * Smoke tests for the H5 rate-limit layer.
 *
 * Verifies:
 *  - POST /ask is capped at 10/min per bearer token → 11th request → 429
 *  - GET /health is exempt from rate limiting (allowList)
 *  - Different tokens have independent buckets
 *
 * Rate limit state is in-memory and resets per-server instance, so each
 * test gets a fresh bucket automatically.
 */

const TOKEN_A = "test-token-aaaaaa";
const TOKEN_B = "test-token-bbbbbb";

const config = {
  api: { tokens: [TOKEN_A, TOKEN_B], principals: [] },
  auth: { provider: "static-token" },
  retrieval: { defaultTopK: 8, maxChunksPerDocument: 4 },
} as unknown as Config;

function makeDeps(): Deps {
  const retriever = {
    search: async (_q: RetrievalQuery): Promise<RetrievalResult[]> => [],
  };
  const generator = {
    answer: async () => ({
      answer: "test answer",
      citations: [],
      reviewStatus: "pending" as const,
      disclaimer: "test disclaimer",
    }),
  };
  return {
    db: {} as Deps["db"],
    queue: {} as Deps["queue"],
    retriever: retriever as unknown as Deps["retriever"],
    embedder: {
      name: "test-provider",
      model: "test-model",
    } as Deps["embedder"],
    generator: generator as unknown as Deps["generator"],
    objectStore: null,
    logger: pino({ level: "silent" }),
    close: async () => {},
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = await buildServer({
    config,
    logger: pino({ level: "silent" }),
    deps: makeDeps(),
  });
  await app.ready();
  return app;
}

const ASK_BODY = JSON.stringify({ question: "what is the answer?" });
const ASK_HEADERS = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN_A}`,
};

describe("H5 rate limiting", () => {
  it("returns 429 on POST /ask after 10 requests in the same window", async () => {
    const app = await buildApp();

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/ask",
        payload: ASK_BODY,
        headers: ASK_HEADERS,
      });
      statuses.push(res.statusCode);
    }

    // First 10 must not be rate-limited (may be 200 or other service errors, never 429)
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    // Requests 11+ must be rate-limited
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it("GET /health is exempt from rate limiting", async () => {
    const app = await buildApp();

    // Flood /health well past any threshold — all must pass
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      statuses.push(res.statusCode);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("each bearer token has an independent rate-limit bucket", async () => {
    const app = await buildApp();

    // Exhaust TOKEN_A's /ask bucket
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/ask",
        payload: ASK_BODY,
        headers: ASK_HEADERS,
      });
    }

    // TOKEN_A next request → 429
    const exhausted = await app.inject({
      method: "POST",
      url: "/ask",
      payload: ASK_BODY,
      headers: ASK_HEADERS,
    });
    expect(exhausted.statusCode).toBe(429);

    // TOKEN_B has its own fresh bucket → not rate-limited
    const fresh = await app.inject({
      method: "POST",
      url: "/ask",
      payload: ASK_BODY,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN_B}`,
      },
    });
    expect(fresh.statusCode).not.toBe(429);
  });
});
