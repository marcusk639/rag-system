import { z } from "zod";
import { parsePrincipalsConfig } from "./access-control.js";
import { OidcConfig } from "./oidc-auth.js";

/**
 * Validated environment-derived configuration. Each runtime (api/mcp/worker)
 * calls `loadConfig()` once at startup and passes the result into its modules
 * so nothing else reads `process.env` directly.
 */
export const Config = z
  .object({
    databaseUrl: z.string().url(),
    pgBossSchema: z.string().default("pgboss"),

    /**
     * Optional TLS mode for the app's Postgres connection pool, from
     * DATABASE_SSL: "require" (verify cert), "no-verify" (TLS, skip verify),
     * "disable"/unset (no explicit TLS on the pool). For uniform coverage
     * (pool + pg-boss + migrations) prefer `?sslmode=require` in DATABASE_URL;
     * this field only configures the main app pool.
     */
    databaseSsl: z.enum(["disable", "require", "no-verify"]).optional(),

    embedding: z.object({
      provider: z.enum(["gemini", "openai", "local"]),
      model: z.string(),
      dimensions: z.number().int().positive(),
      apiKey: z.string().optional(),
      // Retries (after the first attempt) on transient 429 / RESOURCE_EXHAUSTED
      // from the embedding API, using exponential backoff + jitter. Lets bulk
      // embeds ride out rate limits (esp. the Gemini free tier) instead of
      // failing whole documents. 0 disables retrying.
      maxRetries: z.number().int().min(0).default(5),
    }),

    parser: z.object({
      url: z.string().url(),
      timeoutMs: z.number().int().positive().default(60_000),
      // Opt-in shared secret. When set, the sidecar requires a matching
      // X-Parser-Token header and the client sends it. Undefined = no auth
      // (acceptable only for loopback-bound single-host dev).
      secret: z.string().min(1).optional(),
    }),

    api: z.object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().positive().default(3000),
      /**
       * Plain (unscoped) bearer tokens. Each resolves to an ADMIN / all-access
       * principal (unrestricted retrieval) — backward-compatible with the
       * pre-ACL behavior. Reserve these for admin/service callers; use
       * `principals` to wall off scoped staff. See @rag/core access-control.
       */
      tokens: z.array(z.string()).min(1),
      /**
       * Scoped principals (opt-in confidentiality boundary). Any token here is
       * ENFORCED to its `allowedSourceIds` in retrieval and CANNOT see anything
       * else — scoped wins over `tokens` if a string appears in both (least
       * privilege). Sourced from the `API_PRINCIPALS` JSON env. Empty by default.
       * An entry with `isAdmin: true` grants explicit all-corpus admin.
       */
      principals: z.array(
        z.object({
          token: z.string().min(1),
          allowedSourceIds: z.array(z.string()),
          isAdmin: z.boolean().optional(),
        }),
      ),
      /**
       * When true (`API_ENFORCE_SCOPING=true`), plain `tokens` no longer grant
       * admin — they authenticate but resolve to deny-all. Admin must then be
       * granted explicitly via an `isAdmin` principal. Default false preserves
       * the backward-compatible "API_TOKENS = admin" behavior.
       */
      enforceScoping: z.boolean().default(false),
    }),

    mcp: z.object({
      transport: z.enum(["stdio", "http"]).default("stdio"),
      httpPort: z.number().int().positive().default(3001),
    }),

    /**
     * Authentication strategy. Provider-neutral: the static-token path is the
     * legacy behavior (admin/scoped tokens), and `oidc` is optional federated
     * JWT auth (e.g. Microsoft Entra ID) configured purely from env. `composite`
     * (the default) accepts both — static tokens AND OIDC JWTs — so existing
     * token deployments keep working while OIDC is layered on.
     *
     * `oidc` is undefined unless OIDC env is present. The runtime fails LOUD if
     * `provider` is "oidc"/"composite" but the OIDC env is incomplete (see
     * loadConfig); a "composite" with no OIDC env gracefully degrades to
     * static-token-only.
     */
    auth: z.object({
      provider: z
        .enum(["static-token", "oidc", "composite"])
        .default("composite"),
      oidc: OidcConfig.optional(),
    }),

    worker: z.object({
      concurrency: z.number().int().positive().default(4),
      pollIntervalMs: z.number().int().positive().default(2_000),
    }),

    retrieval: z.object({
      chunkSize: z.number().int().positive().default(800),
      chunkOverlap: z.number().int().nonnegative().default(120),
      defaultTopK: z.number().int().positive().default(12),
      hybridDenseWeight: z.number().min(0).max(1).default(0.7),
      hybridSparseWeight: z.number().min(0).max(1).default(0.3),
      /**
       * Per-document diversity cap applied to retrieved chunks before they reach
       * the generator (and any caller of `searchDocuments`/`askQuestion`). Stops
       * one long file from crowding out other sources. `0` disables the cap.
       */
      maxChunksPerDocument: z.number().int().nonnegative().default(3),
    }),

    /**
     * Reranking stage (Phase F). After hybrid RRF fusion, an optional reranker
     * re-orders the over-fetched candidate pool by true query relevance before
     * the top-K is handed to the caller/generator. `none` (default) is a
     * pass-through so deployments opt in; `cohere`/`jina` use a hosted
     * cross-encoder; `llm` reuses the configured generation client.
     */
    rerank: z.object({
      provider: z.enum(["none", "cohere", "jina", "llm"]).default("none"),
      model: z.string().optional(),
      apiKey: z.string().optional(),
      /**
       * How many candidates (as a multiple of the effective topK) to pull from
       * hybrid search and feed the reranker. Larger = better recall before
       * re-ranking, more rerank cost. Ignored when provider is `none`.
       */
      poolMultiplier: z.number().int().positive().default(5),
    }),

    generation: z
      .object({
        provider: z.enum(["gemini", "openai"]).default("gemini"),
        model: z.string().default("gemini-2.5-flash"),
        /**
         * Upper bound on generated answer length. Generous by default so
         * substantive, multi-source answers aren't truncated at provider
         * defaults. Tunable via `GENERATION_MAX_OUTPUT_TOKENS`.
         */
        maxOutputTokens: z.number().int().positive().default(2048),
      })
      .optional(),

    microsoft: z
      .object({
        tenantId: z.string(),
        clientId: z.string(),
        clientSecret: z.string(),
      })
      .optional(),

    google: z
      .object({
        serviceAccountJson: z.string().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        refreshToken: z.string().optional(),
      })
      .optional(),

    /**
     * Optional error-reporting DSN (Sentry-compatible). When set, unhandled
     * errors and failed sync jobs are reported to Sentry. Safe to omit in dev.
     */
    monitoring: z
      .object({
        sentryDsn: z.string().url(),
      })
      .optional(),

    /**
     * Where original document bytes are persisted so cited documents can be
     * downloaded later. `none` (default) keeps the historical behavior — originals
     * are not stored and the download route returns 404. `s3` targets any
     * S3-compatible store (AWS S3, Railway buckets, MinIO, GCS S3-mode).
     */
    objectStore: z.object({
      provider: z.enum(["none", "s3"]).default("none"),
      bucket: z.string().optional(),
      endpoint: z.string().url().optional(),
      region: z.string().default("us-east-1"),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
      // Path-style addressing is required by most S3-compatible stores
      // (MinIO/Railway); virtual-hosted style is AWS-only.
      forcePathStyle: z.boolean().default(true),
      // Optional prefix applied to every object key (e.g. "originals/").
      keyPrefix: z.string().default(""),
    }),

    /**
     * Deployment environment, derived from NODE_ENV. Drives fail-loud production
     * gates (e.g. PARSER_SECRET is mandatory in production). `test`/`development`
     * keep the relaxed local/CI behavior.
     */
    environment: z
      .enum(["development", "test", "production"])
      .default("development"),
  })
  .superRefine((cfg, ctx) => {
    // Production gate: the parser shared secret is mandatory in production so the
    // sidecar's /parse endpoint can't be called unauthenticated over a network.
    // Loopback-only dev/CI may omit it.
    if (cfg.environment === "production" && !cfg.parser.secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parser", "secret"],
        message:
          "PARSER_SECRET is required in production (set it on every service and " +
          "the parser sidecar). Empty/unset is only allowed for loopback-bound " +
          "development.",
      });
    }
  });
export type Config = z.infer<typeof Config>;

/**
 * Parse the `OIDC_SCOPE_MAP` env (a JSON array of
 * `{ claim, allowedSourceIds }`) into a typed list. Fails LOUD on malformed
 * JSON so a misconfigured security mapping is a startup error, not a silent
 * "everyone sees nothing". An absent/blank value yields `[]`.
 */
function parseOidcScopeMap(
  raw: string | undefined,
): { claim: string; allowedSourceIds: string[] }[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `OIDC_SCOPE_MAP is not valid JSON: ${(err as Error).message}. ` +
        `Expected a JSON array of {"claim": string, "allowedSourceIds": string[]}.`,
    );
  }
  // Shape is validated by OidcConfig (Zod) downstream; here we only guarantee
  // it's an array so the Zod error points at the right field.
  if (!Array.isArray(parsed)) {
    throw new Error(
      `OIDC_SCOPE_MAP must be a JSON array of ` +
        `{"claim": string, "allowedSourceIds": string[]}.`,
    );
  }
  return parsed as { claim: string; allowedSourceIds: string[] }[];
}

/**
 * Parse `OIDC_ADMIN_CLAIMS` — accepts either a JSON array of strings or a
 * comma-separated list. Returns undefined when absent (no admin claims).
 */
function parseOidcAdminClaims(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch (err) {
      throw new Error(
        `OIDC_ADMIN_CLAIMS looks like JSON but is invalid: ${(err as Error).message}. ` +
          `Use a JSON array of strings or a comma-separated list.`,
      );
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Assemble the `auth` config block from env. The provider defaults to
 * "composite". OIDC is built only when `OIDC_ISSUER` is present; if the
 * selected provider REQUIRES OIDC (provider === "oidc") but the env is
 * incomplete, we fail loud. A "composite" without OIDC env degrades to
 * static-token-only (so existing deployments don't crash).
 */
function buildAuthConfig(env: NodeJS.ProcessEnv): {
  provider: "static-token" | "oidc" | "composite";
  oidc?: z.input<typeof OidcConfig>;
} {
  const provider = (env.AUTH_PROVIDER ?? "composite") as
    | "static-token"
    | "oidc"
    | "composite";

  // OIDC is "present" when at least an issuer is configured. We require issuer
  // AND audience together — having one without the other is a misconfig.
  const hasOidcEnv = Boolean(env.OIDC_ISSUER || env.OIDC_AUDIENCE);

  if (!hasOidcEnv) {
    if (provider === "oidc") {
      throw new Error(
        "AUTH_PROVIDER=oidc requires OIDC_ISSUER and OIDC_AUDIENCE to be set.",
      );
    }
    // static-token, or composite-without-oidc => no oidc block.
    return { provider };
  }

  // OIDC env present: issuer + audience are mandatory. Zod (OidcConfig) does
  // the final url/shape validation; we surface the missing-pair case clearly.
  if (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE) {
    throw new Error(
      "Incomplete OIDC config: both OIDC_ISSUER and OIDC_AUDIENCE are required.",
    );
  }
  if (provider === "static-token") {
    // OIDC env set but provider explicitly excludes it — honor the explicit
    // choice but don't silently ignore a half-configured IdP.
    throw new Error(
      "OIDC env is set but AUTH_PROVIDER=static-token. Use 'oidc' or 'composite', " +
        "or remove the OIDC_* env vars.",
    );
  }

  return {
    provider,
    oidc: {
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
      jwksUri: env.OIDC_JWKS_URI || undefined,
      claim: env.OIDC_CLAIM || "groups",
      scopeMap: parseOidcScopeMap(env.OIDC_SCOPE_MAP),
      adminClaims: parseOidcAdminClaims(env.OIDC_ADMIN_CLAIMS),
    },
  };
}

/** Read env into a typed Config. Centralizes all env access in one place. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.EMBEDDING_PROVIDER ?? "gemini") as
    | "gemini"
    | "openai"
    | "local";
  const apiKey =
    provider === "gemini"
      ? env.GEMINI_API_KEY
      : provider === "openai"
        ? env.OPENAI_API_KEY
        : undefined;

  const microsoft =
    env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET
      ? {
          tenantId: env.MS_TENANT_ID,
          clientId: env.MS_CLIENT_ID,
          clientSecret: env.MS_CLIENT_SECRET,
        }
      : undefined;

  const google =
    env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
      ? {
          serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          refreshToken: env.GOOGLE_REFRESH_TOKEN,
        }
      : undefined;

  return Config.parse({
    databaseUrl: env.DATABASE_URL,
    pgBossSchema: env.PG_BOSS_SCHEMA,
    environment:
      env.NODE_ENV === "production"
        ? "production"
        : env.NODE_ENV === "test"
          ? "test"
          : "development",
    databaseSsl: env.DATABASE_SSL || undefined,
    embedding: {
      provider,
      model: env.EMBEDDING_MODEL ?? "gemini-embedding-001",
      dimensions: Number(env.EMBEDDING_DIMENSIONS ?? 768),
      apiKey,
      maxRetries:
        env.EMBEDDING_MAX_RETRIES !== undefined
          ? Number(env.EMBEDDING_MAX_RETRIES)
          : undefined,
    },
    parser: {
      url: env.PARSER_URL ?? "http://localhost:8000",
      timeoutMs: Number(env.PARSER_TIMEOUT_MS ?? 60_000),
      secret: env.PARSER_SECRET || undefined,
    },
    api: {
      host: env.API_HOST,
      port: Number(env.API_PORT ?? 3000),
      tokens: (env.API_TOKENS ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      // Throws loudly on malformed API_PRINCIPALS so a misconfig is caught at
      // startup rather than silently re-opening the corpus-wide read.
      principals: parsePrincipalsConfig(env.API_PRINCIPALS),
      enforceScoping: env.API_ENFORCE_SCOPING === "true",
    },
    mcp: {
      transport: env.MCP_TRANSPORT,
      httpPort: Number(env.MCP_HTTP_PORT ?? 3001),
    },
    auth: buildAuthConfig(env),
    worker: {
      concurrency: Number(env.WORKER_CONCURRENCY ?? 4),
      pollIntervalMs: Number(env.WORKER_POLL_INTERVAL_MS ?? 2000),
    },
    retrieval: {
      chunkSize: Number(env.CHUNK_SIZE ?? 800),
      chunkOverlap: Number(env.CHUNK_OVERLAP ?? 120),
      defaultTopK: env.DEFAULT_TOP_K ? Number(env.DEFAULT_TOP_K) : undefined,
      hybridDenseWeight: Number(env.HYBRID_DENSE_WEIGHT ?? 0.7),
      hybridSparseWeight: Number(env.HYBRID_SPARSE_WEIGHT ?? 0.3),
      maxChunksPerDocument:
        env.MAX_CHUNKS_PER_DOCUMENT !== undefined
          ? Number(env.MAX_CHUNKS_PER_DOCUMENT)
          : undefined,
    },
    rerank: {
      provider: (env.RERANK_PROVIDER ?? "none") as
        | "none"
        | "cohere"
        | "jina"
        | "llm",
      model: env.RERANK_MODEL || undefined,
      apiKey: env.RERANK_API_KEY || undefined,
      poolMultiplier: env.RERANK_POOL_MULTIPLIER
        ? Number(env.RERANK_POOL_MULTIPLIER)
        : undefined,
    },
    generation:
      env.GENERATION_PROVIDER && env.GENERATION_MODEL
        ? {
            provider: env.GENERATION_PROVIDER as "gemini" | "openai",
            model: env.GENERATION_MODEL,
            maxOutputTokens: env.GENERATION_MAX_OUTPUT_TOKENS
              ? Number(env.GENERATION_MAX_OUTPUT_TOKENS)
              : undefined,
          }
        : undefined,
    monitoring: env.SENTRY_DSN ? { sentryDsn: env.SENTRY_DSN } : undefined,
    microsoft,
    google,
    objectStore: {
      provider: (env.OBJECT_STORE_PROVIDER ?? "none") as "none" | "s3",
      bucket: env.OBJECT_STORE_BUCKET || undefined,
      endpoint: env.OBJECT_STORE_ENDPOINT || undefined,
      region: env.OBJECT_STORE_REGION || undefined,
      accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY || undefined,
      forcePathStyle:
        env.OBJECT_STORE_FORCE_PATH_STYLE !== undefined
          ? env.OBJECT_STORE_FORCE_PATH_STYLE === "true"
          : undefined,
      keyPrefix: env.OBJECT_STORE_KEY_PREFIX || undefined,
    },
  });
}
