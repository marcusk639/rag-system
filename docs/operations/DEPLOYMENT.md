---
title: Deployment (Railway production reference)
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: What runs in production on Railway, which variables each service reads, how migrations, TLS, the Postgres image and monitoring work, and how to self-host with docker compose instead.
read_when: Changing a Railway service or variable, upgrading the Postgres image, diagnosing a deploy, or standing up a self-hosted stack.
supersedes: [DEPLOYMENT-TARGET.md, PHASE-2-RAILWAY-RUNBOOK.md]
code:
  [
    apps/worker/railway.json,
    apps/api/railway.json,
    apps/mcp/railway.json,
    apps/web/railway.json,
    apps/teams-bot/railway.json,
    services/parser-py/railway.json,
    services/backup/railway.json,
    docker/Dockerfile.warm-base,
    docker/compose.prod.yml,
    packages/core/src/config.ts,
    packages/db/src/migrate.ts,
    packages/db/src/hnsw.ts,
  ]
---

# Deployment

Production runs on **Railway**: one project, one `production` environment, nine services. Every Node service builds
from the repo root with its own `railway.json`. `rag-worker` alone runs migrations, in a pre-deploy step. Cross-service
URLs use `*.railway.internal`. This doc is the reference for what each service is and reads. For the order to stand a
deployment up from nothing, use [`FRESH-DEPLOY-GUIDE.md`](./FRESH-DEPLOY-GUIDE.md). Backups and restores are in
[`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md). The [self-host appendix](#appendix-self-hosting-with-docker-compose)
covers running without Railway.

Railway identifiers an operator needs (as of 2026-10-21): project `rag-system` id `d5676b24-11fe-4665-a9bb-1e55b3670eb1`,
environment `production` id `53a51a39-6b88-493a-92f1-ff3cad32b73a`. Public domains: `rag-api-production-07b4.up.railway.app`,
`rag-mcp-production-77f9.up.railway.app`, `rag-web-production-1c0a.up.railway.app`.

## Service inventory

| Service         | Built from                                              | Config / build                                                                            | Public | Healthcheck   | Role                                                    |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ | ------------- | ------------------------------------------------------- |
| `rag-postgres`  | image `ghcr.io/railwayapp-templates/postgres-ssl:16.14` | volume at exactly `/var/lib/postgresql/data`                                              | no     | —             | Postgres 16 + pgvector + pgBackRest                     |
| `rag-parser`    | repo, Root Directory `/services/parser-py`              | `services/parser-py/Dockerfile` (see [gotchas](#railway-gotchas))                         | no     | `/health`     | Python document parser                                  |
| `rag-worker`    | repo, root `/`                                          | `apps/worker/railway.json`; `preDeployCommand` runs migrations                            | no     | none          | pg-boss jobs: sync, ingest, audit ship, digests         |
| `rag-api`       | repo, root `/`                                          | `apps/api/railway.json`                                                                   | yes    | `/health`     | HTTP API                                                |
| `rag-mcp`       | repo, root `/`                                          | `apps/mcp/railway.json`                                                                   | yes    | `/health`     | MCP server over HTTP                                    |
| `rag-web`       | repo, root `/`                                          | `apps/web/railway.json`                                                                   | yes    | `/api/health` | Next.js chat UI (BFF over the API)                      |
| `rag-teams-bot` | repo, root `/`                                          | `apps/teams-bot/railway.json`; **one replica only**                                       | yes    | `/health`     | Teams bot (BFF over the API)                            |
| `ollama`        | image `ollama/ollama`                                   | volume at `/root/.ollama`                                                                 | no     | —             | Layer 1.5 content scanner (required in `client-data`)   |
| `rag-backup`    | repo, root `/`                                          | `services/backup/railway.json` (`restartPolicyType: NEVER`); cron is set in the dashboard | no     | —             | Nightly `pg_dump` ([details](./BACKUP-AND-RECOVERY.md)) |

The Node Dockerfiles use `pnpm deploy --prod` in a pruner stage, so the runtime image holds prod dependencies only and
**has no pnpm and no tsx**. Run package scripts in a container as compiled JS
(`node node_modules/@rag/db/dist/<script>.js`), never `pnpm --filter …`. `rag-teams-bot` must stay at one replica because
it keeps the SSO exchange in `MemoryStorage`. `ollama`, `rag-teams-bot` and `rag-backup` are optional outside
`COMPLIANCE_MODE=client-data`.

## Variables per service

`env.example` is the source of truth for every variable: its comments carry the defaults and the compliance coupling.
This table only says **who reads what**. Generate secrets as [`FRESH-DEPLOY-GUIDE.md` §2](./FRESH-DEPLOY-GUIDE.md#2-secrets-to-generate)
says.

| Variable / group                                                                                        | Set on                                            | Notes                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` with `?sslmode=no-verify`                                                                | api, worker, mcp, web, teams-bot                  | [TLS rules](#database-tls-and-sslmode)                                                                    |
| `DATABASE_URL` with `?sslmode=require`                                                                  | backup                                            | libpq; never copy the Node value                                                                          |
| `POSTGRES_USER=rag`, `POSTGRES_DB=rag`, `POSTGRES_PASSWORD`, `PGDATA`, `WAL_ARCHIVE_*`                  | postgres                                          | `PGDATA=/var/lib/postgresql/data/pgdata` or the entrypoint refuses to boot                                |
| `PARSER_URL=http://rag-parser.railway.internal:8000`                                                    | api, worker, mcp                                  | Default is `http://localhost:8000` (`packages/core/src/config.ts`)                                        |
| `PARSER_SECRET`                                                                                         | parser, api, worker, mcp                          | Must be identical on all four, or every parse returns 401                                                 |
| `API_TOKENS`                                                                                            | api, mcp, **worker**                              | The shared config rejects an empty list on every service (`config-schema.ts` `tokens`)                    |
| `API_PRINCIPALS`, `API_ENFORCE_SCOPING`                                                                 | api, mcp (same value on both)                     | [`ACCESS-CONTROL.md`](./ACCESS-CONTROL.md)                                                                |
| `AUTH_PROVIDER=composite` (+ `OIDC_*` if used)                                                          | api, mcp                                          | [root CLAUDE.md](../../CLAUDE.md) "Client auth config fails loud"                                         |
| `INTERNAL_SCOPE_JWT_SECRETS` (plural)                                                                   | api                                               | Comma-separated verify list; the API never reads the singular                                             |
| `INTERNAL_SCOPE_JWT_SECRET` (singular)                                                                  | web, teams-bot                                    | One of the api's values; at least 64 hex characters                                                       |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, vendor key                             | api, worker, mcp (identical)                      | Changing them means a re-embed. Never the retired `text-embedding-004`                                    |
| `GENERATION_PROVIDER`, `GENERATION_MODEL`, `GENERATION_TRI_POLICY`                                      | api, mcp                                          | Production model: UNVERIFIED (env.example default `gemini-2.5-flash`; check Railway)                      |
| `EGRESS_ALLOWED_HOSTS`, `COMPLIANCE_MODE`, `LOG_LEVEL`, `PG_BOSS_SCHEMA=pgboss`                         | api, worker, mcp                                  | Every vendor host contacted must be listed                                                                |
| `OBJECT_STORE_*`                                                                                        | api (serves downloads), worker (stores originals) | Same values on both                                                                                       |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`                                                      | **worker and web only**                           | Worker builds connectors (`apps/worker/src/deps.ts`); web uses Graph (`apps/web/src/lib/graph-client.ts`) |
| `WORKER_CONCURRENCY`, `EMBEDDING_REQUESTS_PER_MINUTE`                                                   | worker                                            | Defaults in env.example                                                                                   |
| `CONTENT_SCAN_PROVIDER=ollama`, `CONTENT_SCAN_BASE_URL`, `CONTENT_SCAN_MODEL`                           | worker                                            | Add `ollama.railway.internal` to `EGRESS_ALLOWED_HOSTS` or every document quarantines                     |
| `MCP_TRANSPORT=http`, `MCP_ALLOWED_ORIGINS`, `MCP_MAX_SESSIONS`                                         | mcp                                               | Blank `MCP_ALLOWED_ORIGINS` allows every origin (development only)                                        |
| `AUTH_ENTRA_*`, `AUTH_SECRET`, `AUTH_URL`, `AUTH_TRUST_HOST=true`, `RAG_ADMINS_GROUP_ID`, `RAG_API_URL` | web                                               | [`apps/web/CLAUDE.md`](../../apps/web/CLAUDE.md); leave `WEB_AUTH_MODE` at `entra`                        |
| `MICROSOFT_APP_*`, `BOT_ENTRA_SSO_SCOPE`, `BOT_OAUTH_CONNECTION_NAME`, `RAG_API_URL`                    | teams-bot                                         | [FRESH-DEPLOY-GUIDE appendix](./FRESH-DEPLOY-GUIDE.md#appendix-a-web-and-teams-entra-and-azure-detail)    |
| `PARSER_SECRET`, `PARSER_MAX_UPLOAD_BYTES`                                                              | parser                                            |                                                                                                           |
| Backup variables                                                                                        | backup                                            | [`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md)                                                      |

`RAG_API_URL` is `http://rag-api.railway.internal:8080` on both BFFs. `WEB_AUTH_MODE=static-fallback` turns off
authentication and gives every visitor one shared token; it is an emergency bypass only.

## Ports

Don't set `PORT` on any service. Railway injects `PORT=8080` and its healthcheck probes that port. api and mcp fall
back to it (`packages/core/src/config.ts`: `API_PORT ?? PORT ?? 3000`, `MCP_HTTP_PORT ?? PORT ?? 3001`). web and the
bot read `PORT` natively; the bot's own default is 3978 (`apps/teams-bot/src/config.ts`). If you pin `API_PORT` or
`MCP_HTTP_PORT`, the domain's target port must match it.

## Database TLS and sslmode

`rag-postgres` serves a self-signed certificate, and the two client stacks need opposite spellings of "encrypt, don't
verify":

| Client                                                        | Use                                    | Why                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Node services (pool, pg-boss, migrations)                     | `?sslmode=no-verify` in `DATABASE_URL` | `pg-connection-string` 2.10+ treats `require` as `verify-full`, which fails on the self-signed cert |
| libpq (`pg_dump` in `rag-backup`, `psql`, restore procedures) | `?sslmode=require`                     | libpq rejects `no-verify` as an invalid value                                                       |

`DATABASE_SSL` (`disable` / `require` / `no-verify`) is a separate pool-level knob (`packages/db/src/client.ts`
`pgSslOption`). In production `buildCoreDeps` logs a warning when neither it nor the URL enables TLS. Full certificate
verification would need the image's CA on every client; it is not a launch gate. The canonical comment block is the
`DATABASE_URL` section of `env.example`.

### Connection pooling

Each Node pool defaults to `max: 10` (`packages/db/src/client.ts` `createDb`). Against roughly 100 `max_connections`,
that fits about 5 api + 3 worker + 2 mcp replicas, plus web, bot and backup. Beyond that, put PgBouncer in transaction
mode in front and point `DATABASE_URL` at it. pg-boss and session-level features then need checking against the
pooler first.

## Migrations

The rule (worker `preDeployCommand` is the single migration owner; deploy `rag-worker` first on a schema change; never
add the command to api/mcp) is stated in the [root CLAUDE.md](../../CLAUDE.md) "Migrations auto-run on Railway deploy".
What it adds operationally:

- Railway runs the pre-deploy command between build and release, on the private network with the service's variables,
  **against the new image**. A non-zero exit aborts that deploy, so a migration committed with its code applies before
  the code serves traffic.
- The command is `node node_modules/@rag/db/dist/migrate.js` (`apps/worker/railway.json`). `pnpm --filter @rag/db migrate`
  cannot work inside the image (no pnpm, no tsx).
- `packages/db/src/migrate.ts` `applyMigrations` runs the idempotent `0000_init.sql` bootstrap first (it also creates the
  `vector`, `pg_trgm` and `uuid-ossp` extensions), then Drizzle's migrator for everything after.
- api, mcp and the worker app all run `assertRequiredIndexes` at boot and crash-loop on an unmigrated database. The
  pre-deploy process never boots the app, so it never reaches that assert.
- Applying a migration by hand, and the journal `when` and hash rules that make Drizzle skip or re-run one, are in
  [`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md).

## Upgrading the Railway Postgres image

Changing `rag-postgres`'s image is a live-volume migration. The image facts (volume path, `PGDATA`, the `postgres`
role, why local and CI use a different image) are in the root CLAUDE.md gotchas; this is the procedure.

1. Switch the image, pinned to an exact minor (`:16.14`, never `:16`):
   `railway service source connect --image <new-image> --service rag-postgres --project <project-id> --environment <env-id>`.
2. Check glibc, not only the Postgres version. `select version()` shows the Debian build: `pgdg12` is bookworm
   (glibc 2.36), `pgdg13` is trixie (glibc 2.41). A same-minor rebuild can cross that line and invalidate every text
   btree index.
3. If glibc moved, reindex **before** the collation stamp is refreshed. The image's boot script runs
   `ALTER DATABASE … REFRESH COLLATION VERSION` on every database with no reindex, which hides the evidence. For each
   connectable database (`rag`, `postgres`, `template1`, and any `rag_premigration_*`):

   ```sql
   REINDEX DATABASE "<db>";
   ALTER DATABASE "<db>" REFRESH COLLATION VERSION;
   ```

4. Bring the extension catalog up to the new binary: `ALTER EXTENSION vector UPDATE;`.
5. Confirm the `postgres` superuser role still exists. The image's housekeeping and pgBackRest connect as `postgres`
   (`pg1-user=${PGUSER:-postgres}`), while the app role is `rag`. Without it they fail with `role "postgres" does not exist`
   and WAL archiving stops silently, while the database keeps serving.
6. Verify: `datcollversion` matches the OS on every database, `select count(*) from pg_index where not indisvalid`
   returns 0, and an HNSW probe (`ORDER BY embedding <=> …`) returns rows.

Rollback is the same command with the old image; the volume is untouched. Rolling back re-crosses the glibc boundary,
so reindex either way.

Done when: every check in step 6 passes on every database and the next WAL archive lands
([`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md)).

## Retrieval index tuning

The HNSW index on `chunks.embedding` is built with `m = 16, ef_construction = 64` (`packages/db/drizzle/0000_init.sql`).
`hnsw.ef_search` is set per query with `SET LOCAL` in `packages/db/src/hybrid-search.ts`. The value comes from
`packages/db/src/hnsw.ts` `resolveEfSearch`: at least 100 and at least the dense candidate pool, capped at 1000. No env
var overrides it today, so there is nothing to tune at the connection level. The 768-dimension chain and the boot index
checks are in the `rag-postgres-contracts` skill and the root CLAUDE.md.

## Local embeddings in production

`EMBEDDING_PROVIDER=local` runs `Xenova/bge-base-en-v1.5` (768-d) in-process with no network egress. It is the only
embedding provider `COMPLIANCE_MODE=client-data` permits.

- **The weights are already in the images.** api, worker and mcp `COPY` the cache from the digest-pinned
  `ghcr.io/marcusk639/rag-warm-base@sha256:…` image (`docker/Dockerfile.warm-base`, published by
  `.github/workflows/warm-base.yml`). Each Dockerfile sets `ENV HF_CACHE_DIR=/app/.hf-cache` to match. Nothing runs at
  build or boot.
- **Don't override `HF_CACHE_DIR` on the service.** An empty or different value misses the baked cache. Under
  `client-data`, `LocalEmbeddingProvider` refuses to construct without it, and runtime downloads are refused.
- `scripts/warm-model.ts` is needed only for a non-Docker host or a mounted cache volume.
- `CHUNK_SIZE` is capped at 512 with this model (root CLAUDE.md).
- Resources: about 430 MB on disk, 200–400 MB extra RSS during batch embedding, and roughly 50–100 chunks/s on 2 cores.
  These are estimates, not measured on Railway.

The full `client-data` coupling (scanner, DPA file, TRI `block`, egress) is in `env.example` under `COMPLIANCE_MODE`.

## Secrets and rotation

Secrets live only in Railway variables, sealed in the dashboard. The CLI `--set` form lands in shell history. Never
put a value in a doc or a committed file; `.env` is never committed (template: `env.example`).

- **`API_TOKENS`:** set `API_TOKENS=old,new` on api, mcp and worker and redeploy, move callers to the new token, then
  remove the old one and redeploy again.
- **Scope secret:** add the new value to the api's `INTERNAL_SCOPE_JWT_SECRETS` list and deploy, switch web and bot to
  it, then drop the old value (`packages/core/src/internal-scope-auth.ts`).
- **`API_PRINCIPALS`:** regenerating replaces every token at once ([`ACCESS-CONTROL.md`](./ACCESS-CONTROL.md)).
- **Entra client secrets:** keep every expiry in a calendar. A lapsed secret fails quietly: syncs 401, sign-in breaks,
  backups stop.

## Capacity and bottlenecks

These are rough planning figures from vendor documentation, not production measurements.

| Path      | Bottleneck      | Figure                                                                                                                                                                                                             |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ingest    | Embedding API   | Gemini batches up to 100 inputs per call (`packages/rag/src/embeddings/gemini.ts`); throttle with `EMBEDDING_REQUESTS_PER_MINUTE`                                                                                  |
| Ingest    | Parser CPU      | About 5–20 documents/min per core, by format; parser replicas scale linearly                                                                                                                                       |
| Ingest    | Microsoft Graph | About 10K requests per 10 min per app per tenant, shared by SharePoint and Outlook; a 429 fails the job and pg-boss retries it (3 × 60 s with backoff); connectors do not retry in-process or honour `Retry-After` |
| Retrieval | Query embedding | About 50–200 ms per query                                                                                                                                                                                          |
| Retrieval | pgvector HNSW   | Under 10 ms below 1M chunks; under 100 ms below 10M                                                                                                                                                                |

The cheapest lever is not re-embedding: unchanged content short-circuits on its content hash, so avoid needless full
syncs.

## Monitoring

| Probe                                                                                  | What it tells you                                                                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /health` (api, mcp, bot), `GET /api/health` (web)                                 | Liveness only. The bot's `/health` is green with Postgres unreachable, by design |
| `GET /ready` (api)                                                                     | Database ping                                                                    |
| `SELECT state, count(*) FROM pgboss.job WHERE name = 'rag.sync_source' GROUP BY state` | Sync jobs by state; `created` is queue depth                                     |
| `SELECT name, policy FROM pgboss.queue WHERE name = 'rag.sync_source'`                 | Must be `singleton` (`packages/ingestion/src/queue.ts`)                          |
| `ingestion_jobs` rows with `status = 'failed'`                                         | Failed sync runs over time                                                       |
| `ingest_log` rows by `action` (`ingested`, `blocked`, `tri-flagged`, `failed`)         | Per-document outcomes                                                            |
| Worker log markers `ingest.run.summary`, `ingest.continuation`, `ingest.sync.failed`   | Run totals, pages still queued, and failed syncs                                 |

Also worth tracking: `chunks` row growth, api p95 latency on `/search` and `/ask`, and parser 5xx rate. No alerting is
wired today. The backup dead-man's switch is tracked in [`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md).

## Railway gotchas

- **Parser build context.** `services/parser-py/Dockerfile` copies `requirements.txt` and `app/` relative to its own
  directory, so the service needs Root Directory `/services/parser-py`. Don't change the `COPY` paths: local compose
  builds with that context. Neither CLI trick works: `railway up services/parser-py` fails with "prefix not found", and
  `railway up` from inside the directory can't locate the Dockerfile.
- **Parser Dockerfile selection.** `services/parser-py/railway.json` says `dockerfilePath: services/parser-py/Dockerfile`,
  which is repo-root-relative, while the live service uses Root Directory `/services/parser-py`, where the Dockerfile
  is just `Dockerfile`. UNVERIFIED which one wins. Settle it by checking `rag-parser` → Settings for the config-file
  path and any `RAILWAY_DOCKERFILE_PATH` variable.
- **The parser binds IPv6 and runs as non-root.** Uvicorn listens on `--host ::` port 8000 for private networking, as
  `appuser` (uid 10001).
- **Healthcheck vs pinned port.** On 2026-08-01 a pinned port that didn't match the domain's target port failed
  `rag-api`'s healthcheck. That is why no service sets `PORT` ([Ports](#ports)).
- **Migrating without the pre-deploy command.** Your laptop can't resolve `*.railway.internal`. Open a temporary TCP
  proxy with `railway tcp-proxy --service rag-postgres create --port 5432`, run
  `DATABASE_URL=postgresql://rag:…@<proxyhost>:<port>/rag?sslmode=no-verify pnpm db:migrate` locally, then
  `railway tcp-proxy --service rag-postgres delete <id> --yes`. The database is internal-only again once the proxy is
  gone.
- **`railway ssh` hides stdout in non-interactive mode** (seen with CLI v5.19 in 2026-06). Read database state
  interactively, or send output to stderr. UNVERIFIED on the current CLI version.
- **`railway connect rag-postgres`** depends on the image name and a `DATABASE_URL` on the database service (root
  CLAUDE.md). `rag-postgres` carries one since the 2026-09-02 move to the postgres-ssl image; the 2026-10-02 restore drill
  saw it resolve to `rag-postgres.railway.internal` ([`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md)).
- **Cron services need `restartPolicyType: NEVER`.** Railway skips a scheduled run while the previous deployment is
  still Active, so a crash-looping cron job suppresses every later run ([`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md)).

## Appendix: self-hosting with docker compose

`docker/compose.prod.yml` is a working single-host stack and the per-tenant provisioning unit for a deployment that
can't use Railway. It defines `postgres` (`pgvector/pgvector:pg16`), `parser`, `api`, `web`, `teams-bot`, `mcp` and
`worker`. It has no `ollama` and no backup service, so add those yourself if you need them. It was the planned target
until 2026-06-14; Railway replaced it, and it is not what runs in production today.

Build the images from the repo root first (each compose service reads an image name such as
`${WORKER_IMAGE:-rag-worker:latest}`):

```bash
docker build -f apps/api/Dockerfile    -t rag-api    .
docker build -f apps/worker/Dockerfile -t rag-worker .
docker build -f apps/mcp/Dockerfile    -t rag-mcp    .
docker build -f apps/web/Dockerfile    -t rag-web    .
```

Then provision one tenant:

```bash
cp env.example .env.<tenant>          # fill it in; never commit it
C="docker compose -f docker/compose.prod.yml --env-file .env.<tenant> -p <tenant>"
$C up -d postgres parser              # infrastructure first
$C run --rm worker node node_modules/@rag/db/dist/migrate.js   # the worker is the migration owner
$C up -d api mcp worker web           # add teams-bot if used
```

Done when: `curl http://<host>:<api-port>/ready` returns `{"status":"ready"}`.

Don't share one Postgres instance between tenants with sensitive data. Each tenant gets its own volume, secrets file
and `-p` project name.

### Encryption at rest

The `postgres_data` named volume must sit on an encrypted block device. Options:

- **Linux LUKS:** `cryptsetup luksFormat /dev/sdX`, then mount it at `/var/lib/docker/volumes/<tenant>_postgres_data/`.
- **Cloud disk encryption:** AWS EBS with KMS, GCP Persistent Disk with CMEK, or equivalent. Most cloud VMs encrypt by
  default; confirm it is on.
- **Verify:** `lsblk -o NAME,FSTYPE,MOUNTPOINT,SIZE` shows the underlying device as encrypted (for LUKS, a `crypto_LUKS`
  parent).

On Railway the volume is the platform's. UNVERIFIED: Railway's at-rest encryption guarantee for volumes; settle it from Railway's security documentation before relying on it for a compliance claim.

### When to move to Kubernetes

Move to namespace-per-tenant Kubernetes only when the number of isolated tenants makes managing N compose hosts
unwieldy. The same images and the per-source `data_class` model carry over with no app changes.
