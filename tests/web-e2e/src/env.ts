export const API_PORT = 3100;
export const WEB_PORT = 3200;

const SECRET64 = "e".repeat(64);

/**
 * Which provider stack the suite runs against.
 *
 * - `local` (default, and what CI runs): Ollama `llama3.1:8b` + ONNX bge-base.
 *   No secrets, no spend — but it measures llama's behavior, not production's.
 * - `gemini`: the TWK pilot's actual stack (`gemini-2.5-flash` +
 *   `gemini-embedding-001`, chunk size 800). Model-behavior results (marker
 *   emission, refusals, grounding, latency) only transfer to the pilot from a
 *   run in THIS mode. Needs GEMINI_API_KEY and costs API spend.
 *
 * An unrecognized value throws rather than falling back to `local`: a typo
 * that silently ran llama would report a green "pilot-config" run that says
 * nothing about Gemini.
 */
export type WebE2eProvider = "local" | "gemini";

function readProvider(): WebE2eProvider {
  const raw = process.env.WEB_E2E_PROVIDER;
  if (raw === undefined || raw === "" || raw === "local") return "local";
  if (raw === "gemini") return "gemini";
  throw new Error(
    `[web-e2e] WEB_E2E_PROVIDER must be "local" or "gemini", got "${raw}"`,
  );
}

export const PROVIDER: WebE2eProvider = readProvider();

function readGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "[web-e2e] WEB_E2E_PROVIDER=gemini requires GEMINI_API_KEY in the environment",
    );
  }
  return key;
}

const COMMON_ENV = {
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag",
  PARSER_URL: process.env.E2E_PARSER_URL ?? "http://localhost:8000",

  // The pilot corpus is internal SOPs, for which env.example prescribes
  // `warn` (`block` turns routine tax-procedure questions into hard errors).
  // NOTE: env.example's DEFAULT is `block` — the pilot deployment must set
  // `warn` explicitly or it will not match what this suite verified.
  GENERATION_TRI_POLICY: "warn",
  // Production default; set explicitly so both modes match the deployment.
  MAX_CHUNKS_PER_DOCUMENT: "3",

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

/**
 * Each branch is a complete object checked on its own: spreading a two-branch
 * conditional into one literal widens keys present in only one branch (e.g.
 * GENERATION_BASE_URL) to `string | undefined`, which breaks the
 * Record<string, string> the webServer `env` option needs. Built inside a
 * function so the gemini branch — and its GEMINI_API_KEY requirement — is
 * never evaluated in local mode.
 */
function buildEnv() {
  if (PROVIDER === "gemini") {
    return {
      ...COMMON_ENV,
      EMBEDDING_PROVIDER: "gemini",
      EMBEDDING_MODEL: "gemini-embedding-001",
      EMBEDDING_DIMENSIONS: "768",
      CHUNK_SIZE: "800",

      GENERATION_PROVIDER: "gemini",
      GENERATION_MODEL: "gemini-2.5-flash",
      GEMINI_API_KEY: readGeminiKey(),
      EGRESS_ALLOWED_HOSTS: "generativelanguage.googleapis.com",
    } satisfies Record<string, string>;
  }
  return {
    ...COMMON_ENV,
    EMBEDDING_PROVIDER: "local",
    EMBEDDING_MODEL: "Xenova/bge-base-en-v1.5",
    EMBEDDING_DIMENSIONS: "768",
    // The local ONNX model has a 512-token input limit.
    CHUNK_SIZE: "512",

    GENERATION_PROVIDER: "openai",
    // Overridable so CI can pick a model its hardware can actually serve. A
    // GitHub runner is CPU-only, where llama3.1:8b needs well over two minutes
    // per RAG answer — past both the BFF's 30s time-to-headers budget and the
    // 120s test timeout. Locally (Metal) the 8b is fast and stays the default.
    GENERATION_MODEL: process.env.E2E_GENERATION_MODEL ?? "llama3.1:8b",
    GENERATION_BASE_URL:
      process.env.E2E_GENERATION_BASE_URL ?? "http://127.0.0.1:11434/v1",
    EGRESS_ALLOWED_HOSTS: "127.0.0.1",
  } satisfies Record<string, string>;
}

/**
 * Every variable the four processes need, in one place.
 *
 * ⚠ Harness-only and production-hostile. EGRESS_ALLOWED_HOSTS REPLACES rather
 * than merges, so copying this to a deployed service can drop hosts the
 * service needs and stop ingestion and answering alike.
 */
export const E2E_ENV = buildEnv();
