# Deployment

How to run the RAG system in production. Local dev is covered in the root README; this doc focuses on the production picture.

## Components to deploy

| Component           | Where it runs                          | Scaling                                                                                              |
| ------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Postgres + pgvector | Managed (Neon, Supabase, RDS)          | Vertical for write-heavy ingestion. Read replicas for retrieval-heavy workloads.                     |
| Python parser       | N container replicas                   | Horizontal — stateless. Tune count by ingestion throughput.                                          |
| `@rag/api`          | N container replicas behind LB         | Horizontal — stateless. Add replicas when retrieval QPS climbs.                                      |
| `@rag/mcp`          | 1+ replicas (HTTP) or per-user (stdio) | HTTP for shared agent infrastructure. stdio for single-user (Claude Desktop).                        |
| `@rag/worker`       | N replicas                             | Horizontal — pg-boss distributes jobs. Each replica processes `WORKER_CONCURRENCY` docs in parallel. |

## Environment variables

Every runtime reads the same `.env` (or container env). See `env.example` at repo root for the authoritative list. The minimum to bring the system up:

```
DATABASE_URL=postgres://...
GEMINI_API_KEY=...              # or OPENAI_API_KEY if you set EMBEDDING_PROVIDER=openai
API_TOKENS=long-random-token-here
PARSER_URL=http://parser:8000   # service-discoverable URL
```

Source-specific credentials (Microsoft, Google) only need to be present on the **worker** — the API and MCP server don't talk to external sources directly.

## Docker images

Each Node app has a production-ready multi-stage Dockerfile at `apps/<name>/Dockerfile`.
Build context is always the **repo root** (required for pnpm workspace resolution):

```bash
docker build -f apps/api/Dockerfile    -t rag-api    .
docker build -f apps/mcp/Dockerfile    -t rag-mcp    .
docker build -f apps/worker/Dockerfile -t rag-worker  .
```

The Dockerfiles use `pnpm deploy --prod` in a pruner stage to produce a
self-contained bundle (prod deps only, no other workspace apps). The parser image
is at `services/parser-py/Dockerfile`.

For a single-VM production stack use `docker/compose.prod.yml`. See
`docs/DEPLOYMENT-TARGET.md` for the deployment-target rationale (D1) and
provisioning steps.

## Database

### Provisioning

Any Postgres 14+ with `pgvector` enabled works. Confirmed on:

- **Neon** — enable pgvector via SQL editor: `CREATE EXTENSION vector;`
- **Supabase** — enable pgvector in the dashboard (Database → Extensions).
- **AWS RDS** — pgvector is bundled in Postgres 15.5+ on RDS; enable via parameter group.
- **Self-hosted** — the `pgvector/pgvector:pg16` image used in `docker/docker-compose.yml`.

After provisioning, run:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
```

This is idempotent — safe to re-run on every deploy.

### Migrations on deploy (Railway)

Migrations run **automatically** via the `rag-worker` service's `preDeployCommand`
(`pnpm --filter @rag/db migrate`, see `apps/worker/railway.json`). Railway runs a
pre-deploy command between build and release, on the private network with the
service's env vars; if it exits non-zero the deployment is aborted. Because it
runs against the **new** image, any migration committed alongside code ships and
applies before that code serves traffic.

**The worker is the single migration owner** — it boots without the index-assert
guard that makes `rag-api`/`rag-mcp` crash-loop on a not-yet-migrated DB. Do NOT
add the same `preDeployCommand` to `rag-api`/`rag-mcp`: concurrent runs of the
`0000_init.sql` bootstrap (HNSW/GIN index creation) would contend.

**Ordering caveat for schema-changing releases:** Railway has no cross-service
deploy ordering, so deploy `rag-worker` **first** (or alone) on any release that
adds a column the API reads, then `rag-api`/`rag-mcp`. This avoids a brief window
where new API code queries a column the migration hasn't added yet. For a release
with no schema change, order doesn't matter.

### Connection pooling

The Node clients each create a 10-connection pool by default. For a Postgres instance with ~100 max connections, that supports roughly:

- 5 API replicas
- 3 worker replicas
- 2 MCP HTTP replicas

If you go higher, put a pooler in front (PgBouncer in transaction mode, or Neon's built-in pooler) and set `DATABASE_URL` to the pooler endpoint.

### Indexes

The HNSW index on `chunks.embedding` is created with `m=16, ef_construction=64`. Tune at query time by setting `hnsw.ef_search` per session — higher = better recall, slower. The system doesn't tune this automatically; if your retrieval recall is too low, raise the session GUC in your DB connection setup:

```sql
SET hnsw.ef_search = 100;  -- default 40
```

### Backup & restore (P0 for any deployment holding real client data)

Postgres is the **sole** store for chunks, embeddings, sources, and the compliance
`audit_log` — there is no secondary copy of any of this data anywhere else in the
system. An unrecoverable Postgres loss means total, permanent data loss including
the audit trail itself.

**Status as of 2026-07-12: restore mechanism verified end-to-end; automated
backup does NOT exist yet — this is the open half of the gate.**

**Step 1 result — which Postgres this deployment actually has:** confirmed via
`railway variables --service rag-postgres` (raw `POSTGRES_USER`/`POSTGRES_PASSWORD`/
`POSTGRES_DB`/`PGDATA` env vars, no `DATABASE_PUBLIC_URL`) — this is a
**self-hosted `pgvector/pgvector:pg16` container on a Railway volume**
(`rag-postgres-volume`, 368MB/5000MB used), not Railway's managed Postgres
plugin. `railway volume list` exposes no backup/snapshot metadata for this
volume. **Conclusion: nothing is currently taking automated backups of this
data.** A volume-loss event today would be unrecoverable.

**Step 3 result — manual restore drill, run 2026-07-12 via `railway ssh -s rag-postgres`:**

1. `pg_dump -F c` streamed from the live container over `railway ssh` to a local
   file (36MB, 130 TOC entries, including the `vector`/`pg_trgm`/`uuid-ossp`
   extensions and the `data_class`/`source_kind`/`ingestion_status` enum types) —
   read-only against production, no writes.
2. Restored into a throwaway local `pgvector/pgvector:pg16` Docker container
   (never touched the live database) via `pg_restore --no-owner --no-privileges` —
   clean restore, zero errors in the log.
3. Verified row counts match production exactly: `chunks`=6175, `documents`=858,
   `sources`=3, `audit_log`=3. Spot-checked zero `chunks` rows with a null
   `embedding` or `text` post-restore. Confirmed all six `chunks` indexes
   (including `chunks_embedding_hnsw_idx`) and all five `documents` indexes
   (including the GIN metadata index) rebuilt correctly from the dump.
4. Torn down the scratch container and deleted the local dump file immediately
   after verification — no copy of production data was retained beyond the drill.

**What this proves:** if a `pg_dump` is taken, it restores cleanly and completely
— the mechanics work, including the vector index and extensions that are the
parts most likely to silently fail on restore.

**What this does NOT prove, and what's still open:** there is no scheduled job
producing that `pg_dump` today. This drill required manually pulling one on
demand via `railway ssh`. **The remaining P0 work is Step 2 below — standing up
an actual recurring backup job** — not re-verifying the restore path, which is
now done.

**Step 2 — still open — build the actual backup job.** Since this is a
self-hosted container (confirmed above, not the managed plugin), a recurring
`pg_dump` is needed. Lowest-effort option that fits this stack: a scheduled
job to an S3-compatible bucket (the object-store infra for uploads already
exists — see `STORAGE_*` env vars in `env.example` — a backup bucket can reuse
the same credentials/provider). Options, roughly in order of effort:

- A pg-boss recurring job (mirrors the pattern already shipped for
  `docsGapDigest`/`shipAuditLog` — see `packages/ingestion/src/queue.ts`) that
  shells out to `pg_dump` and uploads the result. Reuses infra already in the
  codebase; no new scheduler to operate.
- A Railway cron service running `pg_dump | gzip | upload` on a schedule,
  external to the app.
- `pg_basebackup` + WAL archiving if point-in-time recovery (not just
  daily-snapshot recovery) is required — more operational surface, only worth
  it if the RPO target demands it.

Re-run the restore drill above (same `railway ssh -s rag-postgres` → scratch
Docker container → row-count/index verification procedure) periodically once
the recurring job exists, so "the backup job runs" and "the backup job
produces something restorable" are both continuously verified, not just
proven once on 2026-07-12.

Record the date, who ran it, and the verification results in this file once
done — that record is itself the P0 evidence, not just the backup existing.

**Status as of this writing: not yet done.** This step needs live Railway
dashboard/CLI access this session does not have — it's the one P0 backup/restore
action that requires a human with production credentials, not more code.

## Local embedding provider setup (CPA / §7216 compliance)

When `EMBEDDING_PROVIDER=local`, embeddings run on-process via `@huggingface/transformers` (ONNX runtime) with zero network egress. This is required for any environment where real taxpayer documents may enter the pipeline.

### Required env vars

```env
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=Xenova/bge-base-en-v1.5   # 768-d; must match chunks.embedding column
EMBEDDING_DIMENSIONS=768
HF_CACHE_DIR=/opt/hf-cache               # shared across redeploys; avoids re-download
```

### First-startup model download (~430 MB)

On first boot the ONNX runtime downloads `bge-base-en-v1.5` from HuggingFace Hub to `HF_CACHE_DIR`. In production, pre-warm the cache during the Docker image build so the first live query doesn't time out:

```dockerfile
# In Dockerfile (worker and api), after `pnpm install`:
RUN npx tsx scripts/warm-model.ts
```

Or run it manually before the first deploy:

```sh
HF_CACHE_DIR=/opt/hf-cache npx tsx scripts/warm-model.ts
```

Subsequent container restarts read from the cache volume — no network egress, no download delay. Mount `HF_CACHE_DIR` as a persistent volume so it survives redeploys.

### Disk and memory

| Resource                    | Estimate                        |
| --------------------------- | ------------------------------- |
| Model size on disk          | ~430 MB                         |
| Peak RSS during batch embed | +200–400 MB above baseline      |
| Throughput                  | ~50–100 chunks/s on a 2-core VM |

### Compliance checklist

- [ ] `EMBEDDING_PROVIDER=local` — confirmed in production `.env`
- [ ] `HF_CACHE_DIR` — mounted as a persistent volume
- [ ] `EGRESS_ALLOWED_HOSTS` — set to the generation vendor only (not the embedding API)
- [ ] `COMPLIANCE_MODE=client-data` — set once a DPA is filed in `docs/compliance/`
- [ ] `scripts/warm-model.ts` — runs in Dockerfile before first deploy

---

## Secrets

DO NOT commit `.env`. The hook in this repo's parent setup blocks `.env` writes to enforce that. Production options, ordered by preference:

1. **Secret Manager** (GCP Secret Manager, AWS Secrets Manager, Vercel Environment Variables): inject as env at container start.
2. **Kubernetes Secrets** with `secretKeyRef` env entries.
3. **HashiCorp Vault** with a sidecar injector.

For the API token allow-list (`API_TOKENS`), rotate by:

1. Add a new token to the env: `API_TOKENS=old-token,new-token`.
2. Roll the API deployment.
3. Update callers to use the new token.
4. Remove the old token: `API_TOKENS=new-token`.
5. Roll the API deployment again.

## Scaling guidance

### Ingestion is bottlenecked by

1. **Embedding API throughput.** Gemini free tier is 1500 req/min; OpenAI is much higher but paid. The worker batches up to 100 chunks per Gemini call, so it can process ~150K chunks/min before saturating the free tier.
2. **Parser sidecar CPU.** Document parsing (especially OCR via Unstructured) is CPU-bound. Scale parser replicas linearly; one core handles 5–20 docs/min depending on format.
3. **Source rate limits.** Microsoft Graph: ~10K requests / 10 min per app per tenant. Google Workspace: much higher. The connectors throw `ConnectorTransientError` on 429; pg-boss retries with backoff.

### Retrieval is bottlenecked by

1. **Embedding latency for the query.** ~50–200ms per query depending on provider.
2. **pgvector ANN search.** Sub-10ms for <1M chunks with HNSW; sub-100ms for <10M. Past that, partition by tenant or move to a dedicated vector store.

### Cost levers (rough order of impact)

- **Use a free embedding provider.** Gemini is free up to its quota; switching from OpenAI saves $0.13 per million embedded tokens.
- **Embed only changed content.** The content-hash short-circuit ensures unchanged documents skip embedding. Don't trigger full syncs unnecessarily.
- **Tune chunk size.** Smaller chunks = more embedding calls; larger chunks = fewer but worse retrieval precision. The default 800 tokens / 120 overlap is a reasonable middle.
- **Tune HNSW ef_search.** Lower = faster, less recall. Find the lowest value that meets your quality bar.

## Monitoring

Endpoints to scrape / probe:

- `GET /health` on API: liveness.
- `GET /ready` on API: dependency check (DB).
- pg-boss exposes job stats via SQL: `SELECT * FROM pgboss.job WHERE state IN ('active', 'failed')`.
- `ingestion_jobs` table is human-readable history of sync runs.

Recommended metrics to track:

- `ingestion_jobs.status='failed'` count over time
- pg-boss queue depth (`SELECT COUNT(*) FROM pgboss.job WHERE state='created'`)
- `chunks` row count growth
- API p95 latency on `/search` and `/ask`
- Parser sidecar 5xx rate
