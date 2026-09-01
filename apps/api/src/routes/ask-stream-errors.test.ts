import { describe, expect, it } from "vitest";
import pino from "pino";
import type { Config, RetrievalQuery, RetrievalResult } from "@rag/core";
import { ComplianceError, EgressError } from "@rag/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { Deps } from "../deps.js";

/**
 * The streaming path writes its 200 header before generation starts, so it
 * cannot use the status-code mapping in error-handler.ts — every failure was
 * flattened to `{"message":"Generation failed."}`.
 *
 * That defeats the air-gap verification in docs/LOCAL-GENERATION.md: pull the
 * endpoint's host out of EGRESS_ALLOWED_HOSTS, ask again, and the documented
 * signal is `EGRESS_BLOCKED`. Through apps/web — the surface staff actually use,
 * and the only one that consumes this stream — an operator instead saw the same
 * string they would get if the model were simply unreachable.
 *
 * Only the two policy codes are echoed. They are server-side decisions about
 * configuration, and their messages carry a hostname or TRI pattern labels
 * rather than document text. Everything else stays generic, because a raw
 * error here can carry connection details.
 */

const TOKEN = "test-token-stream";

const config = {
  api: { tokens: [TOKEN], principals: [] },
  auth: { provider: "static-token" },
  retrieval: { defaultTopK: 8, maxChunksPerDocument: 4 },
} as unknown as Config;

function makeDeps(thrown: Error): Deps {
  const retriever = {
    search: async (_q: RetrievalQuery): Promise<RetrievalResult[]> => [
      {
        text: "some retrieved text",
        score: 1,
        denseScore: 1,
        sparseScore: 0,
        document: {
          id: "d1",
          title: "doc",
          sourceId: "s1",
          sourceKind: "git-markdown",
          uri: "https://example.test/doc",
        },
      } as unknown as RetrievalResult,
    ],
  };
  const generator = {
    answer: async () => {
      throw thrown;
    },

    answerStream: async function* () {
      throw thrown;
    },
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

async function askStream(thrown: Error): Promise<string> {
  const app: FastifyInstance = await buildServer({
    config,
    logger: pino({ level: "silent" }),
    deps: makeDeps(thrown),
  });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/ask/stream",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    payload: { question: "what is the answer?" },
  });
  await app.close();
  return res.body;
}

describe("POST /ask/stream — error codes survive the stream", () => {
  it("emits EGRESS_BLOCKED so the documented air-gap check is observable", async () => {
    const body = await askStream(
      new EgressError(
        "host not-allowed.example is not in the egress allow-list",
      ),
    );

    expect(body).toContain("event: error");
    expect(body).toContain("EGRESS_BLOCKED");
    // The operator must be able to tell this apart from an unreachable model.
    expect(body).not.toContain("Generation failed.");
  });

  it("emits COMPLIANCE_VIOLATION rather than a generic failure", async () => {
    const body = await askStream(
      new ComplianceError("TRI detected in generation input (patterns: SSN)"),
    );

    expect(body).toContain("event: error");
    expect(body).toContain("COMPLIANCE_VIOLATION");
    expect(body).not.toContain("Generation failed.");
  });

  it("still hides every other error behind the generic message", async () => {
    // Regression guard on the boundary this fix moves. An arbitrary error can
    // carry connection strings or upstream detail; only the two policy codes
    // are safe to echo.
    const body = await askStream(
      new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
    );

    expect(body).toContain("event: error");
    expect(body).toContain("Generation failed.");
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("hunter2");
  });
});
