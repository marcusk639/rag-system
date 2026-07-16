import { createDb, pgSslOption, type Db } from "@rag/db";

const globalForBotDb = globalThis as unknown as {
  __ragBotDb?: { db: Db; close: () => Promise<void> };
};

/**
 * Lazily-created singleton DB connection for the Teams bot — used for
 * per-request scope resolution and any bot-side lookups that need direct
 * DB access. Mirrors the api/mcp/worker apps' `createDb` usage
 * (`packages/runtime/src/index.ts`) and the web app's BFF singleton
 * (`apps/web/src/lib/db.ts`) rather than hand-rolling a separate pg client.
 *
 * The singleton is cached on `globalThis` (not just a module-level variable)
 * to survive dev-mode hot-reloads without leaking connection pools.
 */
export function getBotDb(): Db {
  if (!globalForBotDb.__ragBotDb) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL must be set for the Teams bot.");
    }
    const sslMode = process.env.DATABASE_SSL as
      "disable" | "require" | "no-verify" | undefined;
    const { db, close } = createDb(databaseUrl, {
      // Lighter pool than the backend services — the bot only ever issues
      // a handful of narrow lookups per Teams message, never bulk retrieval.
      max: 5,
      ssl: pgSslOption(sslMode),
    });
    globalForBotDb.__ragBotDb = { db, close };
  }
  return globalForBotDb.__ragBotDb.db;
}
