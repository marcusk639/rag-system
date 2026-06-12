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
}
