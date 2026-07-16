# Session Handoff — Launch Readiness, Tasks 1–9 (2026-07-14)

Written so this session can be resumed from a different machine. Everything a
resuming session needs is in this file plus the git history on the branch
below — nothing required to resume lives only in this machine's local
`.claude/` config or the (gitignored) `.superpowers/sdd/` scratch directory.

## Where the work is

- **Branch:** `worktree-rag-system-launch-readiness`, pushed to `origin`.
- **PR:** https://github.com/marcusk639/rag-system/pull/34 — targets
  `feat/kb-governance-phase3-audit-parity` (NOT `main` — that's where this
  branch actually forked from; `feat/kb-governance-phase3-audit-parity`
  itself is not yet merged to `main`).
- **Plan being executed:**
  `docs/superpowers/plans/2026-07-13-rag-system-launch-readiness.md` (12
  tasks total).
- **Workflow:** `superpowers:subagent-driven-development` — fresh implementer
  subagent per task, dedicated reviewer subagent (spec compliance + code
  quality), fix loops on Critical/Important findings, re-review until clean.

## How to resume on a fresh machine

```bash
git clone git@github.com:marcusk639/rag-system.git
cd rag-system
git fetch origin worktree-rag-system-launch-readiness
git checkout worktree-rag-system-launch-readiness
pnpm install
docker compose -f docker/docker-compose.yml up -d   # Postgres + parser, needed for e2e tests
pnpm --filter @rag/db build                          # e2e imports compiled dist/, not src/
```

If using Claude Code's isolated-worktree pattern rather than a plain
checkout: create a fresh worktree from this branch (`EnterWorktree` or
`git worktree add`), not from `main` or `feat/kb-governance-phase3-audit-parity`
directly — this branch already has Tasks 1–9's commits on top of the fork
point.

**Then:** re-invoke `superpowers:subagent-driven-development` on
`docs/superpowers/plans/2026-07-13-rag-system-launch-readiness.md`. The full
ledger below (identical to what would normally live in the local, gitignored
`.superpowers/sdd/progress.md`) tells you Tasks 1–9 are DONE — do not
re-dispatch them. **Resume at Task 10.**

## What does NOT transfer automatically to another machine

This session also made changes to this machine's **global** Claude Code
config (`~/.claude/`, outside any git repo — no sync mechanism carries these
to a different machine unless the user has their own dotfiles sync):

- `~/.claude/settings.json`: default `"model"` changed from `"sonnet"` to
  `"fable"`.
- `~/.claude/agents/mech-executor.md` and `~/.claude/agents/verifier.md`:
  two new agent roles (Haiku-tier mechanical executor, Opus-tier adversarial
  verifier).
- `~/.claude/rules/performance.md` and `~/.claude/rules/common/performance.md`:
  both got an "Orchestrator + Tiered Delegation" section added.
- `~/.zshrc`: a `compinit`-ordering bug fix (unrelated to this repo, this
  machine's shell only).

None of these affect the rag-system code or are required to resume the
plan — they're noted here only so a future session on this same machine (or
the user manually) knows they exist and won't be present on a different
machine without being redone.

## Full task ledger (Tasks 1–9, complete)

### Task 1 — Bring production current (redeploy `rag-worker`/`rag-api`/`rag-mcp`)

COMPLETE (commits `38933b5`, `64ca31c`; reviewed live by the user rather than
via the normal diff-review loop — this became a production-incident
investigation). Root cause: drizzle-orm's Postgres migrator matches by a
single max-applied-timestamp threshold, not per-file hash — an earlier
session's journal-monotonicity fix retimestamped an already-applied migration
(0003), which indirectly left `0007_audit_log`'s `when` sitting above
production's recorded threshold. Fixed 0007's `when`
(1784666666000 → 1783900000000), validated against a scratch restore of the
real production backup (reproduced the failure, then confirmed clean success:
17/17 migrations, zero data loss), then applied to production for real
(verified: 17/17 migrations, full `audit_log` schema, chunks=6175/documents=858
unchanged). All 5 Railway services redeployed and Online. Full writeup:
`docs/MIGRATION-TRACKING-INCIDENT-2026-07-13.md`.

### (Interleaved) Migration-tracking guard plan

Between Task 1 and Task 2, a second plan
(`docs/superpowers/plans/2026-07-13-migration-tracking-guard-and-deploy-config.md`)
was executed to prevent recurrence and fix Railway config-as-code:

- **Guard Task 1** (commit `515f0bd`): added a baseline-timestamp guard
  (`packages/db/src/migration-guard.test.ts` +
  `packages/db/drizzle/meta/_applied-baseline.json`) that fails CI if any
  already-applied migration's journal `when`/`tag` is retimestamped or
  reordered.
- **Guard Task 2** (commits `be835ca`, `6caeffa`, `63acc8a`, `e292cbe`,
  `ca8c744`): fixed Railway config-as-code linkage; uncovered and fixed 3
  additional production bugs along the way — `rag-worker`'s
  `preDeployCommand` used `pnpm` (not present in the runtime image, fixed to
  a direct `node .../dist/migrate.js` call); `migrate.ts`'s CLI auto-run
  guard silently no-op'd through symlinked paths (pnpm's `node_modules`
  layout — `import.meta.url` resolves symlinks, `process.argv[1]` doesn't;
  fixed with `realpath` + `pathToFileURL`, both required); and Railway's
  healthcheck prober couldn't reach newly-deploying `rag-api`/`rag-mcp`
  replicas (dropped `healthcheckPath`, process-liveness only, matching an
  earlier `rag-parser` fix).

### Task 2 — Recurring Postgres backup job

COMPLETE (commits `fa05834`, `544392b`, `683aa6a`). Implementer: sonnet.
Correctly resolved a drizzle-kit auto-numbering collision (migration `0017`
clash) by renumbering the generated migration to `0018` — independently
verified safe (journal `when` threshold, snapshot `id`/`prevId` chain,
migration-guard 5/5) before trusting it. Reviewer found 1 **Critical**:
`pg_dump` leaked the DB password via subprocess argv AND via pg-boss's
`serialize-error` persisting the raw exec error's `cmd` property into
`pgboss.job.output` on failure. Fixed (`683aa6a`: `PGPASSWORD` env instead of
argv, redacted error before propagation) and re-review CONFIRMED FIXED.

**Deferred Minor findings** (not blocking, for Task 13's final review):

1. Migration-renumbering-by-hand is a literal breach of "never hand-author a
   migration journal entry" even though content is generator-produced and
   safety was independently verified — document the correction procedure in
   `CLAUDE.md`'s "Things that will trip you up."
2. `packages/core/src/config.test.ts` has no coverage for the new `backup`
   config block's env parsing.
3. `backup-postgres.test.ts`'s failure-path test never exercises the case
   where `redactConnectionStrings()` actually redacts something.
4. `buildPgDumpInvocation()` is called outside the handler's try/catch — a
   malformed `config.databaseUrl` would throw an unredacted (but
   input-free/generic) error straight to pg-boss.

### Task 3 — Web app security headers

COMPLETE (commits `50d8ec3`, `bdc4c18`). Implementer: haiku (base) + sonnet
(fix). Reviewer found 1 **Critical**: the plan's own static CSP
(`script-src 'self'`, no nonce/`unsafe-inline`) blocks Next.js App Router's
own inline hydration scripts, verified against actual build output — would
have shipped a chat UI that renders SSR HTML and then goes dead. **Plan-
mandated, not an implementer deviation** — escalated to the user, who chose
the correct fix (nonce-based CSP via middleware) over the `unsafe-inline`
shortcut. Fix re-reviewed and CONFIRMED FIXED: same nonce verified to flow
through request header and CSP response header (real build + `next start` +
curl across all 3 middleware auth branches), existing Auth.js gating
confirmed unchanged.

**Deferred Minor findings:**

5. `middleware.ts:61` sets `Content-Security-Policy` on the request headers
   object (zero functional effect) — dead code, should be removed.
6. `middleware.ts:56` uses `Buffer` in Edge Runtime middleware — works today
   via Next.js's bundled polyfill but isn't documented Edge Runtime API
   surface.
7. CSP omits `'strict-dynamic'` on `script-src` (official Next.js example
   includes it) — not treated as blocking.
8. Nonce-based CSP forces `/` and `/_not-found` from static to dynamic
   rendering — confirmed real but Minor, unavoidable, scoped to 2 routes.

### Task 4 — `WEB_AUTH_MODE=static-fallback` startup warning

COMPLETE (commits `9b886bf`, `2a0a333`). Implementer: haiku (base) + sonnet
(fix). Reviewer independently verified both of the brief's factual claims
(Next 15.5.20 genuinely auto-detects `instrumentation.ts`;
`console.warn` is this app's actual sanctioned logging convention) rather
than trusting them. Found 1 **Important**: `register()` fires in both
Node.js and Edge runtime contexts at boot, so the warning printed twice,
contradicting its own "warns ONCE" docstring. Fixed (`2a0a333`:
`NEXT_RUNTIME !== "edge"` gate) and re-review CONFIRMED FIXED. Zero
outstanding findings.

### Task 5 — Citation filter grouped/ranged forms

COMPLETE (commits `1d9dbca`, `d5c4853`). Implementer: haiku (base) + sonnet
(fix). Reviewer was explicitly briefed to be adversarial about regex edge
cases and found 3 real correctness bugs in the plan's own specified code:
mixed range+comma brackets (`[1-3, 5]`) silently dropped citations; an
unbounded range (`[1-50000000]`) threw an uncaught `RangeError` (DoS-relevant
crash, uncaught at `ask.ts` call sites); `Number("") === 0` footgun meant
`[-1]`/`[ ]`/`[,]`/`[-]` spuriously matched citation index 0. No architecture
tradeoff — fixed directly. Fix (`d5c4853`) re-reviewed and CONFIRMED FIXED —
reviewer wrote and ran its own throwaway adversarial tests rather than
trusting the report. 94/94 tests passing workspace-wide.

**Deferred Minor finding:**

9. A second hyphen in one bracket (`[1-2-3]`) parses as range 1-2 and
   silently drops the trailing `-3` — pre-existing behavior, not a
   regression, extremely unlikely LLM output shape.

### Task 6 — Sparse search recall for verbose queries

COMPLETE, required a full re-scope (commits `92e21f4` [superseded],
`7b34499` [actual fix]). **The plan's premise was factually wrong**: swapping
`plainto_tsquery` → `websearch_to_tsquery` for "OR-ish" verbose-query recall
does nothing (both produce byte-identical AND trees for plain text, confirmed
live against Postgres) and silently introduces a NOT-operator injection risk
on any user query starting with `-`. Escalated; user chose "build a real
OR-based query." Implementer (sonnet) investigated multiple SQL constructions
live against Postgres before choosing:
`to_tsquery('simple', array_to_string(array_agg(DISTINCT quote_literal(lexeme)) from unnest(to_tsvector('english', $1)), ' | '))`
— reuses the same `to_tsvector('english', ...)` pipeline that builds the
stored `chunks.tsv` column (index/query tokenizer parity), uses `'simple'`
config on the rejoin specifically to avoid re-stemming already-stemmed
lexemes. Reviewer (opus, given the SQL subtlety) independently re-verified
every claim against live Postgres. Zero Critical/Important findings.

**Deferred Minor findings:**

10. `queries.ts`'s SQL comment explaining this construction is ~40 lines —
    unusually long but judged worth keeping given the subtlety it documents.
11. Broadening AND→OR admits more weak single-term matches into the sparse
    candidate pool — relative ranking quality on very high-term-count
    queries hasn't been benchmarked via the eval harness; future `pnpm eval`
    follow-up, not a defect.
12. Local dev-only footgun (not CI risk): `@rag/e2e`'s test script doesn't
    rebuild `@rag/db` first, so editing `packages/db/src` without rebuilding
    can run stale `dist/` against e2e tests.

### Task 7 — Exclude archived documents from retrieval

COMPLETE (commits `ec3b136`, `eb846fa`). Implementer: haiku. Reviewer
confirmed the exclusion is the only join point both `dense_hits` and
`sparse_hits` CTEs pass through, so neither retrieval path can bypass it.
Found 1 test-quality gap (Minor, fixed directly): the new test never
asserted the document WAS findable before archiving. Fixed.

**Deferred Minor/scope-note findings (may be intentional — need
product-owner confirmation):**

13. `getDocumentById`/`getDocumentDownload`
    (`packages/services/src/documents.ts:25,59`) never check
    `lifecycle_status` — archived documents remain fully
    fetchable/downloadable by direct ID even though hidden from search
    ranking.
14. `lifecycle_status` schema documents 3 values (`draft | active |
archived`) but only `archived` is excluded — not currently a bug since
    no code path writes `draft` yet.

### Task 8 — Apply diversity cap to `searchDocuments`

COMPLETE (commit `177069a`). Implementer: sonnet. Zero findings — clean
approval. Config field, ordering, and backward compatibility all
independently verified.

### Task 9 — Row-aware table splitting in `markdown-chunker`

COMPLETE with one documented, non-default-triggering known limitation
(commits `a8d51b0`, `6e3547b`, `fde70af`, `869c6eb`, `16771f0`). Implementer:
haiku (base) + sonnet/sonnet/opus (3 fix iterations). Went through 4 review
cycles, each closing one narrower gap in the same bug class:

1. Base (`a8d51b0`): row-boundary table splitting; reviewer found 2
   Important bugs (false-positive table detection on pipe-prefixed prose;
   oversized single row cut mid-string by a downstream char-unaware clamp).
2. Fix 1 (`6e3547b`): GFM-separator validation (fixed false-positive
   cleanly) + char-ratio row truncation (only PARTIALLY fixed the
   oversized-row case — not token-accurate for dense/CJK content).
3. Fix 2 (`fde70af`): made truncation token-accurate via a real-tokenizer
   verify+shrink loop — but re-review found the ceiling calc didn't account
   for the outer heading-prefix, reproducible with a deep/verbose heading
   path.
4. Fix 3 (`869c6eb`, opus): structural fix — threads the real heading-prefix
   text through the pipeline and verifies the fully-assembled chunk against
   the real tokenizer. Final adversarial re-review found a 4th, narrower
   gap: `applyOverlap()` runs AFTER this verification and can still
   re-inflate a chunk past `MAX_EMBEDDING_TOKENS` on dense content — but
   ONLY when `CHUNK_SIZE` is configured ≥ ~1600 (ships safe at the actual
   default of 800/120).

**User decision:** given the diminishing-returns pattern, do NOT do a 5th
upstream-prediction patch. Documented the limitation (`16771f0`) in
`CLAUDE.md` and in-code comments, and deferred the real structural fix
(verify AFTER `applyOverlap`, not another prediction) to a fully-written,
ready-to-execute follow-up plan:
`docs/superpowers/plans/2026-07-14-table-truncation-final-stage-fix.md`.

## Not yet started

- **Task 10** — Test coverage for Gmail, Outlook, and Google Drive
  connectors. Fully specced in the plan file. **← resume here.**
- **Task 11** — Test coverage for `buildCoreDeps`/`buildAuthProvider` wiring.
- **Task 12** — Route-level test coverage for `GET /documents/:id` and
  `/download`.
- **Task 13** — Final whole-branch code review +
  `superpowers:finishing-a-development-branch`. This is where all 14
  deferred Minor findings above should get triaged.
- The table-truncation final-stage fix plan
  (`docs/superpowers/plans/2026-07-14-table-truncation-final-stage-fix.md`)
  — written and committed, not yet executed. Independent of Tasks 10–13,
  can be done whenever convenient.
