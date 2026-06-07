import { z } from "zod";
import { parsePrincipalsConfig } from "./access-control.js";

/**
 * Validated environment-derived configuration. Each runtime (api/mcp/worker)
 * calls `loadConfig()` once at startup and passes the result into its modules
 * so nothing else reads `process.env` directly.
 */
export const Config = z.object({
  databaseUrl: z.string().url(),
  pgBossSchema: z.string().default("pgboss"),

  embedding: z.object({
    provider: z.enum(["gemini", "openai", "local"]),
    model: z.string(),
    dimensions: z.number().int().positive(),
    apiKey: z.string().optional(),
  }),

  parser: z.object({
    url: z.string().url(),
    timeoutMs: z.number().int().positive().default(60_000),
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
     */
    principals: z.array(
      z.object({
        token: z.string().min(1),
        allowedSourceIds: z.array(z.string()),
      }),
    ),
  }),

  mcp: z.object({
    transport: z.enum(["stdio", "http"]).default("stdio"),
    httpPort: z.number().int().positive().default(3001),
  }),

  worker: z.object({
    concurrency: z.number().int().positive().default(4),
    pollIntervalMs: z.number().int().positive().default(2_000),
  }),

  retrieval: z.object({
    chunkSize: z.number().int().positive().default(800),
    chunkOverlap: z.number().int().nonnegative().default(120),
    defaultTopK: z.number().int().positive().default(8),
    hybridDenseWeight: z.number().min(0).max(1).default(0.7),
    hybridSparseWeight: z.number().min(0).max(1).default(0.3),
  }),

  generation: z
    .object({
      provider: z.enum(["gemini", "openai"]).default("gemini"),
      model: z.string().default("gemini-2.5-flash"),
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
});
export type Config = z.infer<typeof Config>;

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
    embedding: {
      provider,
      model: env.EMBEDDING_MODEL ?? "text-embedding-004",
      dimensions: Number(env.EMBEDDING_DIMENSIONS ?? 768),
      apiKey,
    },
    parser: {
      url: env.PARSER_URL ?? "http://localhost:8000",
      timeoutMs: Number(env.PARSER_TIMEOUT_MS ?? 60_000),
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
    },
    mcp: {
      transport: env.MCP_TRANSPORT,
      httpPort: Number(env.MCP_HTTP_PORT ?? 3001),
    },
    worker: {
      concurrency: Number(env.WORKER_CONCURRENCY ?? 4),
      pollIntervalMs: Number(env.WORKER_POLL_INTERVAL_MS ?? 2000),
    },
    retrieval: {
      chunkSize: Number(env.CHUNK_SIZE ?? 800),
      chunkOverlap: Number(env.CHUNK_OVERLAP ?? 120),
      defaultTopK: Number(env.DEFAULT_TOP_K ?? 8),
      hybridDenseWeight: Number(env.HYBRID_DENSE_WEIGHT ?? 0.7),
      hybridSparseWeight: Number(env.HYBRID_SPARSE_WEIGHT ?? 0.3),
    },
    generation:
      env.GENERATION_PROVIDER && env.GENERATION_MODEL
        ? {
            provider: env.GENERATION_PROVIDER as "gemini" | "openai",
            model: env.GENERATION_MODEL,
          }
        : undefined,
    microsoft,
    google,
  });
}
