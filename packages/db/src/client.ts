import { sql as sqlRaw } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Map a `DATABASE_SSL` mode to a node-postgres `ssl` pool option.
 *   - "require"   → TLS, verify the server certificate.
 *   - "no-verify" → TLS, but accept self-signed/unverified certs.
 *   - "disable"/undefined → no explicit TLS (rely on `sslmode` in the URL, if any).
 */
export function pgSslOption(
  mode: "disable" | "require" | "no-verify" | undefined,
): pg.PoolConfig["ssl"] {
  if (mode === "require") return { rejectUnauthorized: true };
  if (mode === "no-verify") return { rejectUnauthorized: false };
  return undefined;
}

/**
 * Create a Drizzle client + connection pool. Long-running services (api/mcp/
 * worker) should call this once at startup and reuse the returned db handle.
 *
 * The returned `close()` should be wired into the runtime's shutdown hook so
 * the pool drains cleanly on SIGTERM.
 */
export function createDb(
  databaseUrl: string,
  opts?: { max?: number; ssl?: pg.PoolConfig["ssl"] },
): {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // TLS for the pool. `undefined` leaves it to `sslmode` in the URL (if any).
    ...(opts?.ssl !== undefined ? { ssl: opts.ssl } : {}),
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

/**
 * Create a Drizzle client whose connections **cannot write**, enforced by
 * PostgreSQL rather than by convention.
 *
 * `default_transaction_read_only=on` is passed as a startup option, so every
 * transaction on every connection in this pool begins read-only. An INSERT,
 * UPDATE, DELETE, TRUNCATE, or DDL statement fails server-side with
 * `25006 read_only_sql_transaction`. There is no application-level check to
 * forget, and a caller cannot opt out per-statement.
 *
 * ## Why this exists
 *
 * Corpus-level analysis — claim extraction for the corpus-grounded eval tier,
 * and the client-identifier screen — walks the **production** index. The only
 * pre-existing real-embedder runner in this repo
 * (`tests/e2e/src/eval/run-real-eval.ts`) opens a normal connection and calls
 * `truncateAll`, which executes
 * `TRUNCATE chunks, documents, ingestion_jobs, sources RESTART IDENTITY CASCADE`.
 * That is correct there — it seeds a synthetic corpus and needs a clean slate —
 * but it makes it the obvious template to copy for a production script, where
 * the same line destroys the index silently. See C3 in
 * `docs/ISSUES-AND-OPTIMIZATIONS.md`.
 *
 * The mitigation is not a comment telling people to be careful. It is a handle
 * that physically cannot perform the destructive operation.
 *
 * ## Scope of the guarantee — verified, not assumed
 *
 * Tested against a live PostgreSQL 16 with a **superuser** role: the write was
 * still refused (`25006`). `default_transaction_read_only` is **not** a
 * permission that superusers outrank — it applies to every role. What a
 * superuser (or any role) *can* do is `SET default_transaction_read_only = off`
 * within the session and then write.
 *
 * So the guarantee is precise: **this handle cannot write by accident.** It is
 * not a substitute for a role with no write grants, which is what stops a
 * deliberate override. For a walk of production the accident is the realistic
 * risk, and this closes it; use a read-only role as well when one is available.
 */
export function createReadOnlyDb(
  databaseUrl: string,
  opts?: {
    max?: number;
    ssl?: pg.PoolConfig["ssl"];
    statementTimeoutMs?: number;
  },
): {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(opts?.ssl !== undefined ? { ssl: opts.ssl } : {}),
    // The guard. Applied at connection startup, so it covers implicit
    // single-statement transactions as well as explicit BEGIN blocks.
    options: "-c default_transaction_read_only=on",
    max: opts?.max ?? 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // A full-corpus walk runs longer than an API request; default higher than
    // createDb's 30s, but still bounded so a runaway scan cannot pin a
    // connection forever.
    statement_timeout: opts?.statementTimeoutMs ?? 120_000,
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

/**
 * Verify a handle really is read-only before trusting it with a production
 * walk. Attempts a write inside a rolled-back transaction and asserts the
 * database refuses it.
 *
 * Call this at the top of any script that touches production. It converts
 * "I passed the right factory" into "the server just refused a write," which
 * are very different levels of assurance — and it catches the case where the
 * connection URL points at a superuser role that ignores the session default.
 *
 * @throws if the connection accepts writes.
 */
export async function assertReadOnly(db: Db): Promise<void> {
  try {
    // A temp table: harmless if it somehow succeeded, and still a write as far
    // as a read-only transaction is concerned. The point is which error returns.
    await db.execute(sqlRaw`CREATE TEMPORARY TABLE __readonly_probe__ (x int)`);
  } catch (err) {
    if (findPgErrorCode(err) === "25006") return; // read_only_sql_transaction.
    throw new Error(
      `assertReadOnly: the probe failed, but not with the expected ` +
        `25006 read_only_sql_transaction. Refusing to proceed rather than ` +
        `assuming a different failure means the connection is safe.`,
      { cause: err },
    );
  }
  throw new Error(
    "assertReadOnly: the connection ACCEPTED a write. This handle is not " +
      "read-only — refusing to run a production corpus walk. Use " +
      "createReadOnlyDb.",
  );
}

/**
 * Pull a PostgreSQL SQLSTATE out of an error, walking the `cause` chain.
 *
 * Necessary because Drizzle wraps driver errors in a `DrizzleQueryError` that
 * carries no `code` of its own — reading `err.code` directly yields `undefined`
 * and silently loses the SQLSTATE. Found by testing `assertReadOnly` against a
 * live database: the guard correctly refused the write, then misreported it as
 * an unexpected failure because it was reading the wrapper.
 */
function findPgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
