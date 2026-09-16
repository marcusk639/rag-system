import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { E2E_ENV } from "../env.js";
import {
  DOC_A_EXTERNAL_ID,
  DOC_B_EXTERNAL_ID,
  DOC_C_EXTERNAL_ID,
  DOC_D_EXTERNAL_ID,
  FIXTURE_SOURCE_NAME,
} from "../fixtures/corpus.js";
import { grantFixtureAccess } from "./seed.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const SEED_MAIN = join(PACKAGE_ROOT, "src", "setup", "seed-main.ts");

export default async function globalSetup(): Promise<void> {
  // The stack is already up and migrated: the API webServer command runs
  // stack:ready before it starts (see playwright.config.ts for why).
  runSeedChildProcess();
  const sourceId = await verifySeededCorpus();
  // Runs in the PARENT, after verification: seeding happens in a child process
  // so no source id crosses that boundary, and the id below is the one
  // verifySeededCorpus looked up. Must follow truncateAll (CASCADE) or the
  // assignment is silently removed.
  await grantFixtureAccess(sourceId);
  process.env.E2E_SOURCE_ID = sourceId;
  // Playwright workers are spawned after globalSetup and inherit its env, so
  // specs read the real document UUIDs from here (see fixtures/doc-ids.ts).
  process.env.E2E_DOC_IDS = JSON.stringify(await resolveDocIds());
}

/**
 * Looks up the UUIDs ingestion assigned to the three fixture documents. Specs
 * need them to assert WHICH document a citation points at — the chip title
 * alone can't distinguish a correct citation from a wrong one to a real doc.
 */
async function resolveDocIds(): Promise<Record<"a" | "b" | "c" | "d", string>> {
  const client = new pg.Client({ connectionString: E2E_ENV.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ external_id: string; id: string }>(
      "select external_id, id from documents where external_id = any($1)",
      [
        [
          DOC_A_EXTERNAL_ID,
          DOC_B_EXTERNAL_ID,
          DOC_C_EXTERNAL_ID,
          DOC_D_EXTERNAL_ID,
        ],
      ],
    );
    const byExternal = new Map(rows.map((r) => [r.external_id, r.id]));
    const a = byExternal.get(DOC_A_EXTERNAL_ID);
    const b = byExternal.get(DOC_B_EXTERNAL_ID);
    const c = byExternal.get(DOC_C_EXTERNAL_ID);
    const d = byExternal.get(DOC_D_EXTERNAL_ID);
    if (!a || !b || !c || !d) {
      throw new Error(
        `[web-e2e] expected all four fixture documents to be ingested, found ` +
          `${JSON.stringify(Object.fromEntries(byExternal))}. A document missing ` +
          `here (e.g. quarantined by the sensitivity gate) would make its ` +
          `assertions vacuous — and an expected-failure test would "fail as ` +
          `expected" for the wrong reason.`,
      );
    }
    return { a, b, c, d };
  } finally {
    await client.end();
  }
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
      row?.embedding_provider !== E2E_ENV.EMBEDDING_PROVIDER ||
      row.embedding_model !== E2E_ENV.EMBEDDING_MODEL
    ) {
      throw new Error(
        `[web-e2e] seeding verification failed: chunks were embedded with ` +
          `${row?.embedding_provider ?? "?"}/${row?.embedding_model ?? "?"}, ` +
          `expected ${E2E_ENV.EMBEDDING_PROVIDER}/${E2E_ENV.EMBEDDING_MODEL}`,
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
