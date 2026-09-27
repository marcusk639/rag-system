import pino from "pino";
import type { Logger } from "pino";

/**
 * Builds the Teams bot's structured logger. Mirrors `apps/api/src/main.ts`'s
 * construction (`LOG_LEVEL` env var, `service` base field) so teams-bot
 * failures land in the same structured log stream as the API instead of
 * going to `console.*` (N-6 from the whole-repo review).
 */
export function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "rag-teams-bot" },
  });
}

export type { Logger };
