# Migration Tracking Incident — 2026-07-13

**Status: root cause fully resolved and verified in production. Two systemic/preventive follow-ups remain open — see §5.**

## 1. What happened

While executing Task 1 of `docs/superpowers/plans/2026-07-13-rag-system-launch-readiness.md` (redeploying `rag-worker` to apply 6 pending migrations, `0012`–`0017`), the manual migration run failed:

```
Migration failed: Error: Failed query: CREATE TABLE "audit_log" ( ... )
relation "audit_log" already exists
```

Migration `0007_audit_log.sql` — which creates the `audit_log` table — was attempted again against a database where that table has existed for weeks. The failure was clean (transaction rolled back, zero data change), but it blocked the redeploy and revealed a real, previously-unknown gap in how this repo's migration tooling behaves.

## 2. Root cause

**`drizzle-orm`'s Postgres migrator does not do per-migration content-hash matching.** Read directly from `node_modules/drizzle-orm/pg-core/dialect.js`:

```js
const dbMigrations = await session.all(
  sql`select id, hash, created_at from ${schema}.${table} order by created_at desc limit 1`,
);
const lastDbMigration = dbMigrations[0];
for (const migration of migrations) {
  if (
    !lastDbMigration ||
    Number(lastDbMigration.created_at) < migration.folderMillis
  ) {
    // ...apply it, insert a new tracking row...
  }
}
```

It fetches only the **single highest `created_at`** ever recorded, then applies any local migration whose journal `when` value exceeds that one threshold. The `hash` column is written for bookkeeping only — it is never read back or compared. This means: **a migration's `when` value can never be safely changed once it has been applied to any real, persistent database** — doing so can shift which migration sits "above the threshold," causing the migrator to either (a) silently skip a migration that's genuinely still pending, or (b) try to re-run one that's already applied (this incident).

**How this specific drift happened:** an earlier fix this session corrected `0003_pending_uploads.sql`'s anomalous `when` (moving it from `1784000000000` down to `1781333333000`) to restore local journal monotonicity — a `docs/PLAN-VALIDATION-REMEDIATION.md`-tracked fix. That was correct for the _local_ file ordering, but production had already applied `0003` under the _old_ `1784000000000` value. That left `1784000000000` as production's recorded threshold — and `0007_audit_log`'s `when` (`1784666666000`) now sat just above it, even though `0007`'s content was already live in production.

**Confirmed via content-hash cross-reference** (script: hash each local `0001`–`0007` migration file with SHA-256, compare against the 7 hashes recorded in production): 6 of 7 production-recorded rows match local `0002`–`0007`'s _current file content_ exactly — just under different `created_at` values than local's current `when`. Only `0001`'s recorded hash has no local match at all (see §3 — confirmed benign separately).

## 3. `0001`'s hash mismatch — investigated, confirmed benign, not a bug

`0001_documents_metadata_gin.sql`'s current file content hashes differently than what's recorded in production. Traced via `git log --follow` to commit `f461157` ("fix: make hybridSearch metadata filter index-backed (H2)", 2026-07-09), which edited **only the file's leading SQL comment** (correcting a factually wrong claim about which Postgres operators the GIN index accelerates) — the executed `CREATE INDEX IF NOT EXISTS ...` statement itself is byte-identical. That commit's own message already reasoned through this exact drizzle behavior ("safe on an already-applied migration — migrator only ever writes this file's content hash for its own bookkeeping row, it never reads it back") — independently re-confirmed today by reading the migrator source directly. `0001`'s `when` (`1779667200000`) is far below any plausible threshold and was never going to be re-run regardless of hash. **No action needed.**

## 4. Fix applied and verified

**Fix:** `packages/db/drizzle/meta/_journal.json` — moved `0007_audit_log`'s `when` from `1784666666000` to `1783900000000` (strictly between `0006`'s `1783833333000` and production's recorded threshold `1784000000000`), restoring the "already-applied migrations stay below the recorded threshold" invariant. Commit `38933b5`.

**Validated before touching production again:**

1. Restored the real pre-migration production backup (`pg_dump`, taken immediately before this was discovered) into a disposable scratch Postgres container.
2. Reproduced the exact production failure against that replica with the _unfixed_ journal — confirmed identical error, confirmed clean rollback (still 7 tracked migrations after).
3. Re-ran against the same replica with the fix applied — clean success: 17/17 migrations applied, full `audit_log` schema present (`embedding_provider`, `embedding_model`, `endpoint`, `top_score`, `principal_subject` — the complete P3 disclosure-audit-trail schema), zero data loss (`chunks`=6175, `documents`=858, matching the pre-fix counts exactly).
4. `packages/db/src/migration-guard.test.ts` (including its monotonicity assertion) still passes.

**Applied to production**, 2026-07-13: merged the fix into the branch actually deployed (`feat/kb-governance-phase3-audit-parity`), redeployed `rag-worker`, ran the migration manually (Railway's config-as-code isn't wired for automatic `preDeployCommand` execution on this service — separate, already-tracked gap, see the evaluation doc's P1-5-adjacent finding). **Production now shows 17/17 migrations applied, identical schema and row counts to the validated scratch run.** `rag-api` and `rag-mcp` redeployed after. All five Railway services confirmed `Online`; both recurring jobs (`rag.docs_gap_digest`, `rag.ship_audit_log`) confirmed registered.

**Local dev Postgres checked too** (the long-running container in the original worktree): 15 migrations tracked, threshold sits exactly at `0014`'s correctly-matching hash+timestamp, and `0015`–`0017` all sit safely above it with no prior conflicting history. **No landmine here — will apply cleanly on the next `pnpm db:migrate`.**

## 5. Not yet resolved — genuine follow-ups for planning

Everything in §1–4 is closed. These two are systemic/preventive gaps this incident exposed, not bugs still causing harm today:

1. **No automated guard against changing an already-shipped migration's `when` value.** `migration-guard.test.ts` checks monotonicity (`entries[i].when > entries[i-1].when`) but has no way to know which migrations have already been applied to a _real, persistent_ deployment (only that test would need out-of-band knowledge — e.g., a checked-in "known-applied-as-of" snapshot, or a CI step that queries the actual production tracking table). Without this, the exact mistake that caused this incident (a well-intentioned local reordering fix, applied without cross-checking a live deployment's recorded state) can recur.
2. **Railway's config-as-code linkage isn't wired for `rag-worker`'s `preDeployCommand`.** Confirmed again during this incident (deploy manifest showed `fileServiceManifest: {}`, empty) — migrations require a manual `railway ssh` invocation instead of firing automatically on deploy, as the root `CLAUDE.md` and `docs/DEPLOYMENT.md` both document as the intended behavior. This is the same gap already flagged in `docs/RAG-SYSTEM-EVALUATION-2026-07-13.md`'s P1-1-adjacent deployment findings — restated here because it's what made _this_ incident require a manual, careful intervention rather than happening automatically and safely on a normal deploy.

Both are well-scoped enough to hand directly to `/writing-plans` or `superpowers:writing-plans`: item 1 needs a design decision (what "known-applied" source of truth to check against — likely a small checked-in JSON snapshot of production's tracking table, refreshed deliberately, not auto-generated); item 2 needs the Railway dashboard's config-as-code path fixed for `rag-worker`/`rag-api`/`rag-mcp` (a UI action, not code) plus verification that `preDeployCommand` actually fires on the next real deploy.
