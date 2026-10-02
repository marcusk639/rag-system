import { isPostgresTlsActive } from "./postgres-tls.js";
export { initMonitoring, captureException } from "./monitoring.js";

import {
  EgressPolicy,
  createAuthProvider,
  resolveGenerationCredentials,
  type AuditLogSink,
  type AuthProvider,
  type Config,
  type ObjectStore,
} from "@rag/core";
import { createDb, pgSslOption, type Db } from "@rag/db";
import { createQueue } from "@rag/ingestion";
import {
  Retriever,
  createAuditLogSink,
  createEmbeddingProvider,
  createGenerator,
  createObjectStore,
  createReranker,
  type Generator,
  type TriPolicy,
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
  /**
   * Off-host sink for `audit_log` rows. Null when shipping is disabled
   * (`AUDIT_SINK_PROVIDER=none`) — the ship-audit-log job then no-ops.
   */
  auditLogSink: AuditLogSink | null;
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
    case "composite": {
      // `composite` silently drops the verifiers it has no config for: OIDC when
      // OIDC_* is absent, and the BFF scope verifier when
      // INTERNAL_SCOPE_JWT_SECRETS is empty. A deployment can therefore believe
      // it enforces per-user scoping while running static-token-only, with
      // nothing in the log to say so. Say so.
      const hasOidc = Boolean(config.auth.oidc);
      const hasInternalScope =
        (config.auth.internalScopeSecrets?.length ?? 0) > 0;
      logger.info(
        {
          provider: "composite",
          verifiers: [
            "static-token",
            ...(hasOidc ? ["oidc"] : []),
            ...(hasInternalScope ? ["internal-scope"] : []),
          ],
          enforceScoping: config.api.enforceScoping ?? false,
        },
        "auth chain built",
      );
      if (!hasOidc && !hasInternalScope) {
        logger.warn(
          "AUTH_PROVIDER=composite resolved to static-token ONLY — no OIDC_* and " +
            "no INTERNAL_SCOPE_JWT_SECRETS. Per-user scope assertions from the web " +
            "BFF cannot be verified and will be rejected. If that is not intended, " +
            "note the name: the API reads INTERNAL_SCOPE_JWT_SECRETS (plural); the " +
            "singular INTERNAL_SCOPE_JWT_SECRET is read only by apps/web.",
        );
      }
      return createAuthProvider({
        provider: "composite",
        ...base,
        oidc: config.auth.oidc,
        internalScopeSecrets: config.auth.internalScopeSecrets,
        onError: (err) =>
          logger.warn({ err }, "auth provider error (isolated)"),
      });
    }
  }
}

/**
 * Resolve the effective TRI policy for generation.
 *
 * `client-data` compliance mode forces the strict policy regardless of
 * GENERATION_TRI_POLICY. The permissive setting (`warn`, opt-in since the
 * default moved to `block`) is calibrated for an
 * internal-SOP corpus where the scan's contextual patterns are known false
 * positives; a deployment that has declared real client data in scope must
 * never inherit that leniency — not by omission, and not by an explicit
 * `warn`/`off` that predates the compliance declaration.
 *
 * Exported for its own sake: this one decision is what several comments
 * elsewhere point at when they argue a looser setting is safe, so it is the
 * kind of rule that should fail a test rather than a deployment.
 */
export function resolveTriPolicy(
  complianceMode: string | undefined,
  configured: TriPolicy | undefined,
): TriPolicy {
  return complianceMode === "client-data" ? "block" : (configured ?? "block");
}

export async function buildCoreDeps(
  config: Config,
  logger: Logger,
): Promise<CoreDeps> {
  if (
    config.environment === "production" &&
    !isPostgresTlsActive(config.databaseSsl, config.databaseUrl)
  ) {
    logger.warn(
      "Postgres connection has no TLS in production: DATABASE_SSL is unset/disable " +
        "and DATABASE_URL has no sslmode. DB traffic may be unencrypted. " +
        "Add ?sslmode=no-verify to DATABASE_URL for pool+pg-boss+migration " +
        "coverage. Do NOT use sslmode=require against a self-signed server cert " +
        "(Railway's postgres-ssl image): pg-connection-string treats it as " +
        "verify-full and the connection fails instead of encrypting.",
    );
  }
  const { db, close: closeDb } = createDb(config.databaseUrl, {
    ssl: pgSslOption(config.databaseSsl),
  });

  // Shared across every provider that needs egress enforcement (embedder,
  // audit-log sink) so they all honor the SAME EGRESS_ALLOWED_HOSTS allow-list.
  const egressPolicy = EgressPolicy.fromEnv();

  const embedder = createEmbeddingProvider(config.embedding, {
    egressPolicy,
    complianceMode: config.complianceMode,
  });

  const objectStore = createObjectStore(config.objectStore);

  const auditLogSink = createAuditLogSink(config.auditSink, { egressPolicy });

  // Same shared policy as the embedder and audit sink above — a hosted
  // reranker ships firm document text to a third-party vendor, so it belongs
  // behind the one `EGRESS_ALLOWED_HOSTS` allow-list, not outside it.
  const reranker = createReranker(config.rerank, {
    egressPolicy,
    complianceMode: config.complianceMode,
  });

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
    docsGapDigestCron: config.docsGapDigest.cron,
    docsGapDigestTz: config.docsGapDigest.tz,
    shipAuditLogCron: config.auditSink.cron,
    shipAuditLogTz: config.auditSink.tz,
  });

  let generator: Generator | null = null;
  if (config.generation) {
    // Generation used to borrow the embedding provider's key outright, on the
    // assumption of a single vendor. That assumption fails for the deployment
    // this feature exists to serve: EMBEDDING_PROVIDER=local has no key, so a
    // self-hosted generation endpoint would have disabled itself here.
    const credentials = resolveGenerationCredentials({
      generationApiKey: config.generation.apiKey,
      embeddingApiKey: config.embedding.apiKey,
      baseURL: config.generation.baseURL,
      // Both supplied so key inheritance is gated on the vendors matching —
      // without them a `claude` deployment would inherit the Gemini/OpenAI
      // embedding key and mail it to Anthropic.
      generationProvider: config.generation.provider,
      embeddingProvider: config.embedding.provider,
    });
    if (credentials.kind === "disabled") {
      logger.warn(
        { provider: config.generation.provider, reason: credentials.reason },
        "generation configured but no usable API key — generation disabled",
      );
    } else {
      const triPolicy = resolveTriPolicy(
        config.complianceMode,
        config.generation.triPolicy,
      );
      if (triPolicy !== config.generation.triPolicy) {
        logger.info(
          { triPolicy, complianceMode: config.complianceMode },
          "generation TRI policy forced by compliance mode",
        );
      }
      generator = createGenerator({
        provider: config.generation.provider,
        model: config.generation.model,
        apiKey: credentials.apiKey,
        ...(config.generation.baseURL
          ? { baseURL: config.generation.baseURL }
          : {}),
        maxOutputTokens: config.generation.maxOutputTokens,
        ...(config.generation.thinkingBudget !== undefined
          ? { thinkingBudget: config.generation.thinkingBudget }
          : {}),
        onTruncated: () =>
          logger.warn(
            {
              marker: "generation.truncated",
              maxOutputTokens: config.generation?.maxOutputTokens,
            },
            "generated answer hit the output-token limit and was cut off",
          ),
        // The same shared policy the embedder, audit sink, and reranker use.
        // Without it the generator built its own from the environment — same
        // allow-list in practice, but nothing guaranteed it.
        egressPolicy,
        triPolicy,
        onTriDetected: (patterns) =>
          logger.warn(
            { triPatterns: patterns, marker: "generation.tri.warned" },
            "TRI patterns detected in generation prompt; proceeding under triPolicy=warn",
          ),
        onContextDropped: (dropped) =>
          logger.warn(
            {
              dropped: dropped.map((d) => ({
                chunkId: d.chunkId,
                documentId: d.documentId,
                triPatterns: d.patterns,
              })),
              marker: "generation.tri.context_dropped",
            },
            "TRI-bearing chunks removed from generation context; fix or exclude the source documents",
          ),
      });
      if (config.generation.baseURL) {
        // An operator who believes they are air-gapped needs one line in the
        // boot log confirming it — and that line must not affirm a belief we
        // have not checked. A deployment whose EGRESS_ALLOWED_HOSTS omits this
        // host boots clean and then 503s on every /ask; say so at boot instead.
        //
        // Logged, never thrown: api/mcp crash-looping on a config error is an
        // existing deployment hazard (see CLAUDE.md), and retrieval still works
        // without generation.
        try {
          egressPolicy.assertAllowed(config.generation.baseURL);
          logger.info(
            { baseURL: config.generation.baseURL },
            "generation using a self-hosted endpoint",
          );
        } catch {
          logger.error(
            {
              baseURL: config.generation.baseURL,
              allowedHosts: egressPolicy.allowedHosts,
            },
            "GENERATION_BASE_URL host is not in EGRESS_ALLOWED_HOSTS — every /ask will fail with EGRESS_BLOCKED",
          );
        }
      }
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

  return {
    db,
    embedder,
    retriever,
    queue,
    generator,
    objectStore,
    auditLogSink,
    close,
  };
}
