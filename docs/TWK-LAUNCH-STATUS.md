# TWK KB — Launch Status (current source of truth)

**Updated:** 2026-07-31 (P0 gate #3 closed; P1 item 0 added). Engineering table
last verified 2026-07-16.
**Purpose:** One page that reflects what is _actually_ true right now, verified against the code — not what a plan's checkboxes claim. This project has a documented history of stale "resolved" claims creating false confidence; cross-check anything surprising against the tree before trusting it.

---

## One-line status

**The code is done and merged; launch is gated on human/legal/infra work, not engineering.** All three staff surfaces (web app, MCP, Teams bot) are built, reviewed, and on `main`. What remains are the P0 gates and the Azure/Railway stand-up — none of it is code.

> ### ⚠ AMENDED 2026-08-01 — "not engineering" was too strong
>
> An end-to-end quality review found **three defects sitting directly between a
> staff question and a useful answer**, none of which a build-passes gate would
> catch. All three are now fixed, with tests and before/after measurements:
>
> |         | Defect                                                                    | Effect on a real question                                                                                                                |
> | ------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
> | **C-1** | TRI pre-flight blocked any prompt naming an IRS form near a dollar figure | Tax-procedure questions returned `500 Internal server error`. 8% of the firm's SOPs trip it; **every hit measured was a false positive** |
> | **H-1** | `plainto_tsquery` ANDs every term, so the sparse arm returned nothing     | **5 of 15** realistic staff questions got zero keyword hits — "hybrid" search ran on one arm                                             |
> | **H-7** | Citation filter only matched single-number brackets                       | An answer citing `[1, 2]` rendered with **zero sources** — silently                                                                      |
>
> Two corrections to claims made elsewhere in this file and its companions:
>
> - **The engineering go-live gate below is stale.** `pnpm typecheck` is **red on
>   `main`** (5 errors in `tests/e2e/src/specs/eval-faithfulness.spec.ts`),
>   verified pre-existing.
> - **[`EVAL-BASELINE.md`](./EVAL-BASELINE.md)'s "the corpus is too easy" finding
>   was incomplete.** The flat weight sweep was partly the H-1 bug. Post-fix the
>   sweep responds and recall@5 rises 97.1% → 100%. The gold set is still the
>   right priority; the blanket "no retrieval work until it exists" is not.
>
> Full analysis, severity-scored, incl. 20 further findings not yet actioned:
> **[`PROTOTYPE-READINESS-REVIEW-2026-08-01.md`](./PROTOTYPE-READINESS-REVIEW-2026-08-01.md)**.
> The largest unactioned gap is **no conversation memory** — follow-up questions
> ("what about for partnerships?") fail on both surfaces.

---

## Engineering — DONE (verified on `main`, 2026-07-16)

| Area                                    | State                         | Evidence                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17-task automatable readiness plan      | **Complete**                  | all artifacts exist on `main`; migrations `0000`→`0017`; `classify-source.ts`, MCP audit logging, secret-length enforcement, `staff_source_assignments`, migration guard, `EVAL-BASELINE.md` all present |
| Harness readiness (hooks, CI, coverage) | **Complete**                  | pre-commit/pre-push hooks, CI format+parser-pytest jobs, coverage tooling (`readiness-report.md`, Level 3)                                                                                               |
| Web chat app (`apps/web`)               | **Built + deploy config**     | Entra SSO, per-user scope, streaming, citations; `Dockerfile` + `railway.json` (commit `e285d89`)                                                                                                        |
| Teams bot (`apps/teams-bot`)            | **Built + reviewed + merged** | 9-task plan, whole-branch review passed; merge `fe61ad7`; 43 unit tests                                                                                                                                  |
| Eng go-live gate                        | ⚠ **Amber** (was "Green")     | `build + lint + unit` pass on `main`. **`typecheck` does NOT** — 5 errors in `tests/e2e/src/specs/eval-faithfulness.spec.ts`, verified pre-existing 2026-08-01. See review § M-7.                        |

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

### ✅ LIVE 2026-08-01 — the web app is deployed and auth-gated

`rag-web` → **https://rag-web-production-1c0a.up.railway.app** — Option 1 below,
shipped. Verified: `/api/health` 200; `/` redirects **307 → /api/auth/signin**;
an unauthenticated `POST /api/chat` returns **307, not 200** (no unauthenticated
data path). `rag-api` redeployed from current `main` and now runs the feedback
route against the migration applied earlier.

Entra objects created in the TWK tenant (within the permissions the tenant
already grants Marcus — no admin action needed):

| Object           | Value                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App registration | `TWK KB Assistant (Web)` · `c885331a-8e73-47c0-9dff-263756a81942`                                                                                                               |
| Security group   | `RAG-Admins` · `33cdedd4-61cb-465e-afe2-f37045cf243c`                                                                                                                           |
| Sign-in scopes   | `openid profile email offline_access` — **user-consentable**                                                                                                                    |
| Group claims     | `groupMembershipClaims=SecurityGroup` — ids arrive **inline in the token**, so the admin gate does **not** need the app-only Graph fallback (which would require admin consent) |

⚠ **`WEB_AUTH_MODE=static-fallback` was deliberately NOT used.** It disables
authentication entirely and issues every visitor one shared token — the firm's
internal KB on an open URL. It exists as an emergency override; it is not a
shortcut to launch.

⚠ **Still pilot-scoped, and that is what keeps it defensible.** Named users only,
Class A/B sources only, no client data. P0 #1 (the content audit) is unchanged and
is still the real gate.

#### 🔌 Port gotcha — this will bite the next service too

`rag-api`'s redeploy failed its healthcheck, and the cause is a trap worth
recording. **`packages/core/src/config.ts` resolves the listen port from
`API_PORT` only** (`Number(env.API_PORT ?? 3000)`) — it never reads `PORT`.
Railway injects **`PORT=8080`** and its V2 healthcheck probes _that_. So the app
listened on 3000 while the probe knocked on 8080 and got nothing.

It had gone unnoticed because the previous deployment's manifest carried **no
`healthcheckPath`**, so nothing ever probed it, and the **domain** had an explicit
target port of 3000 — public traffic worked fine. Applying `apps/api/railway.json`
enabled the healthcheck for the first time and exposed the mismatch.

Fixed by setting `API_PORT=8080` and `railway domain update … --port 8080`.
**Both are required** — moving the app without moving the domain returns 502.
`apps/web` is unaffected: Next.js standalone reads `PORT` natively.

**Better long-term fix (not done):** make config read `API_PORT ?? PORT ?? 3000`
so no per-service magic number is needed and any platform works.

### ⚡ Fastest defensible path to a working prototype (2026-08-01)

**The Azure blocker below stops the Teams bot, not the prototype.** Ranked
options — full reasoning in
[`PROTOTYPE-DELIVERY-OPTIONS.md`](./PROTOTYPE-DELIVERY-OPTIONS.md):

| #     | Option                                             | Blocked by                                                         | Effort                |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| **1** | **Deploy `apps/web`, pilot-scoped** ✅ recommended | **nothing** — no subscription, sign-in scopes are user-consentable | hours                 |
| 2     | Teams **personal tab** wrapping the web app        | tenant custom-app-upload setting (⚠ unverified)                    | +½ day                |
| 3     | Full Teams **bot**                                 | Azure subscription → Chris → purchasing                            | small, once unblocked |
| 4     | MCP only — **already live**                        | nothing                                                            | zero                  |

**Verified 2026-08-01:** all 3 indexed sources are SharePoint, `data_class =
general` (844 + 14 + 0 docs) — internal KB content, **no client files, no Onvio,
no QuickBooks**. §7216 attaches to taxpayer data; this corpus has none, which is
why a scoped pilot is defensible without counsel sign-off. ⚠ But `general` is the
ingestion _default_, not a verified judgment — **gate #1 below is the real
compliance action**, and it needs Chris/Doug, not an attorney.

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

- [ ] **4. Deploy web + Teams bot** — ⛔ **NEW BLOCKER (2026-08-01): the Teams bot
      needs an Azure subscription the firm does not have.** Verified against the
      tenant — `az` returns `No subscriptions found` for `marcus@twk-cpafirm.com`.
      An **Azure Bot is an Azure _resource_** (runbook §3: "Create a resource →
      Azure Bot"), so it needs a subscription with a payment method. The free F0
      tier means **cost is not the obstacle; the absent subscription is.** The web
      app is unaffected — Entra app registrations live in the tenant and are free.
      ⚠ Unverified whether no subscription exists or Marcus merely has no role on
      one; only an admin can distinguish them. Raised with Chris via the issue
      register (Conflicts #11). Azure/Entra registrations + Railway + Teams packaging. **See `docs/TWK-AZURE-DEPLOY-RUNBOOK.md`** (covers both surfaces, incl. the new `BOT_OAUTH_CONNECTION_NAME` the bot needs). Code is done; this is portal/infra work.
- [ ] **5. Docs-gap-digest privacy decision** — whether to retain question text for the weekly digest (a real privacy tradeoff; Marcus's call). Safe aggregate-only version already built.
- [ ] **6. Baseline diary** — capture Chris's "interrupt" baseline _before_ anyone uses the bot.

### P2

- [ ] **7. Real CPA eval questions with Doug** — ⬆ **ESCALATED 2026-08-01: this
      is now the single blocking input for all retrieval work.** The first
      real-embedder run proved the current corpus cannot measure quality — the
      dense/sparse sweep is _flat_, identical even at `dense=0` where embeddings
      contribute nothing. Every tuning decision (reranking, weights, chunking,
      models) is therefore **unfalsifiable** until this exists. Instrument is
      built and waiting: `tests/e2e/src/eval/twk-gold-set.ts` (empty by design,
      validated, references real production docs) + a 90-minute session guide,
      `docs/EVAL-GOLD-SET-GUIDE.md`. Original note follows — — the gold set that unblocks reranker/tuning decisions (harness already runs against a real embedder; questions are the missing input).
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
