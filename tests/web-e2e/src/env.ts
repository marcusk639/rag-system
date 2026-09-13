export const API_PORT = 3100;
export const WEB_PORT = 3200;

const SECRET64 = "e".repeat(64);

/**
 * Every variable the four processes need, in one place.
 *
 * ⚠ Harness-only and production-hostile. EGRESS_ALLOWED_HOSTS REPLACES rather
 * than merges, so copying this to a deployed service drops
 * generativelanguage.googleapis.com and stops ingestion and answering alike.
 */
export const E2E_ENV: Record<string, string> = {
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag",
  PARSER_URL: process.env.E2E_PARSER_URL ?? "http://localhost:8000",

  EMBEDDING_PROVIDER: "local",
  EMBEDDING_MODEL: "Xenova/bge-base-en-v1.5",
  EMBEDDING_DIMENSIONS: "768",
  CHUNK_SIZE: "512",

  GENERATION_PROVIDER: "openai",
  GENERATION_MODEL: "llama3.1:8b",
  GENERATION_BASE_URL: "http://127.0.0.1:11434/v1",
  EGRESS_ALLOWED_HOSTS: "127.0.0.1",
  GENERATION_TRI_POLICY: "warn",

  API_PORT: String(API_PORT),
  API_TOKENS: "web-e2e-token",
  INTERNAL_SCOPE_JWT_SECRETS: SECRET64,

  PORT: String(WEB_PORT),
  RAG_API_URL: `http://localhost:${API_PORT}`,
  INTERNAL_SCOPE_JWT_SECRET: SECRET64,
  AUTH_SECRET: "web-e2e-auth-secret-at-least-32-chars-long",
  AUTH_URL: `http://localhost:${WEB_PORT}`,
  AUTH_ENTRA_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
  AUTH_ENTRA_CLIENT_SECRET: "dummy",
  AUTH_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  WEB_AUTH_MODE: "entra",
};
