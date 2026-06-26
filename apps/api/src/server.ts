import { pingDb } from "@rag/db";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Logger } from "pino";
import type { Config } from "@rag/core";
import { buildAuthProvider } from "@rag/runtime";
import { createAuthHook } from "./auth.js";
import type { Deps } from "./deps.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerAskRoute } from "./routes/ask.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerSearchRoute } from "./routes/search.js";
import { registerSourceRoutes } from "./routes/sources.js";

/**
 * Build (but do not start) the Fastify application. Exposed as a separate
 * function so tests can spin up the server in-process without binding a port.
 */
export async function buildServer(opts: {
  config: Config;
  logger: Logger;
  deps: Deps;
}): Promise<FastifyInstance> {
  const { config, logger, deps } = opts;

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 25 * 1024 * 1024,
    disableRequestLogging: false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyMultipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // H5 Rate limiting — protect cost-heavy endpoints from abuse.
  //
  // Default (all authenticated routes): 60 requests per minute per credential.
  // Per-route overrides tighten this for endpoints that trigger LLM calls or
  // full source syncs. The key is the bearer token so each credential has its
  // own independent bucket; probes (/health, /ready) are skipped entirely so
  // they always pass even under high load.
  await app.register(fastifyRateLimit, {
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      // Bearer token is the natural per-principal key. Trim to first 48 chars
      // (all entropy needed for a bucket key; avoids storing the full token).
      if (auth?.startsWith("Bearer ")) return auth.slice(7, 55);
      // Unauthenticated requests fall through to the auth hook and get 401
      // before reaching any handler, but we still assign a bucket to them.
      return request.ip ?? "unknown";
    },
    allowList: (request) =>
      request.url === "/health" || request.url === "/ready",
    // Default errorResponseBuilder returns new Error(msg) with statusCode=429
    // which our setErrorHandler maps to a 429 CLIENT_ERROR envelope.
  });

  // Global error handler — must register BEFORE routes so it catches their throws.
  registerErrorHandler(app);

  // Bearer-credential auth on every route except /health and /ready.
  app.addHook("onRequest", createAuthHook(buildAuthProvider(config, logger)));

  // -------- Liveness/readiness probes --------
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await pingDb(deps.db);
      return { status: "ready" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      return reply
        .code(503)
        .send({ status: "not-ready", error: "database unavailable" });
    }
  });

  // -------- Application routes --------
  await registerSourceRoutes(app, deps);
  await registerDocumentRoutes(app, deps);
  await registerSearchRoute(app, deps, config);
  await registerAskRoute(app, deps, config);

  return app;
}
