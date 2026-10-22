---
title: Backup and recovery
status: current
last_verified: 2026-10-21
verified_against: 9714c1d
answers: How production Postgres is backed up, how to restore it (from a dump or to a point in time), and what is still open.
read_when: Restoring data, changing rag-backup or the Postgres image, applying a migration by hand, or auditing backup posture (P0 gate 3).
supersedes: [BACKUP-SCHEDULE-RUNBOOK.md, BACKUP-RESTORE-DRILL.md]
code:
  [
    services/backup/backup.sh,
    services/backup/Dockerfile,
    services/backup/railway.json,
    packages/db/drizzle/meta/_journal.json,
  ]
---

# Backup and recovery

Production Postgres (`rag-postgres` on Railway) has three backup layers, and all three are live: Railway volume
backups, a nightly `pg_dump` from the `rag-backup` cron service, and pgBackRest WAL archiving for point-in-time
recovery (PITR). Restores are proven from a scheduled dump (2026-10-02) and to a chosen second via pgBackRest
(2026-09-02). The image's own automated PITR restore is broken, so use the [manual procedure](#manual-pitr-procedure).
Every layer currently lives inside the same Railway project as the database. The off-Railway copy is blocked on
admin consent from Chris (tenant admin, see [`GLOSSARY.md`](../GLOSSARY.md)), and nothing alerts if the nightly job
stops running. That is why P0 gate 3 (backups exist off the database host and a restore is proven) is only partly
closed. The gate's status lives in [`LAUNCH-STATUS.md`](../launch/LAUNCH-STATUS.md).

## Current state

| Layer                          | Status                                 | Destination                                                 | Retention                      | Last proven                                          |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| Railway volume backups         | Enabled 2026-08-01 (Daily + Weekly)    | The `rag-postgres` volume, same project and environment     | Daily 6 days, Weekly 1 month   | Never restored                                       |
| Nightly `pg_dump` (rag-backup) | Live since 2026-08-01, stopgap target  | Railway bucket `rag-documents`, folder `backups/`           | None configured; files pile up | 2026-10-02, restore of a scheduled artifact          |
| pgBackRest WAL archiving       | Live since 2026-09-02                  | Bucket `rag-documents`, `/pgbackrest/cluster-<system-id>`   | 4 full, 14 differential        | 2026-09-02, PITR to the second (manual root restore) |
| Off-Railway dump copy          | Blocked on admin consent               | SharePoint, one backup-only site (`BACKUP_DEST=sharepoint`) | Not yet decided (counsel)      | —                                                    |
| Dead-man's switch              | Not configured (`HEARTBEAT_URL` unset) | —                                                           | —                              | —                                                    |

UNVERIFIED: the volume-backup schedules are dashboard-only and can't be read from a script. Settle by opening
`rag-postgres` → **Backups** in the Railway dashboard.

## What the backups protect

Most of the database can be rebuilt by re-syncing SharePoint: `documents`, `chunks` and embeddings. That costs
embedding spend and hours, but no information is lost. These tables have no upstream copy:

| Table                                            | Why it can't be rebuilt                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `audit_log`                                      | The §7216 / Circular 230 evidence trail; nothing else records it |
| `answer_feedback`                                | Staff-supplied signal; nowhere else                              |
| `staff_source_assignments`, `client_assignments` | Access-control config; can only be rebuilt by hand, from memory  |
| `ingest_log`, `docs_gap_digest_runs`             | Operational history                                              |

So the backup exists for the audit log first and the knowledge-base content second. Backup cadence and retention are
compliance questions before they are ops questions.

A dump contains the full KB text plus staff identities and question text from `audit_log`. Classify every artifact
at least as high as the KB itself (Class A/B, see [`GLOSSARY.md`](../GLOSSARY.md)) wherever it lands. Never ship
dumps to a personal cloud account, or to one person's firm OneDrive, because it dies when that person is
deprovisioned. Keep production data inside Railway when you drill; a dump file on a laptop is a compliance problem
the drill has no reason to create.

## Railway volume backups

Railway snapshots any mounted volume, not only its managed databases. `rag-postgres` runs a raw image on a volume
(`ghcr.io/railwayapp-templates/postgres-ssl:16.14`; see root [`CLAUDE.md`](../../CLAUDE.md) for the image contract),
and it qualifies. Configuration lives only in the dashboard: `rag-postgres` → **Backups**. The `railway` CLI and API
have no snapshot subcommand.

- Schedules are Daily (kept 6 days), Weekly (kept 1 month) and Monthly (kept 3 months). One volume can run several
  schedules at once. Daily and Weekly are enabled.
- Snapshots are incremental and copy-on-write; billing covers only data unique to each snapshot.
- A restore lands **only in the same project and environment**. It stages a change that must be reviewed and
  deployed, and it redeploys the service.
- **Wiping the volume deletes every backup with it.**

This layer covers corruption, a bad migration and an accidental `DROP`. It does not cover a volume wipe, project
deletion, account loss or a Railway-level failure. The 3-month ceiling also can't meet a multi-year retention
obligation, so the dump layer needs its own retention window ([open item](#retention)).

## Nightly dump service (rag-backup)

`rag-backup` is a Railway cron service in the production environment of project `rag-system`. It runs
`services/backup/backup.sh`, a plain shell script, on purpose: the backup must not depend on the app's runtime or
build. The script runs `pg_dump --no-owner --no-acl | gzip -9`, checks the result, optionally encrypts it, uploads
it, then pings a heartbeat. It has to run inside Railway's private network, because Postgres has no public TCP
domain.

### Service configuration

| Setting                                                                      | Value or default                         | Notes                                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cron schedule                                                                | `0 8 * * *` UTC (3 a.m. CDT, 2 a.m. CST) | Set in the dashboard; `services/backup/railway.json` has no `cronSchedule`                                    |
| `restartPolicyType`                                                          | `NEVER`                                  | From `services/backup/railway.json`; see [below](#settings-that-look-wrong-and-are-not)                       |
| `DATABASE_URL`                                                               | required                                 | Must use `sslmode=require`; libpq rejects `no-verify` ([TLS rules](./DEPLOYMENT.md#database-tls-and-sslmode)) |
| `BACKUP_DEST`                                                                | required: `sharepoint`, `s3` or `azure`  | Production: `s3`, pointing at the Railway bucket (stopgap)                                                    |
| `BACKUP_NAME_PREFIX`                                                         | `kb`                                     | Artifact **file name** prefix: `<prefix>-<YYYY-MM-DDTHHMMSSZ>.sql.gz`                                         |
| `BACKUP_PREFIX`                                                              | `backups`                                | Upload **folder**. A different setting from the one above                                                     |
| `BACKUP_MIN_BYTES`                                                           | `10000000` (10 MB)                       | Size floor; a smaller dump is refused. See [Unverified](#unverified)                                          |
| `DUMP_TIMEOUT_SECONDS`                                                       | `3600`                                   | Hard timeout on `pg_dump`                                                                                     |
| `UPLOAD_TIMEOUT_SECONDS`                                                     | `1800`                                   | Hard timeout on every uploader                                                                                |
| `AGE_RECIPIENT`                                                              | unset                                    | If set, the artifact is `age`-encrypted to `<name>.sql.gz.age`. Unset logs a warning every run                |
| `HEARTBEAT_URL`                                                              | unset                                    | Pinged only on full success                                                                                   |
| `S3_BUCKET`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`     | required for `s3`                        | Set in production, as Railway reference variables                                                             |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_SITE_ID` | required for `sharepoint`                | App-only (client-credentials) Graph auth                                                                      |
| `GRAPH_FOLDER`                                                               | falls back to `BACKUP_PREFIX`            | SharePoint folder; the planned value is `kb-backups`                                                          |
| `AZURE_SAS_URL`                                                              | required for `azure`                     | A **container** SAS URL. No Azure subscription exists, so this target is unused                               |

`backup.sh` checks the destination's variables before it dumps, so a misconfigured target fails in seconds. The
SharePoint uploader uses Graph simple upload, which is limited to 250 MB, and fails loudly above that. Past that size
it needs an upload session.

`BACKUP_NAME_PREFIX` and `BACKUP_PREFIX` are easy to confuse. Setting the wrong one moves every backup to a folder
that no verification step, retention rule or restore glob watches, while the job still exits 0 and the heartbeat still
fires. If you change either one on a deployment that already has archives, list both the old and the new location.
Older artifacts carry the prefix in force when they were written, so look up the actual name in the bucket.

Credentials are Railway reference variables (`${{rag-postgres.POSTGRES_USER}}`, `${{rag-api.OBJECT_STORE_ACCESS_KEY_ID}}`
and so on), not pasted literals, so each lives in one place and rotates with its source. When the service was set up
on 2026-08-01, `DATABASE_URL` was composed from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `RAILWAY_PRIVATE_DOMAIN` and
`POSTGRES_DB`, with `sslmode=require`. `rag-postgres` now carries its own `DATABASE_URL` as well (added with the
2026-09-02 image move for `railway connect`, root [`CLAUDE.md`](../../CLAUDE.md)). It still has no
`DATABASE_PUBLIC_URL`, so the database can't be reached from a workstation. Don't reference the Node services'
`DATABASE_URL` from `rag-backup`; its `sslmode=no-verify` breaks `pg_dump`.

`services/backup/Dockerfile` builds from `postgres:16`, so the `pg_dump` major version matches the server (16.14).
Bump the base image when production Postgres moves to a new major. It is Debian rather than Alpine because `azcopy`
is a glibc binary. It resets `ENTRYPOINT` so the postgres entrypoint doesn't try to initialise a database. Railway
builds it from the repo root.

### Settings that look wrong and are not

- **`restartPolicyType: NEVER`.** Railway skips a scheduled run while the previous deployment is still Active. A
  restart-looping failure keeps the deployment Active, so with restarts enabled, one crash would silently suppress
  every later backup.
- **The cron was enabled only after a manual run exited `Completed`.** Scheduling a job that never terminates gives
  you zero backups and a green dashboard. Do the same after any change to the service.

### Safeguards against silent failure

A backup that fails quietly is worse than none, because it manufactures confidence.

| Failure            | How it looks                                        | Defence                                                                   |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Dump truncates     | A small file uploads "successfully"                 | Size floor `BACKUP_MIN_BYTES`, then `gzip -t` before upload               |
| Upload hangs       | Service stays Active; Railway skips every later run | Hard timeout; exit 124 is reported as "upload exceeded …s and was killed" |
| Credential expires | Uploads fail; the dashboard looks fine              | The job exits non-zero; only the heartbeat makes that visible             |
| Cron never fires   | Nothing happens at all, so there is no error        | Only an external dead-man's switch (`HEARTBEAT_URL`) can catch this       |

The upload timeout exists because `azcopy` was seen retrying an unreachable endpoint indefinitely during testing. The
heartbeat is pinged only on full success, so the monitor alerts on a missing ping, the only construction that catches
a run that never started. Setting it up is an [open item](#dead-mans-switch).

### Verify a run

1. Trigger a run: `railway redeploy --service rag-backup`, then `railway logs --service rag-backup`.
2. Expect, in order: `start <stamp> -> <dest>`, `dump complete: <n> bytes`, `gzip integrity OK`, then either
   `encrypted -> …` or the `AGE_RECIPIENT unset` warning, `uploaded <name> -> <dest>/<prefix>`, `heartbeat sent` (only
   if `HEARTBEAT_URL` is set), and `done`.
3. Confirm the file is in the bucket with a plausible size. `railway run` injects the service's variables, so the
   credentials are never printed:

   ```bash
   railway run --service rag-backup -- \
     aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://$S3_BUCKET/backups/" --human-readable
   ```

4. Confirm the deployment shows `Completed`, not `Active`.

**Done when:** the new artifact is listed with a size in line with recent ones, and the deployment is `Completed`.

## Restore from a dump artifact

Use this for a disaster restore, or to drill one. Steps 4 to 6 are the pass bar; row counts alone are not a pass. A
dump can restore "cleanly" with the HNSW index missing, or with vectors degraded, and queries still return rows, just
wrong ones and slowly.

1. Fetch the artifact. Take the newest `backups/<prefix>-<stamp>.sql.gz` from the bucket. If it ends in `.age`,
   decrypt it first with `age -d -i <age-key-file> <name>.sql.gz.age > <name>.sql.gz`. The key file is named per
   deployment and isn't derived from `BACKUP_NAME_PREFIX`.
2. Provision a target with pgvector available. `ghcr.io/railwayapp-templates/postgres-ssl:16.14` matches production
   (pgvector 0.8.6); `pgvector/pgvector:pg16` also works. A stock Postgres image fails on `CREATE EXTENSION vector`.
   Restore into the same or a newer pgvector version; the dump doesn't pin one, but an older target may lack features.
   Confirm the target has **0** public tables, because a reused database proves nothing.
3. Restore, failing loudly on the first error:

   ```bash
   gzip -dc <name>.sql.gz | psql "<target-url>" -v ON_ERROR_STOP=1
   ```

   The dump is taken with `--no-owner --no-acl`. Without those flags it embeds role grants that don't exist in a fresh
   target, and the restore fails partway, leaving a half-populated database that looks restored.

4. Run the [verification queries](#restore-verification-queries).
5. Run the e2e suite against it (`E2E_DATABASE_URL` and `DATABASE_URL` set to the target, then
   `pnpm --filter @rag/e2e test`). Every test must pass; anything less means investigate before serving traffic.
6. Only then repoint the services' `DATABASE_URL` (with `sslmode=no-verify` for the Node services).

**Done when:** the restore exits 0 with no `ERROR`/`FATAL`, every verification query matches the source, and the e2e
suite passes.

To drill without moving data off Railway, restore into a throwaway database on the same instance, streamed over
`railway ssh`. The 2026-07-31 production drill did this:

```bash
railway ssh --service rag-postgres "createdb -U \$POSTGRES_USER rag_restore_drill"
railway ssh --service rag-postgres "pg_dump -U \$POSTGRES_USER -d \$POSTGRES_DB --no-owner --no-acl \
  | psql -U \$POSTGRES_USER -d rag_restore_drill -v ON_ERROR_STOP=1 -q"
# ... verification queries against rag_restore_drill ...
railway ssh --service rag-postgres "dropdb -U \$POSTGRES_USER rag_restore_drill"
```

`ssh.railway.com`'s host key was accepted on first use (`SHA256:+S1xg92FrnHz6pY3bpkmh1OGtWQGNANXilPzlxA7B1g`).
Railway doesn't publish the fingerprint, so it hasn't been independently verified.

### Restore verification queries

Run each one on the source and the target, and compare.

```sql
-- pgvector survived, and at what version
select extname, extversion from pg_extension where extname = 'vector';

-- embedding is still a real vector column, not degraded to text or an array
select column_name, udt_name from information_schema.columns
 where table_name = 'chunks' and udt_name = 'vector';

-- searchable rows, and one embedding model only (mixed models mean contamination)
select count(*) from chunks where embedding is not null;
select embedding_model, count(*) from chunks group by 1;

-- indexes are the usual casualty: the count must match the source
select count(*) from pg_indexes where schemaname = 'public';

-- the ANN path executes and returns a real distance spread
with q as (select embedding from chunks where embedding is not null limit 1)
select min(c.embedding <=> q.embedding), max(c.embedding <=> q.embedding)
  from chunks c, q where c.embedding is not null;
```

A self-distance of `0` with a real spread above it means the vectors survived. A restore that zeroed or truncated
embeddings still returns rows, but with degenerate distances. As of 2026-10-02, a restore of production has 13 public
tables and 39 indexes, including 1 HNSW and 4 GIN.

## Point-in-time restore from pgBackRest

### pgBackRest configuration

`rag-postgres` runs Railway's `postgres-ssl` image, which bundles pgBackRest. Archiving is configured by six
variables on `rag-postgres`: `WAL_ARCHIVE_BUCKET`, `WAL_ARCHIVE_ENDPOINT`, `WAL_ARCHIVE_REGION`,
`WAL_ARCHIVE_S3_URI_STYLE`, `WAL_ARCHIVE_KEY` and `WAL_ARCHIVE_SECRET`. `WAL_ARCHIVE_PATH` stays at its `/pgbackrest`
default, which keeps it clear of the KB documents and the `backups/` prefix in the same bucket.

| Setting   | Value                                                                       |
| --------- | --------------------------------------------------------------------------- |
| Bucket    | Railway bucket `rag-documents`; real S3 name `rag-documents-yivrrpkniny`    |
| Repo path | `/pgbackrest/cluster-7652162958315024418`                                   |
| Endpoint  | `https://t3.storageapi.dev` (Tigris), region `auto`, virtual-host URI style |
| Schedule  | Watcher polls every 60 s; full backup every 7 days, differential every 24 h |
| Retention | 4 full, 14 differential (`WAL_BACKUP_RETENTION_FULL` / `_DIFF` defaults)    |
| RPO       | About 60 seconds (`archive_mode=on`, `archive_timeout=60`)                  |

Two dependencies break silently:

- pgBackRest connects as `pg1-user=${PGUSER:-postgres}`, `pg1-database=${PGDATABASE:-postgres}`. This deployment's
  application superuser is `rag`, so archiving works only because a separate `postgres` superuser role exists.
  Dropping that role stops backups while the database keeps serving traffic.
- `WAL_ARCHIVE_BUCKET` must be the S3 bucket name, not the Railway bucket ID. The entrypoint refuses UUID-shaped names
  (`uuid-shape`, override `WAL_ARCHIVE_BUCKET_ALLOW_UUID=1`) to catch that mix-up.

This layer closes the rewind gap. A bad migration, or a source deletion cascading through
`documents.source_id ON DELETE CASCADE`, can be undone to a chosen second rather than to the previous 08:00 UTC dump.
It doesn't decorrelate: project or account loss still takes the bucket with the database. The bucket is
Tigris-backed rather than Railway compute, so a Railway compute failure isn't automatically a bucket failure. Keep the
nightly dump anyway. A plain SQL dump restores without pgBackRest, and the two layers' failures don't correlate.

### Why the image's automated restore fails (err 088)

Setting `POSTGRES_RECOVERY_TARGET_TIME` triggers the image's restore path, which fails with:

```
WARN: unknown group 'root' in backup manifest mapped to current group
ERROR: [088]: unable to set ownership for '.../postgresql.auto.conf': [1] Operation not permitted
```

The Railway volume root `/var/lib/postgresql/data` is `root:root`, so a PGDATA created beneath it inherits group
`root`. During restore, pgBackRest creates `postgresql.auto.conf` to hold the recovery options. The file inherits
group `root`, and pgBackRest then tries to chown it to match the manifest, which needs privilege. The image's
`wrapper.sh` runs `gosu postgres pgbackrest ... restore`, unprivileged, so the chown fails with EPERM. Run as root,
the identical restore completes.

The failure also wedges the volume. After the aborted restore, PGDATA holds partial files but no `PG_VERSION` or
`pg_control`. The restore gate tests only those two files, so it retries and fails forever, while `initdb` refuses
the non-empty directory. The result is an infinite crash loop. To recover, point `PGDATA` at a fresh subdirectory
rather than deleting files.

The defect is in the upstream image (`railwayapp-templates/postgres-ssl`). Automated PITR can't succeed on a Railway
volume as shipped, and that is worth reporting upstream.

### Manual PITR procedure

This restores into a separate service (a fork). Production keeps running until you repoint applications.

1. Create a new service from image `ghcr.io/railwayapp-templates/postgres-ssl:16.14`, with a fresh volume mounted at
   exactly `/var/lib/postgresql/data`. Set `PGDATA` to a subdirectory of it.
2. Set `WAL_RECOVER_FROM_BUCKET`, `_ENDPOINT`, `_REGION`, `_KEY` and `_SECRET`, plus `WAL_RECOVER_FROM_S3_URI_STYLE=host`
   and `WAL_RECOVER_FROM_PATH=/pgbackrest/cluster-<system-id>`. The `/pgbackrest` default won't find the repo; read
   the cluster path from `pgbackrest info` or the `.pgbackrest_repo_path` marker.
3. Set **no** `WAL_ARCHIVE_*` variables on the fork; their absence is what stops it archiving into production's repo.
   Leave `POSTGRES_RECOVERY_TARGET_TIME` **unset**, so the container boots instead of crash-looping on the broken
   automatic path.
4. `railway ssh` into the fork (the container runs as root). Write a pgBackRest config file from the
   `WAL_RECOVER_FROM_*` values, then `chown postgres:postgres` and `chmod 0600` it. `restore_command` runs as
   `postgres` and can't read a root-owned config (`ERROR: [041]: unable to open file ... Permission denied`).
5. As root, restore into a fresh, empty path:

   ```bash
   pgbackrest --config=<conf> --stanza=main --pg1-path=<new> \
     --recovery-option=restore_command="pgbackrest --config=<conf> --stanza=main archive-get %f %p" \
     restore --type=time --target="<timestamp>" --target-action=promote
   ```

6. Start it: `gosu postgres pg_ctl -D <new> -o "-p 5433" start`. Replay fetches WAL from S3 and then promotes; allow
   several minutes. `pg_ctl -w` can outlast an SSH session because the server daemonizes, so reconnect and poll
   `select pg_is_in_recovery();` until it returns `f`.
7. Run the [verification queries](#restore-verification-queries) and check that the data is as of the target time.
   Then repoint applications.

**Done when:** `pg_is_in_recovery()` is `f`, the verification queries pass, and the latest committed transaction
(`pg_last_committed_xact()`) falls before the target.

## Applying a Drizzle migration by hand

Migrations normally run in `rag-worker`'s pre-deploy step (root [`CLAUDE.md`](../../CLAUDE.md)). Apply one by hand
only when the deployed image is older than the migration, so its `migrate.js` doesn't have the file, and redeploying
would ship unrelated code ahead of the schema. That happened on 2026-07-31 with `0018_answer_feedback`.

Drizzle decides what is pending by comparing each journal entry's `when` (`packages/db/drizzle/meta/_journal.json`)
with `max(created_at)` in `drizzle.__drizzle_migrations`. If you apply the SQL without the tracking row, the next
deploy tries the migration again and fails, because the table already exists. The row is what makes the next deploy
a no-op. The `when` gating is recorded in [`DECISIONS.md`](../architecture/DECISIONS.md).

1. Compute the hash the way Drizzle does: sha256 of the **raw** file, before it's split on `--> statement-breakpoint`.

   ```bash
   python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" \
     packages/db/drizzle/<migration>.sql
   ```

2. Validate the method against a migration production already has. Recompute the hash of the previous migration and
   compare it with the stored row. If they differ, stop.

   ```bash
   railway ssh --service rag-postgres "psql -U \$POSTGRES_USER -d \$POSTGRES_DB \
     -c \"select id, created_at, left(hash,16) from drizzle.__drizzle_migrations order by created_at desc limit 3;\""
   ```

3. Take a recovery point first (a manual volume backup, or note the time for PITR).
4. Build one SQL script: the migration, plus
   `insert into drizzle.__drizzle_migrations (hash, created_at) values ('<hash>', <when>);`. `created_at` is the
   journal's `when` verbatim (for example `1795000000000` for `0018`), never `now()`. A wall-clock value would sit far
   ahead of later migrations' `when` values and silently mark them as applied.
5. Apply it in one transaction. Pass it base64-encoded, which avoids nested-quote mangling through `railway ssh`:

   ```bash
   railway ssh --service rag-postgres \
     "echo '<base64>' | base64 -d | psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -1 -f -"
   ```

6. Diff the result against a local database where the migrator applied the same file: columns, nullability, defaults
   and full `indexdef` strings. Clauses such as `NULLS NOT DISTINCT` (on `afb_answer_subject_unique` in `0018`) are
   what a hand application drops.

**Done when:** the schema diff against local is empty, and the tracking row's `created_at` equals the journal `when`.

## Open items

### Off-Railway destination

Every layer sits in the `rag-system` Railway project, so project deletion, account loss or a Railway-level failure
takes all of them. The decided destination is SharePoint, via an app registration with the Graph application
permission `Sites.Selected` and `write` on one site that holds only backups. It is blocked on Chris granting admin
consent.

Why SharePoint, decided 2026-08-01:

- The firm's Microsoft 365 tenant has no Azure subscription. A tenant isn't a subscription; Azure Blob storage needs
  one with billing attached, which is a purchasing decision. SharePoint needs only consent, with no spend.
- `Sites.Selected` grants nothing by default. It reaches only the sites an admin grants, unlike
  `Sites.ReadWrite.All`. The two-stage grant is in [`FRESH-DEPLOY-GUIDE.md`](./FRESH-DEPLOY-GUIDE.md) §1.2.
- Standard users may create app registrations in the tenant (`allowedToCreateApps: True`), so Marcus (engineering and
  ops lead) can create the app. Application permissions always need an administrator, and a cron job needs app-only
  auth because delegated tokens expire and re-prompt for MFA.
- The consent folds into the Entra conversation Chris already needs for the web app and Teams bot.

If Chris prefers to create an Azure subscription, `BACKUP_DEST=azure` already works and needs only a container SAS.

Cutover, once consent and the site grant exist:

1. Create the app registration (`az ad app create --sign-in-audience AzureADMyOrg`, `az ad sp create --id <appId>`,
   `az ad app credential reset --id <appId> --years 1`). The secret is shown once and has a hard expiry, so put the
   expiry date in a calendar. A lapsed secret fails every upload.
2. Set `BACKUP_DEST=sharepoint`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_SITE_ID` and
   `GRAPH_FOLDER=kb-backups` on `rag-backup` with `railway variables --service rag-backup --set ...`. No code change is
   needed.
3. Decide encryption at the same time ([below](#encryption)).
4. Run [Verify a run](#verify-a-run), then restore that artifact.

**Done when:** a scheduled artifact lands on the SharePoint site and a restore from it passes.

### Dead-man's switch

`HEARTBEAT_URL` is unset, so every layer can fail silently. To close it, create a check at a cron-monitoring service
(for example healthchecks.io) with a 1-day period and 2-hour grace. Set its ping URL as `HEARTBEAT_URL`, and send
alerts to an inbox someone reads. The monitor receives only a ping: no data and no file names.

### Encryption

The stopgap artifacts are unencrypted (`AGE_RECIPIENT` unset), and the job logs a warning every run. The bucket
already holds the KB's original documents under the same credentials, so the added exposure is `audit_log`.
Encrypting without a firm-controlled home for the private key trades a disclosure risk for a total-loss risk; a key
on one workstation doesn't survive the disaster it guards against. Revisit this at the SharePoint cutover.

### Retention

Retention is not yet decided, and is a counsel question. Answer it together with launch-runbook item 8 (audit-log
off-host destination and retention window,
[`LAUNCH-RUNBOOK.md`](../launch/LAUNCH-RUNBOOK.md#8-decide-where-off-host-audit-logs-ship-and-how-long-to-keep-them)).
Questions for counsel:

- How long must the `audit_log` trail be kept?
- Does a copy in the firm's own tenant satisfy that, or must it be immutable (WORM)?
- Is there a maximum retention, past which holding staff question text becomes a liability?

Nothing deletes old dump artifacts today. Once a window is decided, implement it as a rule at the destination, not as
manual cleanup.

### Unverified

- UNVERIFIED: whether BACKUP_MIN_BYTES is overridden on Railway — the 2026-10-01 artifact was 1.2 MiB, below the
  10 MB default floor. At the default, the job would refuse to upload a dump that size, so either an undocumented
  override exists or the floor is not doing what this doc says. Settle with
  `railway variables --service rag-backup --kv | grep BACKUP_MIN_BYTES`, and set the floor to match today's post-purge
  size.
- UNVERIFIED: whether the Daily and Weekly volume-backup schedules are still enabled (dashboard only).

## Evidence

Dated results; each proves the claim in its heading as of that date.

**2026-07-31, restore drill (local).** Fresh `pgvector/pgvector:pg16` container on port 5433. The dump was 66,708
bytes (11 KB gzipped). The restore exited 0 under `ON_ERROR_STOP=1`. 13 of 13 tables, row counts exact (1 source, 1
document, 1 chunk, 19 `audit_log`), pgvector 0.8.5, `vector` type kept, ANN self-distance `0.000000`, 39 of 39
indexes including `chunks_embedding_hnsw_idx`, `chunks_tsv_idx` and `documents_metadata_gin_idx`, and 88/88 e2e tests
(17 files) against the restored database.

**2026-07-31, restore drill (production).** Streamed inside Railway into `rag_restore_drill` on the same instance;
nothing left Railway. Production then had 12 tables, **36 indexes**, pgvector 0.8.2, 3 sources, 858 documents, 6,175
chunks and 3 `audit_log` rows; all matched after restore. Elapsed 4 seconds. The ANN query over 6,175 chunks returned
distances from 0.000000 to 0.4573. Production was unchanged afterwards. The drill found production one migration
behind (`0018_answer_feedback`); it was applied by hand the same day, using the
[procedure above](#applying-a-drizzle-migration-by-hand). The 39-index figure belongs to the local leg; production
reached 39 indexes and 13 tables later. A new instance at production volume wasn't drilled that day; the 2026-10-02
restore below covers that path.

**2026-08-01, first nightly run.** Volume backups enabled (Daily + Weekly) and `rag-backup` deployed. The first
manual run dumped 35,551,090 bytes, passed the gzip check, uploaded 33.9 MiB and exited `Completed`; the cron was
enabled afterwards. That run predates `BACKUP_NAME_PREFIX`, so its object carries the prefix hard-coded at the time.
The sizes are from before the 2026-08-03 purge and are not current.

**2026-09-02, pgBackRest first full backup.** `20260902-191553F`: 114.9 MB logical, 52.8 MB in the repo (zstd-3),
1,873 files, 14 seconds.

**2026-09-02, PITR proof.** A marker table in production's `postgres` database (outside `rag`) got row `before` at
19:40:01.976122+00. The target was recorded at 19:40:10.243888+00, and row `after` at 19:40:13.266171+00, followed by
six filler commits. Restored to the target with the manual root procedure, the fork held exactly one row, `before`.
`pg_last_committed_xact()` was `305156 @ 19:40:06.071533+00`, after `before` and before the target. The restored
`rag` database had 47 documents, 210 chunks, 28 `audit_log` rows, 1 source and pgvector 0.8.6, and an HNSW probe
returned rows. The root restore reported `restore size = 114.9MB, file total = 1873, completed successfully`.

**2026-10-02, restore of a scheduled artifact.** Artifact `backups/kb-2026-10-01T080156Z.sql.gz` (1.2 MiB), written
by the cron with no human involvement; 31 artifacts were present, daily and unbroken from 2026-09-01 to 2026-10-01.
It was downloaded with the service's own credentials and restored into a throwaway `pgvector/pgvector:pg16` container
on port 55433 under `ON_ERROR_STOP=1`. Then the container and the artifact were destroyed; production was never
written to. Results: gzip clean, `CREATE EXTENSION vector` present, exit 0 with no `ERROR`/`FATAL` lines, 13 tables,
1 source, 47 documents, 210 chunks, 132 `audit_log` rows, pgvector 0.8.6, `vector(768)`, 39 indexes (1 HNSW, 4 GIN),
one embedding model (`gemini-embedding-001`), and the ANN query returned 3 rows with self-distance `0.000000`. Parity
was checked against the documented index state, not a live count, because the live database isn't reachable from a
workstation. The unencrypted artifact existed on a workstation only for the drill.
