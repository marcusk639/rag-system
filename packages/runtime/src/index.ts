export { initMonitoring, captureException } from "./monitoring.js";

import {
  EgressPolicy,
  createAuthProvider,
  type AuthProvider,
  type Config,
  type ObjectStore,
} from "@rag/core";
import { createDb, pgSslOption, type Db } from "@rag/db";
import { createQueue } from "@rag/ingestion";
import {
  Retriever,
  createEmbeddingProvider,
  createGenerator,
  createObjectStore,
  createReranker,
  type Generator,
} from "@rag/rag";
import type { Logger } from "pino";

/**
 * Queue handle (pg-boss). Derived from `createQueue`'s return type so the
 * runtime layer doesn't take a direct dependency on `pg-boss` — same pattern
 * the MCP/services layers use.
 */
export type Queue = Awaited<ReturnType<typeof createQueue>>;

export type Embedder = ReturnType<typeof createEmbeddingProvider>;

/**
 * The shared core dependency graph: DB pool, embedding provider, retriever,
 * queue, optional generator, and a single hardened `close()`. Every app
 * (api/mcp/worker) builds this once and then layers its own transport- or
 * worker-specific extras on top.
 */
export interface CoreDeps {
  db: Db;
  embedder: Embedder;
  retriever: Retriever;
  queue: Queue;
  /** Null when `config.generation` is not configured. */
  generator: Generator | null;
  /**
   * Object store for original document bytes. Null when object storage is
   * disabled (`OBJECT_STORE_PROVIDER=none`) — ingestion skips uploads and the
   * download route returns 404.
   */
  objectStore: ObjectStore | null;
  /** Drain pg-boss (graceful) then the DB pool. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Build the dependency graph every app shares. Wiring copied verbatim from the
 * former per-app `deps.ts` files (api was the cleanest core-only graph); the
 * `close()` is the worker's hardened variant (re-entrancy guard + per-resource
 * try/catch with error logging) so all three surfaces shut down identically.
 *
 * The generator is always instantiated when configured — there is no opt-out
 * flag. The worker simply ignores it; the cost of the unused instance is
 * negligible and avoiding it would mean an options-bag we explicitly don't want.
 */
/**
 * Build the deployment's `AuthProvider` from config. Single source of truth so
 * the HTTP API and the MCP HTTP transport authenticate IDENTICALLY (same
 * static tokens, same OIDC settings). The provider wraps `resolvePrincipal` —
 * the downstream `Principal` → `AuthorizationScope` → retrieval contract is
 * unchanged.
 *
 * Composite errors (e.g. a thrown OIDC verification path) are routed to the
 * logger rather than swallowed silently or printed to stdout.
 */
export function buildAuthProvider(
  config: Config,
  logger: Logger,
): AuthProvider {
  const base = {
    tokens: config.api.tokens,
    principals: config.api.principals,
    enforceScoping: config.api.enforceScoping,
  };
  switch (config.auth.provider) {
    case "static-token":
      return createAuthProvider({ provider: "static-token", ...base });
    case "oidc":
      // Schema guarantees oidc is present when provider === "oidc" (loadConfig
      // fails loud otherwise), but guard defensively for direct callers.
      if (!config.auth.oidc) {
        throw new Error("auth.provider is 'oidc' but no OIDC config was built");
      }
      return createAuthProvider({
        provider: "oidc",
        oidc: config.auth.oidc,
      });
    case "composite":
      return createAuthProvider({
        provider: "composite",
        ...base,
        oidc: config.auth.oidc,
        onError: (err) =>
          logger.warn({ err }, "auth provider error (isolated)"),
      });
  }
}

export async function buildCoreDeps(
  config: Config,
  logger: Logger,
): Promise<CoreDeps> {
  const urlHasTls = /sslmode=(require|verify-ca|verify-full)/.test(
    config.databaseUrl,
  );
  const tlsActive = config.databaseSsl
    ? config.databaseSsl !== "disable"
    : urlHasTls;
  if (config.environment === "production" && !tlsActive) {
    logger.warn(
      "Postgres connection has no TLS in production: DATABASE_SSL is unset/disable " +
        "and DATABASE_URL has no sslmode=require. DB traffic may be unencrypted. " +
        "Set DATABASE_SSL=require (or no-verify for managed certs), or add " +
        "?sslmode=require to DATABASE_URL for pool+pg-boss+migration coverage.",
    );
  }
  const { db, close: closeDb } = createDb(config.databaseUrl, {
    ssl: pgSslOption(config.databaseSsl),
  });

  const embedder = createEmbeddingProvider(config.embedding, {
    egressPolicy: EgressPolicy.fromEnv(),
    complianceMode: config.complianceMode,
  });

  const objectStore = createObjectStore(config.objectStore);

  const reranker = createReranker(config.rerank);

  const retriever = new Retriever(
    db,
    embedder,
    {
      topK: config.retrieval.defaultTopK,
      denseWeight: config.retrieval.hybridDenseWeight,
      sparseWeight: config.retrieval.hybridSparseWeight,
    },
    {
      reranker,
      poolMultiplier: config.rerank.poolMultiplier,
      onError: (err) =>
        logger.warn({ err }, "reranker failed — falling back to RRF order"),
    },
  );

  const queue = await createQueue({
    databaseUrl: config.databaseUrl,
    schema: config.pgBossSchema,
  });

  // Generation reuses the embedding provider's API key — same vendor in
  // practice (Gemini embedding + Gemini generation, OpenAI + OpenAI).
  let generator: Generator | null = null;
  if (config.generation) {
    const apiKey = config.embedding.apiKey;
    if (!apiKey) {
      logger.warn(
        { provider: config.generation.provider },
        "generation configured but no API key on embedding config — generation disabled",
      );
    } else {
      generator = createGenerator({
        provider: config.generation.provider,
        model: config.generation.model,
        apiKey,
        maxOutputTokens: config.generation.maxOutputTokens,
      });
    }
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Stop pg-boss first so it stops handing out new jobs and lets in-flight
    // ones finish (graceful: true). Then end the DB pool.
    try {
      await queue.stop({ graceful: true });
    } catch (err) {
      logger.error({ err }, "error stopping pg-boss");
    }
    try {
      await closeDb();
    } catch (err) {
      logger.error({ err }, "error closing db pool");
    }
  };

  return { db, embedder, retriever, queue, generator, objectStore, close };
}
