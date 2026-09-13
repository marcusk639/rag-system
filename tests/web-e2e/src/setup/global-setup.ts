import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ensureStackReady } from "./stack.js";
import { E2E_ENV } from "../env.js";
import { FIXTURE_SOURCE_NAME } from "../fixtures/corpus.js";
import { grantFixtureAccess } from "./seed.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const SEED_MAIN = join(PACKAGE_ROOT, "src", "setup", "seed-main.ts");

export default async function globalSetup(): Promise<void> {
  await ensureStackReady();
  runSeedChildProcess();
  const sourceId = await verifySeededCorpus();
  // Runs in the PARENT, after verification: seeding happens in a child process
  // so no source id crosses that boundary, and the id below is the one
  // verifySeededCorpus looked up. Must follow truncateAll (CASCADE) or the
  // assignment is silently removed.
  await grantFixtureAccess(sourceId);
  process.env.E2E_SOURCE_ID = sourceId;
}

/**
 * Runs `seedCorpus()` in a CHILD process (see seed-main.ts for why). The
 * child is EXPECTED to crash with SIGABRT (exit 134) immediately after
 * succeeding — that is onnxruntime-node's native teardown, not a seeding
 * failure — so it is the ONLY non-zero outcome tolerated here. Any other
 * failure (non-zero exit that isn't that crash, or a thrown seeding error)
 * must still fail globalSetup loudly.
 */
function runSeedChildProcess(): void {
  try {
    execFileSync(TSX_BIN, [SEED_MAIN], { stdio: "inherit", env: process.env });
  } catch (err) {
    const status = (err as { status?: number | null }).status ?? null;
    const signal = (err as { signal?: string | null }).signal ?? null;
    if (status === 134 || signal === "SIGABRT") {
      return; // known onnxruntime-node exit crash after a successful seed
    }
    throw new Error(
      `[web-e2e] seeding child process failed (status=${String(status)}, signal=${String(signal)}): ${String(err)}`,
    );
  }
}

/**
 * The child's exit code is not trustworthy (see above), so success is
 * verified independently here: the corpus must exist, every chunk must have
 * been embedded by exactly one (provider, model) pair, and that pair must be
 * the configured local model — not silently degraded to some other embedder.
 * Also resolves the fixture source id for `E2E_SOURCE_ID`.
 */
async function verifySeededCorpus(): Promise<string> {
  const client = new pg.Client({ connectionString: E2E_ENV.DATABASE_URL });
  await client.connect();
  try {
    const chunkRows = await client.query<{
      embedding_provider: string;
      embedding_model: string;
    }>("select distinct embedding_provider, embedding_model from chunks");

    if (chunkRows.rowCount === 0) {
      throw new Error(
        "[web-e2e] seeding verification failed: 0 chunks in the database after seedCorpus()",
      );
    }
    if (chunkRows.rowCount !== 1) {
      throw new Error(
        `[web-e2e] seeding verification failed: expected exactly one distinct ` +
          `(embedding_provider, embedding_model) pair across all chunks, got ` +
          `${String(chunkRows.rowCount)}: ${JSON.stringify(chunkRows.rows)}`,
      );
    }
    const [row] = chunkRows.rows;
    if (
      row?.embedding_provider !== "local" ||
      row.embedding_model !== E2E_ENV.EMBEDDING_MODEL
    ) {
      throw new Error(
        `[web-e2e] seeding verification failed: chunks were embedded with ` +
          `${row?.embedding_provider ?? "?"}/${row?.embedding_model ?? "?"}, ` +
          `expected local/${E2E_ENV.EMBEDDING_MODEL}`,
      );
    }

    const sourceRows = await client.query<{ id: string }>(
      "select id from sources where name = $1",
      [FIXTURE_SOURCE_NAME],
    );
    const sourceId = sourceRows.rows[0]?.id;
    if (!sourceId) {
      throw new Error(
        `[web-e2e] seeding verification failed: fixture source "${FIXTURE_SOURCE_NAME}" not found`,
      );
    }
    return sourceId;
  } finally {
    await client.end();
  }
}
