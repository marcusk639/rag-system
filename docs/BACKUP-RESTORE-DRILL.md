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
[Findings](#-findings-from-the-production-drill) — there is still no automated
backup, and production is one migration behind.

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

**1. Production is one migration behind.** `0018_answer_feedback` is applied
locally but **not in production** — 17 migrations vs 18, and the `answer_feedback`
table does not exist there. Meanwhile `apps/api/src/routes/feedback.ts` and
`answer-feedback.spec.ts` are built and passing. **If the API were deployed today,
feedback submission would fail against a missing table.** This is a launch item,
not a backup item — it is recorded here only because the drill surfaced it.

**2. There is still no automated backup.** This drill proves a restore _works_; it
does not create a backup _schedule_. `railway volume` exposes no `snapshot`
subcommand, so volume snapshots are not manageable from the CLI — confirm in the
dashboard whether they are enabled for `rag-postgres-volume`, and if not, add a
scheduled Railway service running the `pg_dump` above to object storage. Until
then the only backup is the one a human remembers to take.

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

### To close what's left

1. **Confirm volume snapshots** in the Railway dashboard for
   `rag-postgres-volume` — whether enabled, how far back, and the restore
   procedure. `railway volume` exposes no `snapshot` subcommand, so the CLI cannot
   answer this.
2. **If not enabled: add a scheduled Railway service** running the production
   `pg_dump` above, shipping the artifact to object storage. It must run inside
   the private network.
3. **Verify a scheduled artifact restores** — not just that the job ran green.
   A backup nobody has restored from is a hypothesis.

**Done when:** a restore has been watched succeed from an artifact **nobody took
by hand**.

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
