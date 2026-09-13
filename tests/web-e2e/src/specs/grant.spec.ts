import { test, expect } from "@playwright/test";
import { createDb, resolveSourceIdsForUser } from "@rag/db";
import { E2E_ENV } from "../env.js";
import { FIXTURE_OID } from "../setup/seed.js";

/**
 * An id with no assignment. Used to prove the scope lookup discriminates
 * rather than returning rows for anyone — without it, the assertion below
 * would still pass against a lookup that ignored its argument entirely.
 */
const UNASSIGNED_OID = "web-e2e-unassigned-user-oid";

test("the fixture user is scoped to at least one source", async () => {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    const ids = await resolveSourceIdsForUser(db, FIXTURE_OID);
    expect(ids.length).toBeGreaterThan(0);
  } finally {
    await close();
  }
});

test("a user with no assignment resolves to an empty scope", async () => {
  const { db, close } = createDb(E2E_ENV.DATABASE_URL, {});
  try {
    const unassigned = await resolveSourceIdsForUser(db, UNASSIGNED_OID);
    const assigned = await resolveSourceIdsForUser(db, FIXTURE_OID);

    // Empty is fail-closed (scoped to nothing => zero rows), NOT all-access —
    // see packages/core/src/oidc-auth.ts:94-98. If this ever returns rows, the
    // confidentiality boundary is broken and every scope-dependent assertion
    // in this suite is meaningless.
    expect(unassigned).toEqual([]);
    expect(assigned.length).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
