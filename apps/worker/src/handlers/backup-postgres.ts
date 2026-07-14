import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { insertBackupRun } from "@rag/db";
import type PgBoss from "pg-boss";
import type { WorkerDeps } from "../deps.js";

const execFileAsync = promisify(execFile);

/**
 * pg_dump's custom-format output for this corpus is tens of MB today — 512MB
 * is generous headroom without risking an unbounded buffer. This buffers the
 * ENTIRE dump in process memory before uploading, though, which is a real
 * ceiling as the corpus grows; if this job ever needs to handle a
 * multi-GB database, switch to streaming pg_dump's stdout directly into
 * `objectStore` (a multipart/streaming upload) instead of buffering here.
 * Deliberately v1 — the corpus is nowhere near that size yet.
 */
const MAX_DUMP_BYTES = 512 * 1024 * 1024;

/** Matches `scheme://[user[:pass]@]host...` so any connection-string-shaped
 * substring (with or without embedded credentials) is redacted from
 * anything that might reach a persisted error. Defense in depth: the
 * argv-splitting below should already keep the password out of subprocess
 * command lines, but this guards against the password showing up some
 * other way (e.g. echoed back by a tool we call, or a future refactor). */
const CONNECTION_STRING_PATTERN = /\b\w+:\/\/[^\s]*@[^\s"]*/g;

function redactConnectionStrings(value: string): string {
  return value.replace(CONNECTION_STRING_PATTERN, "[redacted]");
}

/**
 * Splits `databaseUrl` into pg_dump argv (host/port/user/db, via a
 * password-free `--dbname` connection string so query params like
 * `?sslmode=require` survive) plus a `PGPASSWORD` env var for the
 * credential. This keeps the password out of argv entirely — argv is
 * visible to any co-resident process via `ps aux` / `/proc/<pid>/cmdline`
 * for the subprocess's whole lifetime, whereas env vars set via the `env`
 * option of execFile are not.
 */
function buildPgDumpInvocation(databaseUrl: string): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const url = new URL(databaseUrl);
  const password = url.password ? decodeURIComponent(url.password) : "";
  url.password = "";

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (password) {
    env.PGPASSWORD = password;
  }

  return { args: ["--dbname", url.toString(), "-F", "c"], env };
}

/**
 * pg-boss hands this the scheduled tick (no meaningful payload — same as
 * docsGapDigest/shipAuditLog). Takes a full `pg_dump -F c` of the configured
 * database, uploads it to the object store under `backup.keyPrefix`, and
 * records the run in `backup_runs` so "the job ran and produced something" is
 * queryable, not just a log line — mirrors the docsGapDigestRuns precedent.
 *
 * No-ops when `config.backup.provider === "none"` or no object store is
 * configured — matches `handleShipAuditLog`'s no-op-when-disabled shape. A
 * pg_dump/upload error propagates unswallowed so pg-boss retries the same
 * tick rather than silently recording a partial/failed backup as done — but
 * a pg_dump failure is first rewrapped in a plain, redacted `Error` (see the
 * catch block below) so the DB password never ends up in `pgboss.job.output`
 * via serialize-error picking up the raw exec error's `cmd`/`stdout`/`stderr`
 * properties.
 */
export async function handleBackupPostgres(
  job: PgBoss.JobWithMetadata<object>,
  deps: WorkerDeps,
): Promise<void> {
  const { db, logger, config, objectStore } = deps;
  const log = logger.child({ jobId: job.id });

  if (config.backup.provider === "none" || !objectStore) {
    return;
  }

  const startedAt = Date.now();
  const { args, env } = buildPgDumpInvocation(config.databaseUrl);
  let stdout: Buffer;
  try {
    ({ stdout } = await execFileAsync("pg_dump", args, {
      maxBuffer: MAX_DUMP_BYTES,
      encoding: "buffer",
      env,
    }));
  } catch (err) {
    // Don't let the raw exec error propagate: Node's execFile error carries
    // the full command line (and stdout/stderr) as own enumerable
    // properties, which pg-boss's serialize-error job-failure path would
    // persist verbatim into pgboss.job.output. Re-throw a plain, redacted
    // summary instead — the failure still propagates unswallowed so pg-boss
    // retries the same tick, it just can't leak anything sensitive.
    const stderr =
      typeof (err as { stderr?: unknown })?.stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    const code = (err as { code?: unknown })?.code;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const summary = redactConnectionStrings(stderr || rawMessage);
    throw new Error(
      `pg_dump failed${code !== undefined ? ` (exit code ${String(code)})` : ""}: ${summary}`,
    );
  }
  const durationMs = Date.now() - startedAt;

  const ranAt = new Date();
  const objectKey = `${config.backup.keyPrefix}${ranAt.toISOString().replace(/[:.]/g, "-")}.dump`;

  await objectStore.put(objectKey, stdout, "application/octet-stream");

  await insertBackupRun(db, {
    ranAt,
    sizeBytes: stdout.length,
    objectKey,
    durationMs,
  });

  log.info(
    {
      marker: "backup.postgres.summary",
      sizeBytes: stdout.length,
      objectKey,
      durationMs,
    },
    "Postgres backup completed",
  );
}
