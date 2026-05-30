import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Create a Drizzle client + connection pool. Long-running services (api/mcp/
 * worker) should call this once at startup and reuse the returned db handle.
 *
 * The returned `close()` should be wired into the runtime's shutdown hook so
 * the pool drains cleanly on SIGTERM.
 */
export function createDb(
  databaseUrl: string,
  opts?: { max?: number },
): {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts?.max ?? 10,
    idleTimeoutMillis: 30_000,
    // Without this, a saturated pool causes new acquisitions to wait
    // forever — API requests would queue inside node-postgres with no
    // observable failure mode. 5s lets clients fail fast and retry.
    connectionTimeoutMillis: 5_000,
    // Bound how long any single statement runs server-side. Stops a
    // pathological query (e.g. a runaway hybrid search with mis-tuned
    // ef_search) from holding a connection indefinitely.
    statement_timeout: 30_000,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
