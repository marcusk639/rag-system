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
      if (auth?.startsWith("Bearer ")) {
        const token = auth.slice(7);
        // Prefer the JWT's `sub` claim as the bucket key so every principal
        // gets its own independent bucket. Reading this here (before the
        // auth hook, which runs after rate-limiting) means the claim is
        // UNVERIFIED — fine for bucketing, not for authorization, since a
        // forged `sub` only lets an attacker dodge their own rate limit,
        // not impersonate another user's data access.
        //
        // A fixed byte-offset slice of the raw token is NOT a safe
        // substitute: this app's internal-scope JWTs (signInternalScopeToken)
        // have a constant HS256 header + a payload that always starts with
        // `{"allowedSourceIds":[...`, so the first 48 characters of EVERY
        // such token are identical regardless of user — collapsing all
        // per-user-auth traffic into one shared bucket. See
        // packages/core/src/internal-scope-auth.ts.
        try {
          const [, payloadB64] = token.split(".");
          if (payloadB64) {
            const payload: unknown = JSON.parse(
              Buffer.from(payloadB64, "base64url").toString("utf8"),
            );
            if (
              typeof payload === "object" &&
              payload !== null &&
              "sub" in payload &&
              typeof (payload as { sub: unknown }).sub === "string"
            ) {
              return (payload as { sub: string }).sub;
            }
          }
        } catch {
          // Malformed/opaque token (e.g. a static API token, which isn't a
          // JWT at all) — fall through to the raw-prefix key below.
        }
        // Non-JWT bearer credentials (static tokens): first 48 chars is
        // still a reasonable per-credential key, since those tokens are
        // fixed strings, not freshly-minted-per-request JWTs.
        return token.slice(0, 48);
      }
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
