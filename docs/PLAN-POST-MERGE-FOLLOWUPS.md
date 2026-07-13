# Post-Merge Follow-Ups Remediation Plan

> **Status: COMPLETE (re-verified 2026-07-13).** All 5 tasks were implemented, reviewed, and merged to `main` in an earlier session (see `.superpowers/sdd/progress.md`'s "NEW PLAN: docs/PLAN-POST-MERGE-FOLLOWUPS.md" section) — this file's checkboxes just hadn't been checked off. Re-confirmed independently against current `HEAD`: typecheck/lint/build clean, full unit suite passing, and a full 78/78 e2e run (including this plan's own concurrency and audit-attribution tests) against a freshly-migrated, isolated Postgres instance. See the progress ledger's "RE-VERIFIED 2026-07-13" entry for details.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every outstanding finding from this session that isn't already covered by `docs/PLAN-HOOK-INJECTION-REMEDIATION.md` — two LOW-severity code-review findings (non-monotonic drizzle migration timestamps, comma-in-secret parsing) and three "Known follow-ups" documented in PR #31's description and `.superpowers/sdd/progress.md` (per-user audit-log attribution gap, TOCTOU race in `grantClientAccess`, missing Next.js middleware/`auth.ts` integration test coverage).

**Architecture:** All five fixes are real `rag-system` application-code changes (unlike the hook-injection plan, which targets the operator's Claude Code installation). Two touch the database schema via new Drizzle migrations (`0010`, `0011`); the rest are code-only. Ordered so schema-touching work happens before code that depends on it, and so the riskiest/most novel piece (the middleware test spike) comes last, after the simpler fixes have built momentum and confidence in the toolchain.

## Global Constraints

- Every new migration must follow the existing numbering convention exactly: next filename is `000N_<name>.sql` immediately after the current highest (`0009_search_audit_parity.sql`), and every new `packages/db/drizzle/meta/_journal.json` entry must have `idx = previous_idx + 1` and `when` **strictly greater than every existing entry's `when`** (current max: `1787000000000` at idx 8) — this is a hard safety rule verified against `drizzle-orm`'s actual migration-gating logic (see Task 1's research) and violating it can cause a migration to be silently skipped or, worse, spuriously re-run against an already-migrated database.
- `0000_init.sql` is deliberately NOT tracked in the journal (hand-authored idempotent bootstrap — see `packages/db/src/migrate.ts` lines 40-59) — never add it or reference its absence as a bug.
- Do not decrease or otherwise disturb any existing journal entry's `idx`, `tag`, `version`, or `breakpoints` field — only `when` values for `idx` 1–7 are in scope for editing (Task 1).
- All new tests must use real Postgres where the finding is about real DB behavior (concurrency, constraints) — per this repo's own convention, `packages/db/src/queries.access-control.test.ts` is a DB-free stub suite and is NOT the right place for the TOCTOU/concurrency test; that belongs in `tests/e2e/src/specs/access-grants.spec.ts`, which already runs against real Postgres.
- No raw question/query text may ever be added to `audit_log` — this is an existing, deliberate privacy design decision (see `packages/db/src/queries.ts` lines 766-769/780-784, "Phase 3's privacy design decision") and nothing in this plan should weaken it. Per-user identity (the JWT `sub`/AAD oid) is a _different_ kind of data and is explicitly expected by `docs/CPA-COMPLIANCE-REQUIREMENTS.md` requirement CR-10 ("Structured retrieval logs (**user**, ts, doc/client id, query hash)...").
- Follow this repo's established config-parsing precedent (`parseOidcAdminClaims` in `packages/core/src/config.ts` lines 298-316) for any new env-var parsing logic — hybrid JSON-or-CSV, not a wholesale format change, to avoid breaking already-deployed env values.

---

## Phase 0 — Documentation Discovery (already complete; summarized for reference)

Three parallel research passes were run before this plan was written, each reading the actual source files rather than assuming. Their confirmed findings are the source of truth for every task below.

**Allowed facts (cite these, don't invent alternatives):**

1. **Drizzle migration ordering**: `drizzle-orm`'s migrator (`readMigrationFiles`) executes journal entries in raw array order (by `idx`), never by `when`. But `when` (`folderMillis`) DOES gate whether a migration runs at all: the dialect's `migrate()` fetches a single `lastDbMigration` row (`MAX(created_at)` across `__drizzle_migrations`) and only runs a journal entry if `lastDbMigration.created_at < migration.folderMillis`. Confirmed directly in `drizzle-orm@0.45.2`'s shipped `pg-core/dialect.js`. This means the existing non-monotonic `when` values for idx 3 (`0004_data_class`) and idx 5 (`0006_client_assignments`) are a **live bug**, not cosmetic: any environment that had already applied through idx 2 (`0003_pending_uploads`, `when=1784000000000`) before a later `migrate()` run would silently skip `0004_data_class.sql` forever (`1784000000000 < 1782548147382` is false), with no error.
2. `drizzle-kit generate` (confirmed by reading `drizzle-kit@0.31.10`'s `bin.cjs`) always appends (`idx = lastEntry.idx + 1`) and always stamps `when = Date.now()` — it never looks at existing `when` values, so this bug cannot recur from future `generate` calls; it originated from a manual merge-conflict resolution (`git show c360db5`) that fixed up `idx` but not `when`.
3. **`Principal` type** (`packages/core/src/access-control.ts:40-42`) has exactly two variants, neither carrying a subject/user identifier: `{ kind: "admin" }` and `{ kind: "scoped"; allowedSourceIds: string[] }`.
4. **`InternalScopeAuthProvider.authenticate`** (`packages/core/src/internal-scope-auth.ts:71-87`) verifies the scope-assertion JWT via `jwtVerify` (which validates the standard `sub` claim, set at sign time via `.setSubject(payload.sub)` in `signInternalScopeToken`, same file lines 26-37) but only reads `payload["allowedSourceIds"]` out of the verified payload — `sub` is verified and then dropped.
5. **`audit_log` schema** (`packages/db/src/schema.ts:341-375`) has no subject/user-identity column today. The call sites (`auditAsk` in `apps/api/src/routes/ask.ts:29-50`, `auditSearch` in `apps/api/src/routes/search.ts:29-48`) both construct their audit row from `request.principal`, so they can't pass a subject that isn't there.
6. **`grantClientAccess`** (`packages/db/src/queries.ts:859-881`) does a `SELECT` (check) then `UPDATE`-or-`INSERT` (act) as two separate round trips — a genuine TOCTOU race for concurrent grants of the same `(userId, clientId)` pair. The `staff_client_assignments` table (`packages/db/src/schema.ts:432-454`, created by `packages/db/drizzle/0006_client_assignments.sql:11-21`) has only non-unique indexes on `userId` and `clientId` individually — no `UNIQUE(user_id, client_id)` constraint exists, so an atomic `ON CONFLICT` upsert isn't possible without a new migration.
7. **`listAssignmentHistoryForStaff`** (`packages/db/src/queries.ts:907-928`) reads assignment history — the existing grant/revoke/re-grant logic already reuses a single row per `(userId, clientId)` pair across cycles (revoke soft-deletes via `revokedAt`, re-grant reactivates the same row) rather than ever creating a second row for the same pair, so adding a `UNIQUE(user_id, client_id)` constraint is compatible with existing behavior, not a breaking schema change.
8. **`packages/core/src/config.ts:453-456` (`API_TOKENS`) and `:468-471` (`INTERNAL_SCOPE_JWT_SECRETS`)** both use naive `.split(",").map(trim).filter(Boolean)` — confirmed byte-for-byte. The file already has a established, safer precedent for exactly this kind of problem: `parseOidcAdminClaims` (lines 298-316) accepts either a JSON array (parsed strictly, throwing loud on invalid JSON) or falls back to comma-split for backward compatibility — this is the pattern to copy, not a wholesale delimiter change (which would silently break already-deployed comma-separated env values in production).
9. **`apps/web/src/middleware.ts`** (41 lines) wraps `auth()` from `next-auth@5.0.0-beta.31`, redirects to `/api/auth/signin` when `!req.auth`. **`apps/web/src/lib/auth.ts`** (52 lines) defines `jwt`/`session` callbacks that fail closed (throw) if `profile.oid` is missing on sign-in. Confirmed via `grep -rn "middleware"` across all `apps/web/src/**/*.test.ts`: **zero hits** — `middleware.ts` is never imported by any test, and the one test touching `lib/auth` (`actions.test.ts`) mocks `auth` entirely rather than exercising its real callbacks.
10. **No Playwright, no `next-test-api-route-handler`, no `msw`/`supertest` anywhere in the repo.** `apps/web/vitest.config.ts` (`environment: "node"`) can directly import and invoke `middleware.ts`'s default export (a plain async function per next-auth v5's `handleAuth` internals) with hand-constructed `NextRequest` objects — no real server boot required. `jose` (already an `apps/web` devDependency) can mint a valid encrypted Auth.js v5 session cookie for the "authenticated" test case, via `@auth/core/jwt`'s `encode()` (available transitively through `next-auth`).

**Anti-patterns to avoid:**

- Do not "fix" the drizzle journal by resorting entries or changing `idx` — only `when` values change, and only for idx 1–7 (idx 0 and idx 8 are fixed anchors — see Task 1 for why).
- Do not switch `API_TOKENS`/`INTERNAL_SCOPE_JWT_SECRETS` parsing to a different delimiter (e.g. `;`) — this would silently break already-deployed environment values that use commas. Use the hybrid JSON-or-CSV pattern instead.
- Do not store a hashed/salted version of the JWT `sub` in `audit_log` — nothing in this repo's compliance docs asks for that, and `docs/CPA-COMPLIANCE-REQUIREMENTS.md`'s CR-10 explicitly expects raw per-user identity in structured retrieval logs for anomaly-detection purposes. Treat "store raw oid" as the default; only deviate with an explicit, separate decision if privacy counsel says otherwise.
- Do not add the TOCTOU concurrency test to `packages/db/src/queries.access-control.test.ts` — that suite is deliberately DB-free/stubbed; it belongs in `tests/e2e/src/specs/access-grants.spec.ts`.
- Do not attempt a Playwright-based middleware test — there's no infrastructure for it in this repo; use the direct vitest + hand-constructed `NextRequest` approach instead.

---

### Task 1: Fix non-monotonic timestamps in the drizzle migration journal

**Files:**

- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**

- Consumes: nothing new.
- Produces: a journal where every entry's `when` is strictly increasing with `idx`, eliminating the silent-skip risk described in Phase 0 fact #1.

- [x] **Step 1: Read the current journal in full and confirm the exact 9 entries**

  ```bash
  cat packages/db/drizzle/meta/_journal.json
  ```

  Expect exactly: idx 0 (`0001_documents_metadata_gin`, when `1779667200000`) through idx 8 (`0009_search_audit_parity`, when `1787000000000`), matching Phase 0's table.

- [x] **Step 2: Reassign `when` for idx 1 through idx 7 only, keeping idx 0 and idx 8 fixed as anchors**

  idx 0 (`1779667200000`) and idx 8 (`1787000000000`) MUST NOT CHANGE — idx 8 is the current recorded maximum in any fully-migrated environment's `__drizzle_migrations` table, and lowering or raising it risks either a spurious re-run or masking a future skip. Reassign idx 1–7 to strictly increasing values between those two anchors, e.g. incrementing by a fixed step:

  ```json
  { "idx": 0, "version": "7", "when": 1779667200000, "tag": "0001_documents_metadata_gin", "breakpoints": true },
  { "idx": 1, "version": "7", "when": 1780500000000, "tag": "0002_documents_original_storage", "breakpoints": true },
  { "idx": 2, "version": "7", "when": 1781333333000, "tag": "0003_pending_uploads", "breakpoints": true },
  { "idx": 3, "version": "7", "when": 1782166666000, "tag": "0004_data_class", "breakpoints": true },
  { "idx": 4, "version": "7", "when": 1783000000000, "tag": "0005_ingest_log", "breakpoints": true },
  { "idx": 5, "version": "7", "when": 1783833333000, "tag": "0006_client_assignments", "breakpoints": true },
  { "idx": 6, "version": "7", "when": 1784666666000, "tag": "0007_audit_log", "breakpoints": true },
  { "idx": 7, "version": "7", "when": 1785500000000, "tag": "0008_document_governance", "breakpoints": true },
  { "idx": 8, "version": "7", "when": 1787000000000, "tag": "0009_search_audit_parity", "breakpoints": true }
  ```

  Edit only the `when` fields for idx 1–7 to match (do not touch `idx`, `version`, `tag`, or `breakpoints` on any entry). Confirm every value is strictly greater than the one before it and strictly less than idx 8's `1787000000000`.

- [x] **Step 3: Verify no `.sql` filename mismatch was introduced**

  ```bash
  ls packages/db/drizzle/*.sql
  ```

  Confirm all 9 `tag` values in the edited journal exactly match existing filenames (`0001_documents_metadata_gin.sql` through `0009_search_audit_parity.sql`) with no typos.

- [x] **Step 4: Run the migration against a fresh local Postgres to confirm nothing breaks**

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/db exec node -e "
    const { createDb } = require('./dist/index.js');
    // or simplest: just run the actual migrate script against a scratch DB
  "
  # Simpler: just run the existing e2e global-setup, which applies migrations fresh:
  pnpm --filter @rag/e2e test -- src/specs/api.spec.ts
  ```

  Expect: migrations apply cleanly (the e2e global-setup logs `✓ Migrations complete`), and the `api.spec.ts` tests still pass — this exercises the full migration chain against a clean database, which is the scenario most sensitive to a broken journal.

- [x] **Step 5: Commit**

  ```bash
  git add packages/db/drizzle/meta/_journal.json
  git commit -m "fix: correct non-monotonic timestamps in drizzle migration journal

  idx 3 (0004_data_class) and idx 5 (0006_client_assignments) had 'when'
  values earlier than idx 2/4 respectively. Since drizzle-orm gates
  migration execution by comparing each entry's 'when' against the single
  recorded max created_at (not idx), any environment that had applied
  through 0003 before a later migrate() run would silently skip 0004
  forever. Reassigned idx 1-7 to strictly increasing values between the
  fixed idx-0/idx-8 anchors."
  ```

---

### Task 2: Harden `API_TOKENS`/`INTERNAL_SCOPE_JWT_SECRETS` parsing against comma-containing values

**Files:**

- Modify: `packages/core/src/config.ts` (lines ~453-456, ~468-471, plus a new shared helper near `parseOidcAdminClaims` at lines 298-316)
- Modify: `packages/core/src/config.test.ts` (extend the existing `describe("loadConfig — INTERNAL_SCOPE_JWT_SECRETS", ...)` block)
- Modify: `env.example` (lines ~96-100, ~163-170 — add a one-line note about the JSON-array escape hatch)

**Interfaces:**

- Consumes: the existing `parseOidcAdminClaims` pattern (JSON-array-or-CSV-fallback) as the template to copy.
- Produces: a `parseMultiValueSecret(raw: string): string[]` helper usable by both `API_TOKENS` and `INTERNAL_SCOPE_JWT_SECRETS`, fully backward-compatible with today's comma-separated deployed values.

- [x] **Step 1: Read the exact current `parseOidcAdminClaims` implementation to copy its shape**

  ```bash
  sed -n '298,316p' packages/core/src/config.ts
  ```

- [x] **Step 2: Add a shared helper function near it**

  ```typescript
  /**
   * Parses a multi-value secret/token env var. Accepts either a JSON array of
   * strings (`["secret-one","secret-two"]`) — required when a value might
   * legitimately contain a comma — or falls back to comma-split for backward
   * compatibility with already-deployed plain comma-separated values.
   * Mirrors parseOidcAdminClaims's JSON-or-CSV pattern above.
   */
  function parseMultiValueSecret(raw: string): string[] {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(
          "Expected a JSON array of strings (value starts with '[') but failed to parse as JSON",
        );
      }
      if (
        !Array.isArray(parsed) ||
        !parsed.every((v) => typeof v === "string")
      ) {
        throw new Error("Expected a JSON array of strings");
      }
      return parsed.map((s) => s.trim()).filter(Boolean);
    }
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  ```

- [x] **Step 3: Replace both call sites**

  Line ~453-456:

  ```typescript
  tokens: parseMultiValueSecret(env.API_TOKENS ?? ""),
  ```

  Line ~468-471:

  ```typescript
  internalScopeSecrets: parseMultiValueSecret(env.INTERNAL_SCOPE_JWT_SECRETS ?? ""),
  ```

- [x] **Step 4: Write the failing test first**

  Add to the existing `describe("loadConfig — INTERNAL_SCOPE_JWT_SECRETS", ...)` block in `packages/core/src/config.test.ts`:

  ```typescript
  it("accepts a JSON array form for secrets that might contain a comma", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: JSON.stringify([
        "secret,with,commas",
        "plain-secret",
      ]),
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([
      "secret,with,commas",
      "plain-secret",
    ]);
  });

  it("still supports the legacy comma-separated form for backward compatibility", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "secret-one,secret-two",
    });
    expect(cfg.auth.internalScopeSecrets).toEqual(["secret-one", "secret-two"]);
  });

  it("fails loud on malformed JSON-looking input", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        INTERNAL_SCOPE_JWT_SECRETS: "[not valid json",
      }),
    ).toThrow(/Expected a JSON array/);
  });
  ```

- [x] **Step 5: Run tests, verify RED then GREEN**

  ```bash
  pnpm --filter @rag/core test -- config.test.ts
  ```

  Expect all `INTERNAL_SCOPE_JWT_SECRETS` tests (both pre-existing and new) to pass, including the four original tests (default-empty, single-secret, multi-secret-with-whitespace, trailing-comma-filtering) — the CSV fallback path must remain byte-for-byte compatible with those.

- [x] **Step 6: Document the escape hatch in `env.example`**

  Append one line to both the `API_TOKENS` comment block (~line 96-99) and the `INTERNAL_SCOPE_JWT_SECRETS` block (~line 163-169):

  ```
  # If a token/secret value might itself contain a comma, use a JSON array
  # instead, e.g. ["secret,with,comma","plain-secret"].
  ```

- [x] **Step 7: Commit**

  ```bash
  git add packages/core/src/config.ts packages/core/src/config.test.ts env.example
  git commit -m "fix: support JSON-array form for API_TOKENS/INTERNAL_SCOPE_JWT_SECRETS

  Naive comma-split silently shattered any secret/token value that itself
  contained a comma. Added a JSON-array escape hatch (mirroring the
  existing parseOidcAdminClaims pattern) while keeping the plain
  comma-separated form working for backward compatibility with already-
  deployed values."
  ```

---

### Task 3: Fix the TOCTOU race in `grantClientAccess`

**Files:**

- Create: `packages/db/drizzle/0010_client_assignments_unique.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append idx 9)
- Modify: `packages/db/src/schema.ts` (add the unique index to the Drizzle schema definition, lines near 432-454)
- Modify: `packages/db/src/queries.ts` (rewrite `grantClientAccess`, lines 859-881)
- Modify: `tests/e2e/src/specs/access-grants.spec.ts` (add a concurrency test)

**Interfaces:**

- Consumes: `staff_client_assignments` table shape from Phase 0 fact #6/#7 — `id`, `userId`, `clientId`, `grantedAt`, `grantedBy`, `revokedAt`.
- Produces: an atomic `INSERT ... ON CONFLICT (user_id, client_id) DO UPDATE` that can never race, verified by a real concurrent-call test against Postgres.

- [x] **Step 1: Add the unique index migration**

  ```sql
  -- packages/db/drizzle/0010_client_assignments_unique.sql
  CREATE UNIQUE INDEX IF NOT EXISTS sca_user_client_unique
    ON staff_client_assignments (user_id, client_id);
  ```

- [x] **Step 2: Append the journal entry — `when` MUST exceed the current max (`1787000000000`)**

  ```json
  {
    "idx": 9,
    "version": "7",
    "when": 1788000000000,
    "tag": "0010_client_assignments_unique",
    "breakpoints": true
  }
  ```

- [x] **Step 3: Add the matching Drizzle schema definition**

  Find the `staffClientAssignments` table definition in `packages/db/src/schema.ts` (~lines 432-454) and add a `uniqueIndex` alongside the existing `index()` calls:

  ```typescript
  import { uniqueIndex } from "drizzle-orm/pg-core"; // add to existing drizzle-orm/pg-core import if not already present

  // ...inside the table's third-argument callback, alongside the existing
  // sca_user_idx / sca_client_idx index() calls:
  scaUserClientUnique: uniqueIndex("sca_user_client_unique").on(
    table.userId,
    table.clientId,
  ),
  ```

- [x] **Step 4: Rewrite `grantClientAccess` as an atomic upsert**

  Replace the SELECT-then-branch logic (lines 859-881) with:

  ```typescript
  export async function grantClientAccess(
    db: Db,
    { userId, clientId, grantedBy }: GrantClientAccessInput,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO staff_client_assignments (user_id, client_id, granted_by)
      VALUES (${userId}, ${clientId}, ${grantedBy})
      ON CONFLICT (user_id, client_id)
      DO UPDATE SET
        revoked_at = NULL,
        granted_by = ${grantedBy},
        granted_at = now()
    `);
  }
  ```

- [x] **Step 5: Write the failing concurrency test first**

  Add to `tests/e2e/src/specs/access-grants.spec.ts` (following the file's existing style — real Postgres, no mocks):

  ```typescript
  it("concurrent grants for the same (userId, clientId) pair never create duplicate rows", async () => {
    const userId = `concurrent-user-${Date.now()}`;
    const clientId = `concurrent-client-${Date.now()}`;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        grantClientAccess(db, { userId, clientId, grantedBy: "test-admin" }),
      ),
    );

    const rows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text as count FROM staff_client_assignments
      WHERE user_id = ${userId} AND client_id = ${clientId}
    `);
    expect(rows.rows[0]?.count).toBe("1");
  });
  ```

- [x] **Step 6: Run the test against real Postgres, confirm RED (pre-fix) then GREEN (post-fix)**

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- src/specs/access-grants.spec.ts
  ```

  Run once against the old code (temporarily `git stash` Step 4's change) to confirm the test actually fails without the fix (count > 1 some fraction of the time — concurrency bugs can be flaky to reproduce, so if it doesn't fail on the first try, increase the `Array.from({length: N})` count), then restore the fix and confirm it passes reliably across a few runs.

- [x] **Step 7: Confirm the existing sequential tests still pass** (grant→history, grant→revoke, grant→revoke→re-grant) — the `ON CONFLICT DO UPDATE` path must produce identical results to the old branching logic for the non-concurrent case.

  ```bash
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- src/specs/access-grants.spec.ts
  ```

- [x] **Step 8: Commit**

  ```bash
  git add packages/db/drizzle/0010_client_assignments_unique.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts packages/db/src/queries.ts tests/e2e/src/specs/access-grants.spec.ts
  git commit -m "fix: close TOCTOU race in grantClientAccess with unique constraint + atomic upsert

  The prior SELECT-then-INSERT/UPDATE sequence let two concurrent grants
  for the same (userId, clientId) pair both pass the existence check and
  both insert, producing duplicate rows. Added a unique index and
  converted the function to a single atomic INSERT ... ON CONFLICT DO
  UPDATE. Verified with a new concurrency test in access-grants.spec.ts
  running 10 simultaneous grants against real Postgres."
  ```

---

### Task 4: Thread per-user identity from the scope-assertion JWT through to `audit_log`

**Files:**

- Create: `packages/db/drizzle/0011_audit_log_principal_subject.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append idx 10)
- Modify: `packages/db/src/schema.ts` (add `principalSubject` column to `auditLog`)
- Modify: `packages/core/src/access-control.ts` (extend `Principal` type, line ~40-42)
- Modify: `packages/core/src/internal-scope-auth.ts` (thread `sub` through, lines ~26-37, ~71-87)
- Modify: `packages/db/src/queries.ts` (extend `AskEventRow`/`logAskEvent`, lines ~720-756)
- Modify: `apps/api/src/routes/ask.ts` and `apps/api/src/routes/search.ts` (pass the subject through in `auditAsk`/`auditSearch`)
- Modify: `tests/e2e/src/specs/audit-log-parity.spec.ts` (extend coverage)

**Interfaces:**

- Consumes: Phase 0 facts #3/#4/#5 — the exact current `Principal` shape, where `sub` is verified-then-dropped, and the exact `audit_log` schema/call sites.
- Produces: `Principal`'s `"scoped"` variant carries an optional `subject: string | null`; `audit_log` gains a nullable `principal_subject` column; both audit call sites populate it when present.

**Design decision this task makes explicit (per Global Constraints):** store the raw AAD oid, not a hash — consistent with `docs/CPA-COMPLIANCE-REQUIREMENTS.md` CR-10's expectation of "user" as a plain field in structured retrieval logs, and distinct from the deliberate question-text hashing (which protects content, not identity).

- [x] **Step 1: Extend the `Principal` type**

  `packages/core/src/access-control.ts:40-42`, change:

  ```typescript
  export type Principal =
    { kind: "admin" } | { kind: "scoped"; allowedSourceIds: string[] };
  ```

  to:

  ```typescript
  export type Principal =
    | { kind: "admin" }
    | { kind: "scoped"; allowedSourceIds: string[]; subject?: string };
  ```

  (Optional field — the static-token/OIDC-derived scoped principals that don't originate from a per-user JWT simply omit it; only `InternalScopeAuthProvider`-derived principals populate it.)

- [x] **Step 2: Thread `sub` through `InternalScopeAuthProvider.authenticate`**

  `packages/core/src/internal-scope-auth.ts:71-87`, change:

  ```typescript
  const { payload } = await jwtVerify(credential, key, {
    algorithms: [ALG],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });
  const allowedSourceIds = payload["allowedSourceIds"];
  if (!isStringArray(allowedSourceIds)) return null;
  return { kind: "scoped", allowedSourceIds };
  ```

  to:

  ```typescript
  const { payload } = await jwtVerify(credential, key, {
    algorithms: [ALG],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });
  const allowedSourceIds = payload["allowedSourceIds"];
  if (!isStringArray(allowedSourceIds)) return null;
  return {
    kind: "scoped",
    allowedSourceIds,
    ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}),
  };
  ```

- [x] **Step 3: Add the migration**

  ```sql
  -- packages/db/drizzle/0011_audit_log_principal_subject.sql
  ALTER TABLE audit_log ADD COLUMN principal_subject text;
  ```

  Append to `_journal.json`:

  ```json
  {
    "idx": 10,
    "version": "7",
    "when": 1789000000000,
    "tag": "0011_audit_log_principal_subject",
    "breakpoints": true
  }
  ```

- [x] **Step 4: Add the Drizzle schema column**

  `packages/db/src/schema.ts`, inside the `auditLog` table definition (~lines 341-375), add alongside `principalKind`/`principalSources`:

  ```typescript
  principalSubject: text("principal_subject"), // nullable — the AAD oid when the request was authenticated via a per-user scope-assertion JWT; null for admin/static-token/OIDC-non-subject principals
  ```

- [x] **Step 5: Extend `AskEventRow` and `logAskEvent`**

  `packages/db/src/queries.ts` (~lines 720-756): add `principalSubject: string | null` to the `AskEventRow` interface, and map it through in the `.values({...})` call to `auditLog`.

- [x] **Step 6: Populate it at both call sites**

  `apps/api/src/routes/ask.ts` (`auditAsk`, ~lines 29-50) and `apps/api/src/routes/search.ts` (`auditSearch`, ~lines 29-48): both currently do `const p = request.principal;` — add:

  ```typescript
  principalSubject: p?.kind === "scoped" ? (p.subject ?? null) : null,
  ```

  to the object passed into `logAskEvent`.

- [x] **Step 7: Write the failing test first**

  Extend `tests/e2e/src/specs/audit-log-parity.spec.ts` with a case that signs an internal-scope JWT with a known `sub`, makes a real `/ask` request, and asserts the resulting `audit_log` row's `principal_subject` matches — follow the file's existing pattern (it already tests `endpoint`/`topScore` parity the same way).

- [x] **Step 8: Run and verify**

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- src/specs/audit-log-parity.spec.ts
  pnpm --filter @rag/core test
  pnpm --filter @rag/db test
  pnpm --filter @rag/api test
  ```

- [x] **Step 9: Commit**

  ```bash
  git add packages/core/src/access-control.ts packages/core/src/internal-scope-auth.ts packages/db/drizzle/0011_audit_log_principal_subject.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts packages/db/src/queries.ts apps/api/src/routes/ask.ts apps/api/src/routes/search.ts tests/e2e/src/specs/audit-log-parity.spec.ts
  git commit -m "feat: thread per-user subject from scope-assertion JWT into audit_log

  The JWT sub (AAD oid) was cryptographically verified but discarded
  before audit logging, so /ask and /search audit entries recorded
  'scoped + these sourceIds' but never which staff member made the
  request. Added a nullable principal_subject column and threaded the
  verified sub through Principal -> audit call sites. Stores the raw
  oid (not hashed), consistent with CR-10's expectation of per-user
  identity in structured retrieval logs — distinct from the existing,
  unchanged questionHash-only handling of raw question content."
  ```

---

### Task 5: Add integration-level test coverage for `middleware.ts` + `auth.ts` callbacks

**Files:**

- Create: `apps/web/src/middleware.test.ts`
- Possibly create: `apps/web/src/lib/test-helpers/mint-session-cookie.ts` (small helper, only if Step 1's spike confirms the approach — see anti-pattern guard below)

**Interfaces:**

- Consumes: the real `middleware.ts` default export and real `auth.ts` config — no mocking of `next-auth` itself, per Phase 0 fact #10's confirmed feasibility.
- Produces: a test file exercising the actual redirect-to-signin (unauthenticated) and pass-through (authenticated) paths through the real Auth.js v5 `handleAuth` pipeline.

**Anti-pattern guard:** Step 1 is a deliberate feasibility spike, not an assumption. Phase 0 research rated this "medium-high confidence, derived from reading next-auth's compiled JS rather than running a working spike." If Step 1 fails to mint a working session cookie or invoke the middleware directly, STOP and report back rather than forcing a workaround — this task's approach may need to change (e.g. falling back to testing `auth.ts`'s callback logic in isolation via a lighter-weight technique, without full middleware invocation).

- [x] **Step 1: Spike — confirm `middleware.ts` can be invoked directly in vitest with a bare `NextRequest`**

  ```typescript
  // apps/web/src/middleware.test.ts (spike version)
  import { describe, expect, it } from "vitest";
  import { NextRequest } from "next/server";
  import middleware from "./middleware.js";

  describe("middleware (spike)", () => {
    it("redirects to /api/auth/signin when there is no session cookie", async () => {
      const req = new NextRequest("http://localhost:3000/");
      const res = await middleware(
        req as unknown as Parameters<typeof middleware>[0],
      );
      expect(res?.status).toBe(307); // or whatever redirect status next-auth uses — confirm empirically
      expect(res?.headers.get("location")).toContain("/api/auth/signin");
    });
  });
  ```

  Run it:

  ```bash
  pnpm --filter @rag/web test -- middleware.test.ts
  ```

  If this fails with a type error or runtime error invoking `middleware` directly, read the actual error and adjust the invocation shape (e.g. next-auth v5's `auth()` HOF may need to be called differently than a plain function) before proceeding — do not skip straight to Step 2 with an unconfirmed approach.

- [x] **Step 2: Once the unauthenticated case passes, mint a valid session cookie for the authenticated case**

  Use `@auth/core/jwt`'s `encode()` (transitively available via `next-auth`) with the same `AUTH_SECRET` the test environment configures, to build a JWE matching what `auth.ts`'s `jwt` callback would have produced (including `oid`, matching Phase 0 fact #9's callback shape):

  ```typescript
  import { encode } from "@auth/core/jwt";

  async function mintSessionCookie(
    oid: string,
    secret: string,
  ): Promise<string> {
    return encode({
      token: { oid, sub: oid },
      secret,
      salt: "authjs.session-token", // confirm exact salt/cookie name next-auth v5 expects — check auth.ts's cookie config or next-auth source
    });
  }
  ```

  Add a test:

  ```typescript
  it("passes through when a valid session cookie is present", async () => {
    const cookie = await mintSessionCookie(
      "test-oid-123",
      process.env.AUTH_SECRET!,
    );
    const req = new NextRequest("http://localhost:3000/", {
      headers: { cookie: `authjs.session-token=${cookie}` },
    });
    const res = await middleware(
      req as unknown as Parameters<typeof middleware>[0],
    );
    expect(res?.status).not.toBe(307);
  });
  ```

  Adjust the cookie name/salt to match whatever `auth.ts`/next-auth v5 actually expects — verify empirically rather than guessing, since Phase 0 flagged this as the one unconfirmed detail.

- [x] **Step 3: Add a test for the fail-closed `oid`-missing case**

  Confirm that `auth.ts`'s `jwt` callback (Phase 0 fact #9: "throws if `profile.oid` is missing on sign-in") actually prevents a session from being established — this may need to test the callback function directly (import it from `auth.ts`'s config object) rather than through the full middleware pipeline, if simulating an Entra ID sign-in profile through `NextRequest` proves impractical.

- [x] **Step 4: Add the `/api/auth`/`/api/auth/*` exemption test**

  Confirm requests to `/api/auth/signin` itself pass through without triggering the redirect loop (this is the specific hardening documented as "Task 9" in `.superpowers/sdd/progress.md` — an exact-or-child-path match, not a `startsWith` prefix match):

  ```typescript
  it("exempts /api/auth and its sub-paths from the session gate", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/signin");
    const res = await middleware(
      req as unknown as Parameters<typeof middleware>[0],
    );
    expect(res?.status).not.toBe(307);
  });

  it("does NOT exempt a path that merely starts with /api/auth-adjacent-lookalike", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/authorize-something-else",
    );
    const res = await middleware(
      req as unknown as Parameters<typeof middleware>[0],
    );
    expect(res?.status).toBe(307); // should still redirect — proves it's not a naive startsWith("/api/auth") match
  });
  ```

- [x] **Step 5: Run the full suite, verify all green**

  ```bash
  pnpm --filter @rag/web test
  ```

- [x] **Step 6: Commit**

  ```bash
  git add apps/web/src/middleware.test.ts
  git commit -m "test(web): add integration coverage for middleware.ts + auth.ts callbacks

  Prior coverage only unit-tested downstream consumers of a hand-built
  Session object (admin-check, actions), never exercising middleware.ts
  or auth.ts's actual jwt/session callbacks. Added direct vitest
  invocation of the real middleware with hand-constructed NextRequest
  objects (no server boot, no Playwright needed) covering: unauthenticated
  redirect, authenticated pass-through via a minted session cookie,
  the /api/auth exemption's exact-path-match (not startsWith) hardening,
  and the oid-missing fail-closed path."
  ```

---

## Final Phase: Verification

- [x] Run the full unit test suite and confirm no regressions: `pnpm --filter='!@rag/e2e' test`
- [x] Run the full e2e suite against real Postgres and confirm no regressions: `pnpm docker:up && E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test`
- [x] Run `pnpm typecheck` and `pnpm lint` across the whole workspace.
- [x] Run `pnpm build` (including `apps/web`'s `next build`) to confirm the schema/type changes compile end-to-end.
- [x] Manually confirm the migration chain applies cleanly from scratch on a fresh database (drop and recreate the local Postgres volume, or use a scratch DB, then run the full migrate): this specifically re-validates Task 1's journal fix and Tasks 3/4's new migrations together, in the order they'd actually run.
- [x] Grep for any remaining reference to the old `grantClientAccess` SELECT-then-branch pattern elsewhere in the codebase (`grep -rn "grantClientAccess" packages/ apps/`) to confirm no other call site assumed the old two-step behavior.
- [x] Confirm `docs/HOOK-INJECTION-FINDINGS.md` and `docs/PLAN-HOOK-INJECTION-REMEDIATION.md` are unaffected by this plan (they're a separate, orthogonal workstream targeting `~/.claude/`, not `rag-system` application code) — no overlap expected, this is a final sanity check only.
- [x] Update `.superpowers/sdd/progress.md`'s "Known follow-ups" section to mark the three items this plan resolved (audit attribution, TOCTOU race, middleware test coverage) as done, with a pointer to the commits/this plan.
