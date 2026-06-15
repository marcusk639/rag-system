import { pingDb } from "@rag/db";
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

  // Fastify v5's `FastifyBaseLogger` adds an `msgPrefix` field that pino's
  // own `Logger` doesn't declare. The implementations are runtime-compatible —
  // pino has a `child()` that produces the same shape — so we cast through
  // the structural intersection rather than mutate the pino logger.
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // 25 MB body limit — large enough for inline-uploaded documents, small
    // enough to avoid accidental OOM from a malformed client.
    bodyLimit: 25 * 1024 * 1024,
    disableRequestLogging: false,
  });

  // Zod-aware validation + serialization.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Global error handler — must register BEFORE routes so it catches their throws.
  registerErrorHandler(app);

  // Bearer-credential auth on every route except /health and /ready. The
  // pluggable AuthProvider (static tokens, OIDC JWTs, or both via composite —
  // selected by AUTH_PROVIDER) resolves each credential to a Principal (admin
  // for plain API_TOKENS, scoped for API_PRINCIPALS or OIDC scope-map) and
  // decorates `request.principal` — the source of the MANDATORY retrieval
  // authorization scope used by /search and /ask.
  app.addHook("onRequest", createAuthHook(buildAuthProvider(config, logger)));

  // -------- Liveness/readiness probes --------
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await pingDb(deps.db);
      return { status: "ready" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      // Do not echo the raw error — pg connection errors include the
      // DATABASE_URL (with credentials). The detail is logged server-side above.
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
