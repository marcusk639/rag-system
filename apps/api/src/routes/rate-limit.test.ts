import { describe, expect, it } from "vitest";
import pino from "pino";
import type { Config, RetrievalQuery, RetrievalResult } from "@rag/core";
import { signInternalScopeToken } from "@rag/core";
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

/**
 * Regression coverage for the keyGenerator bug found during review: a fixed
 * byte-offset slice of the raw bearer token (`auth.slice(7, 55)`) collapsed
 * every internal-scope JWT into ONE shared rate-limit bucket, because those
 * JWTs have a constant HS256 header plus a payload that always starts with
 * `{"allowedSourceIds":[...` regardless of which user signed it — the first
 * 48 characters were identical for every user. The fix extracts the JWT's
 * `sub` claim (unverified — verification happens later in the auth hook;
 * this is only a rate-limit bucket key) instead of slicing raw bytes.
 */
const INTERNAL_SCOPE_SECRET =
  "rate-limit-test-internal-scope-secret-32bytes+xxxxxxxxxxxxxxxxxx";

const compositeConfig = {
  api: { tokens: ["unused-static-token-placeholder"], principals: [] },
  auth: {
    provider: "composite",
    internalScopeSecrets: [INTERNAL_SCOPE_SECRET],
  },
  retrieval: { defaultTopK: 8, maxChunksPerDocument: 4 },
} as unknown as Config;

async function buildCompositeApp(): Promise<FastifyInstance> {
  const app = await buildServer({
    config: compositeConfig,
    logger: pino({ level: "silent" }),
    deps: makeDeps(),
  });
  await app.ready();
  return app;
}

describe("H5 rate limiting — internal-scope JWT bucket isolation", () => {
  it("two different users' scope-assertion JWTs get independent buckets, not a shared one", async () => {
    const app = await buildCompositeApp();

    const tokenAlice = await signInternalScopeToken(
      { sub: "aad-oid-alice", allowedSourceIds: ["src-a"] },
      INTERNAL_SCOPE_SECRET,
    );
    const tokenBob = await signInternalScopeToken(
      { sub: "aad-oid-bob", allowedSourceIds: ["src-b"] },
      INTERNAL_SCOPE_SECRET,
    );

    // Sanity-check the premise the bug relied on: both tokens really do
    // share the same first 48 characters (constant header + constant
    // `{"allowedSourceIds":[` payload prefix), so a slice-based key would
    // collide them into one bucket.
    expect(tokenAlice.slice(0, 48)).toBe(tokenBob.slice(0, 48));

    // Exhaust Alice's /ask bucket (10/min).
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: "POST",
        url: "/ask",
        payload: ASK_BODY,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenAlice}`,
        },
      });
    }
    const aliceExhausted = await app.inject({
      method: "POST",
      url: "/ask",
      payload: ASK_BODY,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenAlice}`,
      },
    });
    expect(aliceExhausted.statusCode).toBe(429);

    // Bob's bucket must still be fresh — this is the assertion that fails
    // under the old slice(0, 48)-based keyGenerator.
    const bobFresh = await app.inject({
      method: "POST",
      url: "/ask",
      payload: ASK_BODY,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenBob}`,
      },
    });
    expect(bobFresh.statusCode).not.toBe(429);
  });
});
