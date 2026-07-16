# Migration Tracking Guard & Railway Deploy Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two systemic follow-ups from `docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md` §5 — add an automated guard that stops anyone from retimestamping an already-shipped migration (the exact mistake that caused that incident), and fix Railway's config-as-code linkage so `rag-worker`'s migrations apply automatically on deploy instead of requiring manual intervention.

**Architecture:** Task 1 extends the existing `packages/db/src/migration-guard.test.ts` pattern (already has two guard `describe` blocks) with a third: a checked-in "known-applied-to-production" baseline that the journal is diffed against on every `pnpm test` run. Task 2 is a Railway dashboard configuration fix plus CLI-verified proof that `preDeployCommand` actually fires — no application code changes.

**Tech Stack:** TypeScript, vitest (Task 1); Railway CLI + dashboard (Task 2).

## Global Constraints

- Never hand-modify `packages/db/drizzle/meta/_journal.json`'s `when` values for a migration already represented in the new baseline file (Task 1) without first confirming, from a real deployed database's `drizzle.__drizzle_migrations` table, that the change is safe — this is the exact rule the baseline exists to enforce mechanically.
- Follow the existing `migration-guard.test.ts` file's structure: one `describe` block per guard, plain `it` assertions with a descriptive failure message explaining the fix, no test framework beyond what's already imported (`node:fs/promises`, `node:path`, `node:url`, `vitest`).
- No new dependencies for Task 1 — the baseline file is plain JSON, read the same way `_journal.json` already is in the same test file.
- Task 2's dashboard step requires either the user directly or an agent with Claude-in-Chrome (or equivalent) browser access to railway.app — it cannot be done via the `railway` CLI, which has no command to set a service's config-as-code path.

---

## File Structure

| File                                              | Responsibility                                                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/drizzle/meta/_applied-baseline.json` | **Create**: checked-in snapshot of `{tag, when}` pairs for every migration confirmed applied to the real production database. Updated deliberately, by hand, only after confirming a migration is live in production — never auto-generated. |
| `packages/db/src/migration-guard.test.ts`         | **Modify**: add a third `describe` block asserting every baseline entry's `when` still matches the current journal.                                                                                                                          |
| _(Railway dashboard, not a repo file)_            | **Modify**: config-as-code path for `rag-worker`, `rag-api`, `rag-mcp` services.                                                                                                                                                             |

---

## Task 1: Baseline guard against retimestamping already-shipped migrations

**Files:**

- Create: `packages/db/drizzle/meta/_applied-baseline.json`
- Modify: `packages/db/src/migration-guard.test.ts`

**Interfaces:**

- Produces: no exported functions — this is a test-only guard. The baseline file's shape is `{ "note": string, "entries": [{ "tag": string, "when": number }] }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/migration-guard.test.ts` (after the existing `describe("drizzle migration guard — journal timestamp ordering"` block, end of file):

```typescript
/**
 * Regression guard for the 0007_audit_log incident (2026-07-13, see
 * docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md): drizzle-orm's migrator
 * matches by a single highest-applied-timestamp threshold, never by content
 * hash (verified directly against node_modules/drizzle-orm/pg-core/dialect.js).
 * Changing an already-applied migration's `when` — even for a good reason
 * like fixing local monotonicity — can silently shift that threshold and
 * cause the migrator to either skip a genuinely-pending migration or try to
 * re-run one that's already live, exactly what happened to 0007.
 *
 * `_applied-baseline.json` is a checked-in, DELIBERATELY-maintained snapshot
 * of every migration confirmed applied to the real production database — not
 * auto-generated, not derived from the journal itself (that would make this
 * guard tautological). Update it by hand, in its own commit, only after
 * confirming (via `railway ssh -s rag-postgres`, per the incident doc and
 * Task 1 of docs/superpowers/plans/2026-07-13-rag-system-launch-readiness.md)
 * that a migration is genuinely live in production.
 */
describe("drizzle migration guard — no retimestamping an already-applied migration", () => {
  it("every baseline entry's 'when' still matches the current journal", async () => {
    const baselinePath = join(MIGRATIONS_DIR, "meta", "_applied-baseline.json");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const journalPath = join(MIGRATIONS_DIR, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };

    const violations: string[] = [];
    for (const baselineEntry of baseline.entries) {
      const journalEntry = journal.entries.find(
        (e) => e.tag === baselineEntry.tag,
      );
      if (!journalEntry) {
        violations.push(
          `baseline entry "${baselineEntry.tag}" no longer exists in the journal — ` +
            `a migration confirmed applied to production was renamed or deleted`,
        );
        continue;
      }
      if (journalEntry.when !== baselineEntry.when) {
        violations.push(
          `"${baselineEntry.tag}" is confirmed applied to production with when=${baselineEntry.when}, ` +
            `but the current journal has when=${journalEntry.when}. Changing an already-applied ` +
            `migration's timestamp can cause drizzle-orm's migrator to silently skip or re-run ` +
            `migrations (see docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md). If this migration ` +
            `genuinely needs a new timestamp, first confirm via a real production database query ` +
            `whether that's safe — do not just restore the baseline value blindly.`,
        );
      }
    }

    expect(
      violations,
      `One or more migrations confirmed applied to production have had their ` +
        `journal timestamp changed. Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the baseline itself is non-empty (guard is actually wired)", async () => {
    const baselinePath = join(MIGRATIONS_DIR, "meta", "_applied-baseline.json");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    expect(baseline.entries.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/marcusklein/dev/rag-system/.claude/worktrees/rag-system-launch-readiness
pnpm --filter @rag/db test -- migration-guard
```

Expected: FAIL — `ENOENT` reading `_applied-baseline.json` (file doesn't exist yet).

- [ ] **Step 3: Create the baseline, seeded with the current, production-confirmed-correct state**

Create `packages/db/drizzle/meta/_applied-baseline.json`. Every `tag`/`when` pair below is copied verbatim from the current (fixed, post-incident) `packages/db/drizzle/meta/_journal.json` — all 17 entries are confirmed live in production as of the migration applied during Task 1 of `docs/superpowers/plans/2026-07-13-rag-system-launch-readiness.md` (verified: `select count(*) from drizzle.__drizzle_migrations` = 17 in production):

```json
{
  "note": "Checked-in snapshot of every migration confirmed applied to the REAL production database (not derived from the journal — that would make the migration-guard.test.ts check tautological). Update by hand, in its own commit, ONLY after confirming via `railway ssh -s rag-postgres` (see docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md) that a new migration is genuinely live in production. Never edit an existing entry's `when` here to 'fix' a guard failure without first confirming, against the real database, that doing so is safe.",
  "entries": [
    { "tag": "0001_documents_metadata_gin", "when": 1779667200000 },
    { "tag": "0002_documents_original_storage", "when": 1780500000000 },
    { "tag": "0003_pending_uploads", "when": 1781333333000 },
    { "tag": "0004_data_class", "when": 1782166666000 },
    { "tag": "0005_ingest_log", "when": 1783000000000 },
    { "tag": "0006_client_assignments", "when": 1783833333000 },
    { "tag": "0007_audit_log", "when": 1783900000000 },
    { "tag": "0008_document_governance", "when": 1785500000000 },
    { "tag": "0009_search_audit_parity", "when": 1787000000000 },
    { "tag": "0010_client_assignments_unique", "when": 1788000000000 },
    { "tag": "0011_audit_log_principal_subject", "when": 1789000000000 },
    { "tag": "0012_staff_source_assignments", "when": 1790000000000 },
    { "tag": "0013_docs_gap_digest_runs", "when": 1791000000000 },
    { "tag": "0014_audit_log_shipper_state", "when": 1792000000000 },
    { "tag": "0015_add_git_markdown_source_kind", "when": 1793000000000 },
    { "tag": "0016_add_ecfr_part4_source_kind", "when": 1793000000001 },
    { "tag": "0017_add_audit_log_provider_disclosure", "when": 1794000000000 }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rag/db test -- migration-guard
```

Expected: PASS, all 5 test cases green (2 existing guards + 2 new + the sanity check).

- [ ] **Step 5: Prove the guard actually catches the incident's exact mistake**

Temporarily reintroduce the bug to confirm the guard fires (then revert):

```bash
cd /Users/marcusklein/dev/rag-system/.claude/worktrees/rag-system-launch-readiness
sed -i.bak 's/"when": 1783900000000,\n      "tag": "0007_audit_log"/"when": 1784666666000,\n      "tag": "0007_audit_log"/' packages/db/drizzle/meta/_journal.json
```

If `sed` with a literal newline doesn't match on your platform, instead open `packages/db/drizzle/meta/_journal.json` and manually change `0007_audit_log`'s `"when": 1783900000000` back to `"when": 1784666666000`, run the command below, then revert it back to `1783900000000` by hand.

```bash
pnpm --filter @rag/db test -- migration-guard
```

Expected: FAIL — the new guard's first test reports `"0007_audit_log" is confirmed applied to production with when=1783900000000, but the current journal has when=1784666666000`.

Revert the temporary change:

```bash
mv packages/db/drizzle/meta/_journal.json.bak packages/db/drizzle/meta/_journal.json 2>/dev/null || true
git checkout -- packages/db/drizzle/meta/_journal.json
pnpm --filter @rag/db test -- migration-guard
```

Expected: PASS again (confirms the revert worked and the guard is not left in a broken state).

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/meta/_applied-baseline.json packages/db/src/migration-guard.test.ts
git commit -m "feat: add migration-guard check against retimestamping already-shipped migrations

Checked-in baseline of every migration confirmed applied to production
(packages/db/drizzle/meta/_applied-baseline.json), diffed against the
journal on every test run. Prevents a recurrence of the
0007_audit_log incident (docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md) —
drizzle-orm's migrator matches by a single highest-timestamp threshold, not
per-migration content hash, so retimestamping an already-applied migration
can silently break production migrations."
```

---

## Task 2: Fix Railway config-as-code linkage so migrations apply automatically

**Files:** None in this repo — this task modifies Railway dashboard configuration and verifies the result via CLI. `apps/worker/railway.json`, `apps/api/railway.json`, `apps/mcp/railway.json` already exist and are already correct (confirmed during the 2026-07-13 incident) — the gap is purely that Railway isn't reading them.

**Interfaces:** N/A (no code).

- [ ] **Step 1: Confirm the gap still exists**

```bash
railway deployment list -s rag-worker --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d)[0];console.log(j.id, j.status, JSON.stringify(j.meta.fileServiceManifest))})'
```

Expected (if the gap still exists): `fileServiceManifest` prints as `{}` (empty). If it already shows a populated object with `configFile`/`build`/`deploy` keys, this task is already done for `rag-worker` — check `rag-api`/`rag-mcp` the same way (substitute `-s rag-api`, `-s rag-mcp`) before concluding the whole task is unnecessary.

- [ ] **Step 2 (requires human or browser-capable agent — cannot be done via `railway` CLI): set the config-as-code path in the Railway dashboard**

For each of `rag-worker`, `rag-api`, `rag-mcp` in the Railway dashboard (railway.app, project "rag-system", environment "production"):

1. Open the service → **Settings** tab → **Config-as-code** section.
2. Set the path to the service's `railway.json`:
   - `rag-worker` → `apps/worker/railway.json`
   - `rag-api` → `apps/api/railway.json`
   - `rag-mcp` → `apps/mcp/railway.json`
3. Save.

Do not proceed to Step 3 until this is done for at least `rag-worker` (the one with a `preDeployCommand` that matters for migrations) — `rag-api`/`rag-mcp` matter less urgently (they only have `healthcheckPath`, already working via other means per `docs/RAG-SYSTEM-EVALUATION-2026-07-13.md`) but should be set too while in the dashboard.

- [ ] **Step 3: Verify the config-as-code linkage is now live**

```bash
railway up --service rag-worker --ci -y
```

Expected: deploy succeeds. Then:

```bash
railway deployment list -s rag-worker --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d)[0];console.log(j.id, j.status); console.log(JSON.stringify(j.meta.fileServiceManifest, null, 2))})'
```

Expected: `fileServiceManifest` is now populated, including `"deploy": { "preDeployCommand": "pnpm --filter @rag/db migrate", ... }` (or equivalent, matching `apps/worker/railway.json`'s actual current content — read that file first if the exact field name/value differs).

- [ ] **Step 4: Verify `preDeployCommand` actually executes, not just that it's configured**

`packages/db/src/migrate.ts` unconditionally prints two specific lines on every run, even when nothing is pending (Phase 1's bootstrap always re-runs; Phase 2 always at least connects and checks) — this makes it possible to verify execution without needing a real pending migration:

```bash
DEPLOY_ID=$(railway deployment list -s rag-worker --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d)[0].id))')
railway logs -s rag-worker -d --lines 200 "$DEPLOY_ID" | grep -E "applying 0000_init|running drizzle migrator|Migrations complete"
```

Expected: both lines appear —

```
→ applying 0000_init.sql (bootstrap)
→ running drizzle migrator for pending files
✓ Migrations complete
```

If these lines are absent, `preDeployCommand` still isn't firing — re-check Step 2's dashboard path (a common mistake: the path is relative to the repo root, not the service's own directory — it should read `apps/worker/railway.json`, not `railway.json` or `worker/railway.json`).

- [ ] **Step 5: Repeat Step 3's verification for `rag-api` and `rag-mcp`**

```bash
railway up --service rag-api --ci -y
railway deployment list -s rag-api --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(d)[0].meta.fileServiceManifest, null, 2)))'

railway up --service rag-mcp --ci -y
railway deployment list -s rag-mcp --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(d)[0].meta.fileServiceManifest, null, 2)))'
```

Expected: both now show a populated `fileServiceManifest` with `healthcheckPath: "/health"` reflected (matching each service's `railway.json`).

- [ ] **Step 6: Update `docs/DEPLOYMENT.md` to remove the now-resolved caveat**

Read `docs/DEPLOYMENT.md`'s "Migrations on deploy (Railway)" section (added during the 2026-07-13 incident investigation, or check `docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md` §5 item 2 for the exact wording) and remove or update any note stating migrations require manual intervention — they no longer do, as of this task's Step 2.

- [ ] **Step 7: No code commit for Steps 1-5 (dashboard-only + verification)** — if Step 6 changed `docs/DEPLOYMENT.md`, commit that:

```bash
git add docs/DEPLOYMENT.md
git commit -m "docs: remove manual-migration caveat now that Railway config-as-code is wired"
```

---

## Self-Review

**Spec coverage** — both items from `docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md` §5 map directly to a task: item 1 (no guard against retimestamping) → Task 1; item 2 (Railway config-as-code not wired) → Task 2. No other requirements stated in the source doc.

**Placeholder scan** — Task 1 has complete, real code for the test and the baseline file (exact `tag`/`when` values copied from the actual current, verified-correct journal — not invented). Task 2's dashboard step is necessarily a manual instruction (Railway has no CLI for this), not a placeholder — it's followed by concrete, runnable verification commands with exact expected output.

**Type consistency** — Task 1's baseline JSON shape (`{ tag: string, when: number }[]`) matches exactly what the new test parses; both reference the same `MIGRATIONS_DIR`/`join` helpers already imported at the top of `migration-guard.test.ts` (confirmed by reading the file before writing this plan — no new imports needed beyond what's already there).

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-13-migration-tracking-guard-and-deploy-config.md`.** Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
