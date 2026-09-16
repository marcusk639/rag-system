import { FakeConnector } from "@rag/test-fixtures";
// NOTE: LocalEmbeddingProvider is NOT exported from @rag/rag — only the factory
// is. Do not reach for a deep dist path; use createEmbeddingProvider.
import { createEmbeddingProvider } from "@rag/rag";
import type { Config } from "@rag/core";
import { createDb, grantSourceAccess, resolveSourceIdsForUser } from "@rag/db";
import {
  createFixtureSource,
  runOneIngestion,
  truncateAll,
} from "./ingestion.js";
import { E2E_ENV } from "../env.js";
import {
  FIXTURE_DOCS,
  OUT_OF_SCOPE_DOCS,
  OUT_OF_SCOPE_SOURCE_NAME,
} from "../fixtures/corpus.js";

export async function seedCorpus(): Promise<void> {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    // Make the suite re-runnable: without this, a second run accumulates
    // documents and the "exactly one distinct embedding_model" coherence
    // assertion fails for the wrong reason (row count, not model drift).
    await truncateAll(db);

    // One embedder for BOTH sources: the coherence check requires every chunk
    // to share a single (provider, model) pair.
    const embedder = createEmbeddingProvider({
      provider: E2E_ENV.EMBEDDING_PROVIDER,
      model: E2E_ENV.EMBEDDING_MODEL,
      dimensions: Number(E2E_ENV.EMBEDDING_DIMENSIONS),
      apiKey: "GEMINI_API_KEY" in E2E_ENV ? E2E_ENV.GEMINI_API_KEY : undefined,
    } as Config["embedding"]);
    // MUST be passed explicitly — runOneIngestion never reads env, and the
    // local model's 512-token limit differs from production's 800.
    const overrides = { chunkSize: Number(E2E_ENV.CHUNK_SIZE), embedder };

    const sourceId = await createFixtureSource(db);
    await runOneIngestion(
      db,
      sourceId,
      new FakeConnector(FIXTURE_DOCS),
      overrides,
    );

    // Ingested but never granted. Its presence is what gives the scope
    // assertions something to exclude — with only granted content in the
    // index, "the user cannot see X" is vacuously true.
    const outOfScopeId = await createFixtureSource(
      db,
      OUT_OF_SCOPE_SOURCE_NAME,
    );
    await runOneIngestion(
      db,
      outOfScopeId,
      new FakeConnector(OUT_OF_SCOPE_DOCS),
      overrides,
    );
  } finally {
    await close();
  }
}

/**
 * The synthetic identity every browser spec authenticates as. Matches the
 * `oid` claim the auth fixture puts in the session cookie.
 */
export const FIXTURE_OID = "web-e2e-fixture-user-oid";

/**
 * Assigns the fixture user to the fixture source ONLY, then proves the
 * resulting scope is exactly that source.
 *
 * Not boilerplate. `resolveSourceIdsForUser` reads only the staff assignment
 * tables, and an empty result is fail-closed by design
 * (packages/core/src/oidc-auth.ts:94-98) — without the grant the fixture user
 * retrieves ZERO rows and refusal-style assertions pass for the wrong reason.
 * The exact-scope check also catches the opposite failure: a scope that
 * includes the out-of-scope source would make every exclusion assertion fail
 * for the wrong reason.
 *
 * Must run AFTER truncateAll() and after the source rows exist: truncateAll
 * truncates `sources ... CASCADE` and staff_source_assignments.source_id is
 * ON DELETE CASCADE, so an assignment written earlier is silently removed.
 */
export async function grantFixtureAccess(sourceId: string): Promise<void> {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    await grantSourceAccess(db, {
      userId: FIXTURE_OID,
      sourceId,
      grantedBy: "web-e2e-setup",
    });
    const ids = await resolveSourceIdsForUser(db, FIXTURE_OID);
    if (ids.length !== 1 || ids[0] !== sourceId) {
      throw new Error(
        `[web-e2e] the fixture user must resolve to exactly the fixture source ` +
          `(${sourceId}), got ${JSON.stringify(ids)}. An empty scope makes ` +
          `retrieval assertions pass for the wrong reason; a wider one makes ` +
          `the out-of-scope assertions meaningless. Check the assignment was ` +
          `written after truncateAll() and the source id is current.`,
      );
    }
  } finally {
    await close();
  }
}
