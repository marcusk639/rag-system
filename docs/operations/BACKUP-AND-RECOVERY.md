# Backup Schedule — Internal SharePoint KB

**Status:** 🟡 **Stopgap LIVE since 2026-08-01** — nightly backups are running to
Railway's own bucket. The permanent, decorrelated destination (SharePoint) is
**blocked on Chris's admin consent**. See
[Where this actually stands](#where-this-actually-stands).
**Closes:** the open half of P0 gate #3 in [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md).
**Prerequisite reading:** [`BACKUP-RESTORE-DRILL.md`](./BACKUP-RESTORE-DRILL.md) — a
restore is already proven to work on real production data. What is missing is a
backup to restore _from_.

> **The one-sentence version.** Two layers: Railway **volume backups** (15
> minutes, dashboard, do today) for corruption and bad migrations, plus a
> nightly **`pg_dump` shipped off Railway** for the failures volume backups
> structurally cannot cover.

---

## What is actually being protected

The database holds the firm's internal SharePoint knowledge base after ingestion.
Most of it is **re-derivable** — but not all of it, and the difference is what
sets the schedule.

| Content                                          | Recoverable without a backup?                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `documents`, `chunks`, embeddings                | **Yes** — re-sync SharePoint. Costs embedding spend and hours, loses no information |
| `audit_log`                                      | **No.** The §7216 / Circular 230 evidence trail. No upstream copy exists            |
| `answer_feedback`                                | **No.** Staff-supplied signal, nowhere else                                         |
| `staff_source_assignments`, `client_assignments` | **No.** Access-control config; reconstructable only by hand, from memory            |
| `ingest_log`, `docs_gap_digest_runs`             | **No.** Operational history                                                         |

**So the backup exists for the audit log first and the KB content second.** That
inverts the intuition — the 6,175 chunks are the bulk of the bytes and the least
of the risk.

**Classify the backup at least as high as the KB itself.** A dump contains the
full KB text plus staff identities and question text from the audit log. It is
**Class A/B**, POL-01 is still unadopted, and it must be treated as firm data
wherever it lands. This is the constraint that decides Step 0.

**Current size:** 123 MB raw, **35.5 MB gzipped** (measured 2026-07-31). Thirty
daily copies is roughly 1 GB. Cost is not a factor in any of the decisions below.

---

## Where this actually stands

| Layer                               | Covers                                       | Status                                      |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Restore procedure                   | —                                            | ✅ Proven on production data                |
| Railway **volume backups**          | Corruption, bad migration, accidental delete | ✅ **Enabled 2026-08-01** (Daily + Weekly)  |
| Nightly `pg_dump` → Railway bucket  | The above **+ a volume wipe**                | 🟡 **LIVE — stopgap**, `0 8 * * *` UTC      |
| Nightly `pg_dump` → **off-Railway** | Project / account / provider loss            | ⛔ **Blocked on Chris** — admin consent     |
| pgBackRest WAL archiving (PITR)     | Point-in-time rewind; ~60s RPO               | ✅ **LIVE 2026-09-02** — see below          |
| Restore FROM pgBackRest             | The PITR claim itself                        | ✅ **PROVEN 2026-09-02** — manual/root only |
| Monitoring (dead-man's switch)      | Silent failure of all the above              | ⬜ `HEARTBEAT_URL` unset                    |
| Retention decision                  | §7216 / Circular 230                         | ⬜ Counsel, with P2 #8                      |
| Restore from a scheduled artifact   | The claim itself                             | ✅ **PROVEN 2026-10-02** — see below        |

### ✅ Restore from a scheduled artifact — done 2026-10-02

This is the row the runbook meant by _"a restore has been watched succeed from an
artifact **nobody took by hand**."_ It is now done, and it was never blocked on
Chris — only the off-Railway **destination** is.

**The artifact.** `backups/kb-2026-10-01T080156Z.sql.gz`, 1.2 MiB, written by the
`rag-backup` cron (`0 8 * * *` UTC) with no human involvement. 31 artifacts are
present, daily and unbroken from 2026-09-01 to 2026-10-01.

**Procedure.** Downloaded with the service's own credentials, restored into a
throwaway `pgvector/pgvector:pg16` container on port 55433 under
`psql -v ON_ERROR_STOP=1`, verified, then container and artifact destroyed.
Production was never written to.

| Check                                   | Result                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| gzip stream intact                      | ✅ `gzip -t` clean                                               |
| Dump contains `CREATE EXTENSION vector` | ✅                                                               |
| Restore under `ON_ERROR_STOP=1`         | ✅ **exit 0, zero ERROR/FATAL lines**                            |
| Public base tables                      | ✅ **13**                                                        |
| Row counts                              | ✅ sources 1 · documents **47** · chunks **210** · audit_log 132 |
| pgvector extension                      | ✅ `0.8.6`                                                       |
| `chunks.embedding` still a real vector  | ✅ **`vector(768)`** — not degraded to text/array                |
| Indexes restored                        | ✅ **39**, incl. 1 HNSW + 4 GIN                                  |
| Distinct embedding models               | ✅ **1** (`gemini-embedding-001`) — no mixed-model contamination |
| Vector ANN query executes               | ✅ 3 rows, self-distance `0.000000`                              |

`documents 47 / chunks 210 / 39 indexes / 13 tables` match the production index
state recorded elsewhere in this runbook and in `PILOT-LAUNCH-STATUS.md`.
`audit_log` has grown 28 → 132 since the 2026-09-02 pgBackRest restore, which is
expected.

⚠ **What this does NOT prove.** Parity against _live_ production was not checked:
`DATABASE_URL` resolves `rag-postgres.railway.internal`, and `rag-postgres`
exposes no `DATABASE_PUBLIC_URL`, so the live database is unreachable from a
workstation — correct posture, but it means the comparison is against the
documented index state rather than a live count taken at the same moment. The
artifact is also **unencrypted firm data**: it existed on a workstation only for
the duration of the drill and was deleted immediately after.

⚠ **Two rows above this one are still genuinely open, and neither is the restore.**
`HEARTBEAT_URL` is unset, so every layer here can fail silently — a cron that
never fires produces no error because there is no run. And the off-Railway
destination still needs Chris's admin consent; `S3_BUCKET` /`S3_ENDPOINT` /
`BACKUP_DEST=s3` are all set and working, but they point at the Railway-hosted
bucket, which does not survive the project-loss scenario the second layer exists
for.

🟡 **What "stopgap" means concretely.** Backups now run nightly and land in
Railway's own `rag-documents` bucket under `backups/`. That bucket lives in the
same project as the database it protects, so it does **not** survive project
deletion, account loss, or a Railway-level failure — the exact scenarios the
second layer exists for. It _does_ cover corruption, a bad migration, and a
volume wipe (which destroys Railway's volume backups along with the volume).
Strictly better than nothing, and **not** the finished state.

⚠ **The stopgap is currently unencrypted** (`AGE_RECIPIENT` unset — the job logs
a warning every run so this stays visible). The reasoning: the bucket already
holds the KB's original documents under the same credentials, so the marginal
new exposure is the `audit_log`. Encryption without a firm-controlled home for
the private key trades a disclosure risk for a total-loss risk, and a key on a
workstation is not a key that survives the disaster it guards against. **Revisit
encryption as part of the SharePoint cutover**, when a real key home exists.

✅ **pgBackRest WAL archiving — LIVE since 2026-09-02.** `rag-postgres` runs
Railway's `ghcr.io/railwayapp-templates/postgres-ssl:16.14`, which bundles
pgBackRest. Archiving is enabled and verified:

|                   |                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Destination       | Railway bucket `rag-documents` (real S3 name `rag-documents-yivrrpkniny`), prefix `/pgbackrest/cluster-7652162958315024418` |
| Endpoint          | `https://t3.storageapi.dev` (Tigris), region `auto`, virtual-host URI style                                                 |
| First full backup | `20260902-191553F` — 114.9 MB logical, **52.8 MB** in-repo (zstd-3), 1,873 files, 14s                                       |
| Schedule          | watcher polls 60s; full every 7d, differential every 24h                                                                    |
| Retention         | 4 fulls, 14 diffs (`WAL_BACKUP_RETENTION_FULL` / `_DIFF` defaults)                                                          |
| RPO               | `archive_mode=on`, `archive_timeout=60` → **~60 seconds**                                                                   |

Config lives in six variables on `rag-postgres`: `WAL_ARCHIVE_BUCKET`,
`WAL_ARCHIVE_ENDPOINT`, `WAL_ARCHIVE_REGION`, `WAL_ARCHIVE_S3_URI_STYLE`,
`WAL_ARCHIVE_KEY`, `WAL_ARCHIVE_SECRET`. `WAL_ARCHIVE_PATH` is left at its
`/pgbackrest` default, which keeps it clear of the KB documents and the nightly
`backups/` prefix in the same bucket.

⚠ **Two dependencies that are easy to break.**

1. pgBackRest connects as `pg1-user=${PGUSER:-postgres}` / `pg1-database=${PGDATABASE:-postgres}`.
   This deployment's superuser is `rag`, so it only works because a separate
   `postgres` superuser role exists. **Dropping that role silently disables
   backups** — the database keeps serving traffic.
2. `WAL_ARCHIVE_BUCKET` must be the S3 bucket name, not the Railway bucket ID.
   The entrypoint refuses UUID-shaped names outright (`uuid-shape`, override
   `WAL_ARCHIVE_BUCKET_ALLOW_UUID=1`) precisely to catch that mix-up.

**What this does and does not cover.** It closes the _rewind_ gap: an
irreversible mistake — a bad migration, or a source deletion cascading through
`documents.source_id ON DELETE CASCADE` — is now recoverable to a chosen second
rather than only to the previous 08:00 UTC dump. It does **not** decorrelate:
the bucket lives in the same Railway project as the database, so project
deletion or account loss still takes both. The off-Railway row above remains
open. (Mild mitigation: the bucket is Tigris-backed, not Railway compute, so a
Railway _infrastructure_ failure is not automatically a bucket failure.)

**Keep the nightly `pg_dump`.** It is a logically independent, format-independent
second layer — pgBackRest failures and `pg_dump` failures do not correlate, and a
plain SQL dump is restorable without pgBackRest present.

✅ **PITR is PROVEN — but only via a manual, root-run restore. The image's
automated restore path is broken.** Drilled 2026-09-02 against production backup
`20260902-191553F`.

**The proof.** A marker table was planted in production's `postgres` database
(deliberately outside the `rag` schema): row `before` at 19:40:01.976122+00, target
recorded at 19:40:10.243888+00, row `after` at 19:40:13.266171+00, then six filler
commits. Restored to the target, the fork contained **exactly one row**:

```
 id |  tag   |              at
----+--------+-------------------------------
  1 | before | 2026-09-02 19:40:01.976122+00
```

`pg_last_committed_xact()` = `305156 @ 19:40:06.071533+00` — after `before`, before
the target. Restored `rag`: 47 documents, 210 chunks, 28 audit_log, 1 source,
`vector 0.8.6`, HNSW probe returns rows. **The backups are good and point-in-time
targeting is accurate to the second.**

⛔ **The defect.** The image's own restore path fails with:

```
WARN: unknown group 'root' in backup manifest mapped to current group
ERROR: [088]: unable to set ownership for '.../postgresql.auto.conf': [1] Operation not permitted
```

Root cause: the Railway volume root `/var/lib/postgresql/data` is `root:root`, so a
PGDATA created beneath it inherits group `root`. pgBackRest _creates_
`postgresql.auto.conf` during restore (it writes the recovery options there), the file
inherits group `root`, and pgBackRest then chowns it to match the manifest — which
requires privilege. `wrapper.sh` runs `gosu postgres pgbackrest ... restore`, i.e.
unprivileged, so it gets EPERM. Run as root, the identical restore completes:
`restore size = 114.9MB, file total = 1873, completed successfully`.

⚠ **The failure also wedges the volume permanently.** After the aborted restore, PGDATA
holds partial files but no `PG_VERSION`/`pg_control`. The restore gate tests only those
two, so it retries and fails forever; `initdb` sees a non-empty directory and refuses
(`directory ... exists but is not empty`). Neither path can proceed — infinite crash
loop. Recover by pointing `PGDATA` at a _fresh_ subdirectory rather than deleting.

### Manual PITR recovery procedure (the one that works)

1. New service, image `ghcr.io/railwayapp-templates/postgres-ssl:16.14`, fresh volume at
   exactly `/var/lib/postgresql/data`. Set `PGDATA` to a subdirectory of it.
2. Set `WAL_RECOVER_FROM_BUCKET` / `_ENDPOINT` / `_REGION` / `_KEY` / `_SECRET`, plus
   **`_S3_URI_STYLE=host`** and **`_PATH=/pgbackrest/cluster-<system-id>`** (the cluster
   anchor — the `/pgbackrest` default will not find the repo; read it from
   `pgbackrest info` or the `.pgbackrest_repo_path` marker).
3. Set **no** `WAL_ARCHIVE_*` — that absence is what stops the fork archiving into
   production's repo. And leave `POSTGRES_RECOVERY_TARGET_TIME` **unset**, so the
   container boots instead of crash-looping on the broken automatic path.
4. `railway ssh` in (the container runs as root). Write a pgbackrest config from the
   `WAL_RECOVER_FROM_*` env vars, then `chown postgres:postgres` + `chmod 0600` it —
   `restore_command` runs as `postgres` and cannot read a root-owned config
   (`ERROR: [041]: unable to open file ... Permission denied`).
5. As **root**, into a fresh empty path:
   `pgbackrest --config=<conf> --stanza=main --pg1-path=<new> --recovery-option=restore_command="pgbackrest --config=<conf> --stanza=main archive-get %f %p" restore --type=time --target="<ts>" --target-action=promote`
6. `gosu postgres pg_ctl -D <new> -o "-p 5433" start`. Replay fetches WAL from S3 and
   promotes; allow several minutes. `pg_ctl -w` can outlast an SSH session — it
   daemonizes, so reconnect and poll `select pg_is_in_recovery()` until `f`.
7. Verify before trusting it, then repoint applications.

**Upstream:** worth filing against `railwayapp-templates/postgres-ssl` — automated PITR
restore cannot succeed on a Railway volume as shipped.

---

## Step 0 — Decide where the dumps go ⛔ RESOLVED 2026-08-01

**This is a firm decision, not a personal one.** Verified rather than assumed —
see the tenant check below.

**Decision: SharePoint, via an app registration scoped `Sites.Selected`.**
Azure Blob was the original recommendation and is the better-shaped tool, but it
is unreachable: the firm has no Azure subscription, and creating one is a purchasing
decision. SharePoint needs only admin consent — no spend, no PO — and folds into
the Entra consent conversation Chris must have anyway for the web app and Teams
bot.

⚠ **Do not ship these dumps to a personal cloud account.** It is the same
problem already flagged for the firm's SOP folder in the consulting repo: firm data in
an individual's account, outside firm control, surviving past any engagement.
The convenience is real and the exposure is worse. Marcus's _firm_ OneDrive is
not the same thing as a personal account — but it is still tied to one person's
identity and dies with their deprovisioning, so it is not the answer either.

### ✅ Tenant reality, checked 2026-08-01 — this changes the recommendation

Verified against the live tenant with `az`, signed in as
`<admin>@<tenant-domain>`:

| Check                             | Result                                                   |
| --------------------------------- | -------------------------------------------------------- |
| Tenant                            | **the firm CPA** `b49c5690-ccd1-4336-9f66-52780215c4ec`  |
| Azure **subscriptions** reachable | **None.** `ERROR: No subscriptions found`                |
| Marcus's directory roles          | **None** — standard user, group memberships only         |
| Billing accounts visible          | None                                                     |
| Tenant `allowedToCreateApps`      | **`True`** — standard users may create app registrations |

**The distinction that matters:** an Entra/M365 **tenant** is not an Azure
**subscription**. Microsoft 365 licences include the former, never the latter.
App registrations (what the web app and Teams bot need) live in the tenant and
cost nothing. **Storage accounts require a subscription with billing attached** —
so Azure Blob is not reachable today, and no amount of permission-fixing changes
that. Someone has to create a subscription and attach a payment method.

**Consequence: prefer SharePoint over Azure Blob as the destination.** Both need
Chris. But they need _different_ things from him, and the sizes are not close:

| Destination       | What Chris must do                                                            | Spend                                     |
| ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| Azure Blob        | Create a subscription **and attach a payment method** — a purchasing decision | ~cents/mo, but a new billing relationship |
| **SharePoint** ✅ | **Grant admin consent** to one app registration, scoped `Sites.Selected`      | **None**                                  |

SharePoint wins on friction, not on elegance. Azure Blob is the better-shaped
tool. But Chris **already has to consent to Entra app registrations** for the web
app and Teams bot ([`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md)),
so the backup app folds into a conversation that must happen regardless — and it
carries no purchase order.

⚠ **`Sites.Selected` is the permission to ask for, not `Sites.ReadWrite.All`.**
It grants the app write access to **one named site** rather than every site in
the tenant. For a firm whose SharePoint holds internal knowledge and admin
documents, that difference is the whole argument for saying yes.

⚠ **Marcus can create the app registration but cannot consent to it.**
`allowedToCreateApps: True` covers creation only; application permissions always
require an administrator. And a cron job needs **app-only** auth — delegated
tokens expire and re-prompt for MFA, which no headless job survives. So consent
is genuinely unavoidable; there is no clever route around Chris.

---

## Step 1 — Turn on Railway volume backups (15 min, do today)

Independent of Step 0, and worth having before anything else changes.

1. Railway dashboard → project **rag-system** → environment **production**
2. Click the **`rag-postgres`** service → **Backups** tab
3. Enable **Daily** (kept 6 days) **and** **Weekly** (kept 1 month) — multiple
   schedules can run on one volume, so take both
4. Take one **manual** backup now, so a recovery point exists immediately

Incremental and copy-on-write; on an 85 MB volume the billed increment is noise.

**Know the limits before relying on it.** From
[Railway's docs](https://docs.railway.com/volumes/backups): restores land **only
in the same project and environment**, and **wiping the volume deletes every
backup with it**. Restoring also stages a change that must be reviewed and
deployed — it is not instant, and it redeploys the service.

That covers corruption, a bad migration, an accidental `DROP`. It does **not**
cover project deletion, account loss, or a Railway-level failure. Hence Step 3.

⚠ **There is no CLI or API path for this** — `railway volume` exposes no
snapshot subcommand. It has to be a human in the dashboard, which also means
nobody can verify it from a script later. Screenshot it once enabled.

---

## Step 1.5 — ✅ DONE: the stopgap is deployed

Recorded so nobody re-does it. Service `rag-backup` exists in the `rag-system`
project, production environment.

| Setting              | Value                                                 |
| -------------------- | ----------------------------------------------------- |
| Config file          | `services/backup/railway.json`                        |
| `BACKUP_DEST`        | `s3` (Railway bucket — stopgap)                       |
| `BACKUP_NAME_PREFIX` | unset → `kb` (artifact FILENAME prefix)               |
| `BACKUP_PREFIX`      | unset → `backups` (upload FOLDER — a different thing) |
| Cron                 | `0 8 * * *` UTC = 3 a.m. CDT / 2 a.m. CST             |
| Restart policy       | **NEVER** — see below                                 |
| Credentials          | Railway **reference variables**, no literals          |

> `BACKUP_NAME_PREFIX` and `BACKUP_PREFIX` are two different identifiers and
> are easy to confuse. The first names the FILE (`<prefix>-<stamp>.sql.gz`);
> the second names the upload FOLDER. Setting the wrong one relocates every
> backup to a folder no verification step, retention rule, or restore glob is
> watching — while the job still exits 0 and the heartbeat still fires. If you
> change either on a deployment with existing archives, re-run the
> verification listing in both the old and the new location.

First run 2026-08-01: dumped **35,551,090 bytes**, gzip verified, uploaded
the artifact `<prefix>-2026-08-01T051051Z.sql.gz` (**33.9 MiB** confirmed present
in the
bucket), container exited **Completed**. That run predates
`BACKUP_NAME_PREFIX`, so the stored object carries the prefix hard-coded at the
time — look it up in the bucket rather than assuming today's default.

⚠ **Two settings here look wrong and are not.** `restartPolicyType: NEVER`,
because a restart-looping failure keeps the deployment **Active** and Railway
**skips scheduled runs while a previous one is still Active** — a crash-looping
backup would silently suppress every future backup. And the cron was only
enabled _after_ a manual run exited `Completed`, because scheduling a job that
never terminates is how you get zero backups and a green dashboard.

**Credentials use Railway reference variables** (`${{rag-postgres.POSTGRES_USER}}`,
`${{rag-api.OBJECT_STORE_ACCESS_KEY_ID}}`, …) rather than pasted literals, so
they exist in exactly one place and rotate automatically. Note `rag-postgres`
exposes **no `DATABASE_URL`** — it must be composed from
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `RAILWAY_PRIVATE_DOMAIN` / `POSTGRES_DB`.

---

## Step 2 — The ask to Chris ⛔ BLOCKING the real destination

Everything below waits on one admin action. **Marcus can create the app
registration; only an administrator can consent to it.**

### 2a. What to ask for

> An app registration in the firm's tenant needs **admin consent** for a single
> Microsoft Graph application permission — **`Sites.Selected`** — plus write
> access granted to **one** SharePoint site used only for KB backups. No Azure
> subscription, no cost, nothing else in the tenant becomes reachable.

Why this framing works, and why it is honest:

- **`Sites.Selected` is not broad access.** Unlike `Sites.ReadWrite.All`, it
  grants nothing by default — an admin then grants the app write access to
  specific sites, one at a time. For a firm whose SharePoint holds internal
  knowledge and admin documents, that distinction is the entire basis for
  agreeing.
- **It bundles.** Chris already has to consent to Entra app registrations for
  the web app and the Teams bot
  ([`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md)). This is one
  more item in a conversation that must happen, not a new one.
- **It costs nothing.** Worth saying explicitly and early — "we need somewhere
  to put backups" sounds like a procurement request, and this one is not.

If Chris would rather stand up an Azure subscription, that is a _better_
technical answer and the service already supports it (`BACKUP_DEST=azure`, needs
only a container SAS). It is offered as his choice, not argued against.

### 2b. Create the app registration (Marcus, no admin needed)

Tenant policy allows it — `allowedToCreateApps: True`, verified 2026-08-01.

```bash
az ad app create --display-name "the knowledge base Backup" --sign-in-audience AzureADMyOrg
az ad sp create --id <appId>                    # service principal
az ad app credential reset --id <appId> --years 1   # capture the secret ONCE
```

⚠ **The client secret is shown once and has a hard expiry.** Put the expiry date
in a calendar reminder now — a lapsed secret fails silently, exactly like a
lapsed SAS, and Step 4 is what catches it.

### 2c. What Chris does (two clicks, needs Global Admin or Privileged Role Admin)

1. Entra admin centre → **App registrations** → **the knowledge base Backup** → **API
   permissions** → add **Microsoft Graph → Application permissions →
   `Sites.Selected`** → **Grant admin consent**
2. Grant the app write access to the one backup site — via Graph:
   `POST /sites/{site-id}/permissions` with role `write` and the app's id

### 2d. Then create the site and switch over

Create (or pick) a SharePoint site that holds **only** backups — not the KB
source site. Get its id, then:

```bash
railway variables --service rag-backup \
  --set 'BACKUP_DEST=sharepoint' \
  --set 'GRAPH_TENANT_ID=b49c5690-ccd1-4336-9f66-52780215c4ec' \
  --set 'GRAPH_CLIENT_ID=<appId>' \
  --set 'GRAPH_CLIENT_SECRET=<secret>' \
  --set 'GRAPH_SITE_ID=<site-id>' \
  --set 'GRAPH_FOLDER=kb-backups'
```

The uploader is already written and validated at startup — no code change is
needed at cutover. Revisit `AGE_RECIPIENT` at the same time, once the private
key has a firm-controlled home.

---

## Step 3 — First run and verification

Trigger manually rather than waiting for 3 a.m.

```bash
railway redeploy --service rag-backup
railway logs --service rag-backup
```

Expected, in order:

```
[backup] start <stamp> -> sharepoint
[backup] dump complete: ~35500000 bytes
[backup] gzip integrity OK
[backup] encrypted -> kb-<stamp>.sql.gz.age
[backup] uploaded kb-<stamp>.sql.gz.age -> sharepoint/kb-backups
[backup] heartbeat sent
[backup] done
```

Then **confirm the file is really there, with a plausible size.** A zero-byte or
2 KB artifact is a failed backup that reported success. For the s3 stopgap:

```bash
railway run --service rag-backup -- docker run --rm \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e S3_ENDPOINT -e S3_BUCKET \
  --entrypoint bash rag-backup-test -c \
  'aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://$S3_BUCKET/backups/" --human-readable'
```

`railway run` injects the service's variables into a local command, so this
verifies with the real credentials **without ever printing them**.

**Confirm the deployment shows `Completed`, not `Active`.** If it stays Active,
something is holding the process open and every later run will be skipped.

---

## Step 4 — Make silent failure impossible ⚠

**Read this even if you skip everything else optional.**

A backup job that fails quietly is _worse than no backup_, because it
manufactures confidence. Every likely failure here is silent:

| Failure                 | How it looks                                          |
| ----------------------- | ----------------------------------------------------- |
| SAS token expires       | Uploads fail. Dashboard looks fine. Nobody is told    |
| Cron never fires        | **Nothing happens at all** — no error, because no run |
| Upload hangs            | Service stays Active; Railway skips every later run   |
| Dump silently truncates | A small blob uploads "successfully"                   |

The script defends the last two directly. `backup.sh` enforces a **size floor**
(`BACKUP_MIN_BYTES`, default 10 MB against a ~35.5 MB baseline), verifies the
**gzip stream** before upload, and wraps the upload in a hard **timeout**. That
last one was added because testing showed azcopy retrying an unreachable
endpoint _indefinitely_ — which, combined with Railway's skip-while-Active
behaviour, would have stopped backups permanently while showing green.

The first two cannot be solved from inside the job — **a job that never runs
cannot report that it did not run.** That needs an external dead-man's switch:

1. Create a check at a cron-monitoring service (healthchecks.io has a free tier;
   Cronitor and Better Stack are equivalent). Period 1 day, grace 2 hours
2. Set its ping URL as `HEARTBEAT_URL`
3. `backup.sh` pings it **only on full success**, so the monitor alerts on the
   **absence** of a ping — the only construction that catches a run that never
   started
4. Point the alert at an inbox that is actually read

⚠ The monitor URL is a third-party endpoint. It receives **only** a ping — no
data, no filenames. Worth stating plainly when this goes to counsel.

---

## Step 5 — Retention is a compliance question, not a default

Do not pick a number here. **Bring it to counsel** alongside the existing
open item **P2 #8** (audit-log off-host destination + retention window) — they
are the same decision and should be answered once.

Ask specifically:

- How long must the `audit_log` §7216 / Circular 230 trail be retained?
- Does an encrypted copy in the firm's Azure tenant satisfy that, or does the
  trail need to be immutable (WORM)?
- Is there a _maximum_ retention — a point past which holding staff question
  text becomes a liability rather than an asset?

⚠ **Note the mismatch driving this.** Railway volume-backup retention tops out
at **3 months**, while tax record-retention expectations are commonly measured
in **years**. Layer 1 cannot satisfy a multi-year obligation and was never going
to. Layer 2's retention window is the one that has to be right.

Once decided, implement it in **Azure lifecycle management** (Storage account →
Data management → Lifecycle management) — a rule deleting blobs in `kb-backups`
older than N days. Do not rely on manual cleanup.

---

## Step 6 — Prove it, then the gate is closed

**A backup nobody has restored from is a hypothesis.**

Take an artifact the _schedule_ produced — not one taken by hand — and restore
it, following the production procedure in
[`BACKUP-RESTORE-DRILL.md`](./BACKUP-RESTORE-DRILL.md):

```bash
# decrypt first if AGE_RECIPIENT was used
age -d -i <age-key-file> <prefix>-<stamp>.sql.gz.age > <prefix>-<stamp>.sql.gz
# ^ <age-key-file> is whatever the private key is actually called on disk — it
#   is named per deployment and is NOT derived from BACKUP_NAME_PREFIX. Get it
#   from the vault. <prefix> is BACKUP_NAME_PREFIX, and historical artifacts
#   carry the prefix in force when they were written, not today's default.

railway ssh --service rag-postgres "createdb -U \$POSTGRES_USER rag_restore_drill"
# ... stream the dump in, then run the verification queries from the drill doc
railway ssh --service rag-postgres "dropdb -U \$POSTGRES_USER rag_restore_drill"
```

Verify what row counts miss: pgvector extension present, `embedding` still a
real `vector` type, **index count matches** (39 as of 2026-07-31, incl. HNSW +
GIN + tsvector), and an ANN query returns a real distance spread.

**Done when:** a restore has been watched succeed from an artifact **nobody took
by hand**. Until then P0 gate #3 is half-open, whatever the checkbox says.

---
