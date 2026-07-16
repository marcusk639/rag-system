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
 * Connection parameters are threaded in from the validated `BotConfig`
 * (`loadBotConfig`) rather than re-read from `process.env` here, so the
 * value the config loader validated at startup is guaranteed to be the one
 * actually used — a single source of truth.
 *
 * The singleton is cached on `globalThis` (not just a module-level variable)
 * to survive dev-mode hot-reloads without leaking connection pools.
 */
export function getBotDb(
  databaseUrl: string,
  sslMode?: "disable" | "require" | "no-verify",
): Db {
  if (!globalForBotDb.__ragBotDb) {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL must be set for the Teams bot.");
    }
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
