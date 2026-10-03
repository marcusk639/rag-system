import { z } from "zod";
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
     * (pool + pg-boss + migrations) prefer an `?sslmode=` in DATABASE_URL;
     * this field only configures the main app pool.
     *
     * ⚠ Against a self-signed server cert use `no-verify`, not `require`:
     * pg-connection-string >= 2.10 aliases `require` to `verify-full`, which
     * fails the connection instead of encrypting it.
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
      /**
       * Directory holding the vertical's `pack.yaml` — the identifier
       * scanners the ingestion pipeline redacts against. Resolved relative to
       * `cwd`, matching how `docs/compliance` is located; the worker image
       * copies `packs/` alongside its code so the default works unchanged in
       * a container. Ingestion refuses to run without a loadable pack, so a
       * wrong path here fails the worker at startup rather than silently
       * indexing unredacted identifiers.
       */
      scannerPackDir: z.string().min(1).default("packs/cpa"),
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
      /**
       * "Small-to-big" expansion for /ask: for the top `documents` documents,
       * also hand the generator up to `chunksPerDocument` chunks adjacent to
       * the retrieved ones, so a multi-chunk procedure arrives whole. `0` in
       * either field disables it. Does not affect /search.
       */
      neighborExpansion: z
        .object({
          documents: z.number().int().nonnegative().default(2),
          chunksPerDocument: z.number().int().nonnegative().default(4),
        })
        .default({}),
      /** /ask relevance floor (RETRIEVAL_MIN_DENSE_SIMILARITY). Unset = off. */
      minDenseSimilarity: z.number().min(-1).max(1).optional(),
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
    /**
     * Layer 1.5 semantic content scanner (ingestion-time), separate from
     * generation/embeddings/rerank. `none` (default) means `ingestOne`
     * quarantines every document rather than skipping this check — see
     * `createContentScanner`'s docstring. MUST be self-hosted; never a
     * third-party API (same constraint as self-hosted generation).
     */
    contentScan: z.object({
      provider: z.enum(["none", "ollama"]).default("none"),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),

    generation: z
      .object({
        provider: z.enum(["gemini", "openai", "claude"]).default("gemini"),
        model: z.string().default("gemini-2.5-flash"),
        /**
         * Upper bound on generated answer length. Generous by default so
         * substantive, multi-source answers aren't truncated at provider
         * defaults. Tunable via `GENERATION_MAX_OUTPUT_TOKENS`.
         */
        maxOutputTokens: z.number().int().positive().default(2048),
        /**
         * Gemini only. Thinking tokens count against `maxOutputTokens`, so an
         * unset (dynamic) budget can cut a long answer short. Leave unset for
         * the provider default; set via `GENERATION_THINKING_BUDGET`.
         */
        thinkingBudget: z.number().int().nonnegative().optional(),

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
