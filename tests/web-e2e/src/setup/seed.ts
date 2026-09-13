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
import { FIXTURE_DOCS } from "../fixtures/corpus.js";

export async function seedCorpus(): Promise<{ sourceId: string }> {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    // Make the suite re-runnable: without this, a second run accumulates
    // documents and the "exactly one distinct embedding_model" coherence
    // assertion fails for the wrong reason (row count, not model drift).
    await truncateAll(db);
    const sourceId = await createFixtureSource(db);
    await runOneIngestion(db, sourceId, new FakeConnector(FIXTURE_DOCS), {
      // MUST be passed explicitly — runOneIngestion never reads env and would
      // otherwise chunk at 800, exceeding the local model's 512-token limit.
      chunkSize: 512,
      embedder: createEmbeddingProvider({
        provider: "local",
        model: E2E_ENV.EMBEDDING_MODEL,
        dimensions: 768,
      } as Config["embedding"]),
    });
    return { sourceId };
  } finally {
    await close();
  }
}

/**
 * The synthetic identity every browser spec authenticates as. Matches the
 * `oid` claim the auth fixture puts in the session cookie (Task 7).
 */
export const FIXTURE_OID = "web-e2e-fixture-user-oid";

/**
 * Assigns the fixture user to the fixture source, then proves the assignment
 * actually resolves.
 *
 * This is not boilerplate. `resolveSourceIdsForUser` reads only the staff
 * assignment tables, and an empty result is fail-closed by design
 * (packages/core/src/oidc-auth.ts:94-98) — so without this the fixture user
 * retrieves ZERO rows, and the later "out-of-corpus question is refused"
 * assertion passes for entirely the wrong reason: an empty index also yields a
 * refusal with no citations. The non-empty check below is what stops this suite
 * reporting green while verifying nothing.
 *
 * Must run AFTER truncateAll() and after the source row exists: truncateAll
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
    if (ids.length === 0) {
      throw new Error(
        "[web-e2e] the fixture user resolved to an empty source scope. " +
          "Retrieval is fail-closed, so every retrieval assertion would pass " +
          "for the wrong reason. Check that the assignment was written after " +
          "truncateAll() and that the source id is current.",
      );
    }
  } finally {
    await close();
  }
}
