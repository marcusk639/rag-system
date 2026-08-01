# Backup & Restore Drill — TWK KB

**P0 gate #3** from `TWK-LAUNCH-STATUS.md`. Runbook item 3 in `TWK-MANUAL-RUNBOOK.md`.

**Drill run:** 2026-07-31 · **Result:** ✅ **complete — local mechanism AND production data both proven**

Two halves, run in this order:

1. **Local** — fresh-instance restore, extension created from scratch, **88/88 e2e
   against the restored database**. Proves the mechanism and app compatibility.
2. **Production** — real data (858 documents / 6,175 chunks) dumped and restored
   **entirely inside Railway**, nothing copied to a laptop. Proves it at real
   volume with real embeddings.

⚠ **A restore is proven; a backup _schedule_ is not.** See
[Findings](#-findings-from-the-production-drill) — nothing takes a scheduled
backup yet. Railway **volume backups are available** for our volume (dashboard
only) and should be turned on now; they do **not** replace an off-Railway
`pg_dump`, because they restore only into the same project + environment.

_(Production is no longer a migration behind — `0018_answer_feedback` was applied
2026-07-31. Procedure: [Applying a migration by hand](#applying-a-migration-by-hand).)_

> **Why this exists:** Postgres is the sole store for chunks, embeddings, sources,
> **and the compliance audit log**. Before the drill there was no confirmed,
> tested recovery path — only an assumption that one existed.

---

## Local drill — result summary

| Check                                                                      | Result                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pg_dump` completes, dump contains `CREATE EXTENSION vector`               | ✅ 66,708 bytes raw / 11 KB gzipped                                                          |
| Restore into a **fresh, never-used** Postgres                              | ✅ exit 0, **zero errors** under `ON_ERROR_STOP=1`                                           |
| All 13 public tables restored                                              | ✅ 13 → 13                                                                                   |
| Row counts match exactly                                                   | ✅ sources 1, documents 1, chunks 1, **audit_log 19**                                        |
| pgvector extension survived                                                | ✅ `vector v0.8.5`                                                                           |
| `embedding` column still a real `vector` type (not degraded to text/array) | ✅                                                                                           |
| **Vector ANN query actually executes**                                     | ✅ returned 1 row, self-distance `0.000000`                                                  |
| **All indexes restored — incl. HNSW and GIN**                              | ✅ **39 → 39** (`chunks_embedding_hnsw_idx`, `chunks_tsv_idx`, `documents_metadata_gin_idx`) |
| **Full e2e suite against the restored DB**                                 | ✅ **88/88 passing, 17/17 files**                                                            |

The last two rows are the ones that matter. Index loss and silent vector-type
degradation are the classic pgvector restore failures — a dump can look fine,
restore without error, and leave you with a database that returns wrong results or
falls back to sequential scans. Both were explicitly checked.

---

## Local drill — exactly what was run

```bash
# 1 — take the backup (the same command a scheduled job would run)
docker exec rag-postgres pg_dump -U rag -d rag --no-owner --no-acl \
  | gzip > backup-$(date +%F).sql.gz

# 2 — fresh throwaway target on a different port, NEVER production
docker run -d --name rag-restore-drill \
  -e POSTGRES_USER=rag -e POSTGRES_PASSWORD=rag -e POSTGRES_DB=rag \
  -p 5433:5432 pgvector/pgvector:pg16

# 3 — restore, failing loudly on the first error
gzip -dc backup-*.sql.gz \
  | docker exec -i rag-restore-drill psql -U rag -d rag -v ON_ERROR_STOP=1

# 4 — prove the app works against restored data, not just that rows exist
E2E_DATABASE_URL="postgres://rag:rag@localhost:5433/rag" \
DATABASE_URL="postgres://rag:rag@localhost:5433/rag" \
  pnpm --filter @rag/e2e test
```

**`--no-owner --no-acl` matters.** Without them the dump embeds role grants that
don't exist in a fresh target, and the restore fails partway — leaving a
half-populated database that looks restored.

**Verification queries** that caught the things row counts don't:

```sql
-- extension survived, and at what version
select extname, extversion from pg_extension where extname = 'vector';

-- embedding is still a vector, not silently degraded
select column_name, udt_name from information_schema.columns
 where table_name = 'chunks' and udt_name = 'vector';

-- the ANN path actually executes
select count(*) from chunks where embedding is not null;

-- indexes are the usual casualty — compare counts against source
select count(*) from pg_indexes where schemaname = 'public';
```

---

## ✅ Production drill — run 2026-07-31, inside Railway

The production leg is now closed. **No firm data left Railway's infrastructure** —
the dump was streamed directly into a throwaway database on the same instance via
`railway ssh`, never written to disk and never copied to a laptop. That was a
deliberate choice given the KB is Class A/B and POL-01 is still unadopted.

### Production inventory (before)

|               |                                              |
| ------------- | -------------------------------------------- |
| Database size | **85 MB** (volume 205 MB / 4.6 GB)           |
| Content       | **3 sources · 858 documents · 6,175 chunks** |
| Schema        | 12 tables · 36 indexes · pgvector **v0.8.2** |

### Result

| Check                            | Production | Restored                                                |     |
| -------------------------------- | ---------- | ------------------------------------------------------- | --- |
| Restore exit code                | —          | **0**                                                   | ✅  |
| Elapsed                          | —          | **4 seconds**                                           | ✅  |
| Tables                           | 12         | 12                                                      | ✅  |
| Sources                          | 3          | 3                                                       | ✅  |
| Documents                        | 858        | 858                                                     | ✅  |
| Chunks                           | 6,175      | 6,175                                                   | ✅  |
| audit_log                        | 3          | 3                                                       | ✅  |
| **Indexes**                      | **36**     | **36**                                                  | ✅  |
| pgvector extension               | v0.8.2     | v0.8.2                                                  | ✅  |
| `embedding` column type          | `vector`   | `vector`                                                | ✅  |
| HNSW + GIN + tsvector indexes    | present    | **all 3 present**                                       | ✅  |
| **ANN query over restored data** | —          | **6,175 searchable; nearest 0.000000, farthest 0.4573** | ✅  |

The distance spread matters: a restore that silently zeroed or truncated
embeddings would still return rows, just with degenerate distances. A real spread
across 6,175 chunks means the vectors survived intact.

### Exactly what was run

```bash
railway link --project <id> --environment production
railway ssh keys add -k ~/.ssh/id_ed25519.pub

# empty target on the same instance
railway ssh --service rag-postgres "createdb -U \$POSTGRES_USER rag_restore_drill"

# dump -> restore, streamed; never hits disk, never leaves Railway
railway ssh --service rag-postgres "pg_dump -U \$POSTGRES_USER -d \$POSTGRES_DB \
  --no-owner --no-acl | psql -U \$POSTGRES_USER -d rag_restore_drill -v ON_ERROR_STOP=1 -q"

# ... verification queries ...

railway ssh --service rag-postgres "dropdb -U \$POSTGRES_USER rag_restore_drill"
```

**Production verified untouched afterwards** (3 / 858 / 6,175 / 36 unchanged),
throwaway dropped, disk reclaimed.

### Why a separate database rather than a fresh instance

The fresh-instance path — including `CREATE EXTENSION vector` on a virgin server
and 88/88 e2e against restored data — was already proven in the local drill below.
What production uniquely adds is **real data volume with real embeddings**, and a
separate empty database on the same instance tests exactly that. Both halves
together cover the full path.

---

## ⚠ Findings from the production drill

**1. Production was one migration behind — ✅ resolved 2026-07-31.**
`0018_answer_feedback` was applied locally but not in production (17 vs 18).
Now applied; production is 18/18. See
[Applying a migration by hand](#applying-a-migration-by-hand) for the procedure
and why it was needed. Recorded here only because the drill surfaced it.

**2. There is no automated backup — but volume backups _are_ available.**
⚠ **This corrects an earlier version of this document,** which said volume
snapshots might not apply to us. They do:

- The `railway` **CLI** exposes no snapshot/backup subcommand — that part was
  right, and is why the earlier note reached the wrong conclusion.
- But Railway's **volume backups apply to any mounted volume**, not just their
  managed database offerings — [docs](https://docs.railway.com/volumes/backups).
  `rag-postgres-volume` qualifies. They are configured **in the dashboard only**,
  under the service's **Backups** tab.

Schedules are Daily (kept 6 days) / Weekly (kept 1 month) / Monthly (kept 3
months), and **multiple schedules can run on one volume**, so layered retention is
just checkboxes. Incremental and copy-on-write, billed only for data unique to
each snapshot.

**They are not off-site, and that matters.** Two caveats from the docs:
_"Backups can only be restored into the same project + environment"_ and
_"Wiping a volume deletes all backups."_ So volume backups cover corruption, a bad
migration, and accidental deletion — **not** project loss, account loss, or
provider failure. That is the gap `pg_dump` fills, and why both belong in the
plan. See [What is NOT yet proven](#what-is-not-yet-proven).

**3. pgvector version differs between environments.** Production runs **v0.8.2**,
local dev runs **v0.8.5**. Restoring a production dump into a local environment
works, but the reverse is not guaranteed — a dump from 0.8.5 may reference
features absent in 0.8.2. Keep restores same-version-or-newer.

**4. Host key was trust-on-first-use.** `ssh.railway.com`'s key
(`SHA256:+S1xg92FrnHz6pY3bpkmh1OGtWQGNANXilPzlxA7B1g`) was added via `ssh-keyscan`.
Railway does not publish the fingerprint in its docs, so this **could not be
independently verified** — noted rather than glossed over.

---

## What is NOT yet proven

The **restore** is proven on both legs. What remains open is everything on the
other side of it.

**1. There is no backup to restore from.** Nothing takes a scheduled dump. Both
legs of this drill restored from a dump taken by hand, minutes earlier. A drill
proves the recovery path works; it does not create the artifact recovery needs.
Until a schedule exists, the honest statement of recovery capability is: _"we can
restore whatever someone last remembered to dump."_

**2. The infrastructure constraint that shapes the fix.** Discovered during the
first leg and confirmed in the second:

- `rag-postgres` is a **raw Docker image on a Railway volume**
  (`RAILWAY_VOLUME_ID` / `RAILWAY_VOLUME_MOUNT_PATH` confirmed in its variables),
  **not** Railway's managed Postgres plugin. **Managed-plugin automatic backups do
  not apply.**
- Postgres has **no public TCP domain** — private-network only.

**Consequence:** a backup cannot be taken from a laptop at all. It **must run
inside Railway's network** — which is why the production leg ran over
`railway ssh`. That is not a limitation to work around; it's the correct design,
and it also means firm data never has to leave their infrastructure. But it makes
the backup job **infrastructure work**, not a script someone runs locally.

**3. Restore-to-a-new-instance at production volume.** The production leg restored
into a second database on the **same** instance. A real disaster restores onto a
**new** instance — that path is proven at local volume (fresh container,
`CREATE EXTENSION vector` from scratch, 88/88 e2e) but not at 6,175 chunks. The
gap is small; the 4-second same-instance restore is the reassuring datapoint.

### To close what's left — two layers, not one

They cover different failures. Neither is sufficient alone.

**Layer 1 — volume backups. Do this now; it is checkboxes, not code.**
Dashboard → `rag-postgres` → **Backups** tab. Enable **Daily _and_ Weekly**
(multiple schedules are allowed on one volume): 6 days of fine-grained recovery
plus a month of coarse. Covers corruption, a bad migration, an accidental
`DROP` — the failures that actually happen. Cost is incremental-only on an 85 MB
database, so effectively noise. **Restores are same-project + same-environment
only, and wiping the volume deletes every backup with it.**

**Layer 2 — scheduled `pg_dump` off Railway.** This is the disaster-recovery leg
and the _only_ thing covering project loss, account loss, or a provider-level
failure. A Railway **cron service** is the right shape — Railway supports
scheduled services, with the hard requirement that
[the process exits cleanly](https://docs.railway.com/cron-jobs#service-execution-requirements)
or subsequent runs are skipped. It runs inside the private network, so the dump
never transits a laptop. Ship the artifact to storage **not owned by the same
Railway project**; the whole point is decorrelated failure.

**What actually drives the schedule — and it isn't the chunk count.** Most of
this database is _re-derivable_: documents, chunks, and embeddings can be
rebuilt by re-syncing SharePoint (costs embedding spend and time, but no
information is lost). What cannot be rebuilt from any upstream source:

| Table                                            | Why it's irreplaceable                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| `audit_log`                                      | The §7216 / Circular 230 evidence trail. No upstream. |
| `answer_feedback`                                | Staff-supplied signal; nowhere else                   |
| `staff_source_assignments`, `client_assignments` | Access-control config; painful to reconstruct         |
| `ingest_log`, `docs_gap_digest_runs`             | Operational history                                   |

So **backup cadence is a compliance question before it is an ops question.**
⚠ Note the mismatch: volume-backup retention tops out at **3 months**, while tax
record-retention expectations are measured in **years**. That is not a reason to
skip volume backups — it is the reason Layer 2 needs its own retention window,
and it ties directly to open launch item **P2 #8** (audit-log off-host
destination + retention). **Retention length is a question for counsel, not a
default to pick here.**

**Then verify.** Restore from a _scheduled_ artifact — not one taken by hand.
A backup nobody has restored from is a hypothesis.

**Done when:** a restore has been watched succeed from an artifact **nobody took
by hand**.

---

## Applying a migration by hand

Used on 2026-07-31 to apply `0018_answer_feedback` to production. Worth keeping,
because the situation recurs whenever **the deployed container is older than the
migration**.

`pnpm db:migrate` could not be used. The deployed `rag-api` image was built
**2026-07-14**; `0018` landed **2026-07-17**, so the container ships `migrate.js`
but not `0018_answer_feedback.sql` — the migrator cannot apply a file it doesn't
have. Redeploying `rag-api` first would have fixed that, but it would also ship
two weeks of unrelated application changes to get a schema change out, and it
puts **code before schema**, which is the wrong order.

So the SQL was applied directly, along with the tracking row Drizzle would have
written itself.

**The part that is easy to get wrong.** Drizzle decides what is pending by
comparing each journal entry's `when` against `max(created_at)` in
`drizzle.__drizzle_migrations`. Apply the SQL _without_ inserting that row and the
migrator will try to apply `0018` again on the next deploy — and fail, because the
table already exists. The row is not bookkeeping; it is what makes the next
deploy a no-op.

```bash
# 1 — derive the hash exactly as Drizzle does: sha256 of the RAW file,
#     before splitting on --> statement-breakpoint
python3 -c "import hashlib;print(hashlib.sha256(
  open('packages/db/drizzle/0018_answer_feedback.sql','rb').read()).hexdigest())"

# 2 — VALIDATE the method against a migration production already has.
#     If the recomputed hash of 0017 doesn't match the stored row, stop.
railway ssh --service rag-postgres "psql -U \$POSTGRES_USER -d \$POSTGRES_DB \
  -c \"select id, created_at, left(hash,16) from drizzle.__drizzle_migrations \
       order by created_at desc limit 3;\""

# 3 — snapshot first (see the production drill above)

# 4 — apply the migration AND the tracking row in ONE transaction (-1),
#     base64 to sidestep nested-quote mangling through railway ssh
railway ssh --service rag-postgres \
  "echo '<base64>' | base64 -d | psql -U \$POSTGRES_USER -d \$POSTGRES_DB \
     -v ON_ERROR_STOP=1 -1 -f -"
```

The tracking row uses the journal's `when` verbatim — `1795000000000` for `0018`,
**not** a wall-clock timestamp. Using `now()` would place it far in the future
relative to later migrations' `when` values and silently mark everything after it
as already applied.

**Verify against local, not against expectations.** Local had `0018` applied by
the migrator itself, which makes it the ground truth for what the result should
look like. Diff columns, nullability, defaults, and full `indexdef` strings — the
`NULLS NOT DISTINCT` clause on `afb_answer_subject_unique` is exactly the kind of
detail a hand-application drops. Both sides came back byte-identical.

---

## Restoring for real

If production is ever lost, the sequence is:

1. Retrieve the most recent `backup-YYYY-MM-DD.sql.gz`.
2. Provision a Postgres **with the pgvector extension available**
   (`pgvector/pgvector:pg16` — a stock Postgres image will fail on
   `CREATE EXTENSION vector`).
3. Restore with `ON_ERROR_STOP=1` so a partial restore fails loudly rather than
   leaving a half-populated database.
4. Run the four verification queries above **before** pointing any service at it.
5. Run the e2e suite against it. 88/88 is the bar; anything less means investigate
   before serving traffic.

---

## Notes for whoever runs this next

- **Row counts alone are not a passing drill.** The dump can restore "cleanly"
  with the HNSW index missing — queries still return results, just wrong ones,
  slowly. Always diff `pg_indexes` counts.
- **The throwaway must be genuinely fresh.** Confirm `0` public tables before
  restoring; reusing a container that already has the schema proves nothing.
- **The audit log is in scope.** It is the §7216 / Circular 230 evidence trail, and
  it lives in the same database as everything else. Losing it is a compliance
  problem, not just an operational one — which is why `audit_log` is verified
  explicitly above rather than folded into a generic table count.
- **Run both legs, not one.** The local leg proves the _mechanism_ (fresh
  instance, extension from scratch, 88/88 e2e against restored data) on trivial
  volume — 1 source / 1 chunk / 19 audit rows. The production leg proves it at
  _real_ volume with real embeddings, but restores beside the source rather than
  onto a virgin server. Neither substitutes for the other.
- **Keep production data inside Railway.** The production leg streams
  `pg_dump | psql` over `railway ssh` — never to disk, never to a laptop. The KB is
  Class A/B and POL-01 is still unadopted; a dump file in `~/Downloads` is a
  compliance problem the drill has no reason to create.
