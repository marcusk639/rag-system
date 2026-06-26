import type { ObjectStore } from "@rag/core";
import type { Db } from "@rag/db";
import type { createQueue } from "@rag/ingestion";
import type { Generator, Retriever } from "@rag/rag";

/**
 * Queue handle (pg-boss). Derived from `createQueue`'s return type so the
 * service layer doesn't take a direct dependency on `pg-boss` — mirrors the
 * pattern in `apps/mcp/src/deps.ts`.
 */
export type Queue = Awaited<ReturnType<typeof createQueue>>;

/**
 * Minimal structural logger the service layer writes to. Pino's `Logger`
 * satisfies this shape, so apps pass their runtime logger straight through
 * without the service package taking a direct `pino` dependency — mirrors how
 * `Queue` avoids depending on `pg-boss` directly.
 */
export interface ServiceLogger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/**
 * The transport-agnostic dependencies the five service functions need. HTTP
 * routes and MCP tools each build their own runtime `Deps` (which is a
 * superset of this) and pass it straight through — the structural overlap
 * means no adapter object is required.
 */
export interface ServiceDeps {
  db: Db;
  retriever: Retriever;
  /** Null when generation is not configured — `askQuestion` throws in that case. */
  generator: Generator | null;
  queue: Queue;
  /**
   * Object store for original document bytes. Null/undefined when storage is
   * disabled — `getDocumentDownload` then treats every document as
   * not-downloadable (404).
   */
  objectStore?: ObjectStore | null;
  /**
   * Server-side log sink. Service functions own capturing failures that a
   * transport might otherwise reduce to a user-facing string (e.g. the
   * `trigger_sync` MCP tool returns enqueue errors as text).
   */
  logger: ServiceLogger;
}
