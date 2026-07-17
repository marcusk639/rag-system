import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Config } from "@rag/core";
import { signInternalScopeToken } from "@rag/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

/**
 * Task 5 (docs/PLAN-ANSWER-FEEDBACK-BACKEND): POST /feedback route.
 *
 * `@rag/services` is mocked (via importOriginal passthrough) so these tests
 * exercise route-layer wiring — Zod validation, the 204 contract, and (most
 * importantly) that `principal_subject` is derived from `request.principal`,
 * never from the client body — without needing a real DB. This mirrors how
 * `auth-scope.test.ts` overrides only `triggerSync` from the same module.
 */
const { submitAnswerFeedbackMock } = vi.hoisted(() => ({
  submitAnswerFeedbackMock: vi.fn(),
}));
vi.mock("@rag/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rag/services")>();
  return { ...actual, submitAnswerFeedback: submitAnswerFeedbackMock };
});

const ADMIN_TOKEN = "admin-token-aaaaaaaa";

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
    objectStore: null,
    logger: pino({ level: "silent" }),
    close: async () => {},
  };
}

const staticConfig = {
  api: { tokens: [ADMIN_TOKEN], principals: [] },
  auth: { provider: "static-token" },
  retrieval: { defaultTopK: 8 },
} as unknown as Config;

const INTERNAL_SCOPE_SECRET =
  "feedback-test-internal-scope-secret-32bytes+xxxxxxxxxxxxxxxxxxxxx";

const compositeConfig = {
  api: { tokens: [ADMIN_TOKEN], principals: [] },
  auth: {
    provider: "composite",
    internalScopeSecrets: [INTERNAL_SCOPE_SECRET],
  },
  retrieval: { defaultTopK: 8 },
} as unknown as Config;

async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = await buildServer({
    config,
    logger: pino({ level: "silent" }),
    deps: makeDeps(),
  });
  await app.ready();
  return app;
}

describe("POST /feedback", () => {
  it("returns 204 and calls the service with a valid body", async () => {
    submitAnswerFeedbackMock.mockClear();
    submitAnswerFeedbackMock.mockResolvedValue(undefined);
    const app = await buildApp(staticConfig);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { answerId: "a1", rating: "helpful" },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(submitAnswerFeedbackMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          answerId: "a1",
          rating: "helpful",
          channel: "web",
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("derives principal_subject from request.principal.subject (JWT sub), never the client body", async () => {
    submitAnswerFeedbackMock.mockClear();
    submitAnswerFeedbackMock.mockResolvedValue(undefined);
    const app = await buildApp(compositeConfig);
    try {
      const token = await signInternalScopeToken(
        { sub: "aad-oid-feedback-1", allowedSourceIds: [] },
        INTERNAL_SCOPE_SECRET,
      );
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { authorization: `Bearer ${token}` },
        // Client attempts to spoof another user's identity via the body —
        // there is no such field in the schema, but assert the service is
        // called with the SERVER-resolved subject regardless of body content.
        payload: {
          answerId: "a2",
          rating: "not_helpful",
          comment: "not accurate",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(submitAnswerFeedbackMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          answerId: "a2",
          rating: "not_helpful",
          comment: "not accurate",
          principalSubject: "aad-oid-feedback-1",
          channel: "web",
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("an admin (static-token) principal yields a null principalSubject", async () => {
    submitAnswerFeedbackMock.mockClear();
    submitAnswerFeedbackMock.mockResolvedValue(undefined);
    const app = await buildApp(staticConfig);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { answerId: "a3", rating: "helpful" },
      });
      expect(res.statusCode).toBe(204);
      expect(submitAnswerFeedbackMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ principalSubject: null }),
      );
    } finally {
      await app.close();
    }
  });

  it("400s on a bad rating value (Zod validation)", async () => {
    submitAnswerFeedbackMock.mockClear();
    const app = await buildApp(staticConfig);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { answerId: "a1", rating: "meh" },
      });
      expect(res.statusCode).toBe(400);
      expect(submitAnswerFeedbackMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("400s when comment exceeds 1000 characters", async () => {
    submitAnswerFeedbackMock.mockClear();
    const app = await buildApp(staticConfig);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: {
          answerId: "a1",
          rating: "helpful",
          comment: "x".repeat(1001),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(submitAnswerFeedbackMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("400s on a missing/empty answerId", async () => {
    submitAnswerFeedbackMock.mockClear();
    const app = await buildApp(staticConfig);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { answerId: "", rating: "helpful" },
      });
      expect(res.statusCode).toBe(400);
      expect(submitAnswerFeedbackMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated request (401, service untouched)", async () => {
    submitAnswerFeedbackMock.mockClear();
    const app = await buildApp(staticConfig);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        payload: { answerId: "a1", rating: "helpful" },
      });
      expect(res.statusCode).toBe(401);
      expect(submitAnswerFeedbackMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
