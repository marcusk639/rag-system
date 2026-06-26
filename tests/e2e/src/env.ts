import type { Config } from "@rag/core";

/**
 * Single source of truth for E2E test environment values.
 *
 * Defaults match `docker/docker-compose.yml` so the suite works against a
 * locally running `pnpm docker:up` stack with no extra env wiring. CI can
 * override via DATABASE_URL / PARSER_URL.
 */
export const TEST_API_TOKEN = "e2e-test-token";

export const env = {
  databaseUrl:
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://rag:rag@localhost:5432/rag",
  parserUrl:
    process.env.E2E_PARSER_URL ??
    process.env.PARSER_URL ??
    "http://localhost:8000",
  // `|| undefined` (not `??`) so a blank PARSER_SECRET normalizes to undefined,
  // matching loadConfig and the schema's `.min(1).optional()` expectation.
  parserSecret:
    (process.env.E2E_PARSER_SECRET ?? process.env.PARSER_SECRET) || undefined,
  // Dedicated pg-boss schema so a leftover queue from `pnpm dev:worker` runs
  // doesn't surface jobs into the test suite.
  pgBossSchema: process.env.E2E_PGBOSS_SCHEMA ?? "pgboss_e2e",
} as const;

/**
 * Build a `Config` for the in-process API/Retriever. Generation is left
 * undefined; the /ask spec injects a fake Generator directly into Deps.
 */
export function makeTestConfig(): Config {
  return {
    databaseUrl: env.databaseUrl,
    pgBossSchema: env.pgBossSchema,
    embedding: {
      provider: "local",
      model: "fake-bow-768",
      dimensions: 768,
      apiKey: undefined,
      // Inert for the local deterministic embedder (it never rate-limits);
      // present only to satisfy the required EmbeddingConfig field.
      maxRetries: 0,
    },
    parser: {
      url: env.parserUrl,
      timeoutMs: 60_000,
      secret: env.parserSecret,
    },
    api: {
      host: "127.0.0.1",
      port: 0, // never bound; we use Fastify inject()
      tokens: [TEST_API_TOKEN],
      // No scoped principals in the base test config — the test token is an
      // admin (all-access) principal, preserving pre-ACL retrieval behavior.
      principals: [],
    },
    mcp: { transport: "stdio", httpPort: 3001 },
    // Static-token auth only — the test token resolves to an admin principal,
    // matching the `tokens`/`principals` above. No OIDC in the e2e harness.
    auth: { provider: "static-token" },
    worker: { concurrency: 1, pollIntervalMs: 2_000 },
    retrieval: {
      chunkSize: 800,
      chunkOverlap: 120,
      defaultTopK: 8,
      hybridDenseWeight: 0.7,
      hybridSparseWeight: 0.3,
      maxChunksPerDocument: 3,
    },
    // Reranking disabled in the e2e harness (no hosted reranker available).
    rerank: { provider: "none", poolMultiplier: 5 },
    // Originals storage disabled in the e2e harness (no object store running).
    objectStore: {
      provider: "none",
      region: "us-east-1",
      forcePathStyle: true,
      keyPrefix: "",
    },
    environment: "test",
  };
}
