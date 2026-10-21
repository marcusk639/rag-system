# Pilot Readiness — Automatable Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every code/test/config-automatable gap identified in `docs/CPA-READINESS-ASSESSMENT-2026-07-08.md`, so the platform's technical controls actually match what the compliance and business documentation already claims.

**Architecture:** Seventeen mostly-independent tasks across `packages/core`, `packages/db`, `packages/ingestion`, `packages/rag`, `apps/worker`, `apps/mcp`, `apps/web`. Ordered so schema-touching work lands before dependent code, and so the two highest-severity compliance gates (data-class wiring, MCP audit logging) come first.

**Companion document:** `docs/PILOT-MANUAL-RUNBOOK.md` — every item here that required a human/business/legal decision was deliberately excluded from this plan and lives there instead. Several tasks below reference specific decision points from that runbook; do not silently resolve those decisions in code.

## Global Constraints

- Every new migration must follow the existing numbering convention exactly: the current highest is `0011_audit_log_principal_subject.sql` (journal `idx: 10`). Confirm the actual current highest before creating a new one — other work may have landed since this plan was written. **Note the off-by-one**: the journal has no entry for `0000_init.sql`, so `idx = tagNumber − 1` (e.g. `0012_*.sql` gets `idx: 11`, not `idx: 12`).
- New journal entries in `packages/db/drizzle/meta/_journal.json` must have `idx = previous_idx + 1` and `when` strictly greater than every existing entry's `when`.
- **Migration serialization is mandatory, not just "confirm first."** Tasks 9, 13, and 14 each create a new migration and mutate `_journal.json`. These three MUST be executed in strict sequence relative to one another — **never in parallel, and never out of order** — because each independently "confirming the current highest number" against a baseline that doesn't yet include the others' uncommitted work will produce a collision (duplicate `idx`/tag, or two migrations racing for the same `when`). Pre-assigned order for this plan: **Task 9 → `0012` (idx 11), Task 13 → `0013` (idx 12), Task 14 → `0014` (idx 13)** — adjust only if other unrelated work lands first in between, but preserve this relative order and re-confirm the true current highest immediately before each of these three tasks starts, not once at the top of the plan. This is not a theoretical risk — this exact repo has already hit a non-monotonic-timestamp migration bug once, and this worktree's own git history shows a prior unresolved `_journal.json` merge conflict.
- Migrations in this repo are **forward-only** — no `down` migrations exist anywhere in `packages/db/drizzle/`. Do not author one. To correct a bad migration, ship a new corrective migration; never hand-edit an already-committed journal entry to remove or "undo" it.
- Only `env.example` is editable — `.env` file writes are hook-blocked in this environment (see this repo's `CLAUDE.md`). Tasks 3, 7, 8, 14 all touch env documentation; confirm you're editing `env.example`, never a real `.env` file.
- Do not silently retain raw question text or any reversible derivative of it anywhere — this is a deliberate, repeatedly-documented privacy design decision (`packages/db/src/queries.ts:773-778,785-792`, `apps/worker/src/handlers/docs-gap-digest.ts:33-36,103-106`). Task 13 in this plan is explicitly scoped to NOT cross this line (see its own anti-pattern guard).
- Do not build the type/class AI classifier (assessment doc P2 item 16) — it is gated on an unresolved firm "build vs. buy" business decision (`~/dev/cpa-consulting/docs/rag/evaluations/document-classification-automation.md`) and is out of scope for this plan; it is tracked in `docs/PILOT-MANUAL-RUNBOOK.md` as a decision gate instead.
- Follow this repo's established provider-factory pattern (interface in `packages/core/src/interfaces.ts`, concrete implementation in the relevant package, a `create<X>` factory switching on a config `provider` enum, wired once in `packages/runtime/src/index.ts`) for any new pluggable integration (Task 14).
- This repo standardizes on the `uuid-ossp` extension's `uuid_generate_v4()` for every UUID primary-key default (`0000_init.sql`, `0006_client_assignments.sql`, `schema.ts`'s existing tables) — **not** `gen_random_uuid()`/`pgcrypto`, which is not installed. Any new migration in this plan (Tasks 9, 13) must use `uuid_generate_v4()` to match the Drizzle schema default it's paired with, or `drizzle-kit generate` will see the DB default and the schema-declared default disagree and emit a spurious diff.
- Every task that touches `apps/worker`'s real production ingestion path must have its regression test exercise that REAL path — not `tests/e2e/src/helpers/ingestion.ts`'s `runOneIngestion` bypass helper, which calls `runIngestion` directly and skips the worker handler entirely. This exact bypass is why the data-class gate went unnoticed for as long as it did (see Task 1).
- Match this session's already-established test patterns: MCP tool tests use the `fakeServer()` harness pattern (capture the registrar's handler map, invoke the real handler directly) from `apps/mcp/src/tools/list-sources.test.ts`/`trigger-sync.test.ts`; worker handler tests use `vi.hoisted` mocks for `@rag/db`/`@rag/ingestion` from `apps/worker/src/handlers/sync-source.test.ts`.

---

## Task 1: Wire `sources.dataClass` into the real ingestion path

**Files:**

- Create: `packages/ingestion/src/classify-source.ts`, `packages/ingestion/src/classify-source.test.ts`
- Modify: `packages/ingestion/src/index.ts` (export the new function)
- Modify: `apps/worker/src/handlers/sync-source.ts` (lines ~107-117)
- Modify: `apps/worker/src/handlers/sync-source.test.ts`
- Create: `tests/e2e/src/specs/data-class-ingestion-gate.spec.ts`

**Interfaces:**

- Consumes: `Source.dataClass` (`packages/db/src/schema.ts:49-54,95` — Drizzle field `dataClass`, DB column `data_class`, enum `"general" | "research" | "sop" | "client_confidential"`); `DocumentClass` (`packages/core/src/types.ts:33-34` — `z.enum(["A","B","C","D"])`); `PipelineDeps.sourceDocClass` (`packages/ingestion/src/pipeline.ts:74`).
- Produces: `mapDataClassToDocumentClass(dataClass): DocumentClass`, exported from `@rag/ingestion`.

- [ ] **Step 1: Write the failing unit tests for the mapping function**

  ```typescript
  // packages/ingestion/src/classify-source.test.ts
  import { describe, expect, it } from "vitest";
  import { mapDataClassToDocumentClass } from "./classify-source.js";

  describe("mapDataClassToDocumentClass", () => {
    it("maps 'general' to Class A", () => {
      expect(mapDataClassToDocumentClass("general")).toBe("A");
    });
    it("maps 'sop' to Class A", () => {
      expect(mapDataClassToDocumentClass("sop")).toBe("A");
    });
    it("maps 'research' to Class B", () => {
      expect(mapDataClassToDocumentClass("research")).toBe("B");
    });
    it("maps 'client_confidential' to Class C", () => {
      expect(mapDataClassToDocumentClass("client_confidential")).toBe("C");
    });
  });
  ```

- [ ] **Step 2: Run to confirm RED**

  ```bash
  pnpm --filter @rag/ingestion test -- classify-source
  ```

  Expected: fails with "module not found."

- [ ] **Step 3: Implement the mapping function — fail CLOSED, not open**

  Import `DataClass` from `@rag/db` (do not redeclare it as a local literal union) so a future addition to the DB enum is a compile error here, not a silent runtime gap. Add an explicit `default` branch that throws rather than allowing an unhandled value to fall through to `undefined` — the pipeline's own `deps.sourceDocClass ?? "A"` fallback (`pipeline.ts:148`) would otherwise silently treat an unmapped value as public Class A, exactly the fail-open this task exists to close:

  ```typescript
  // packages/ingestion/src/classify-source.ts
  import type { DocumentClass } from "@rag/core";
  import type { DataClass } from "@rag/db";

  /**
   * Maps the operator-facing `sources.data_class` classification (general |
   * research | sop | client_confidential) to the pipeline's compliance-gate
   * `DocumentClass` (A | B | C | D). `client_confidential` maps to C, not D —
   * D is reserved for tax-return-specific data; both C and D are blocked at
   * the pipeline level today (`pipeline.ts:245`), so this distinction has no
   * behavioral effect yet. This C-vs-D semantic assignment is a provisional
   * engineering default, NOT a ratified compliance-classification decision —
   * see docs/PILOT-MANUAL-RUNBOOK.md item 9, which flags it for confirmation
   * against the firm's actual data-classification policy before any
   * D-specific behavior is ever built on top of it.
   *
   * Fails CLOSED on an unrecognized value (throws) rather than falling
   * through to `undefined`, which the pipeline's `?? "A"` default would
   * otherwise silently treat as public Class A.
   */
  export function mapDataClassToDocumentClass(
    dataClass: DataClass,
  ): DocumentClass {
    switch (dataClass) {
      case "general":
      case "sop":
        return "A";
      case "research":
        return "B";
      case "client_confidential":
        return "C";
      default: {
        const exhaustive: never = dataClass;
        throw new Error(
          `Unrecognized sources.data_class value: ${String(exhaustive)} — refusing to default to Class A. Add an explicit mapping before this value can be ingested.`,
        );
      }
    }
  }
  ```

  Also confirm (`packages/ingestion/src/pipeline.ts:74`) whether `sourceDocClass` should become a **required** field on `PipelineDeps` rather than optional, removing the `?? "A"` fallback in `pipeline.ts:148` entirely now that the one real caller (the worker handler, this task) always supplies it — this would turn "classification missing" into a compile error everywhere, not just a runtime throw in the mapping function. If removing the fallback would break other legitimate callers (check `pipeline.test.ts` and any other caller before deciding), keep the optional field and rely on this function's throw as the fail-closed backstop instead, and note that decision in the commit message.

- [ ] **Step 4: Run to confirm GREEN**

  ```bash
  pnpm --filter @rag/ingestion test -- classify-source
  ```

- [ ] **Step 5: Export from the package barrel**

  Add to `packages/ingestion/src/index.ts`:

  ```typescript
  export { mapDataClassToDocumentClass } from "./classify-source.js";
  ```

- [ ] **Step 6: Write the failing worker-handler test first**

  In `apps/worker/src/handlers/sync-source.test.ts`, find the existing `SOURCE` fixture (~line 88) and the assertion on `runIngestionMock.mock.calls[0]![2]` (~line 214). Add:

  ```typescript
  it("passes sourceDocClass derived from source.dataClass into runIngestion's deps", async () => {
    getSourceMock.mockResolvedValue({ ...SOURCE, dataClass: "research" });
    await handleSyncSource(job, deps);
    expect(runIngestionMock.mock.calls[0]![4]).toEqual(
      expect.objectContaining({ sourceDocClass: "B" }),
    );
  });

  it("does not default to Class A when the source is client_confidential", async () => {
    getSourceMock.mockResolvedValue({
      ...SOURCE,
      dataClass: "client_confidential",
    });
    await handleSyncSource(job, deps);
    expect(runIngestionMock.mock.calls[0]![4]).toEqual(
      expect.objectContaining({ sourceDocClass: "C" }),
    );
  });
  ```

  Adjust fixture/mock names to match this file's actual current variable names (read the file first — do not assume exact identifiers).

- [ ] **Step 7: Confirm RED**

  ```bash
  pnpm --filter @rag/worker test -- sync-source
  ```

  Expected: fails because `sourceDocClass` is currently absent from the deps object entirely.

- [ ] **Step 8: Wire the fix in the real handler**

  In `apps/worker/src/handlers/sync-source.ts`, import `mapDataClassToDocumentClass` from `@rag/ingestion`, and change the deps object literal (~lines 107-117) to add `sourceDocClass: mapDataClassToDocumentClass(source.dataClass)` alongside the existing `db, parser, chunker, embedder, objectStore, logger` fields.

- [ ] **Step 9: Confirm GREEN**

  ```bash
  pnpm --filter @rag/worker test -- sync-source
  ```

- [ ] **Step 10: Write the failing e2e test that exercises the REAL handler, not the bypass helper**

  Create `tests/e2e/src/specs/data-class-ingestion-gate.spec.ts`. Do NOT use `runOneIngestion` from `tests/e2e/src/helpers/ingestion.ts` — it bypasses this exact code path. Instead, create a source with `dataClass: "client_confidential"` via the existing `createCustomSource` e2e helper, enqueue a real sync job (following whatever pattern `tests/e2e/src/specs/ingestion.spec.ts` or `idempotency.spec.ts` uses to drive a real job through the worker — read one of those files first to copy its exact setup), and assert the resulting `ingest_log` row records a blocked/rejected action with `docClass: "C"`, and that zero `documents`/`chunks` rows were created for that source.

- [ ] **Step 11: Run against real Postgres, confirm RED then GREEN**

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- data-class-ingestion-gate
  ```

  Confirm this test would have failed against the pre-fix code (temporarily revert Step 8's change via `git stash` if needed to prove it), then confirm it passes with the fix in place.

- [ ] **Step 12: Run the full affected test surface**

  ```bash
  pnpm --filter @rag/ingestion test
  pnpm --filter @rag/worker test
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- ingestion idempotency governance-taxonomy data-class-ingestion-gate
  ```

- [ ] **Step 13: Commit**

  ```bash
  git add packages/ingestion/src/classify-source.ts packages/ingestion/src/classify-source.test.ts packages/ingestion/src/index.ts apps/worker/src/handlers/sync-source.ts apps/worker/src/handlers/sync-source.test.ts tests/e2e/src/specs/data-class-ingestion-gate.spec.ts
  git commit -m "fix: wire sources.data_class into the real ingestion pipeline

  sourceDocClass previously defaulted to Class A unconditionally in
  apps/worker (the only real production caller of the pipeline) —
  sources.data_class was set at the DB level but never read anywhere
  outside pipeline.test.ts's isolated unit tests. Added a mapping
  function (general/sop -> A, research -> B, client_confidential -> C)
  and wired it into the real worker handler, with a regression test
  that exercises the REAL handler (not the e2e runOneIngestion bypass
  that let this gap go unnoticed)."
  ```

---

## Task 2: Correct `docs/ISSUES-AND-OPTIMIZATIONS.md`'s inaccurate P3 line

**Files:**

- Modify: `docs/ISSUES-AND-OPTIMIZATIONS.md` (line ~238, and the P3 entries at ~252-279, ~377)

**Interfaces:** none — documentation-only change.

- [ ] **Step 1: Read the current inaccurate text**

  ```bash
  sed -n '230,280p' docs/ISSUES-AND-OPTIMIZATIONS.md
  ```

- [ ] **Step 2: Correct the two false claims**

  Change "DPA signed" to accurately reflect `docs/compliance/vendor-dpa-google-gemini.md`'s actual status ("PROVISIONAL — NOT COUNSEL-CONFIRMED; Cloud Billing status unverified; no counsel review has occurred"). Change "`dataClass` gate all ship" to reflect Task 1's actual state at the time this edit lands — if Task 1 has already merged, this claim becomes true and should cite the resolving commit; if this task is being done before Task 1, mark it explicitly as **still not wired** with a citation to the assessment doc's finding.

- [ ] **Step 3: Add a standing process note**

  If one doesn't already exist nearby, add: "This section was found to contain inaccurate 'resolved' claims on 2026-07-08 despite an earlier revisit — cross-check any status claim here against the actual code before trusting it, the same discipline this note itself asks for."

- [ ] **Step 4: Commit**

  ```bash
  git add docs/ISSUES-AND-OPTIMIZATIONS.md
  git commit -m "docs: correct inaccurate DPA-signed and dataClass-gate claims

  Both claims were verified false against current code/docs as of
  2026-07-08 (see docs/CPA-READINESS-ASSESSMENT-2026-07-08.md section
  3) — the same stale-doc-creates-false-confidence failure mode this
  file's own prior revisit was supposed to prevent."
  ```

---

## Task 3: Raise the minimum length on `INTERNAL_SCOPE_JWT_SECRETS`

**Files:**

- Modify: `packages/core/src/config.ts` (~line 108)
- Modify: `packages/core/src/internal-scope-auth.ts` (~lines 26-37, the signing side)
- Modify: `packages/core/src/config.test.ts`, `packages/core/src/internal-scope-auth.test.ts`

**Interfaces:**

- Consumes: existing `parseMultiValueSecret` (added this session, `packages/core/src/config.ts` — mirrors `parseOidcAdminClaims`'s JSON-or-CSV pattern) for parsing; `signInternalScopeToken` (`internal-scope-auth.ts:26-37`).
- Produces: both the config-loading path AND the signing path reject a secret with fewer than 64 hex characters (256 bits of real entropy), failing loud rather than silently accepting a weak HS256 key.

**Design correction from the original draft of this task:** a plain character-length check is not the same as an entropy check. `openssl rand -hex 32` (this task's own documented generation method) produces a **64-character** hex string encoding 32 bytes (256 bits) of entropy — `openssl rand -hex 16` also passes a naive `.min(32)` check while carrying only 128 bits, half the HS256 target. Enforce **`.min(64)`**, not `.min(32)`, and keep the hex-generation guidance consistent with that number throughout config, code, and docs. (If base64 secrets need supporting instead of/alongside hex, `openssl rand -base64 32` produces 44 characters — use `.min(44)` and document base64 explicitly; do not mix the two without picking which encoding the length check assumes.)

**The signing-side check (Step 5) is not optional defense-in-depth — verify this before treating it as such.** The web app's BFF (`apps/web/src/lib/scope-token.ts`) reads `INTERNAL_SCOPE_JWT_SECRET` (singular) directly from `process.env` and checks only presence (`if (!secret)`), never routing through `loadConfig`'s validation at all. That means Step 3's config-side check protects only the API/MCP _verification_ side — the web app's _signing_ side has no length enforcement except whatever Step 5 adds directly in `signInternalScopeToken`. Confirm this during Step 1 (read `scope-token.ts` in full) before assuming Step 3 alone is sufficient.

- [ ] **Step 1: Read `apps/web/src/lib/scope-token.ts` in full first**, to confirm it really does read the secret directly from `process.env` rather than through `loadConfig`, and confirm exactly where it calls into `signInternalScopeToken`.

- [ ] **Step 2: Write the failing config test**

  ```typescript
  it("rejects an INTERNAL_SCOPE_JWT_SECRETS entry shorter than 64 characters", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, INTERNAL_SCOPE_JWT_SECRETS: "a".repeat(63) }),
    ).toThrow(/at least 64/);
  });
  ```

- [ ] **Step 3: Run to confirm RED**

  ```bash
  pnpm --filter @rag/core test -- config.test.ts
  ```

- [ ] **Step 4: Enforce the minimum in the Zod schema / parsing path**

  Change the relevant schema/validation for `internalScopeSecrets` from accepting any non-empty string to requiring `.min(64)` per entry, with a clear error message (`"INTERNAL_SCOPE_JWT_SECRETS entries must be at least 64 hex characters (256 bits of entropy for HS256) — generate with: openssl rand -hex 32"`).

- [ ] **Step 5: Run to confirm GREEN, then confirm the pre-existing valid-secret tests still pass** (the existing test fixtures' secret strings must be at least 64 characters — check and lengthen them if they were only 32).

  ```bash
  pnpm --filter @rag/core test -- config.test.ts
  ```

- [ ] **Step 6: Add the SAME length check on the signing side — required, not optional**

  In `internal-scope-auth.ts`'s `signInternalScopeToken`, add the identical `.min(64)`-equivalent assertion, since (per Step 1's finding) this is the _only_ enforcement point for the web app's signing secret, not a defense-in-depth backstop for a path that's already covered elsewhere. Add a corresponding test in `internal-scope-auth.test.ts` proving a short secret throws here even when never routed through `loadConfig`.

- [ ] **Step 7: Update `env.example`'s documentation**

  Near the `INTERNAL_SCOPE_JWT_SECRETS` AND `INTERNAL_SCOPE_JWT_SECRET` (singular, web app) blocks, add: "Must be at least 64 characters per secret (256 bits of entropy for HS256). Generate with `openssl rand -hex 32` (produces exactly 64 hex characters)."

- [ ] **Step 8: Run full affected suite**

  ```bash
  pnpm --filter @rag/core test
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add packages/core/src/config.ts packages/core/src/config.test.ts packages/core/src/internal-scope-auth.ts packages/core/src/internal-scope-auth.test.ts apps/web/src/lib/scope-token.ts env.example
  git commit -m "fix: enforce 64-character (256-bit) minimum on INTERNAL_SCOPE_JWT_SECRETS

  This secret signs the entire per-user confidentiality boundary
  (allowedSourceIds) for the web app; a weak/short key set by
  non-expert ops was previously accepted silently, and would be
  brute-forceable offline from a single observed 60s token — a full
  cross-tenant confidentiality break. Fixed as 64 chars (not the
  originally-considered 32), since 32 would have permitted a
  128-bit-entropy hex secret despite this file's own openssl guidance
  producing 64 chars. Enforced identically on both the config-load
  path (api/mcp verification) and signInternalScopeToken (the web
  app's signing side, which never routes through loadConfig and was
  otherwise completely unenforced)."
  ```

---

## Task 4: Wire audit logging into the MCP `ask`/`search_documents` tools

**Files:**

- Modify: `apps/mcp/src/tools/ask.ts`, `apps/mcp/src/tools/search-documents.ts`
- Modify: `apps/mcp/src/server.ts`, `apps/mcp/src/transports/http.ts`, `apps/mcp/src/main.ts`
- Modify: `apps/mcp/src/server.test.ts` — **this file currently calls `buildServer({...})` at four sites, none passing a principal; it WILL break once `principal` becomes part of `buildServer`'s opts if implemented as a required field.** Update all four call sites, or make `principal` optional with a documented default (see Step 3).
- Create: `apps/mcp/src/tools/ask.test.ts`, `apps/mcp/src/tools/search-documents.test.ts`

**Interfaces:**

- Consumes: `auditAsk`/`auditSearch` (`apps/api/src/routes/ask.ts:29-51`, `search.ts:29-50`) as the exact pattern to mirror; `Principal` (`packages/core/src/access-control.ts:47-49`); `principalToScope` (`access-control.ts:212-214`).
- Produces: MCP `ask`/`search_documents` tool calls now write an `audit_log` row with `channel: "mcp"`, matching the API surface's parity — including `principalSubject`, not just a degraded scope-derived approximation. This is a deliberate choice (see Step 1) over the faster-but-lossier alternative Phase 0 research flagged.

**Design decision this task makes explicit:** Phase 0 research surfaced two options — (a) plumb the full `Principal` (not just the derived `AuthorizationScope`) through `http.ts` → `server.ts` → the tools, preserving full per-user audit parity with the API side; or (b) derive a degraded `principalKind`/`principalSources` from `scope` alone and always record `principalSubject: null` for MCP. This task implements **(a)**, because the entire point of this fix is satisfying CR-10's per-user audit-trail expectation for the channel Doug and Chris actually use — option (b) would ship an MCP audit trail that still can't answer "which staff member asked this," which is the exact gap being closed.

- [ ] **Step 1: Read the current full chain before changing anything**

  Read `apps/mcp/src/transports/http.ts`'s `scopeForRequest` (~lines 75-79) AND the transport hook's own type (`http.ts:48` — currently typed `buildServer: (scope: AuthorizationScope) => McpServer`, a SEPARATE signature from `server.ts`'s own `buildServer` function), the `http.ts:194` call site (`buildServer(await scopeForRequest(req))`), `apps/mcp/src/server.ts`'s `buildServer` (~lines 28-46), and `apps/mcp/src/main.ts`'s stdio wiring (~line 67 and the `buildServer: (scope) => buildServer({ deps, logger, scope })` closure at ~line 89) in full. There are TWO distinct things both called `buildServer` in this chain — the transport-injected hook function, and `server.ts`'s actual server-construction function — and this task must change both signatures, not just one. Confirm exact current line numbers/identifiers before modifying anything.

- [ ] **Step 2: Extend `scopeForRequest` to also return the resolved `Principal`**

  In `http.ts`, change the function to return `{ scope, principal }` instead of just `scope` (it already resolves `principal` via `authProvider.authenticate(credential)` before deriving `scope` — just stop discarding it). Handle the failed-auth case explicitly: when authentication fails, `principal` is `null` — confirm this `null` is never silently coerced into an admin principal anywhere downstream, and that the existing `guard` middleware (`http.ts:106`, which already 401s unauthenticated requests before `buildServer` runs) means `buildServer` should only ever actually receive a real, non-null principal in practice — but the type should still honor `Principal | null` rather than asserting non-null.

- [ ] **Step 3: Widen BOTH `buildServer` signatures to thread the principal through**

  - The transport hook type in `http.ts:48` changes from `(scope: AuthorizationScope) => McpServer` to `(scope: AuthorizationScope, principal: Principal) => McpServer`, and its call site at `http.ts:194` becomes `buildServer(scope, principal)` (using Step 2's now-destructured result).
  - `server.ts`'s actual `buildServer` function gets `principal: Principal` added to its `opts` type (alongside the existing `deps`, `logger`, `scope`), passed through to `registerAsk`/`registerSearchDocuments`'s call sites.
  - `main.ts`'s stdio closure (`buildServer: (scope) => buildServer({ deps, logger, scope })`) becomes `buildServer: (scope, principal) => buildServer({ deps, logger, scope, principal })`.
  - Decide explicitly whether `principal` is a required or optional field on `server.ts`'s `opts` type. If required, `apps/mcp/src/server.test.ts`'s four existing `buildServer({...})` call sites (none currently passing a principal) must all be updated in this same task — see this task's Files list. If made optional with a sensible default (e.g. defaulting to an anonymous/deny-all principal), state that choice and its rationale in the commit message instead of silently picking one.

- [ ] **Step 4: Update the stdio entrypoint AND consolidate double-authentication**

  In `main.ts`, the stdio transport currently passes `ADMIN_SCOPE` with no principal. Construct an explicit `{ kind: "admin" }` `Principal` alongside it (matching the existing documented "trusted local channel" design — stdio sessions are intentionally unscoped/admin, so `principalSubject` is correctly absent here, not a bug).

  Separately, note that the HTTP path today authenticates twice: once via the `guard` middleware (`http.ts:106`) for the 401 decision, and again via `scopeForRequest`'s own `authProvider.authenticate(credential)` call to derive scope/principal. With a deterministic verifier (the current static/OIDC/composite providers) this is only redundant work, not a correctness bug — but as part of this task, check whether these two calls can be consolidated into one (authenticate once, reuse the result for both the guard decision and the server build) to eliminate any future risk of the two calls resolving different principals for a hypothetical stateful/remote `AuthProvider`. If consolidating is a larger change than fits this task cleanly, leave it as a noted follow-up in the commit message rather than silently skipping it.

- [ ] **Step 5: Write the failing tests first**

  Create `apps/mcp/src/tools/ask.test.ts` and `search-documents.test.ts`, following the `fakeServer()` pattern from `list-sources.test.ts`/`trigger-sync.test.ts` (capture the registrar's handler via a stubbed `registerTool`, invoke it directly) and the `vi.hoisted`-mocked `@rag/db` pattern from `sync-source.test.ts` to capture `logAskEvent` calls. Assert:

  ```typescript
  it("logs an audit_log row with channel 'mcp' and the caller's principalSubject after a successful ask", async () => {
    const principal = {
      kind: "scoped" as const,
      allowedSourceIds: ["src-1"],
      subject: "user-oid-123",
    };
    await invokeAskHandler(
      { question: "test" },
      { deps, scope: principalToScope(principal), principal },
    );
    expect(logAskEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "mcp",
        endpoint: "ask",
        principalKind: "scoped",
        principalSubject: "user-oid-123",
      }),
    );
  });
  ```

  Adjust exact helper/mock names to this repo's actual conventions after reading the reference test files.

- [ ] **Step 6: Confirm RED**

  ```bash
  pnpm --filter @rag/mcp test -- ask search-documents
  ```

- [ ] **Step 7: Implement `auditMcpAsk`/`auditMcpSearch` mirroring the API pattern exactly**

  In `ask.ts` and `search-documents.ts`, add functions mirroring `auditAsk`/`auditSearch` field-for-field (`principalKind`, `principalSources`, `principalSubject`, `questionHash`, `channel: "mcp"`, `model`, `sourceIds`/`chunkIds`/`docIds`, `retrievedCount`, `endpoint`, `topScore`), called fire-and-forget after a successful `askQuestion`/`searchDocuments` result, with the same `.catch(err => deps.logger.error(...))` non-blocking pattern the API routes use.

- [ ] **Step 8: Confirm GREEN**

  ```bash
  pnpm --filter @rag/mcp test
  ```

- [ ] **Step 9: Run the full MCP suite and the server-level test to confirm the signature changes didn't break anything**

  ```bash
  pnpm --filter @rag/mcp test
  pnpm --filter @rag/mcp typecheck
  ```

- [ ] **Step 10: Commit**

  ```bash
  git add apps/mcp/src/tools/ask.ts apps/mcp/src/tools/search-documents.ts apps/mcp/src/tools/ask.test.ts apps/mcp/src/tools/search-documents.test.ts apps/mcp/src/server.ts apps/mcp/src/server.test.ts apps/mcp/src/transports/http.ts apps/mcp/src/main.ts
  git commit -m "fix: audit-log MCP ask/search_documents calls with full principal parity

  Queries via the MCP surface -- the actual channel Doug/Chris use via
  Claude/CoWork -- were producing zero audit_log rows. Threaded the
  resolved Principal (not just the derived AuthorizationScope) through
  http.ts -> server.ts -> the tools so MCP audit rows carry
  principalSubject with the same per-user attribution the API side
  already has, rather than a degraded subject-less approximation."
  ```

---

## Task 5: Add the permanent migration-timestamp monotonicity guard

**Files:**

- Modify: `packages/db/src/migration-guard.test.ts`

**Interfaces:** consumes `packages/db/drizzle/meta/_journal.json`'s existing shape (already read/modeled by this same test file's existing `readdir`/`readFile` calls).

- [ ] **Step 1: Read the existing test file in full** to model the new test on its established I/O pattern (lines ~44-51 per prior research).

- [ ] **Step 2: Write the new test**

  ```typescript
  it("has strictly increasing 'when' values across every journal entry in idx order", () => {
    const journal = JSON.parse(
      readFileSync(
        path.join(__dirname, "../drizzle/meta/_journal.json"),
        "utf8",
      ),
    );
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThan(
        journal.entries[i - 1].when,
      );
    }
  });
  ```

  Adjust the path/import style to match this file's existing conventions exactly.

- [ ] **Step 3: Run — should already be GREEN** (the journal was fixed earlier this session; this test's job is to prevent a _future_ regression, not fix a current break).

  ```bash
  pnpm --filter @rag/db test -- migration-guard
  ```

- [ ] **Step 4: Verify the test actually catches the bug class it targets** — temporarily edit a copy of `_journal.json` in a scratch location with two entries swapped, point the test at it in a throwaway local run, confirm it fails, then discard the scratch edit. Do not modify the real journal file during this verification.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/db/src/migration-guard.test.ts
  git commit -m "test: add permanent guard against non-monotonic migration timestamps

  This exact bug class (a manual merge-conflict resolution fixing idx
  but not when) has already happened twice in this project's history.
  CI is structurally blind to it otherwise, since it only ever
  cold-starts a fresh database and the bug only manifests on
  incremental application (i.e. real deploys)."
  ```

---

## Task 6: Add a test for `purge_source`'s authorization gate

**Files:**

- Create: `apps/mcp/src/tools/purge-source.test.ts`

**Interfaces:** consumes the `fakeServer()` pattern (as in Task 4), and `apps/mcp/src/tools/purge-source.ts`'s existing `scope.enforcedSourceIds === null || scope.enforcedSourceIds.includes(sourceId)` check.

- [ ] **Step 1: Read `purge-source.ts` in full** to confirm its exact handler signature and the permission check's exact line/shape.

- [ ] **Step 2: Write the failing tests**

  ```typescript
  it("allows an admin-scoped (enforcedSourceIds: null) session to purge any source", async () => {
    const result = await invokePurgeSourceHandler(
      { sourceId: "src-1" },
      { deps, scope: { enforcedSourceIds: null } },
    );
    expect(purgeSourceMock).toHaveBeenCalledWith(expect.anything(), "src-1");
  });

  it("allows a scoped session to purge a source within its enforcedSourceIds", async () => {
    await invokePurgeSourceHandler(
      { sourceId: "src-1" },
      { deps, scope: { enforcedSourceIds: ["src-1", "src-2"] } },
    );
    expect(purgeSourceMock).toHaveBeenCalled();
  });

  it("REJECTS a scoped session from purging a source outside its enforcedSourceIds", async () => {
    await expect(
      invokePurgeSourceHandler(
        { sourceId: "src-99" },
        { deps, scope: { enforcedSourceIds: ["src-1", "src-2"] } },
      ),
    ).rejects.toThrow();
    expect(purgeSourceMock).not.toHaveBeenCalled();
  });
  ```

  Adjust exact mock/helper names after reading the real file.

- [ ] **Step 3: Confirm all three pass against the current (already-correct) implementation** — this task is closing a test-coverage gap on already-correct logic, not fixing a bug. If the third test unexpectedly fails, STOP and report — that would mean the authorization check is not actually enforced despite its appearance, which is a Critical finding requiring escalation, not a silent fix.

  ```bash
  pnpm --filter @rag/mcp test -- purge-source
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add apps/mcp/src/tools/purge-source.test.ts
  git commit -m "test: add authorization-gate coverage for purge_source

  This is the single most destructive, irreversible action in the
  system (permanently deletes a source and all its documents/chunks/
  history) and its scope check had zero test coverage -- the
  server-level test mocks the tool out entirely."
  ```

---

## Task 7: Fix the 512-token silent truncation on the local embedding path

**Files:**

- Modify: `packages/core/src/config.ts` (chunk-size default, conditionally on embedding provider)
- Modify: `packages/rag/src/embeddings/local.ts` (explicit truncation handling)
- Modify: `packages/rag/src/embeddings/local.test.ts`, `packages/core/src/config.test.ts`

**Interfaces:** consumes `Xenova/bge-base-en-v1.5`'s 512-token limit (`local.ts:56`), `CHUNK_SIZE` config default (`config.ts:117`, currently 800), `embedBatch` (`local.ts:118-131`).

- [ ] **Step 1: Read `local.ts`'s `embedBatch` in full** to confirm the exact pipeline call signature and what truncation options `@xenova/transformers` actually exposes (check its type definitions — do not assume a parameter name without confirming it in the installed package's types).

- [ ] **Step 2: Write the failing test proving silent truncation currently occurs**

  In `local.test.ts`, construct an input longer than 512 tokens and assert the current behavior either truncates silently (documenting the bug) or — once fixed — throws a clear, actionable error identifying the offending chunk, OR (preferred, less disruptive to ingestion) succeeds by using the provider's real max-length with explicit truncation set intentionally, WITH a corresponding reduction in `CHUNK_SIZE` so this scenario becomes rare rather than routine. Pick the "fail loud on overflow" design if the assessment's own recommendation ("fail loud on overflow instead of silently degrading") is to be honored — write the test to assert a thrown/logged warning when a chunk still exceeds 512 tokens after the config fix, treating that as a defense-in-depth backstop rather than the primary fix.

- [ ] **Step 3: Confirm RED**, then implement:
  - Change `CHUNK_SIZE`'s effective default to be provider-aware: when `EMBEDDING_PROVIDER=local`, the config loader should cap `chunkSize` at 512 (log a warning if the user explicitly configured something higher), rather than leaving the global 800 default in place for this provider.
  - In `embedBatch`, pass an explicit truncation configuration to the tokenizer/pipeline call (per whatever `@xenova/transformers`'s actual API supports — confirmed via Step 1, not assumed) so any chunk that still exceeds 512 tokens either truncates predictably with a logged warning naming the chunk, rather than doing so silently with no signal at all.

- [ ] **Step 4: Confirm GREEN**

  ```bash
  pnpm --filter @rag/rag test -- local
  pnpm --filter @rag/core test -- config
  ```

- [ ] **Step 5: Run the full affected suite**

  ```bash
  pnpm --filter @rag/rag test
  pnpm --filter @rag/core test
  ```

- [ ] **Step 6: Update `env.example`'s documentation** near `CHUNK_SIZE`/`EMBEDDING_PROVIDER=local` noting the 512-token effective cap and why.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/core/src/config.ts packages/rag/src/embeddings/local.ts packages/rag/src/embeddings/local.test.ts packages/core/src/config.test.ts env.example
  git commit -m "fix: stop silently truncating chunks past the local embedder's 512-token limit

  Xenova/bge-base-en-v1.5 (the ONLY embedding provider allowed under
  COMPLIANCE_MODE=client-data) has a 512-token hard limit, but the
  default chunk size (800) and embedBatch's lack of explicit truncation
  control meant every full-size chunk's dense vector silently reflected
  only its first ~65% -- a systematic, invisible retrieval-quality
  degradation on exactly the path a CPA firm handling taxpayer data is
  required to use."
  ```

---

## Task 8: Swap the eval harness to the local embedder for a real baseline

**Files:**

- Modify: `tests/e2e/src/eval/run-eval.ts` (line ~109)
- Create: `docs/EVAL-BASELINE.md`

**Interfaces:** consumes `LocalEmbeddingProvider` (`packages/rag/src/embeddings/local.ts`) as a drop-in replacement for `FakeEmbedder` in the harness — requires no API key, no egress, no cost/quota risk (confirmed by the RAG-architecture review this assessment is based on).

**Anti-pattern guard:** this task does NOT include writing 30-50 real CPA-domain questions — that requires Doug's domain expertise and is a manual-runbook item (`docs/PILOT-MANUAL-RUNBOOK.md`). This task only proves the harness CAN run against a real embedder and records what the EXISTING 14-doc/17-question synthetic corpus shows under it — clearly labeled as still-synthetic, not a real quality baseline.

- [ ] **Step 1: Read `run-eval.ts` in full** to confirm exactly how `FakeEmbedder` is currently constructed/injected (line ~109 per prior research) and what the harness's embedder-provider interface expects.

- [ ] **Step 2: Swap in `LocalEmbeddingProvider`**, gated by an env var or CLI flag (e.g. `EVAL_EMBEDDER=local pnpm eval`) so the FakeEmbedder path remains available as a fast smoke test — don't remove it, add the real option alongside it.

- [ ] **Step 3: Run the harness against the local embedder for the first time**

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 EVAL_EMBEDDER=local pnpm --filter @rag/e2e run eval
  ```

  Expect a first-run delay while the ONNX model downloads (~430 MB, per this repo's own documentation); subsequent runs use the disk cache.

- [ ] **Step 4: Record the results in a new `docs/EVAL-BASELINE.md`**, explicitly labeled: "Run against the LOCAL embedding provider (real semantic embeddings, not FakeEmbedder) but STILL against the existing 14-document/17-question synthetic corpus (Postgres/Docker/espresso/sailing/gardening) — this proves the harness works end-to-end with a real embedder and gives a real (if not yet domain-relevant) recall/nDCG/MRR number. It is NOT yet a CPA-domain quality baseline — that requires the real question set tracked in `docs/PILOT-MANUAL-RUNBOOK.md`." Include the actual numbers produced, and the weight-sweep table (confirm whether it's now meaningfully varied across dense/sparse blends, unlike the previous flat FakeEmbedder sweep — report whatever it actually shows, do not assume).

- [ ] **Step 5: Update the two files that reference a nonexistent `EVAL-BASELINE.md`** (`docs/DEPLOYMENT.md`, `docs/ISSUES-AND-OPTIMIZATIONS.md`) to point at the real, now-existing file.

- [ ] **Step 6: Commit**

  ```bash
  git add tests/e2e/src/eval/run-eval.ts docs/EVAL-BASELINE.md docs/DEPLOYMENT.md docs/ISSUES-AND-OPTIMIZATIONS.md
  git commit -m "feat: run the retrieval-eval harness against a real embedder

  Swapped LocalEmbeddingProvider in alongside the existing FakeEmbedder
  path (zero cost/egress, no API key needed) and recorded the first
  real-embedder baseline in docs/EVAL-BASELINE.md. Still against the
  synthetic corpus -- a real CPA-domain question set is a manual-runbook
  item requiring Doug's input, not something to fabricate here."
  ```

---

## Task 9: Add a direct per-source access-grant primitive for the admin UI

**Files:**

- Create: `packages/db/drizzle/0012_staff_source_assignments.sql` (confirm this is still the next number before creating it)
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts`, `packages/db/src/queries.ts`
- Create: `packages/db/src/queries.source-access.test.ts` (or extend the existing access-control test file — check current naming first)
- Modify: `apps/web/src/app/admin/access/actions.ts`, `apps/web/src/app/admin/access/access-forms.tsx`, `apps/web/src/app/admin/access/page.tsx`
- Modify: `tests/e2e/src/specs/access-grants.spec.ts`

**Interfaces:** consumes the existing `staffClientAssignments` table's exact shape (`packages/db/src/schema.ts:441-467`) as the pattern to mirror; `resolveSourceIdsForUser` (`queries.ts:840-852`) as the function to extend.

**Design decision this task makes explicit:** a new `staff_source_assignments` table (option b from Phase 0 research), NOT a nullable-`clientId` sentinel on the existing table (option a) — the sentinel approach was found to require a special-cased NULL-matching join branch that would incorrectly grant every "direct" user access to every "direct" source, not a specific per-user-per-source pairing.

- [ ] **Step 1: Confirm the actual current highest migration number** before writing the file (per Global Constraints, this task is pre-assigned `0012`/`idx: 11` — re-confirm this is still accurate immediately before starting, since Tasks 13/14 must not have raced ahead of this one).

  ```bash
  ls packages/db/drizzle/*.sql | sort -V | tail -3
  ```

- [ ] **Step 2: Write the migration**

  Use `uuid_generate_v4()` (this repo's standard convention, per Global Constraints), NOT `gen_random_uuid()` — the latter would drift from the Drizzle schema default Step 4 mirrors. Add a standalone index on `source_id` (not just the composite unique index) — this table has `ON DELETE CASCADE` from `sources`, and without a `source_id`-leading index, every source deletion forces a sequential scan to find referencing rows, exactly the reason `source_client_assignments` already carries its own standalone `source_id` index (`src_client_source_idx`):

  ```sql
  -- packages/db/drizzle/0012_staff_source_assignments.sql
  CREATE TABLE staff_source_assignments (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id text NOT NULL,
    source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT now(),
    granted_by text NOT NULL,
    revoked_at timestamptz
  );

  CREATE UNIQUE INDEX ssa_user_source_unique
    ON staff_source_assignments (user_id, source_id);

  CREATE INDEX ssa_source_idx
    ON staff_source_assignments (source_id);
  ```

- [ ] **Step 3: Append the journal entry** — `idx: 11`, tag `0012_staff_source_assignments`, `when` strictly greater than the current max (per Global Constraints' pre-assigned ordering, this task's `when` must be the smallest of the three new entries Tasks 9/13/14 will add, since it runs first).

- [ ] **Step 4: Add the Drizzle schema definition** in `schema.ts` immediately after `sourceClientAssignments` (~line 488), mirroring `staffClientAssignments`'s column shape with `.default(sql\`uuid_generate_v4()\`)`(matching Step 2's migration exactly, not`gen_random_uuid()`), plus the additional `source_id`index from Step 2 (a deliberate deviation from strictly mirroring`staffClientAssignments`, justified by the FK-cascade performance concern).

- [ ] **Step 5: Write the failing tests for the new query functions — including the cross-user isolation case, not just the positive union case**

  Following the exact style of the existing `grantClientAccess`/`revokeClientAccess` tests, write tests for new `grantSourceAccess`/`revokeSourceAccess`/`listSourceAssignmentHistoryForStaff` functions (copy-pasted in spirit from `queries.ts:854-930`'s existing client-scoped equivalents). For `resolveSourceIdsForUser`'s UNION change, write BOTH:

  1. The positive case: a user with a direct source grant sees that source in the result.
  2. **The negative/isolation case — this is the one that catches a `UNION`-scoping bug that would otherwise be a cross-tenant confidentiality break**: user A has a direct grant to source X; user B has no grants at all. Assert `resolveSourceIdsForUser(B)` does NOT contain X. Also assert a user with only a client-routed grant does not pick up another user's unrelated direct grant. A bug where `user_id = $1` is dropped or mis-bound in the new subquery would make the positive test pass while silently granting every user access to every directly-granted source — only the negative test catches that.

- [ ] **Step 6: Confirm RED**, then implement the three new query functions and the `resolveSourceIdsForUser` UNION change. Use `UNION` (not `UNION ALL`) so cross-branch duplicates are removed automatically; the existing inner `DISTINCT` in the client-routed branch becomes redundant once wrapped in a `UNION` and may be dropped.

  ```sql
  -- resolveSourceIdsForUser, conceptually:
  SELECT source_id FROM (
    SELECT sca.source_id FROM staff_client_assignments sta
      JOIN source_client_assignments sca ON sca.client_id = sta.client_id
      WHERE sta.user_id = $1 AND sta.revoked_at IS NULL
    UNION
    SELECT source_id FROM staff_source_assignments
      WHERE user_id = $1 AND revoked_at IS NULL
  ) combined
  ```

- [ ] **Step 7: Confirm GREEN, including the isolation test**

  ```bash
  pnpm --filter @rag/db test
  ```

- [ ] **Step 8: Add the admin UI form**, following `GrantAccessForm`'s exact pattern (`access-forms.tsx`) — a `"use client"` component with an email input and a source-id input/select, manually-managed `isSubmitting` state (not `useTransition`, per this codebase's already-documented React 18.3.1 constraint), calling a new `"use server"` action in `actions.ts` that re-checks `requireAdmin()` and calls `grantSourceAccess`/`revokeSourceAccess`.

- [ ] **Step 9: Extend the e2e coverage**

  Add a case to `tests/e2e/src/specs/access-grants.spec.ts` proving a direct source grant makes that source appear in `resolveSourceIdsForUser`'s result without any client being involved at all.

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- access-grants
  ```

- [ ] **Step 10: Commit**

  ```bash
  git add packages/db/drizzle/0012_staff_source_assignments.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts packages/db/src/queries.ts packages/db/src/queries.source-access.test.ts apps/web/src/app/admin/access/actions.ts apps/web/src/app/admin/access/access-forms.tsx apps/web/src/app/admin/access/page.tsx tests/e2e/src/specs/access-grants.spec.ts
  git commit -m "feat: add direct per-source access grants alongside the existing per-client model

  The existing staff_client_assignments/source_client_assignments model
  is correctly built for the Class C/D per-engagement problem, but has
  no way to grant a staff member access to a firm-internal index
  (firm-sop/firm-research) without inventing a synthetic client row.
  Added a new staff_source_assignments table (not a nullable-clientId
  sentinel on the existing table, which would incorrectly cross-grant
  every direct user to every direct source) and unioned it into
  resolveSourceIdsForUser."
  ```

---

## Task 10: Fix the citation-filter gap on grouped/ranged citations

**Files:**

- Modify: `packages/rag/src/generation/generator.ts` (~lines 89-98)
- Modify: `packages/rag/src/generation/generator.test.ts`

**Interfaces:** consumes `filterCitationsToAnswer`'s existing signature (`(answer: string, citations) => citations`), unchanged.

- [ ] **Step 1: Write the failing tests**

  Add a new `describe("filterCitationsToAnswer", ...)` block to `generator.test.ts` (which currently only tests `buildPrompt`), using plain citation-array fixtures (not the `rr()` `RetrievalResult` helper, which is `buildPrompt`-specific):

  ```typescript
  describe("filterCitationsToAnswer", () => {
    const citations = [
      {
        index: 1,
        documentId: "d1",
        title: "A",
        downloadable: false,
        chunkId: "c1",
        score: 0.9,
      },
      {
        index: 2,
        documentId: "d2",
        title: "B",
        downloadable: false,
        chunkId: "c2",
        score: 0.8,
      },
      {
        index: 3,
        documentId: "d3",
        title: "C",
        downloadable: false,
        chunkId: "c3",
        score: 0.7,
      },
    ];

    it("keeps citations referenced individually", () => {
      expect(
        filterCitationsToAnswer("see [1] and [2]", citations),
      ).toHaveLength(2);
    });
    it("keeps citations referenced as a comma group", () => {
      expect(
        filterCitationsToAnswer("see [1,2]", citations).map((c) => c.index),
      ).toEqual([1, 2]);
    });
    it("keeps citations referenced with internal spacing", () => {
      expect(
        filterCitationsToAnswer("see [1, 2]", citations).map((c) => c.index),
      ).toEqual([1, 2]);
    });
    it("keeps citations referenced as a range", () => {
      expect(
        filterCitationsToAnswer("see [1-3]", citations).map((c) => c.index),
      ).toEqual([1, 2, 3]);
    });
    it("still drops citations never referenced at all", () => {
      expect(
        filterCitationsToAnswer("no citations here", citations),
      ).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 2: Confirm RED** for the comma-group/spacing/range cases (the individual-citation and zero-citation cases already pass).

  ```bash
  pnpm --filter @rag/rag test -- generator
  ```

- [ ] **Step 3: Implement the fix**

  ```typescript
  export function filterCitationsToAnswer(
    answer: string,
    citations: GenerationResult["citations"],
  ): GenerationResult["citations"] {
    const referenced = new Set<number>();
    for (const match of answer.matchAll(/\[(\d+(?:\s*[-,]\s*\d+)*)\]/g)) {
      for (const part of match[1]!.split(",")) {
        const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
          const [lo, hi] = [Number(range[1]), Number(range[2])];
          for (let n = Math.min(lo, hi); n <= Math.max(lo, hi); n++) {
            referenced.add(n);
          }
        } else {
          const n = Number(part.trim());
          if (Number.isInteger(n)) referenced.add(n);
        }
      }
    }
    return citations.filter((c) => referenced.has(c.index));
  }
  ```

- [ ] **Step 4: Confirm GREEN**

  ```bash
  pnpm --filter @rag/rag test -- generator
  ```

- [ ] **Step 5: Run the full affected suite** (this function's behavior change could affect anything asserting on citation counts — check `packages/services/src/ask.test.ts`, `apps/api/src/routes/audit-log.test.ts`, `tests/e2e/src/specs/api.spec.ts` for anything relying on the old single-bracket-only behavior).

  ```bash
  pnpm --filter @rag/rag test
  pnpm --filter @rag/services test
  pnpm --filter @rag/api test
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- api.spec
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add packages/rag/src/generation/generator.ts packages/rag/src/generation/generator.test.ts
  git commit -m "fix: handle grouped and ranged citation markers ([1,2], [1-3])

  filterCitationsToAnswer previously matched only single-number
  brackets ([N]) -- a common LLM output style like [1,2] or [1-3]
  matched nothing, silently dropping the entire citation set for that
  answer. For a system whose citations are the compliance audit trail,
  a silently-uncited answer is a worse failure mode than a slightly-off
  one."
  ```

---

## Task 11: Surface document recency in citations

**Files:**

- Modify: `packages/db/src/queries.ts` (hybridSearch's SELECT and result mapping, ~lines 536-587)
- Modify: `packages/core/src/types.ts` (`RetrievalResult.document`, ~lines 240-249)
- Modify: `packages/core/src/interfaces.ts` (`GenerationResult["citations"]`, ~lines 63-75)
- Modify: `packages/rag/src/generation/generator.ts` (`buildCitations`, ~lines 101-113; `SYSTEM_PROMPT`, ~lines 14-32)
- Modify: relevant test files for each of the above

**Interfaces:** consumes `documents.sourceModifiedAt` (`packages/db/src/schema.ts:121` — already populated unconditionally at ingest, `packages/ingestion/src/pipeline.ts:281`), the most reliable existing recency signal (more reliable than the optional connector/parser-populated `metadata.modifiedAt`).

**Anti-pattern guard:** this task surfaces EXISTING, already-populated recency data that's currently computed but discarded before reaching the citation — it does NOT implement same-document version detection/clustering, which is a materially larger, out-of-scope feature.

- [ ] **Step 1: Write the failing test proving the field is missing today**

  In whatever test currently exercises `hybridSearch`'s result shape (check `packages/db/src/queries.identity-scope.test.ts` or the e2e retrieval specs), add an assertion that a returned `RetrievalResult.document` includes `sourceModifiedAt`.

- [ ] **Step 2: Confirm RED**

- [ ] **Step 3: Add `source_modified_at` to `hybridSearch`'s SELECT** (~line 550) and map it into the returned `document` object (~lines 579-587) as `sourceModifiedAt: r.source_modified_at ?? undefined`.

- [ ] **Step 4: Add the optional field to `RetrievalResult.document`** in `packages/core/src/types.ts` (~lines 240-249): `sourceModifiedAt?: string`.

- [ ] **Step 5: Confirm GREEN for Step 1's test**

  ```bash
  pnpm --filter @rag/db test
  ```

- [ ] **Step 6: Write the failing test for citation propagation**

  In `generator.test.ts`, assert `buildCitations` includes a `modifiedAt` field sourced from `r.document.sourceModifiedAt` when present.

- [ ] **Step 7: Confirm RED**, then add `modifiedAt?: string` to `GenerationResult["citations"]` (`packages/core/src/interfaces.ts:63-75`) and populate it in `buildCitations` (`generator.ts:101-113`).

- [ ] **Step 8: Confirm GREEN**

  ```bash
  pnpm --filter @rag/rag test -- generator
  ```

- [ ] **Step 9: Add the system-prompt instruction**

  Append to `SYSTEM_PROMPT` (`generator.ts:14-32`) as a new numbered rule: _"Citations include each document's last-modified date. If two or more cited documents cover the same topic with materially different dates, note that a newer document may supersede an older one and prefer the more recent document's information when they conflict."_

- [ ] **Step 10: Run the full affected suite** (this is an additive/optional field, should not break anything, but confirm):

  ```bash
  pnpm --filter @rag/core test
  pnpm --filter @rag/db test
  pnpm --filter @rag/rag test
  pnpm --filter @rag/services test
  pnpm --filter @rag/api test
  ```

- [ ] **Step 11: Commit**

  ```bash
  git add packages/db/src/queries.ts packages/core/src/types.ts packages/core/src/interfaces.ts packages/rag/src/generation/generator.ts <test files>
  git commit -m "feat: surface document last-modified date in citations

  documents.sourceModifiedAt was already populated unconditionally at
  ingest but discarded before reaching hybridSearch's results or the
  generated citations. Surfacing it (plus a system-prompt instruction
  to flag same-topic date conflicts) is a cheap, purely-additive
  mitigation for the stale-SOP-co-retrieval gap -- NOT same-document
  version detection, which remains out of scope."
  ```

---

## Task 12: Fix table-butchering for inline Word/PDF tables

**Files:**

- Modify: `packages/rag/src/chunking/markdown-chunker.ts`
- Modify: `packages/rag/src/chunking/markdown-chunker.test.ts`

**Interfaces:** consumes the existing `chunkSection`/`splitParagraphs`/`hardSplit` functions (~lines 55-219); does NOT depend on or modify `TableChunker` (Phase 0 research found direct reuse would require an adapter layer with more moving parts than a small dedicated in-file splitter).

- [ ] **Step 1: Write the failing test**

  Construct a markdown input containing an inline pipe-table large enough to exceed `chunkSize`, and assert the resulting chunks preserve whole rows (no row's cells split across two chunks) and repeat the header line in each table chunk, mirroring `TableChunker`'s existing header-repetition convention for consistency.

- [ ] **Step 2: Confirm RED** (current behavior slices at a raw character offset, verifiable by asserting a specific row stays intact and currently doesn't).

- [ ] **Step 3: Add table detection**

  A unit (from `splitParagraphs`) is a markdown table if its lines match a header line `/^\s*\|.*\|\s*$/` followed by a separator line `/^\s*\|?[\s:|-]+\|?\s*$/` containing at least one `-`.

- [ ] **Step 4: Add a row-aware splitter**, activated in `chunkSection` (~line 87) when the oversized unit is a detected table, instead of routing to `hardSplit`: repeat the header + separator lines as a prefix in every resulting chunk, and group whole `|`-delimited row lines up to `chunkSize`, never splitting a single row's line.

- [ ] **Step 5: Confirm GREEN**

  ```bash
  pnpm --filter @rag/rag test -- markdown-chunker
  ```

- [ ] **Step 6: Run the full chunking suite** (confirm `composite-chunker.test.ts` and any spreadsheet-adjacent tests still pass — this change only affects the markdown path's table-shaped paragraphs, not the dedicated spreadsheet `TableChunker` path).

  ```bash
  pnpm --filter @rag/rag test
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add packages/rag/src/chunking/markdown-chunker.ts packages/rag/src/chunking/markdown-chunker.test.ts
  git commit -m "fix: preserve table rows when an inline markdown table exceeds chunk size

  A table embedded inline in a .docx/.pdf SOP (as opposed to a
  spreadsheet, which already routes through the row-aware
  TableChunker) previously fell through to a sentence-boundary
  splitter with no table awareness, and an oversized table ultimately
  got cut at a raw character offset -- capable of slicing a fee
  schedule or depreciation table mid-row, stranding dollar figures
  from their labels."
  ```

---

## Task 13: Persist docs-gap-digest aggregates as a queryable admin-visible record (Tier 1 only)

**Files:**

- Create: `packages/db/drizzle/0013_docs_gap_digest_runs.sql` (pre-assigned per Global Constraints — re-confirm this is still the accurate next number immediately before starting; this task runs AFTER Task 9 in the mandatory sequencing order)
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts`, `packages/db/src/queries.ts`
- Modify: `apps/worker/src/handlers/docs-gap-digest.ts`, `apps/worker/src/handlers/docs-gap-digest.test.ts`
- Create: `apps/web/src/app/admin/docs-gap-digest/page.tsx`

**Interfaces:** consumes the existing, already-computed `DocsGapDigestSummary` shape from `aggregateWeakResultEvents` (`docs-gap-digest.ts:22-28,63-94`) — this task persists that exact aggregate, unchanged, rather than introducing any new data collection.

**Anti-pattern guard — read this before starting:** this task is explicitly Tier 1 only. Do NOT retain raw question text, a paraphrase of it, or any other reversible derivative anywhere in this task — the aggregate already deliberately excludes `questionHash` (`docs-gap-digest.ts:33-36,103-106`), and this task must preserve that. The "top question was X" feature the partner-facing proposal describes requires retaining question content in some form — that is a policy decision, tracked as a decision gate in `docs/PILOT-MANUAL-RUNBOOK.md`, and is explicitly OUT OF SCOPE here. If you find yourself adding any field that could reconstruct what was asked, stop and re-read this guard.

- [ ] **Step 1: Confirm Task 9 has already merged and the actual current highest migration number is `0012`.** Per Global Constraints, this task must run strictly after Task 9, never in parallel with it.

  ```bash
  ls packages/db/drizzle/*.sql | sort -V | tail -3
  ```

- [ ] **Step 2: Write the migration**

  Use `uuid_generate_v4()` (this repo's standard convention, per Global Constraints), NOT `gen_random_uuid()`. Give the `jsonb` columns an explicit default so a run computing zero groups still inserts cleanly:

  ```sql
  -- packages/db/drizzle/0013_docs_gap_digest_runs.sql
  CREATE TABLE docs_gap_digest_runs (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_at timestamptz NOT NULL DEFAULT now(),
    window_since timestamptz NOT NULL,
    window_until timestamptz NOT NULL,
    total_weak_events integer NOT NULL,
    by_endpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
    by_source_group jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  ```

  No GIN index is needed on the `jsonb` columns — unlike `documents.metadata`, these are small, display-only aggregates never filtered by their inner keys, only read whole and rendered in the Step 8 admin page.

- [ ] **Step 3: Append the journal entry** — `idx: 12`, tag `0013_docs_gap_digest_runs`, `when` strictly greater than Task 9's entry (and every other existing entry).

- [ ] **Step 4: Add the Drizzle schema definition** in `schema.ts`.

- [ ] **Step 5: Write the failing test**

  Extend `docs-gap-digest.test.ts` to assert `handleDocsGapDigest` now inserts a row into `docs_gap_digest_runs` matching the aggregate it computes, IN ADDITION TO the existing log line (do not remove the log line — keep both).

- [ ] **Step 6: Confirm RED**, then implement: add a `insertDocsGapDigestRun` query function in `queries.ts`, call it from `handleDocsGapDigest` alongside the existing `log.info` call.

- [ ] **Step 7: Confirm GREEN**

  ```bash
  pnpm --filter @rag/worker test -- docs-gap-digest
  pnpm --filter @rag/db test
  ```

- [ ] **Step 8: Add the admin UI page**

  Create `apps/web/src/app/admin/docs-gap-digest/page.tsx`, following `apps/web/src/app/admin/access/page.tsx`'s exact self-contained pattern (its own `auth()`/`isAdmin()` guard, no shared admin layout exists yet — note this in a code comment as a known gap, don't invent a shared layout as part of this task). List recent `docs_gap_digest_runs` rows in a simple table: run date, total weak events, breakdown by endpoint, breakdown by source group. No question text anywhere on this page.

- [ ] **Step 9: Run the e2e digest spec**

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- docs-gap-digest
  ```

- [ ] **Step 10: Commit**

  ```bash
  git add packages/db/drizzle/0013_docs_gap_digest_runs.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts packages/db/src/queries.ts apps/worker/src/handlers/docs-gap-digest.ts apps/worker/src/handlers/docs-gap-digest.test.ts apps/web/src/app/admin/docs-gap-digest/page.tsx
  git commit -m "feat: persist docs-gap-digest aggregates so Doug/Chris can actually see them

  Previously the weekly digest job produced exactly one structured log
  line with no queryable record and no UI -- not the Friday
  Teams-message deliverable described to the partner. This adds a
  queryable table and a simple admin page showing the SAME aggregate
  already computed today (counts by endpoint/source-group), with no
  new privacy surface -- it deliberately does not retain question text.
  Actual push delivery (Teams/email) and a 'top question was X' feature
  both require decisions tracked in docs/PILOT-MANUAL-RUNBOOK.md, not
  resolved here."
  ```

---

## Task 14: Build a vendor-agnostic audit-log shipping mechanism

**Files:**

- Create: `packages/core/src/interfaces.ts` addition (`AuditLogSink` interface)
- Create: `packages/rag/src/audit-sink/http-webhook.ts`, `packages/rag/src/audit-sink/factory.ts`, corresponding test files
- Modify: `packages/core/src/config.ts` (new `auditSink` config block)
- Modify: `packages/runtime/src/index.ts` (wire the factory)
- Create: `packages/db/drizzle/0014_audit_log_shipper_state.sql` (pre-assigned per Global Constraints — this task runs strictly after Tasks 9 and 13; re-confirm the next number is still `0014` immediately before starting)
- Modify: `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.ts`
- Create: `apps/worker/src/handlers/ship-audit-log.ts` (new scheduled job, mirroring `docs-gap-digest.ts`'s pattern)
- Modify: `packages/ingestion/src/queue.ts` (register the new scheduled job)
- Modify: `env.example`

**Interfaces:** consumes the established provider-factory pattern (`createEmbeddingProvider`/`createObjectStore` in `packages/rag/src/embeddings/factory.ts`/`storage/factory.ts` as the exact shape to copy), the existing `EgressPolicy` (`packages/core/src/egress-policy.ts`, already threaded into `CoreDeps` via `buildCoreDeps`, `packages/runtime/src/index.ts`) as the mandatory gate this task's own outbound call must go through, and a NEW dedicated single-row watermark table (decided explicitly below, not left as an implementation-time choice).

**Design decisions this task makes explicit — both are load-bearing, do not silently deviate:**

1. **Scheduled/cursor-based shipping**, NOT write-time shipping hooked into `logAskEvent` — write-time coupling would add network I/O and an external vendor's availability/latency risk to the hot request path, which `logAskEvent`'s own design explicitly avoids today.
2. **The webhook destination MUST be checked against `EgressPolicy`/`EGRESS_ALLOWED_HOSTS` before every POST, exactly like every LLM/embedding call already is.** This is not optional hardening — without it, this task would introduce the only outbound network path in the entire system that ships real, identity-linked data (`principalSubject`, a real AAD object id, plus `sourceIds`/`docIds`/`questionHash`) to an arbitrary external URL with zero egress control, directly undermining the exact compliance boundary (`COMPLIANCE_MODE=client-data`, `EGRESS_ALLOWED_HOSTS`) the rest of this codebase is built around. The reference pattern this task is modeled on (`HttpCrossEncoderReranker`, `packages/rag/src/retrieval/reranker.ts:35`) does NOT do this egress check itself — copy its `fetch()` shape, but do NOT copy its missing egress gate; that's a pre-existing gap in the reranker, not a pattern to replicate here where the payload is far more sensitive (chunk text vs. per-user identity).

**Watermark storage decision:** a new single-row table `audit_log_shipper_state (id boolean PRIMARY KEY DEFAULT true, last_shipped_at timestamptz)`, following the `sources.cursor` precedent's spirit but as its own dedicated table rather than overloading an unrelated column — this keeps the shipping watermark's lifecycle independent of any single source's sync state. Do not defer this decision to implementation time.

- [ ] **Step 1: Add the `AuditLogSink` interface** to `packages/core/src/interfaces.ts`, following `ObjectStore`'s minimalism: `interface AuditLogSink { ship(rows: AuditLog[]): Promise<void>; }`.

- [ ] **Step 2: Write the failing tests for the webhook implementation — including the egress-gate rejection case**

  In a new `packages/rag/src/audit-sink/http-webhook.test.ts`, assert:
  1. `HttpWebhookAuditLogSink.ship(rows)` POSTs the rows as JSON to the configured URL with the configured auth header, mirroring `HttpCrossEncoderReranker`'s existing `fetch(endpoint, {method:"POST", headers, body: JSON.stringify(...)})` shape (`packages/rag/src/retrieval/reranker.ts:14-38`) as the reference pattern for the HTTP mechanics only.
  2. **`ship()` calls `EgressPolicy.assertAllowed(webhookUrl)` before ever calling `fetch`, and throws (never silently swallows) if the configured URL is not on `EGRESS_ALLOWED_HOSTS`** — construct the sink with a policy that rejects the test URL and assert `fetch` was never called.

- [ ] **Step 3: Confirm RED**, then implement `HttpWebhookAuditLogSink` in `packages/rag/src/audit-sink/http-webhook.ts`, accepting an `EgressPolicy` instance in its constructor (mirroring how the embedding providers accept one, `packages/rag/src/embeddings/gemini.ts`) and calling `assertAllowed` on the configured URL before every `ship()` call's `fetch`.

- [ ] **Step 4: Confirm GREEN**

  ```bash
  pnpm --filter @rag/rag test -- audit-sink
  ```

- [ ] **Step 5: Add the factory**, `createAuditLogSink(cfg)` in `packages/rag/src/audit-sink/factory.ts`, switching on a new `AUDIT_SINK_PROVIDER` config enum (`"none" | "webhook"`, default `"none"`), following `createObjectStore`'s exact `"none"` → `null` convention.

- [ ] **Step 6: Add the config block** in `packages/core/src/config.ts` (`auditSink: { provider, webhookUrl?, webhookToken? }`) and document `AUDIT_SINK_PROVIDER`/`AUDIT_SINK_WEBHOOK_URL`/`AUDIT_SINK_WEBHOOK_TOKEN` in `env.example`, following the `OBJECT_STORE_*` block's exact documentation style.

- [ ] **Step 7: Wire it once in `packages/runtime/src/index.ts`**, alongside the existing `createEmbeddingProvider`/`createObjectStore` calls, adding `auditLogSink` to `CoreDeps` and passing the already-constructed shared `EgressPolicy` instance into `createAuditLogSink` so the sink is built with real egress enforcement from the start, not constructed separately without it.

- [ ] **Step 8: Add the migration and the scheduled shipping job**

  First, write the migration decided in this task's header (`0014_audit_log_shipper_state.sql`, single-row watermark table) and its Drizzle schema definition, following Task 9/13's exact conventions (`uuid_generate_v4()` if a uuid PK is used, or the boolean-sentinel single-row pattern shown in this task's header — pick the single-row pattern, it's simpler for a table that only ever has one row).

  Then create `apps/worker/src/handlers/ship-audit-log.ts`, mirroring `docs-gap-digest.ts`'s job structure: read the current `last_shipped_at` watermark from `audit_log_shipper_state`, query `audit_log` rows created since that watermark, call `deps.auditLogSink?.ship(rows)` if a sink is configured (no-op if `provider: "none"`), advance the watermark only on success (never on a thrown egress-rejection or network error — a failed ship must be retried on the next tick, not silently marked complete).

- [ ] **Step 9: Register the new recurring job** in `packages/ingestion/src/queue.ts`, following `docs-gap-digest`'s exact registration pattern (new `JOB_NAMES` entry, `boss.schedule()` call, config-driven cron).

- [ ] **Step 10: Write the failing e2e test**

  Following `docs-gap-digest.spec.ts`'s pattern (including its "first use of `boss.schedule()`" spike-test precedent), write an e2e test proving the new job is registered with the configured cron/tz, and (using a fake/mock `AuditLogSink` injected into deps) that it actually calls `ship()` with the expected rows and advances its watermark.

- [ ] **Step 11: Confirm GREEN**

  ```bash
  pnpm docker:up
  E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- ship-audit-log
  ```

- [ ] **Step 12: Commit**

  ```bash
  git add packages/core/src/interfaces.ts packages/rag/src/audit-sink/ packages/core/src/config.ts packages/runtime/src/index.ts packages/db/drizzle/0014_audit_log_shipper_state.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts apps/worker/src/handlers/ship-audit-log.ts packages/ingestion/src/queue.ts env.example <test files>
  git commit -m "feat: add vendor-agnostic off-host audit-log shipping

  A generic HTTPS-webhook AuditLogSink (works identically with
  Datadog/Splunk/Papertrail/any generic collector -- it's just 'POST
  this JSON here') following the same provider-factory pattern already
  used for embeddings/object-storage, wired as a new scheduled
  cursor-based job (not write-time, to avoid coupling the hot request
  path to an external vendor's availability). Gated by EgressPolicy
  before every POST, since this ships real per-user identity
  (principalSubject) to an external URL -- the same compliance control
  that already governs LLM egress, applied here for the first time to
  audit-log shipping. Defaults to 'none' -- which specific vendor/
  destination to actually point this at is a decision tracked in
  docs/PILOT-MANUAL-RUNBOOK.md, not made here."
  ```

---

## Task 15: Add security headers to the web app

**Files:**

- Modify: `apps/web/next.config.ts`
- Create or modify: an e2e/integration test asserting the headers are present (check `apps/web/src/middleware.test.ts` for the right place to add this, since it already tests real request/response behavior)

**Interfaces:** consumes Next.js's `headers()` config function (confirm exact current signature/usage against the installed Next.js version's actual type definitions before writing — do not assume the API shape).

- [ ] **Step 1: Read `apps/web/next.config.ts`** in full to confirm its current exact structure before adding to it.

- [ ] **Step 2: Write the failing test — NOT in `middleware.test.ts`**

  **Confirmed by a 2026-07-11 pre-launch audit: `middleware.test.ts` cannot test this, full stop.** It invokes the exported `middleware` function directly against hand-built `NextRequest` objects with no server boot (its own header comment says so explicitly). `next.config.ts`'s `headers()` is applied by the actual Next.js server/build layer, which that test never touches. Use a real `next start`-backed check instead (an e2e/Playwright-level test hitting a booted server, or `apps/web`'s existing e2e test pattern if one already boots the app for other checks — check `tests/e2e/` for a precedent before inventing a new harness). Assert a response includes `X-Frame-Options: DENY`, a `Content-Security-Policy` containing `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, and `form-action 'self'`, `Strict-Transport-Security`, and `X-Content-Type-Options: nosniff`.

- [ ] **Step 3: Confirm RED**, then add the `headers()` function to `next.config.ts`. Include `object-src`/`base-uri`/`form-action` alongside `frame-ancestors` — these are near-zero-risk additions that block plugin content, `<base>`-tag hijacking, and cross-origin form submission, meaningfully raising the floor beyond clickjacking-only protection at negligible cost to a normal Next.js app:

  ```typescript
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  ```

  **Scope note — read before writing the commit message:** this CSP does NOT restrict `script-src`/`style-src`, so it provides clickjacking + transport-hardening protection, not general XSS defense-in-depth. A real script-injection-resistant CSP on Next.js App Router requires a per-request nonce generated in middleware (Next injects inline scripts, so a static `script-src` without `'unsafe-inline'` would break the app, and `'unsafe-inline'` defeats the purpose) — that is a materially larger change, explicitly out of scope for this task. Do not claim script-XSS protection in the commit message; claim only what this specific header set actually delivers.

  Adjust the CSP if this breaks anything the app actually needs (e.g. inline styles) — check by running the app and exercising the chat UI after this change (Step 5).

- [ ] **Step 4: Confirm GREEN**

  ```bash
  pnpm --filter @rag/web test
  ```

- [ ] **Step 5: Manually verify the running app still works** — start the dev server, load the chat UI, confirm no CSP violations appear in the browser console for legitimate app functionality.

  ```bash
  pnpm dev:web
  ```

- [ ] **Step 6: Run the full build to confirm no regression**

  ```bash
  pnpm --filter @rag/web build
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add apps/web/next.config.ts apps/web/src/middleware.test.ts
  git commit -m "fix: add security headers to the web app (CSP, X-Frame-Options, HSTS)

  The authenticated chat UI (rendering taxpayer-confidential retrieved
  content) had no clickjacking protection and no CSP directives at all.
  This adds X-Frame-Options, HSTS, nosniff, and a CSP covering
  frame-ancestors/object-src/base-uri/form-action -- clickjacking and
  transport hardening. It does NOT add script-src/style-src
  restrictions (would require per-request nonce generation in
  middleware, a materially larger change) -- this is not general
  script-XSS defense-in-depth, only the specific protections listed
  above."
  ```

---

## Task 16: Close the highest-risk test-coverage gaps

**Files:**

- Create: `packages/connectors/src/gdrive/index.test.ts`, `packages/connectors/src/gmail/index.test.ts`, `packages/connectors/src/outlook/index.test.ts`
- Create: `apps/api/src/routes/documents.test.ts`
- Create: `packages/runtime/src/index.test.ts`

This task bundles five independent test-only additions — split into sub-steps, commit incrementally, do not treat as one atomic unit if any sub-step proves substantially larger than expected (escalate rather than silently descoping).

- [ ] **Step 1: `gdrive`/`gmail`/`outlook` connector tests.** For each connector, read its `index.ts` in full and the existing `sharepoint/index.test.ts` (the one connector that IS tested) to copy its test structure/mocking approach exactly. Cover at minimum: pagination across multiple pages, cursor persistence/resumption, and at least one error-handling path (a failed API call surfacing as a typed error, not swallowed). Run each package's tests after writing:

  ```bash
  pnpm --filter @rag/connectors test
  ```

- [ ] **Step 2: `GET /documents/:id` and `/documents/:id/download` route tests.** Read `apps/api/src/routes/documents.ts` in full. Following `apps/api/src/routes/auth-scope.test.ts`'s pattern (real app, `app.inject()`, real scope enforcement), write tests covering: successful fetch within scope, a 404 (not 403) for an out-of-scope id (confirming the existing "forbidden indistinguishable from missing" design), and the download route's actual byte-stream response for a real (test-fixture) S3 object.

  ```bash
  pnpm --filter @rag/api test
  ```

- [ ] **Step 3: `packages/runtime/src/index.ts`'s `buildCoreDeps`/`buildAuthProvider` wiring test.** Currently only exercised through a fully-mocked module in one worker test. Write a real (not mocked) test constructing a minimal `Config` for each of the three `AuthProvider` dispatch branches (`static-token`/`oidc`/`composite`) and asserting `buildAuthProvider` returns the correctly-typed provider for each, plus a test for `buildCoreDeps`'s production-TLS-enforcement warning logic (asserting the warning logs when `environment: "production"` and no TLS indicator is present).

  ```bash
  pnpm --filter @rag/runtime test
  ```

- [ ] **Step 4: Run the full test suite** to confirm nothing regressed.

  ```bash
  pnpm --filter='!@rag/e2e' test
  ```

- [ ] **Step 5: Commit** (one commit per sub-step is fine, or bundle if genuinely small):

  ```bash
  git add packages/connectors/src/gdrive/index.test.ts packages/connectors/src/gmail/index.test.ts packages/connectors/src/outlook/index.test.ts
  git commit -m "test: add coverage for gdrive/gmail/outlook connectors (pagination, cursors, errors)"

  git add apps/api/src/routes/documents.test.ts
  git commit -m "test: add coverage for GET /documents/:id and /documents/:id/download"

  git add packages/runtime/src/index.test.ts
  git commit -m "test: add coverage for buildCoreDeps/buildAuthProvider wiring"
  ```

---

## Task 17: Deployment documentation and hardening cleanup

**Files:**

- Modify: `docs/DEPLOYMENT.md`, `docs/DEPLOYMENT-TARGET.md`
- Create: `apps/web/railway.json` (or equivalent, matching whatever config format `apps/api`/`apps/worker`/`apps/mcp` already use — check first)
- Modify: monitoring/alerting config if a low-effort option exists (see Step 3)

- [ ] **Step 1: Document the rollback procedure.** Add a section to `docs/DEPLOYMENT.md`: "Migrations are forward-only (no `down` migrations exist). To correct a bad migration, ship a corrective migration following this repo's standard numbering — do not attempt to hand-edit `_journal.json` to remove an already-applied entry. For app-code-only regressions (no schema change involved), redeploy the previous Railway build directly."

- [ ] **Step 2: Reconcile `docs/DEPLOYMENT-TARGET.md`.** Read it in full — it currently documents "Decision D1, resolved 2026-06-14" as single-VM + docker-compose. Mark D1 explicitly superseded, pointing at `docs/PHASE-2-RAILWAY-RUNBOOK.md`/`docs/PLAN-LIVE-DEPLOY-AND-CHAT-UI.md` as the actual, current, live target.

- [ ] **Step 3: Add basic alerting beyond Sentry's own channel**, scoped to what's actually cheap for this deployment: check whether Railway's own deploy/crash webhook can be pointed at a free notification channel (e.g. an email-via-webhook service, or reusing the `AuditLogSink` webhook mechanism from Task 14 for a second, differently-configured purpose — a generic "something's wrong" ping). If no cheap, zero-new-vendor option is clearly available within this task's scope, document the gap explicitly in `docs/DEPLOYMENT.md` rather than forcing a vendor choice — this may need to move to the manual runbook if it turns out to require a real decision.

- [x] **Step 4: Add deploy config for `apps/web` — ✅ DONE (2026-07-12), commit `e285d89`.** Built and verified via a real `docker build` + `docker run` (not just written and assumed correct) — `/api/health` returns 200 from a running container. `Dockerfile` (Next.js standalone multi-stage build), `next.config.ts` (`output: "standalone"` + an explicit `outputFileTracingRoot` — NOT optional, see below), `railway.json`, `docker/compose.prod.yml`'s `web` service entry, a new `/api/health` route + middleware exemption, and both `env.example`s (root + apps/web's, the latter was badly stale) all landed together.

  **Two real bugs found only by actually verifying the build, not by reading the Dockerfile:**
  1. `.dockerignore` fully excluded `apps/web`, with a stale comment claiming its deps "aren't in the root lockfile yet" — disproven by this session's many successful workspace-wide `pnpm install` runs. Fixed by removing the exclusion.
  2. **`.dockerignore` never excluded `*.tsbuildinfo`** — a real, repo-wide latent bug (affects `api`/`mcp`/`worker`'s existing Dockerfiles too, not just this one). A developer's local TypeScript incremental-build cache (gitignored, but present on disk) got copied verbatim into every Docker build's context; stale/mismatched buildinfo made `tsc` silently skip real compilation — `@rag/core`/`@rag/db` emitted only `.d.ts` files, or nothing, with zero error message. Reproduced and confirmed locally too (moving the stale `tsconfig.tsbuildinfo` aside made a genuinely clean rebuild emit `.js` files correctly). Fixed by adding `**/*.tsbuildinfo` to `.dockerignore` — this protects every app's Docker build, not just `apps/web`'s.

  The Azure AD app registration and `RAG-Admins` security group creation remain human/infra actions — tracked in `docs/PILOT-MANUAL-RUNBOOK.md` item 4, not this task.

- [ ] **Step 5: Commit**

  ```bash
  git add docs/DEPLOYMENT.md docs/DEPLOYMENT-TARGET.md apps/web/railway.json
  git commit -m "docs: document rollback procedure, reconcile stale deployment-target doc, add apps/web deploy config

  docs/DEPLOYMENT-TARGET.md still described single-VM/docker-compose as
  the chosen target four weeks after Railway became the actual live
  deployment -- doc drift that would confuse a future operator.
  apps/web (this session's own feature) had no deploy config committed
  despite being the newest, most complex service."
  ```

---

## Final Phase: Verification

- [ ] Run the full unit test suite: `pnpm --filter='!@rag/e2e' test`
- [ ] Run the full e2e suite against real Postgres: `pnpm docker:up && E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test`
- [ ] Run `pnpm typecheck` and `pnpm lint` across the whole workspace
- [ ] Run `pnpm build` (including `apps/web`'s `next build`) to confirm every schema/type/config change compiles end-to-end
- [ ] Confirm the migration chain now runs through `0014` (Task 9 → `0012`, Task 13 → `0013`, Task 14 → `0014`, per the mandatory sequencing in Global Constraints) with no duplicate `idx`/`when` values anywhere in `_journal.json`, and applies cleanly from scratch on a fresh database
- [ ] Re-run `E2E_SKIP_DOCKER_UP=1 pnpm --filter @rag/e2e test -- data-class-ingestion-gate` specifically, since it's the single highest-severity item this plan closes
- [ ] Grep for any remaining reference to `sourceDocClass ?? "A"` defaulting logic to confirm Task 1's fix is the only path now setting this value in production code
- [ ] Confirm `docs/ISSUES-AND-OPTIMIZATIONS.md` no longer contains the two false claims Task 2 corrected
- [ ] Confirm `docs/CPA-READINESS-ASSESSMENT-2026-07-08.md`'s P0/P1/P2 items 2, 4, 5(partial-code-side), 6, 7, 9, 10, 11, 13, 14(harness-side), 15, 17, 18, 19(mechanism), 20 are each closeable/closed by a specific commit from this plan — cross-reference before declaring this plan complete
- [ ] Update `docs/CPA-READINESS-ASSESSMENT-2026-07-08.md`'s reconciliation table (or add a new dated addendum section) marking each closed item resolved with a commit citation, following this session's own established pattern of correcting prior audit documents rather than leaving them stale
