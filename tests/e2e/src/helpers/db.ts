import { sql } from "drizzle-orm";
import { createDb, createSource, type DataClass, type Db } from "@rag/db";
import { env } from "../env.js";

/**
 * Open a Drizzle handle against the E2E database. Caller MUST `close()` it.
 */
export function openTestDb(): { db: Db; close: () => Promise<void> } {
  const { db, close } = createDb(env.databaseUrl, { max: 5 });
  return { db, close };
}

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "postgres",
]);

/**
 * Refuse to run destructive test setup against anything but a local database.
 *
 * `truncateAll` wipes documents, chunks, and sources, and the harness takes its
 * target from `DATABASE_URL` — the same variable production uses. One
 * `pnpm eval:real` in a shell with a production URL exported would erase the
 * index. Local hosts (and `postgres`, the docker-compose service name) pass;
 * anything else needs `E2E_ALLOW_REMOTE_TRUNCATE=1`. The refusal names the host
 * but never echoes the URL, which carries the password.
 */
export function assertDestructiveTestTarget(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  let host: string;
  try {
    // `postgres:` is not a special URL scheme, so the host is opaque: no
    // lowercasing. An empty host is the unix-socket form
    // (postgresql:///db?host=/var/run/postgresql), which is local.
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(
      "[e2e] refusing to truncate: the test DATABASE_URL could not be parsed",
    );
  }
  if (host === "" || LOCAL_HOSTS.has(host)) return;
  if (environment.E2E_ALLOW_REMOTE_TRUNCATE === "1") return;
  throw new Error(
    `[e2e] refusing to truncate tables on non-local database host "${host}". ` +
      "Point E2E_DATABASE_URL at a local test database, or set " +
      "E2E_ALLOW_REMOTE_TRUNCATE=1 if this remote database is disposable.",
  );
}

/**
 * Truncate every application table. Called by each spec's beforeEach so specs
 * don't leak ingested data into each other.
 *
 * Order matters because of FKs: chunks → documents → ingestion_jobs → sources.
 * `RESTART IDENTITY CASCADE` makes UUID PKs noisy-but-safe; we use it so we
 * don't have to enumerate dependents.
 */
export async function truncateAll(db: Db): Promise<void> {
  assertDestructiveTestTarget(env.databaseUrl);
  await db.execute(sql`
    TRUNCATE TABLE chunks, documents, ingestion_jobs, sources
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Create a `custom` source row so the foreign-key on documents.source_id is
 * satisfied when the FakeConnector ingests. Returns the source id.
 */
export async function createCustomSource(
  db: Db,
  name: string,
  config: Record<string, unknown> = {},
  dataClass?: DataClass,
): Promise<string> {
  const row = await createSource(db, {
    kind: "custom",
    name,
    config,
    ...(dataClass ? { dataClass } : {}),
  });
  return row.id;
}

/**
 * Wire a source to a client so `resolveSourceIdsForUser` (joined through
 * `staff_client_assignments`) resolves it. No existing helper covers
 * `source_client_assignments` inserts, so this is a minimal addition
 * alongside `createCustomSource`.
 */
export async function assignSourceToClient(
  db: Db,
  sourceId: string,
  clientId: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO source_client_assignments (source_id, client_id)
    VALUES (${sourceId}, ${clientId})
  `);
}

export async function countChunks(db: Db): Promise<number> {
  const res = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM chunks`,
  );
  return Number(res.rows[0]?.n ?? "0");
}

export async function countDocuments(db: Db): Promise<number> {
  const res = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM documents`,
  );
  return Number(res.rows[0]?.n ?? "0");
}

/**
 * Read all chunks for a given external document id, ordered by ordinal. Used
 * by specs that want to assert on exact chunk content / ordering.
 */
export async function getChunksForExternalId(
  db: Db,
  sourceId: string,
  externalId: string,
): Promise<
  Array<{
    id: string;
    text: string;
    ordinal: number;
    hash: string;
    headingPath: string[];
    tokenCount: number;
  }>
> {
  const res = await db.execute<{
    id: string;
    text: string;
    ordinal: number;
    hash: string;
    heading_path: string[];
    token_count: number;
  }>(sql`
    SELECT c.id, c.text, c.ordinal, c.hash, c.heading_path, c.token_count
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.source_id = ${sourceId} AND d.external_id = ${externalId}
    ORDER BY c.ordinal
  `);
  return res.rows.map((r) => ({
    id: r.id,
    text: r.text,
    ordinal: r.ordinal,
    hash: r.hash,
    headingPath: r.heading_path ?? [],
    tokenCount: r.token_count,
  }));
}
