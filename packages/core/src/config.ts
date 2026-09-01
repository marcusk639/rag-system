import { existsSync, readdirSync } from "fs";
import { join } from "path";
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
      /**
       * Client-side pacing: cap embedding requests at N per minute.
       *
       * `maxRetries` above reacts to a 429 AFTER it happens, which does not
       * help when the burst is our own and predictable — a large document
       * chunks into several back-to-back batch calls, trips the provider's
       * per-minute limit, and every backoff lands in the same still-full
       * window. That document then fails permanently while smaller ones around
       * it succeed. This spaces the calls so the limit is never reached.
       *
       * 0 (the default) disables pacing, so nothing changes for deployments
       * that were not hitting a limit.
       */
      requestsPerMinute: z.number().int().min(0).default(0),
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
      /**
       * Secrets for verifying BFF-asserted scope-assertion tokens (see
       * `InternalScopeAuthProvider`). Comma-separated to support rotation
       * without downtime. Empty by default — the provider is simply excluded
       * from `composite` until at least one secret is configured.
       * Each secret must be at least 64 hex characters (256 bits of entropy
       * for HS256). Generate with `openssl rand -hex 32`.
       */
      internalScopeSecrets: z
        .array(
          z
            .string()
            .min(
              64,
              "INTERNAL_SCOPE_JWT_SECRETS entries must be at least 64 hex characters (256 bits of entropy for HS256) — generate with: openssl rand -hex 32",
            ),
        )
        .default([]),
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

        /**
         * Base URL for an OpenAI-compatible generation endpoint. Set this to
         * run generation against a self-hosted model (Ollama, vLLM, LM Studio,
         * llama.cpp) instead of a third-party API; combined with
         * `EMBEDDING_PROVIDER=local` nothing leaves the client's network.
         *
         * `openai` provider only — `GENERATION_PROVIDER=gemini` with this set
         * throws at generator construction rather than ignoring it.
         *
         * The egress allow-list applies to THIS host: add it to
         * `EGRESS_ALLOWED_HOSTS` or every call throws `EgressError`.
         *
         * Set via `GENERATION_BASE_URL`.
         */
        baseURL: z.string().url().optional(),

        /**
         * API key for generation. Optional: falls back to the embedding
         * provider's key (the single-vendor case), and is unnecessary
         * altogether for a self-hosted endpoint, which ignores it.
         *
         * Set via `GENERATION_API_KEY`.
         */
        apiKey: z.string().optional(),

        /**
         * What the generation-time TRI (Taxpayer Return Information) pre-flight
         * does when `scanForTRI` fires on the assembled prompt.
         *
         * **This governs the CONTEXTUAL patterns only.** `SSN` and `EIN` are
         * identifying and block regardless of this setting — see
         * `TRI_IDENTIFYING_LABELS` in tri-scanner.ts. One knob covering both
         * classes is what let a permissive default apply to a real identifier.
         *
         * The contextual patterns (`tax-form+amount`, `W2+amount`, …) match any
         * text naming an IRS form within ~50 characters of a dollar figure —
         * which is what a *procedure describing how to prepare that form* looks
         * like. Measured by a full screen of a representative accounting-firm
         * SOP corpus (858 documents,
         * 2026-08-01): **`tax-form+amount` matched 316 documents (36.8%) and the
         * inspected hits were SOPs.** Because one prompt bundles ~12 chunks, a
         * topically-clustered tax question reliably pulls in a tripping chunk,
         * so blocking on these makes the assistant fail on the questions it
         * exists to answer.
         *
         * That same screen matched `SSN`/`EIN` on 24 documents — 21 of them
         * chunked and retrievable — one holding 260 distinct SSN-shaped values.
         * No corpus-level false-positive rate makes that safe to disclose, which
         * is why the identifying patterns are not tunable here.
         *
         * - `block` — throw `ComplianceError` on any match; no provider call.
         *   Correct when real client tax documents are in the corpus.
         * - `warn` — proceed for contextual matches, invoking `onTriDetected` so
         *   the hit is logged/audited. Identifying matches still throw.
         * - `off` — skip the scan entirely, which disables the identifier guard
         *   too. Only correct where no third-party disclosure occurs (e.g.
         *   self-hosted generation).
         *
         * Set via `GENERATION_TRI_POLICY`. **`complianceMode=client-data`
         * overrides this to `block` at wiring time** (packages/runtime) so a
         * client-data deployment can never run permissively by omission.
         */
        // Default `block`, deliberately. The contextual patterns produce known
        // false positives on an internal-SOP corpus, so `warn` is the right
        // setting for many deployments — but it is a §7216 disclosure decision
        // and must be made explicitly, not inherited by saying nothing. A
        // deployment that never considered TRI gets the strict policy.
        triPolicy: z.enum(["block", "warn", "off"]).default("block"),
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

    /**
     * Compliance enforcement level (§7216 / CPA deployment).
     *
     * `none` (default) — no additional startup checks beyond the standard gates.
     * `client-data` — enforces that a DPA document is on file for every external
     *   generation vendor before the service boots. Startup aborts if no
     *   `docs/compliance/vendor-dpa-*.md` file exists. Use this mode in any
     *   environment where real firm/taxpayer documents may enter the pipeline.
     *
     * Set via `COMPLIANCE_MODE` env. Leave unset (or `none`) for dev/CI.
     */
    complianceMode: z.enum(["none", "client-data"]).default("none"),

    /**
     * The documentation-gap digest (Phase 4 of
     * docs/PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md) — the first recurring
     * (pg-boss `schedule()`) job in this codebase. It scans `audit_log` for
     * zero-result/weak-confidence queries and logs a structured summary.
     * All three knobs are config-driven (never hardcoded in `queue.ts`).
     */
    docsGapDigest: z.object({
      /** 5-field crontab expression. Default: weekly, Monday 06:00. */
      cron: z.string().min(1).default("0 6 * * 1"),
      /** IANA timezone the cron expression is evaluated in. */
      tz: z.string().min(1).default("UTC"),
      /** Retrieval `score` below this (0-1) counts as "weak". */
      minScore: z.number().min(0).max(1).default(0.3),
    }),

    /**
     * Off-host shipping of `audit_log` rows (e.g. to Datadog/Splunk/Papertrail
     * or any generic HTTPS collector) — a scheduled, cursor-based job (see
     * apps/worker/src/handlers/ship-audit-log.ts), NOT write-time. `none`
     * (default) disables shipping entirely; `webhook` POSTs rows as JSON to
     * `webhookUrl`, gated by `EgressPolicy` since rows carry real per-user
     * identity (`principalSubject`).
     */
    auditSink: z.object({
      provider: z.enum(["none", "webhook"]).default("none"),
      webhookUrl: z.string().url().optional(),
      webhookToken: z.string().optional(),
      /** 5-field crontab expression for the shipping job. Default: hourly. */
      cron: z.string().min(1).default("0 * * * *"),
      /** IANA timezone the cron expression is evaluated in. */
      tz: z.string().min(1).default("UTC"),
    }),
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
 * Parses a multi-value secret/token env var. Accepts either a JSON array of
 * strings (`["secret-one","secret-two"]`) — required when a value might
 * legitimately contain a comma — or falls back to comma-split for backward
 * compatibility with already-deployed plain comma-separated values.
 * Mirrors parseOidcAdminClaims's JSON-or-CSV pattern above.
 */
function parseMultiValueSecret(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        "Expected a JSON array of strings (value starts with '[') but failed to parse as JSON",
      );
    }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
      throw new Error("Expected a JSON array of strings");
    }
    return parsed.map((s) => s.trim()).filter(Boolean);
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
    "static-token" | "oidc" | "composite";

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

/**
 * Default DPA presence check: returns true when at least one
 * `docs/compliance/vendor-dpa-*.md` file exists relative to `cwd`.
 * Injected as `opts.checkDpa` in tests so no real FS access is needed.
 */
function defaultCheckDpa(cwd = process.cwd()): boolean {
  const dir = join(cwd, "docs", "compliance");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (f) => f.startsWith("vendor-dpa-") && f.endsWith(".md"),
  );
}

/**
 * Xenova/bge-base-en-v1.5 (the local embedding model — the ONLY provider
 * allowed under COMPLIANCE_MODE=client-data) has a hard 512-token limit.
 * Chunks longer than this are silently truncated by the underlying ONNX
 * pipeline with no signal, degrading retrieval quality invisibly. Capping
 * CHUNK_SIZE here makes overflow rare rather than routine; the local
 * embedder's `embedBatch` (packages/rag/src/embeddings/local.ts) backstops
 * the rare remaining case with a logged, non-fatal truncation warning.
 */
const LOCAL_PROVIDER_MAX_CHUNK_SIZE = 512;

/** Read env into a typed Config. Centralizes all env access in one place. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts?: {
    /** Override the DPA presence check for tests. Defaults to `defaultCheckDpa`. */
    checkDpa?: () => boolean;
    /**
     * Sink for startup warnings (e.g. the local-provider chunk-size cap).
     * Defaults to stderr — pino isn't constructed yet at loadConfig time
     * (every app's main.ts calls loadConfig() before building its logger).
     */
    warn?: (message: string) => void;
  },
): Config {
  const warn =
    opts?.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  const provider = (env.EMBEDDING_PROVIDER ?? "gemini") as
    "gemini" | "openai" | "local";
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

  const requestedChunkSize = Number(env.CHUNK_SIZE ?? 800);
  let effectiveChunkSize = requestedChunkSize;
  if (provider === "local") {
    const userSetChunkSize = env.CHUNK_SIZE !== undefined;
    if (
      userSetChunkSize &&
      requestedChunkSize > LOCAL_PROVIDER_MAX_CHUNK_SIZE
    ) {
      warn(
        `CHUNK_SIZE=${requestedChunkSize} exceeds the local embedding model's ` +
          `${LOCAL_PROVIDER_MAX_CHUNK_SIZE}-token limit (Xenova/bge-base-en-v1.5). ` +
          `Capping effective chunkSize to ${LOCAL_PROVIDER_MAX_CHUNK_SIZE} to avoid ` +
          `systematic silent truncation of every full-size chunk's embedding.`,
      );
    }
    effectiveChunkSize = Math.min(
      requestedChunkSize,
      LOCAL_PROVIDER_MAX_CHUNK_SIZE,
    );
  }

  const cfg = Config.parse({
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
      requestsPerMinute: Number(env.EMBEDDING_REQUESTS_PER_MINUTE ?? 0),
    },
    parser: {
      url: env.PARSER_URL ?? "http://localhost:8000",
      timeoutMs: Number(env.PARSER_TIMEOUT_MS ?? 60_000),
      secret: env.PARSER_SECRET || undefined,
    },
    api: {
      host: env.API_HOST,
      port: Number(env.API_PORT ?? 3000),
      tokens: parseMultiValueSecret(env.API_TOKENS ?? ""),
      // Throws loudly on malformed API_PRINCIPALS so a misconfig is caught at
      // startup rather than silently re-opening the corpus-wide read.
      principals: parsePrincipalsConfig(env.API_PRINCIPALS),
      enforceScoping: env.API_ENFORCE_SCOPING === "true",
    },
    mcp: {
      transport: env.MCP_TRANSPORT,
      httpPort: Number(env.MCP_HTTP_PORT ?? 3001),
    },
    auth: {
      ...buildAuthConfig(env),
      internalScopeSecrets: parseMultiValueSecret(
        env.INTERNAL_SCOPE_JWT_SECRETS ?? "",
      ),
    },
    worker: {
      concurrency: Number(env.WORKER_CONCURRENCY ?? 4),
      pollIntervalMs: Number(env.WORKER_POLL_INTERVAL_MS ?? 2000),
    },
    retrieval: {
      chunkSize: effectiveChunkSize,
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
        "none" | "cohere" | "jina" | "llm",
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
            baseURL: env.GENERATION_BASE_URL || undefined,
            apiKey: env.GENERATION_API_KEY || undefined,
            triPolicy: env.GENERATION_TRI_POLICY as
              "block" | "warn" | "off" | undefined,
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
    complianceMode: (env.COMPLIANCE_MODE ?? "none") as "none" | "client-data",
    docsGapDigest: {
      cron: env.DOCS_GAP_DIGEST_CRON || undefined,
      tz: env.DOCS_GAP_DIGEST_TZ || undefined,
      minScore:
        env.DOCS_GAP_DIGEST_MIN_SCORE !== undefined
          ? Number(env.DOCS_GAP_DIGEST_MIN_SCORE)
          : undefined,
    },
    auditSink: {
      provider: (env.AUDIT_SINK_PROVIDER ?? "none") as "none" | "webhook",
      webhookUrl: env.AUDIT_SINK_WEBHOOK_URL || undefined,
      webhookToken: env.AUDIT_SINK_WEBHOOK_TOKEN || undefined,
      cron: env.AUDIT_SINK_CRON || undefined,
      tz: env.AUDIT_SINK_TZ || undefined,
    },
  });

  // Compliance gate: in client-data mode a signed DPA must be on file before
  // any service boots. Fail loud so the operator can't accidentally run the
  // pipeline against real firm documents without a recorded legal agreement.
  if (cfg.complianceMode === "client-data") {
    const hasDpa = opts?.checkDpa ? opts.checkDpa() : defaultCheckDpa();
    if (!hasDpa) {
      throw new Error(
        "COMPLIANCE_MODE=client-data requires a signed DPA document at " +
          "docs/compliance/vendor-dpa-<vendor>.md. " +
          "Create the file (see docs/compliance/README.md) or set " +
          "COMPLIANCE_MODE=none to run without the gate.",
      );
    }
  }

  return cfg;
}
