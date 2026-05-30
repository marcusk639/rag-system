import { buildServer, type Deps } from "@rag/api";
import { Retriever, type Generator } from "@rag/rag";
import type { Config } from "@rag/core";
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";
import type { Db } from "@rag/db";
import type PgBoss from "pg-boss";
import pino from "pino";
import { TEST_API_TOKEN, makeTestConfig } from "../env.js";
import { FakeEmbedder } from "../fakes/fake-embedder.js";

/**
 * Spin up a Fastify instance in-process with the FakeEmbedder + an optional
 * fake Generator wired into the Deps. Returns the app and a typed `inject()`
 * helper preconfigured with the test bearer token.
 *
 * The app does NOT bind a port — every test runs via Fastify's inject API.
 */
export async function buildTestApi(opts: {
  db: Db;
  generator?: Generator | null;
  queue?: PgBoss; // optional — sources/sync isn't covered, but Deps requires it
}): Promise<{
  app: FastifyInstance;
  config: Config;
  inject: TestInject;
  close: () => Promise<void>;
}> {
  const config = makeTestConfig();
  const logger = pino({ level: "silent" });

  const embedder = new FakeEmbedder();
  const retriever = new Retriever(opts.db, embedder, {
    topK: config.retrieval.defaultTopK,
    denseWeight: config.retrieval.hybridDenseWeight,
    sparseWeight: config.retrieval.hybridSparseWeight,
  });

  // pg-boss is required by the Deps interface even though we never invoke any
  // route that uses it. Provide a stub that satisfies the type contract.
  const queueStub = opts.queue ?? (stubQueue() as unknown as PgBoss);

  const deps: Deps = {
    db: opts.db,
    queue: queueStub,
    retriever,
    generator: opts.generator ?? null,
    close: async () => undefined, // owned by the spec, not by the harness
  };

  const app = await buildServer({ config, logger, deps });
  await app.ready();

  const inject: TestInject = async (req) => {
    const opts: InjectOptions = {
      ...req,
      headers: {
        authorization: `Bearer ${TEST_API_TOKEN}`,
        ...(req.headers ?? {}),
      },
    };
    return app.inject(opts);
  };

  return {
    app,
    config,
    inject,
    close: async () => {
      await app.close();
    },
  };
}

export type TestInject = (
  req: InjectOptions,
) => Promise<LightMyRequestResponse>;

// ----------------------------------------------------------------------------
// pg-boss stub — minimal surface to satisfy the Deps type without spinning up
// the real queue. None of the routes we test call into it.
// ----------------------------------------------------------------------------
function stubQueue(): Pick<PgBoss, "stop"> {
  return {
    stop: async () => undefined,
  } as unknown as PgBoss;
}
