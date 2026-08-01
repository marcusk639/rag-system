# Backup Schedule — TWK Internal SharePoint KB

**Status:** ⚠ Not yet set up. This is the procedure, not a record of it being done.
**Closes:** the open half of P0 gate #3 in [`TWK-LAUNCH-STATUS.md`](./TWK-LAUNCH-STATUS.md).
**Prerequisite reading:** [`BACKUP-RESTORE-DRILL.md`](./BACKUP-RESTORE-DRILL.md) — a
restore is already proven to work on real production data. What is missing is a
backup to restore _from_.

> **The one-sentence version.** Two layers: Railway **volume backups** (15
> minutes, dashboard, do today) for corruption and bad migrations, plus a
> nightly **`pg_dump` shipped off Railway** for the failures volume backups
> structurally cannot cover.

---

## What is actually being protected

The database holds TWK's internal SharePoint knowledge base after ingestion.
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

## Step 0 — Decide where the dumps go ⛔ BLOCKING

**This is a firm decision, not a personal one, and everything else waits on it.**

The recommended destination is **Azure Blob Storage in TWK's own Microsoft 365
tenant**:

- The firm is already a Microsoft shop — SharePoint is the KB source, Teams is
  the delivery surface, Entra is the auth. The **existing Microsoft agreement
  already covers the tenant**, so this adds no new data-processing relationship
  to paper. Any other provider does.
- It is a **different provider from Railway**, which is the entire point of the
  second layer. Decorrelated failure.
- It stays **firm-controlled**.

⚠ **Do not ship these dumps to a personal cloud account.** It is the same
problem already flagged for `docs/TWK SOPs/` in the consulting repo: firm data in
an individual's account, outside firm control, surviving past any engagement.
The convenience is real and the exposure is worse. If Azure access is slow to
arrange, the honest interim is Railway's existing `rag-documents` bucket —
explicitly a **stopgap**, since it is the same provider and therefore fails
together with the thing it is backing up. Note it as such and replace it.

**Ask Chris for:** an Azure subscription under the firm tenant (or approval to
create one), and who administers it. If TWK has no Azure subscription at all,
that is worth knowing now rather than at Step 2 — the Microsoft 365 tenant
exists regardless, but a _subscription_ for paid resources may not.

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

## Step 2 — Create the Azure destination

In the **firm's** tenant, once Step 0 is settled.

### 2a. Storage account

`portal.azure.com` → **Storage accounts** → **Create**

| Field          | Value                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| Resource group | `rg-twk-kb-backup` (create)                                              |
| Name           | e.g. `twkkbbackup` — globally unique, 3–24 chars, lowercase alphanumeric |
| Region         | Match the firm's other resources; a US region                            |
| Performance    | Standard                                                                 |
| Redundancy     | **GRS** (geo-redundant)                                                  |

**Redundancy is the one setting not to economise on.** LRS keeps all copies in a
single datacenter — which is precisely the failure a second backup layer exists
to survive. GRS replicates to a paired region.

### 2b. Container

Storage account → **Data storage → Containers** → **+ Container**

- Name: `kb-backups`
- Public access level: **Private (no anonymous access)** — confirm this; a
  public container here would expose the entire KB and audit log

### 2c. Protective settings — do these now, not later

Under **Data protection**:

- **Enable soft delete for blobs** (30 days) — survives an accidental delete
- **Enable versioning** — survives an overwrite

Consider an **immutability (WORM) time-based retention policy** on the
container. For an audit trail that exists to satisfy §7216 / Circular 230, "this
record could not have been altered" is a materially stronger claim than "we
have a copy." ⚠ Immutable blobs **cannot be deleted before their retention
expires, by anyone, including you** — which is the point, and also means the
retention length must be right before it is switched on. See Step 6.

### 2d. SAS token — least privilege matters here

Container `kb-backups` → **Shared access tokens**

| Setting     | Value                                                          |
| ----------- | -------------------------------------------------------------- |
| Permissions | **Create** and **Write** only                                  |
| Expiry      | 12 months — **and put the expiry date in a calendar reminder** |
| Protocol    | HTTPS only                                                     |

**Grant no Read, no Delete, no List.** The backup job only ever needs to add new
blobs. If the Railway service is ever compromised, a write-only credential means
the attacker can write junk but **cannot read the KB back out and cannot destroy
the backup history** — which is exactly the property that makes a backup worth
having during a security incident.

⚠ **A SAS expiry is a silent time bomb.** When it lapses, uploads start failing
while everything looks normal from the outside. This is the single most likely
way this setup dies quietly, and it is why Step 5 is not optional.

Copy the full **Blob SAS URL** — it looks like
`https://<account>.blob.core.windows.net/kb-backups?sv=...&sig=...`. That whole
string, container-scoped, is what `AZURE_SAS_URL` wants.

---

## Step 3 — Deploy the backup service

The service already exists in this repo at **`services/backup/`** —
`Dockerfile`, `backup.sh`, `railway.json`. It has been built and exercised
locally (dump, gzip integrity check, size floor, encryption, and the upload
timeout all verified); it has **not** yet run against production.

### 3a. Create the service

Dashboard → project **rag-system** → **+ New** → **Empty Service**, name it
`rag-backup`. Point it at this repo and set the config file to
`services/backup/railway.json`.

### 3b. Variables

Service → **Variables**. `DATABASE_URL` must be **composed** — `rag-postgres`
exposes no such variable, only `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_DB` / `RAILWAY_PRIVATE_DOMAIN`:

```
DATABASE_URL=postgresql://${{rag-postgres.POSTGRES_USER}}:${{rag-postgres.POSTGRES_PASSWORD}}@${{rag-postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{rag-postgres.POSTGRES_DB}}
AZURE_SAS_URL=<the container SAS URL from Step 2d>
```

Optional but recommended:

```
AGE_RECIPIENT=<age public key — see 3c>
HEARTBEAT_URL=<dead-man's-switch ping URL — see Step 5>
BACKUP_MIN_BYTES=10000000
```

Using Railway **reference variables** rather than pasted literals means the
credentials never exist in two places and rotate automatically.

### 3c. Client-side encryption (recommended)

Azure encrypts at rest already. Client-side `age` encryption means the storage
provider never holds plaintext — a meaningfully different guarantee for a file
containing the full KB and staff identities.

```bash
age-keygen -o twk-kb-backup.key     # prints the public key to stdout
```

Set the **public** key as `AGE_RECIPIENT`.

⚠ **The private key is now a single point of failure that can silently void
every backup you own.** An encrypted dump whose key was lost is not a backup. It
must survive the same disaster as the database — so **not** only on a
workstation, and **not** only in this Railway project. A password manager the
firm controls, plus a sealed offline copy, is the minimum. If that cannot be
arranged reliably, leave `AGE_RECIPIENT` unset and rely on Azure's at-rest
encryption; the job logs a warning so the choice stays visible rather than
forgotten.

### 3d. Schedule

Service → **Settings** → **Cron Schedule**:

```
0 8 * * *
```

**Schedules are UTC.** `08:00` UTC is 3 a.m. CDT / 2 a.m. CST — overnight for the
firm, and clear of business hours in either offset.

⚠ **Leave the restart policy at `NEVER`** (already set in `railway.json`). This
looks wrong and is not. Railway **skips** a scheduled run while the previous one
is still Active, so a restart-looping failure would suppress every subsequent
backup indefinitely. A failed run must stay failed and visible until the next
schedule.

---

## Step 4 — First run and verification

Trigger a run manually rather than waiting for 3 a.m.

```bash
railway redeploy --service rag-backup
railway logs --service rag-backup
```

Expected, in order:

```
[backup] start 2026-08-01T080000Z
[backup] dump complete: ~37000000 bytes
[backup] gzip integrity OK
[backup] encrypted -> twk-kb-<stamp>.sql.gz.age
[backup] uploaded twk-kb-<stamp>.sql.gz.age
[backup] heartbeat sent
[backup] done
```

Then confirm the blob is actually in `kb-backups` in the portal, **with a
plausible size**. A zero-byte or 2 KB blob is a failed backup that reported
success.

**Confirm the service went Inactive.** If it shows Active after finishing,
something is holding the process open and every subsequent run will be skipped.

---

## Step 5 — Make silent failure impossible ⚠

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

## Step 6 — Retention is a compliance question, not a default

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

## Step 7 — Prove it, then the gate is closed

**A backup nobody has restored from is a hypothesis.**

Take an artifact the _schedule_ produced — not one taken by hand — and restore
it, following the production procedure in
[`BACKUP-RESTORE-DRILL.md`](./BACKUP-RESTORE-DRILL.md):

```bash
# decrypt first if AGE_RECIPIENT was used
age -d -i twk-kb-backup.key twk-kb-<stamp>.sql.gz.age > twk-kb-<stamp>.sql.gz

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

## Where this leaves the launch gate

| Layer                           | Covers                                       | Status              |
| ------------------------------- | -------------------------------------------- | ------------------- |
| Restore procedure               | —                                            | ✅ Proven           |
| Volume backups                  | Corruption, bad migration, accidental delete | ⬜ Step 1           |
| Off-Railway `pg_dump`           | Project / account / provider loss            | ⬜ Steps 2–4        |
| Monitoring                      | Silent failure of the above                  | ⬜ Step 5           |
| Retention decision              | §7216 / Circular 230                         | ⬜ Step 6 (counsel) |
| Restore from scheduled artifact | The claim itself                             | ⬜ Step 7           |

**Steps 1 and 5 carry most of the risk reduction for the least effort.** Volume
backups take fifteen minutes and cover the failures that actually happen;
monitoring is what keeps the rest from decaying into theatre. Step 0 is what
gates the sequence, and it needs Chris.
