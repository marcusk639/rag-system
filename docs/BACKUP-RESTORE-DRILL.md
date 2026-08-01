# Backup & Restore Drill — TWK KB

**P0 gate #3** from `TWK-LAUNCH-STATUS.md`. Runbook item 3 in `TWK-MANUAL-RUNBOOK.md`.

**Drill run:** 2026-07-31 · **Result:** ✅ mechanism proven end-to-end
**Still outstanding:** the production leg — see [What is NOT yet proven](#what-is-not-yet-proven).

> **Why this exists:** Postgres is the sole store for chunks, embeddings, sources,
> **and the compliance audit log**. Before the drill there was no confirmed,
> tested recovery path — only an assumption that one existed.

---

## Result summary

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

## Exactly what was run

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

## What is NOT yet proven

⚠ **The drill ran against the local dev database, not Railway production.**

The mechanism is proven — dump format, extension round-trip, index survival,
vector integrity, and full application compatibility. What is **not** proven is
the production access path.

**Blocker found during the drill, and it is a real finding:**

- `rag-postgres` on Railway is a **raw Docker image on a Railway volume**
  (`RAILWAY_VOLUME_ID` / `RAILWAY_VOLUME_MOUNT_PATH` confirmed in its variables),
  **not** Railway's managed Postgres plugin. **Managed-plugin automatic backups do
  not apply.**
- Postgres has **no public TCP domain** — it is private-network only.
- The Railway **CLI is not installed** locally, and the MCP integration returns
  variable names with **values redacted**, so no connection string is reachable
  from this machine.

**Consequence:** a backup cannot be taken from a laptop at all. It **must run
inside Railway's network**. That is not a limitation to work around — it's the
correct design — but it means the backup job is infrastructure work, not a script
someone runs locally and forgets.

### To close the production leg

1. Install and authenticate the Railway CLI (`railway login`), or use the
   dashboard.
2. Confirm whether **volume snapshots** are enabled for the `rag-postgres` volume
   — how far back they go, and the restore procedure.
3. If not enabled: add a **scheduled Railway service** running the pg_dump command
   above, shipping the artifact to object storage. It must run inside the private
   network.
4. **Re-run this drill against a real production dump.** Every command above works
   unchanged; only the source of the dump differs.

**Done when:** a restore from a _production_ backup has been watched succeed —
not just this local proof.

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
- **Data volume was small** (1 source / 1 chunk / 19 audit rows). That is enough to
  prove format and mechanism, and is _not_ enough to prove restore duration at
  scale. Re-time the restore once real content is indexed.
