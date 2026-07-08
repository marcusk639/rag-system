import { createDb, pgSslOption, type Db } from "@rag/db";

const globalForWebDb = globalThis as unknown as {
  __ragWebDb?: { db: Db; close: () => Promise<void> };
};

/**
 * Lazily-created singleton DB connection for the web app's BFF — used only
 * for per-request scope resolution (`resolveSourceIdsForUser`) and the admin
 * UI's grant/revoke/history queries. Mirrors the api/mcp/worker apps'
 * `createDb` usage (`packages/runtime/src/index.ts`) rather than hand-rolling
 * a separate pg client.
 *
 * The singleton is cached on `globalThis` (not just a module-level variable)
 * to survive Next.js dev-mode hot-module reloads, preventing connection pool leaks.
 */
export function getWebDb(): Db {
  if (!globalForWebDb.__ragWebDb) {
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
    globalForWebDb.__ragWebDb = { db, close };
  }
  return globalForWebDb.__ragWebDb.db;
}
