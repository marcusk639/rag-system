import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { parsePrincipalsConfig } from "./access-control.js";
import { OidcConfig } from "./oidc-auth.js";
import { Config } from "./config-schema.js";

/**
 * Validated environment-derived configuration — schema lives in
 * `config-schema.ts` (split out to stay under the 800-line file cap).
 * Re-exported here so every existing `import { Config } from "./config.js"`
 * keeps working unchanged.
 */
export * from "./config-schema.js";

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
      port: Number(env.API_PORT ?? env.PORT ?? 3000),
      tokens: parseMultiValueSecret(env.API_TOKENS ?? ""),
      // Throws loudly on malformed API_PRINCIPALS so a misconfig is caught at
      // startup rather than silently re-opening the corpus-wide read.
      principals: parsePrincipalsConfig(env.API_PRINCIPALS),
      enforceScoping: env.API_ENFORCE_SCOPING === "true",
    },
    mcp: {
      transport: env.MCP_TRANSPORT,
      httpPort: Number(env.MCP_HTTP_PORT ?? env.PORT ?? 3001),
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
      scannerPackDir: env.WORKER_SCANNER_PACK_DIR ?? "packs/cpa",
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
      neighborExpansion: {
        documents:
          env.NEIGHBOR_EXPANSION_DOCUMENTS !== undefined
            ? Number(env.NEIGHBOR_EXPANSION_DOCUMENTS)
            : undefined,
        chunksPerDocument:
          env.NEIGHBOR_EXPANSION_CHUNKS !== undefined
            ? Number(env.NEIGHBOR_EXPANSION_CHUNKS)
            : undefined,
      },
      minDenseSimilarity: env.RETRIEVAL_MIN_DENSE_SIMILARITY
        ? Number(env.RETRIEVAL_MIN_DENSE_SIMILARITY)
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
    // Retention of question/answer text. Policy decision, not tuning --
    // see the schema field in config-schema.ts and env.example. Without this
    // mapping the schema's `.default("none")` would make AUDIT_LOG_CONTENT=full
    // silently ineffective.
    auditLogContent: (env.AUDIT_LOG_CONTENT ?? "none") as "none" | "full",

    contentScan: {
      provider: (env.CONTENT_SCAN_PROVIDER ?? "none") as "none" | "ollama",
      baseUrl: env.CONTENT_SCAN_BASE_URL || undefined,
      model: env.CONTENT_SCAN_MODEL || undefined,
      timeoutMs: env.CONTENT_SCAN_TIMEOUT_MS
        ? Number(env.CONTENT_SCAN_TIMEOUT_MS)
        : undefined,
    },

    generation:
      env.GENERATION_PROVIDER && env.GENERATION_MODEL
        ? {
            provider: env.GENERATION_PROVIDER as "gemini" | "openai" | "claude",
            model: env.GENERATION_MODEL,
            maxOutputTokens: env.GENERATION_MAX_OUTPUT_TOKENS
              ? Number(env.GENERATION_MAX_OUTPUT_TOKENS)
              : undefined,
            thinkingBudget: env.GENERATION_THINKING_BUDGET
              ? Number(env.GENERATION_THINKING_BUDGET)
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
    // Layer 1.5 is opt-in and defaults to `none`, which means "off". That is
    // a defensible default for a corpus of general material, but not once the
    // operator has declared that real client data is in scope: "off" would
    // then be a silent bypass of the one layer that catches a client named in
    // prose, which pattern redaction structurally cannot see. Refuse the
    // combination rather than boot with the check quietly absent.
    if (cfg.contentScan.provider === "none") {
      throw new Error(
        "COMPLIANCE_MODE=client-data requires CONTENT_SCAN_PROVIDER to be " +
          "configured (Layer 1.5 semantic client-context detection). " +
          "CONTENT_SCAN_PROVIDER=none disables it entirely, which is not a " +
          "valid configuration when client data is in scope. Point it at a " +
          "self-hosted scanner (see env.example) or set COMPLIANCE_MODE=none.",
      );
    }
  }

  return cfg;
}
