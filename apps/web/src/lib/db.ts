import { createDb, pgSslOption, type Db } from "@rag/db";

let cached: { db: Db; close: () => Promise<void> } | undefined;

/**
 * Lazily-created singleton DB connection for the web app's BFF — used only
 * for per-request scope resolution (`resolveSourceIdsForUser`) and the admin
 * UI's grant/revoke/history queries. Mirrors the api/mcp/worker apps'
 * `createDb` usage (`packages/runtime/src/index.ts`) rather than hand-rolling
 * a separate pg client.
 */
export function getWebDb(): Db {
  if (!cached) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL must be set for the web app's BFF (scope resolution + admin UI).",
      );
    }
    const sslMode = process.env.DATABASE_SSL as
      "disable" | "require" | "no-verify" | undefined;
    const { db, close } = createDb(databaseUrl, {
      // Lighter pool than the backend services — the BFF only ever issues
      // a handful of narrow lookups per request, never bulk retrieval.
      max: 5,
      ssl: pgSslOption(sslMode),
    });
    cached = { db, close };
  }
  return cached.db;
}
