# TWK KB — Launch Status (current source of truth)

**Updated:** 2026-07-31 (P0 gate #3 closed; P1 item 0 added). Engineering table
last verified 2026-07-16.
**Purpose:** One page that reflects what is _actually_ true right now, verified against the code — not what a plan's checkboxes claim. This project has a documented history of stale "resolved" claims creating false confidence; cross-check anything surprising against the tree before trusting it.

---

## One-line status

**The code is done and merged; launch is gated on human/legal/infra work, not engineering.** All three staff surfaces (web app, MCP, Teams bot) are built, reviewed, and on `main`. What remains are the P0 gates and the Azure/Railway stand-up — none of it is code.

---

## Engineering — DONE (verified on `main`, 2026-07-16)

| Area                                    | State                         | Evidence                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17-task automatable readiness plan      | **Complete**                  | all artifacts exist on `main`; migrations `0000`→`0017`; `classify-source.ts`, MCP audit logging, secret-length enforcement, `staff_source_assignments`, migration guard, `EVAL-BASELINE.md` all present |
| Harness readiness (hooks, CI, coverage) | **Complete**                  | pre-commit/pre-push hooks, CI format+parser-pytest jobs, coverage tooling (`readiness-report.md`, Level 3)                                                                                               |
| Web chat app (`apps/web`)               | **Built + deploy config**     | Entra SSO, per-user scope, streaming, citations; `Dockerfile` + `railway.json` (commit `e285d89`)                                                                                                        |
| Teams bot (`apps/teams-bot`)            | **Built + reviewed + merged** | 9-task plan, whole-branch review passed; merge `fe61ad7`; 43 unit tests                                                                                                                                  |
| Eng go-live gate                        | **Green**                     | `build + typecheck + lint + unit` all pass on `main`                                                                                                                                                     |

**Do not re-do any of the above.** If a plan doc's checkboxes look unchecked, they are stale — the work landed; verify against the tree.

---

## What remains for launch — the critical path (all human/infra/legal)

Tracked in detail in `docs/TWK-MANUAL-RUNBOOK.md`. Nothing here is a code task.

### P0 — hard gates (internal/unapproved pilot only until done)

- [ ] **1. Content audit** — eyeball every synced source for client-confidential material, _with Chris/Doug_. (Firm domain judgment.)
- [ ] **2. Counsel + carrier sign-off** — §7216/Circular 230/GLBA; the Google DPA is still "PROVISIONAL — NOT COUNSEL-CONFIRMED." (Attorney required.)
- [x] **3. Backup/restore drill** — ✅ **DONE 2026-07-31, both legs.** Local:
      fresh-instance restore + **88/88 e2e against restored data**. Production: real
      data (858 docs / 6,175 chunks) dumped and restored **entirely inside Railway**
      via `railway ssh` — nothing copied off their infrastructure — exit 0 in 4s,
      **36/36 indexes** incl. HNSW, pgvector v0.8.2 intact, ANN query verified over
      all 6,175 chunks. Production confirmed untouched; throwaway dropped.
      Full write-up: `docs/BACKUP-RESTORE-DRILL.md`. Setup procedure for the
      missing schedule: `docs/BACKUP-SCHEDULE-RUNBOOK.md`.
      ⚠ **A restore is proven; a backup _schedule_ is not.** Until one exists the
      only backup is one a human remembers to take. Two layers are needed:
      **(1)** Railway **volume backups** — available for our volume, dashboard-only
      (service → Backups tab), Daily + Weekly can both run; do this now, it is
      checkboxes. **(2)** a scheduled **`pg_dump` shipped off Railway** — volume
      backups restore only into the same project + environment and are deleted if
      the volume is wiped, so they do not cover project/account/provider loss.
      Retention for `audit_log` is a **counsel** question (ties to P2 #8), not a
      default: volume-backup retention tops out at 3 months.

### P1

- [x] **0. Apply migration `0018_answer_feedback` to production.** ✅ **DONE
      2026-07-31.** Found during the backup drill (production 17 migrations / 12
      tables vs local 18 / 13). Applied by hand — the deployed `rag-api` image
      predates the migration file, so `pnpm db:migrate` could not be run from it;
      redeploying first would have shipped code before schema. Snapshot taken
      first; SQL + the Drizzle tracking row applied in one transaction; resulting
      schema verified **byte-identical** to the migrator-applied local schema
      (columns, defaults, and all three `indexdef` strings incl.
      `NULLS NOT DISTINCT`). Production now 18/18, 39 indexes, data untouched
      (3 / 858 / 6,175). Procedure: `docs/BACKUP-RESTORE-DRILL.md` →
      _Applying a migration by hand_.

- [ ] **4. Deploy web + Teams bot** — Azure/Entra registrations + Railway + Teams packaging. **See `docs/TWK-AZURE-DEPLOY-RUNBOOK.md`** (covers both surfaces, incl. the new `BOT_OAUTH_CONNECTION_NAME` the bot needs). Code is done; this is portal/infra work.
- [ ] **5. Docs-gap-digest privacy decision** — whether to retain question text for the weekly digest (a real privacy tradeoff; Marcus's call). Safe aggregate-only version already built.
- [ ] **6. Baseline diary** — capture Chris's "interrupt" baseline _before_ anyone uses the bot.

### P2

- [ ] **7. Real CPA eval questions with Doug** — the gold set that unblocks reranker/tuning decisions (harness already runs against a real embedder; questions are the missing input).
- [ ] **8. Audit-log off-host destination + retention window** — decision, then small config.
- [ ] **9. Classifier build-vs-buy** — deferred; nothing depends on it.
- [ ] **10. Reset the shared local dev Postgres** — local-dev hygiene only; not production.

---

## New requirement surfaced by the Teams bot build

The Teams bot added one deployment input beyond the web app's Entra setup:

- **`BOT_OAUTH_CONNECTION_NAME`** — the Azure Bot **OAuth connection setting** name (distinct from the SSO scope URI). Without it configured (and passing its **Test Connection** in the Azure portal), the bot authenticates no one and replies with a sign-in card to every message. Fully covered in `docs/TWK-AZURE-DEPLOY-RUNBOOK.md` §4.
- The bot must run **single-instance** (it uses `MemoryStorage` for the SSO exchange) — fine for a firm-scale pilot.

---

## Doc-accuracy corrections (truth-up)

- **`docs/DEPLOYMENT-TARGET.md` is stale.** It records "single VM + docker-compose" (a 2026-06-14 decision), but the system actually runs on **Railway** (per `docs/TWK-MANUAL-RUNBOOK.md` items 3–4 and the `railway.json` deploy configs on each app). Treat Railway as the live target; the VM+compose file (`docker/compose.prod.yml`) remains a valid self-host option but is not what's deployed.
- **Plan checkboxes are not a status source.** `PLAN-TWK-READINESS-AUTOMATABLE.md` and `PLAN-LAUNCH-READINESS.md` have mostly-unchecked boxes despite the work being complete — they were execution guides, not trackers. **This file is the status source; the manual runbook is the remaining-work source.**

---

## Where things live

| Concern                                        | Doc                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Remaining human/legal/infra work               | `docs/TWK-MANUAL-RUNBOOK.md`                                               |
| How to deploy (Azure + Railway, both surfaces) | `docs/TWK-AZURE-DEPLOY-RUNBOOK.md`                                         |
| Staff-facing "how to use the bot"              | `docs/TWK-STAFF-BOT-ONE-PAGER.md`                                          |
| Teams bot design + plan                        | `docs/superpowers/{specs,plans}/2026-07-16-teams-bot*`                     |
| Architecture / connectors / API                | `docs/ARCHITECTURE.md`, `docs/CONNECTORS.md`, `docs/API.md`, `docs/MCP.md` |
