# Deployment

**Status:** Current · **Updated:** 2026-08-03 · **Live target:** Railway

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

**The live deployment target is Railway** (see [Migrations on deploy](#migrations-on-deploy-railway)
below). For a single-VM self-hosted stack use `docker/compose.prod.yml`;
[`DEPLOYMENT-TARGET.md`](./DEPLOYMENT-TARGET.md) holds that path's rationale and
provisioning steps — note it is **superseded as a description of what runs
today** and carries a banner saying so.

## Database

### Provisioning

Any Postgres 14+ with `pgvector` enabled works. Confirmed on:

- **Neon** — enable pgvector via SQL editor: `CREATE EXTENSION vector;`
- **Supabase** — enable pgvector in the dashboard (Database → Extensions).
- **AWS RDS** — pgvector is bundled in Postgres 15.5+ on RDS; enable via parameter group.
- **Self-hosted** — the `pgvector/pgvector:pg16` image used in `docker/docker-compose.yml`.
- **Railway (production, tenant #1)** — `ghcr.io/railwayapp-templates/postgres-ssl:16.14`, Railway's
  official Postgres image. Bundles pgvector (`postgresql-16-pgvector`), generates a self-signed cert on
  first boot (`ssl = on`), and ships pgBackRest for WAL archiving / point-in-time recovery. It hard-requires
  the volume mounted at exactly `/var/lib/postgresql/data` with `PGDATA=/var/lib/postgresql/data/pgdata` —
  the entrypoint exits non-zero otherwise. pgBackRest WAL archiving is
  **enabled as of 2026-09-02** (six `WAL_ARCHIVE_*` variables on `rag-postgres`, targeting the
  `rag-documents` bucket; `archive_mode=on`, `archive_timeout=60`). It is gated on `WAL_ARCHIVE_BUCKET` —
  unset that and the watcher returns early, silently. Note pgBackRest connects as
  `pg1-user=${PGUSER:-postgres}`, so the `postgres` superuser role must exist even though the application
  role is `rag`. See `docs/BACKUP-SCHEDULE-RUNBOOK.md`.

After provisioning, run:

```bash
DATABASE_URL=postgres://... pnpm db:migrate
```

This is idempotent — safe to re-run on every deploy.

### Upgrading the Railway Postgres image

Changing `rag-postgres`'s image is a live-volume migration, not a config tweak. Checklist:

```bash
railway service source connect --image <new-image> --service rag-postgres \
  --project <project-id> --environment <env-id>
```

1. **Pin the exact minor** (e.g. `:16.14`, not `:16`) so the server binary doesn't move underneath you.
2. **Check glibc, not just the PG version.** `select version()` reports the Debian build — `pgdg12` (bookworm,
   glibc 2.36) vs `pgdg13` (trixie, glibc 2.41). A same-minor image bump can still cross that boundary and
   invalidate every text btree index.
3. **If glibc moved, reindex before the version stamp is refreshed.** The image's entrypoint forks a "blind"
   `ALTER DATABASE ... REFRESH COLLATION VERSION` across all databases on boot, with no `REINDEX` — it treats
   the mismatch as cosmetic noise and, in silencing it, destroys the signal. Run this per connectable database
   (`rag`, `postgres`, `template1`, and any `rag_premigration_*`), not just `rag`:

   ```sql
   REINDEX DATABASE "<db>";
   ALTER DATABASE "<db>" REFRESH COLLATION VERSION;
   ```

4. **Bring extension catalogs up to the new binaries:** `ALTER EXTENSION vector UPDATE;` (the volume pins the
   SQL catalog at install-time version while the image carries the `.so`).
5. **Verify:** `datcollversion` matches the OS on every DB, `select count(*) from pg_index where not indisvalid`
   returns 0, and an HNSW probe (`ORDER BY embedding <=> ...`) still returns rows.
6. The image's housekeeping (collation refresh, pgBackRest watcher) connects as the `postgres` role. This
   deployment's superuser is `rag`, so a `postgres` superuser role must also exist or those scripts FATAL with
   `role "postgres" does not exist` — the database itself still serves traffic normally.

Rollback is `railway service source connect --image <old-image>`; the volume is untouched and generated certs
are inert to other images. Note that rolling back re-crosses the glibc boundary, so reindex either way.

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
