# Teams MVP — what is actually required

**Written:** 2026-09-12 · **Verified against production and the tree on that date.**

One page answering a single question: what stands between today and staff
asking the knowledge base questions from Microsoft Teams.

Every "done" row below was checked by execution, not inferred from a plan.
Every "required" row names an owner, because the remaining work is almost
entirely not engineering.

---

## Definition of done

A named pilot user opens Teams, messages the bot a real firm question, and gets
a cited answer scoped to the sources they personally have access to — with the
query recorded in `audit_log`.

That is the bar. Not "the bot is deployed"; not "the code is merged".

---

## Already done — do not redo

| Capability             | State                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Bot code               | Complete, reviewed, merged. 60 unit tests.                                                                                 |
| Bot container          | Builds from the repo root (exit 0, 488 MB), boots, serves `GET /health` 200                                                |
| Railway port handling  | Honours the injected `PORT`; the trap that broke `rag-api`'s healthcheck does not apply                                    |
| Teams app package      | `pnpm --filter @rag/teams-bot package` renders and validates the manifest, emits the uploadable zip                        |
| Retrieval + generation | 51/51 probe questions answered, 0 invalid citations, 4/4 correct refusals (`scripts/check-kb-grounding.mjs`)               |
| Index                  | 47 documents, all Class A, TRI-screened at ingest                                                                          |
| Database TLS           | TLS 1.3 on every application connection                                                                                    |
| Backups                | Nightly `pg_dump` runs and is verified (size floor + gzip integrity + upload); PITR proven restorable via manual procedure |
| Web surface            | Live and auth-gated since 2026-08-01                                                                                       |

Full deploy steps live in [`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md).
Current gate status lives in [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md).

---

## Required — blocking

### 1. Azure subscription · owner: Chris / purchasing · **hard blocker**

An **Azure Bot is an Azure resource**, so it needs a subscription with a payment
method. The free F0 tier means **cost is not the obstacle; the absent
subscription is.**

Verified 2026-09-12: `az` reports no accessible subscription. Unknown whether
none exists or the operator merely holds no role on one — only a tenant admin
can tell those apart, and the distinction changes who has to act.

Nothing else on this list unblocks Teams chat. A tab-only surface (§6) is the
fallback if this stalls.

### 2. Azure Bot resource + Entra registration · owner: operator, once §1 lands · ~1 hour

Runbook §3 and §4. Produces the five values the bot cannot start without:

- `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_APP_TENANT_ID`
- `BOT_ENTRA_SSO_SCOPE` — the exposed API scope, `api://botid-<app id>/access_as_user`
- `BOT_OAUTH_CONNECTION_NAME` — the OAuth **connection setting name**, which is
  not the SSO scope URI

⚠ **Run Test Connection on the OAuth setting before deploying.** If it fails the
bot authenticates nobody and replies with a sign-in card to every message — a
symptom that points at the wrong thing, because it looks like a bot problem
rather than a connection-setting problem.

### 3. Content audit · owner: Chris / Doug · ~1 hour · **P0 gate**

47 documents, every one already screened by the TRI scanner and classed A. The
question is not "does this contain an SSN" — that is answered mechanically. It
is: _would it be a problem if any pilot user could read this document in full by
asking a chatbot?_

A worksheet with all 47 titles and a sign-off block is generated at
`corpus-analysis/CONTENT-AUDIT-WORKSHEET.md` (gitignored — firm content stays
out of the repo). Record the outcome in `PILOT-LAUNCH-STATUS.md` P0 #1.

This is the one gate that is cheap, load-bearing, and needs no lawyer.

### 4. Real icons · owner: whoever owns branding · ~30 minutes

`apps/teams-bot/manifest/` ships **structural placeholders** — a solid purple
square and a white circle. They satisfy Teams' schema (correct dimensions and
transparency) but are not branding. Needed: `color.png` 192×192 and
`outline.png` 32×32, transparent background.

### 5. Railway service + three reachable URLs · owner: operator · ~15 minutes

Create `rag-teams-bot` (does not exist yet — verified 2026-09-12). The runbook
carries the one-pass command block. Then set the Azure messaging endpoint to
`https://<domain>/api/messages`.

Teams validates the developer website / privacy / terms URLs **at upload time**,
so three real reachable HTTPS URLs are required before packaging.

### 6. Tenant custom-app-upload policy · owner: tenant admin · **unverified**

Sideloading a custom app requires the tenant to permit it. This has never been
confirmed either way. Worth checking early — if it is disabled, §1 and §2 do not
help, and the answer changes the plan rather than delaying it.

A ready-to-send draft, including the fallback where an admin publishes the
package to the org catalogue instead, is at
[`EMAIL-IT-TEAMS-APP-UPLOAD.md`](./EMAIL-IT-TEAMS-APP-UPLOAD.md).

---

## Required — but not blocking Teams specifically

### 7. Backup dead-man's switch · owner: operator · ~10 minutes

`HEARTBEAT_URL` is unset on `rag-backup`, so **nothing alerts if the nightly
dump stops**. Everything else about that job is carefully built — size floor,
gzip integrity check, hard timeouts on every uploader — which is exactly what
makes the silence dangerous. A free healthchecks.io check and one variable
closes it.

`AGE_RECIPIENT` is also unset, so the artifact sits in the bucket relying on
storage-side encryption only.

Not a Teams blocker. Listed because opening a new surface to more users raises
the cost of losing the index.

---

## Deliberately NOT required for this MVP

State these explicitly so nobody imports a bigger scope than the pilot needs:

- **Counsel sign-off (P0 #2).** §7216 attaches to taxpayer data. This corpus is
  47 internal Class A SOPs with none. A scoped, named-user pilot is defensible
  without it. ⚠ This stops being true the moment Onvio, client folders, or the
  Z drive enter the index, or the pilot opens past the named group.
- **Off-Railway backup destination.** Blocked on Graph admin consent, and the
  corpus can be re-synced from SharePoint in about 90 seconds. The real loss on
  provider failure is the audit log, not the knowledge base.
- **`verify-full` database TLS.** Connections are encrypted; full certificate
  verification needs the image's CA distributed to every client. Later
  hardening, not a gate.
- **The eval gold set.** Needed to tune retrieval quality, not to launch. Still
  the blocking input for any reranking or weighting decision.

---

## Go-live sequence

1. Confirm the tenant permits custom app upload (§6) — cheapest thing to learn.
2. Obtain the subscription (§1).
3. Create the Azure Bot + Entra registration; pass **Test Connection** (§2).
4. Create the Railway service, set variables, deploy, take the domain (§5).
5. Point the Azure messaging endpoint at `https://<domain>/api/messages`.
6. Drop in real icons, build the package, upload it (§4).
7. Install for yourself. DM a real question. Confirm a cited answer.
8. @mention it in a test channel. Confirm it answers only from channel-safe
   sources.
9. Confirm both queries appear in `audit_log` with `channel = 'teams'`.

Only then add pilot users, and only named ones.

---

## Traps that will bite on the day

- **Do not set `PORT`** on the Railway service. Railway injects it and probes
  that port; the bot reads it natively. Pinning `3978` means also retargeting
  the domain.
- **Keep `?sslmode=no-verify`** on the copied `DATABASE_URL`. Do not "upgrade"
  it to `require` — `pg-connection-string` treats that as `verify-full` and the
  self-signed certificate fails the connection. The opposite is true for
  `pg_dump`, which rejects `no-verify` outright.
- **Run the bot single-instance.** It uses `MemoryStorage` for the SSO exchange.
  Fine at firm scale; multi-replica needs a shared store.
- **Do not hand-edit the manifest.** The packager rejects a `botid-`-prefixed
  app id and a scope belonging to a different registration — both produce a bot
  that authenticates nobody while looking correctly configured.
- **A green healthcheck does not prove database reachability.** The bot boots
  and serves `/health` with Postgres unreachable, by design, so a transient blip
  does not wedge it in a restart loop.
