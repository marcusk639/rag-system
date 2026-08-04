# TWK KB — Launch Status (current source of truth)

**Updated:** 2026-08-03 — P0 gate #1 is a **live finding** (client-identifying
material confirmed in the index); gate #3 is **partially closed**, not closed.
Engineering table last verified 2026-07-16.

> ⛔ **Read first (2026-08-03).** Two things supersede everything below them:
>
> 1. **The content audit ran and found client PII already in the live index.**
>    This retires every "no client data" statement previously in this file. See
>    [P0 gate #1](#p0--hard-gates-internalunapproved-pilot-only-until-done).
> 2. **Closing gate #1 needs code**, not only firm judgment — connector
>    exclude-paths, a citation/metadata fix, and an ingest-time gate. The
>    "launch is gated on human/legal/infra work, not engineering" framing below
>    is **no longer accurate** and is retained only as the record of what was
>    believed on 2026-07-16.

**Purpose:** One page that reflects what is _actually_ true right now, verified against the code — not what a plan's checkboxes claim. This project has a documented history of stale "resolved" claims creating false confidence; cross-check anything surprising against the tree before trusting it.

> **On the dated blocks in this file.** `AMENDED` / `CORRECTED` / `UPDATED` all do
> the same thing: quote the superseded claim, say why it was wrong, state what is
> true now. Read the newest date as authoritative.

---

## One-line status

⚠ **Superseded on two counts — see Read first, above.**

**(As of 2026-07-16)** The code is done and merged; launch is gated on human/legal/infra work, not engineering. All three staff surfaces (web app, MCP, Teams bot) are built, reviewed, and on `main`. What remains are the P0 gates and the Azure/Railway stand-up — none of it is code.

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

## What remains for launch — the critical path (mostly human/infra/legal; gate #1 also needs code)

Tracked in detail in `docs/TWK-MANUAL-RUNBOOK.md`. ⚠ **Corrected 2026-08-03:**
this section previously read _"(all human/infra/legal) … Nothing here is a code
task."_ That held until the content audit ran. Gates #2 and #3 are still purely
human/infra/legal; **gate #1 is not** — see its entry.

### P0 — hard gates (internal/unapproved pilot only until done)

- [ ] **1. Content audit** — ⚠ **IN PROGRESS WITH A FINDING (2026-08-03), not unstarted.** The deterministic client-identifier screen has now run against all 858 documents and found client-identifying material in the index (full correction **below**, under _Fastest defensible path_). ⛔ **Remediation has not started:** Phase 1 Task 1.1 — removing the flagged roster from the index — is an unchecked box, so assume it is still retrievable through the live deployment. Beyond that, closing this gate is **not** purely human work despite this file's "none of it is code" framing: it needs connector exclude-paths, a metadata/citation fix, and an ingest-time gate. The human half is a firm reviewer ruling on the residual. `superpowers/plans/2026-08-03-kb-content-boundary.md` sizes this at ~97 documents needing genuine review once structural folder exclusion removes the rest, and supplies the review instrument. Still firm domain judgment, still Chris/Doug, still not an attorney.
- [ ] **2. Counsel + carrier sign-off** — §7216/Circular 230/GLBA; the Google DPA is still "PROVISIONAL — NOT COUNSEL-CONFIRMED." (Attorney required.)
- [ ] 🟡 **3. Backup/restore drill — HALF-OPEN.** The _restore_ leg is proven; the _backup schedule_ is a stopgap and the off-Railway destination is blocked. `BACKUP-SCHEDULE-RUNBOOK.md` states it plainly: _"a restore has been watched succeed from an artifact **nobody took by hand**… Until then P0 gate #3 is half-open, whatever the checkbox says."_ Marking this `[x]` was exactly the stale-resolved-claim pattern this file exists to prevent. Open items are enumerated once, at the end of this entry. What **is** done, 2026-07-31, both legs: Local:
      fresh-instance restore + **88/88 e2e against restored data**. Production: real
      data (858 docs / 6,175 chunks) dumped and restored **entirely inside Railway**
      via `railway ssh` — nothing copied off their infrastructure — exit 0 in 4s,
      **36/36 indexes** incl. HNSW, pgvector v0.8.2 intact, ANN query verified over
      all 6,175 chunks. Production confirmed untouched; throwaway dropped.
      Full write-up: `docs/BACKUP-RESTORE-DRILL.md`. Setup procedure for the
      missing schedule: `docs/BACKUP-SCHEDULE-RUNBOOK.md`.
      ✅ **UPDATED 2026-08-03 — the schedule now exists.** This entry previously
      read _"A restore is proven; a backup schedule is not,"_ and listed enabling
      Railway volume backups as "do this now, it is checkboxes." Both have since
      been done. Per
      [`BACKUP-SCHEDULE-RUNBOOK.md`](./BACKUP-SCHEDULE-RUNBOOK.md):
      **(1)** Railway **volume backups** — ✅ enabled 2026-08-01 (Daily + Weekly).
      **(2)** nightly **`pg_dump`** — 🟡 **LIVE as a stopgap** (`0 8 * * *` UTC),
      landing in Railway's own bucket. The permanent, decorrelated off-Railway
      destination is ⛔ **blocked on Chris's admin consent** — volume backups
      restore only into the same project + environment, so they do not cover
      project/account/provider loss.
      Still open: a dead-man's-switch (`HEARTBEAT_URL` unset), a restore _from a
      scheduled artifact_ (the drill restored a hand-taken dump), and the
      `audit_log` retention window — a **counsel** question (ties to P2 #8), not a
      default; volume-backup retention tops out at 3 months.

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

⚠ **Still pilot-scoped — but scope is now doing more work than it was.** Named
users only. **Corrected 2026-08-03:** this passage previously read _"Class A/B
sources only, no client data. P0 #1 (the content audit) is unchanged and is still
the real gate."_ Both halves are now wrong. Client-identifying material **is**
present in the live index (see the correction under _Fastest defensible path_
below and P0 gate #1 above), so "Class A/B only" is a remediation target rather
than a description, and gate #1 is **not** unchanged — it is a live finding.

⛔ **The exposure is live, not theoretical.** This deployment is auth-gated but
serving named pilot users right now, and per
[`superpowers/plans/2026-08-03-kb-content-boundary.md`](./superpowers/plans/2026-08-03-kb-content-boundary.md)
§0b a client-named document title reaches the UI as a **citation**, bypassing the
model entirely — so the system prompt's do-not-repeat-client-names rule cannot
stop it. Phase 1 Task 1.1 (removing the flagged roster from the index) is
**still an unchecked box**. Until it is executed, assume the roster is
retrievable.

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
general` (844 + 14 + 0 docs), and nothing is connected to Onvio, the Z Drive, or
QuickBooks. That connection scope still holds and is still the strongest part of
the compliance story.

> ### ⛔ CORRECTED 2026-08-03 — "this corpus has none" was wrong
>
> This paragraph previously read _"internal KB content, **no client files, no
> Onvio, no QuickBooks**. §7216 attaches to taxpayer data; this corpus has none,
> which is why a scoped pilot is defensible without counsel sign-off."_ **The
> first and third claims are falsified.** The `no Onvio / no QuickBooks` half
> stands — that is a connection fact. The `no client files` half does not.
>
> The client-identifier screen (`corpus-analysis/`) ran against the full
> 858-document production corpus and found **355 documents carrying at least one
> pattern hit**, including per-client billing and production analyses under
> client-named folders, client fee/scope deliverables, engagement letters, and
> **one indexed spreadsheet holding 522 SSN-shaped and 518 EIN-shaped values** —
> a client roster. 17 documents carry SSN/EIN/bank-account hits.
>
> **The hedge below was right and the conclusion above was wrong.** `general` was
> the ingestion default, nobody had checked, and when the check was finally run it
> came back the other way. Note what this does _not_ change: the connection scope
> is unchanged, and no client data reached a third-party model that was not
> already reachable. What it changes is that **P0 gate #1 is now a live finding
> with remediation in flight, not an unstarted formality** — and the sentence
> "a scoped pilot is defensible without counsel sign-off" can no longer rest on
> the corpus being clean.
>
> Remediation plan, including removal of the roster and structural folder
> exclusion: [`superpowers/plans/2026-08-03-kb-content-boundary.md`](./superpowers/plans/2026-08-03-kb-content-boundary.md).
> The same premise appeared in four other documents. All four were corrected on
> 2026-08-03: `PROTOTYPE-DELIVERY-OPTIONS.md`, `TWK-STAFF-BOT-ONE-PAGER.md`,
> `PLAN-LAUNCH-READINESS.md`, and `DECISION-CPA-KB-RAG-CONVERGENCE.md`.

⚠ `general` was the ingestion _default_, never a verified judgment — which is
exactly why the screen was run, and why it came back the way it did. **Gate #1
above is the real compliance action.** Its firm-judgment half needs Chris/Doug,
not an attorney; its remediation half needs code.

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
