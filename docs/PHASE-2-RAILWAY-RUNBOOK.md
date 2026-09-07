# Phase 2 — Railway Deploy Runbook (resume from here)

Self-contained steps to finish Phase 2. Project is already created and Postgres is
live; this covers the remaining work: Gemini key, pgvector extensions, fixing the
parser, deploying the 3 Node services, migrations, domains, and verification.

## Current state (LIVE — all services online, Phase 2 complete)

| Resource                 | State     | Notes                                                                                                                                                                                                                                                   |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project `rag-system`     | ✅        | id `d5676b24-11fe-4665-a9bb-1e55b3670eb1`                                                                                                                                                                                                               |
| Environment `production` | ✅        | id `53a51a39-6b88-493a-92f1-ff3cad32b73a`                                                                                                                                                                                                               |
| `rag-postgres`           | ✅ Online | `ghcr.io/railwayapp-templates/postgres-ssl:16.14` + volume (was `pgvector/pgvector:pg16` until 2026-09-02); `PGDATA=/var/lib/postgresql/data/pgdata`; extensions installed (`vector` 0.8.6, `pg_trgm`, `uuid-ossp`); `ssl = on`; **migrations applied** |
| `rag-api`                | ✅ Online | `https://rag-api-production-07b4.up.railway.app` — `/health` ok, `/ready` ok (DB ping passes)                                                                                                                                                           |
| `rag-worker`             | ✅ Online | pg-boss connected, polling `rag.sync_source` (concurrency 4)                                                                                                                                                                                            |
| `rag-mcp`                | ✅ Online | `https://rag-mcp-production-77f9.up.railway.app` — `/health` ok (http transport)                                                                                                                                                                        |
| `rag-parser`             | ✅ Online | **internal-only** (no public domain); Root Directory fix applied (Step 3). Verified 2026-06-18: worker → `rag-parser.railway.internal:8000/health` 200; authed `/parse` 200; missing-token `/parse` 401 (`PARSER_SECRET` enforced)                      |

> Migrations were run via a temporary Postgres **TCP proxy** + local
> `pnpm --filter @rag/db migrate`, then the proxy was **deleted** (DB is
> internal-only again). To migrate again later: recreate with
> `railway tcp-proxy --service rag-postgres create --port 5432`, migrate, then
> `railway tcp-proxy --service rag-postgres delete <id> --yes`.

**Committed code changes (in working tree, not yet committed):**

- `apps/{api,worker,mcp}/railway.json`, `services/parser-py/railway.json` — config-as-code.
- `services/parser-py/Dockerfile` — now binds IPv6 (`--host ::`) for private networking + runs as non-root `appuser`.

**Connection facts**

- Internal DB host: `rag-postgres.railway.internal:5432`, db `rag`, user `rag`.
- `DATABASE_URL` (already set on api/worker/mcp):
  `postgresql://rag:<DB_PASSWORD>@rag-postgres.railway.internal:5432/rag`
  (read the live value from the dashboard / `railway variables --service rag-postgres`).
- Generated secrets already set (read live values from the dashboard; rotate + seal
  for hygiene — see Step 6). Never paste real secret values into this doc:
  - `PARSER_SECRET` = `<PARSER_SECRET>` (on rag-parser/rag-api/rag-worker)
  - admin `API_TOKENS` = `<API_TOKENS>` (on rag-api/rag-mcp)

> Every command assumes the repo is linked (`railway status` shows project
> `rag-system` / env `production`). All work is in the `production` environment.

---

## Step 1 — Gemini key on all 3 Node services

The dashboard edit didn't reach `rag-api` in `production`. Verify each, fix any
that still say `REPLACE_ME`.

```bash
for s in rag-api rag-worker rag-mcp; do
  echo "== $s =="; railway variables --service "$s" | grep -i GEMINI_API_KEY
done
```

Fix (dashboard, sealed — preferred): Service → **Variables** → set
`GEMINI_API_KEY` on **rag-api, rag-worker, rag-mcp**, environment **production**,
then seal. Or CLI (note: lands in shell history):

```bash
for s in rag-api rag-worker rag-mcp; do
  railway variables --service "$s" --set "GEMINI_API_KEY=PASTE_KEY_HERE"
done
```

✅ Done when all three show a real value (or a sealed indicator), not `REPLACE_ME`.

### 1b — `API_TOKENS` is required on EVERY Node service (incl. worker)

The shared `loadConfig` validates `api.tokens` non-empty for **all** services (the
intentional "empty token allow-list throws" guard). The worker crash-loops without
it:

> `ZodError … path:["api","tokens"] — Array must contain at least 1 element(s)` at `loadConfig`

Fix (already applied to `rag-worker`):

```bash
railway variables --service rag-worker --set "API_TOKENS=<admin-token>"
```

✅ `rag-api`, `rag-mcp`, `rag-worker` all have `API_TOKENS`. (`rag-parser` is Python —
not affected.)

> **Boot-order chicken-and-egg:** `rag-api` (and `rag-mcp`, which also serves
> search/ask) run `assertRequiredIndexes` at boot, so they crash-loop until
> migrations exist. That means you can't SSH into them to run migrations. Run
> migrations from **`rag-worker`** (which does NOT assert indexes once it has
> `API_TOKENS`), or via the **TCP-proxy + local** fallback in Step 5. Then redeploy
> `rag-api` and `rag-mcp`.

---

## Step 2 — pgvector extensions (must run before migrations)

`railway connect` does **not** work here (rag-postgres is a raw Docker image, not a
managed plugin). Use the container's own `psql` over SSH (local socket, no proxy):

```bash
railway ssh --service rag-postgres
# inside the container:
psql -U rag -d rag
```

At the `psql` prompt:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SELECT extname FROM pg_extension;   -- expect: plpgsql, vector, pg_trgm, uuid-ossp
\q
```

Then `exit` the container.

> Non-interactive check (note the backslash must reach psql, so quote carefully):
> `railway ssh --service rag-postgres psql -U rag -d rag -c "SELECT extname FROM pg_extension;"`

✅ Done when `vector`, `pg_trgm`, `uuid-ossp` are all listed.

---

## Step 3 — Fix the parser (build-context mismatch) and redeploy

**Root cause:** `services/parser-py/Dockerfile` uses `COPY requirements.txt .` and
`COPY app/ ./app/`, which assume the build context is `services/parser-py/` (as in
local docker-compose). On Railway the deploy used `RAILWAY_DOCKERFILE_PATH` with the
**repo root** as context, so those COPYs can't find the files → build fails.

Confirm the cause:

```bash
railway logs --service rag-parser | tail -40   # expect a COPY / "not found" build error
```

**Fix (keeps the Dockerfile working both locally and on Railway):** point the parser
service at its own subdirectory so the build context matches the Dockerfile.

> NOTE (verified): the CLI context tricks do **not** work for this — both
> `railway up services/parser-py` ("prefix not found") and running `railway up`
> from inside `services/parser-py` ("couldn't locate the dockerfile at path
> Dockerfile in code archive") failed. Use the dashboard **Root Directory**
> setting, which is the reliable fix.

1. Dashboard → `rag-parser` → **Settings** → **Source** → **Root Directory** =
   `/services/parser-py`.
2. Same service → **Variables** → set `RAILWAY_DOCKERFILE_PATH=Dockerfile`
   (now relative to the new root directory) — or remove it so the default
   `Dockerfile` lookup applies.
3. Redeploy: dashboard **Deploy**, or `railway redeploy --service rag-parser --yes`.

> Do NOT change the parser Dockerfile's COPY paths — that would break local
> docker-compose (which builds with context `services/parser-py`). Changing the
> Root Directory is the correct fix. The Node services keep Root Directory `/`
> (repo root) because their Dockerfiles need the whole pnpm workspace.

✅ Done when `railway status` shows `rag-parser` Online and:
`railway ssh --service rag-parser curl -fsS localhost:8000/health` → ok
(or check the service's `/health` once a domain exists).

---

## Step 4 — Deploy the 3 Node services

Each uploads the local repo (working tree, so it includes the railway.json +
Dockerfile fixes) and builds with `RAILWAY_DOCKERFILE_PATH` against the repo root.
Run from the repo root. These are slow builds (pnpm install + tsc); `--detach`
returns immediately.

```bash
railway up --service rag-api --detach
railway up --service rag-worker --detach
railway up --service rag-mcp --detach
```

Watch:

```bash
railway logs --service rag-api | tail -40
railway logs --service rag-worker | tail -40
railway logs --service rag-mcp | tail -40
```

Expected gotchas:

- **api** boots through fail-fast guards (`assertEmbeddingDimensions`,
  `assertRequiredIndexes`). If indexes are missing it throws — that's expected
  until Step 5 (migrations) runs. Deploy migrations first if it crash-loops, or
  just redeploy api after Step 5.
- **worker** has no HTTP port; success = logs show pg-boss connected to schema
  `pgboss` and polling.
- **mcp** must show it's serving HTTP (we set `MCP_TRANSPORT=http`). If it exits
  immediately, confirm `MCP_TRANSPORT=http` is set.

---

## Step 5 — Run migrations

Run inside a **running** Node container so the internal DB host resolves (your
laptop can't reach `*.railway.internal`). Use **`rag-worker`** — `rag-api` is
crash-looping on the index guard until migrations exist, so you can't reliably SSH
into it yet. The worker image contains the same `@rag/db` package.

```bash
railway ssh --service rag-worker
# inside the container:
cd /app
pnpm --filter @rag/db migrate
# (fallback if the script name differs: check packages/db/package.json "scripts")
exit
```

Then **redeploy `rag-api`** so `assertRequiredIndexes` passes and it boots:

```bash
railway redeploy --service rag-api --yes
```

Verify the schema landed:

```bash
railway ssh --service rag-postgres psql -U rag -d rag -c "\dt"
railway ssh --service rag-postgres psql -U rag -d rag -c "\di"   # HNSW + GIN indexes present
```

> If `rag-api` isn't up yet (crash-looping on the index guard), you can instead run
> migrations from a one-off: temporarily set the api start command, or add a
> Postgres TCP proxy (dashboard → rag-postgres → Settings → Networking → TCP Proxy)
> and run `DATABASE_URL=postgresql://rag:…@<proxyhost>:<proxyport>/rag pnpm --filter @rag/db migrate`
> locally. Then redeploy `rag-api` so `assertRequiredIndexes` passes.

✅ Done when migrate reports applied and `\di` shows the HNSW + GIN indexes and the
tsv trigger exists.

---

## Step 6 — Public domains (api + mcp) and secret hygiene

Generate domains only for the two public services (worker + parser stay internal):

```bash
railway domain --service rag-api --port 3000    # app listens on API_PORT default 3000 (API_HOST=::)
railway domain --service rag-mcp --port 3001    # MCP_HTTP_PORT default 3001
```

Secret hygiene (optional but recommended — the originals passed through a CLI
session):

- Rotate `API_TOKENS` (new `openssl rand -hex 32`) on rag-api + rag-mcp; seal it.
- Re-set `PARSER_SECRET` identically on rag-parser + rag-api + rag-worker; seal it.
- Seal `GEMINI_API_KEY` on all three.

---

## Step 7 — Verification checklist (Phase 2 "done")

```bash
# api ready (pings DB)
curl -s https://<rag-api-domain>/ready        # -> {"status":"ready"}
curl -s https://<rag-api-domain>/health       # -> {"status":"ok"}

# parser reachable + auth on (no 401 from api/worker because PARSER_SECRET matches)
railway ssh --service rag-parser curl -fsS localhost:8000/health

# worker connected to pg-boss
railway logs --service rag-worker | grep -i 'pg-boss\|polling'

# indexes/trigger present (assertRequiredIndexes passed at api boot = no startup throw)
railway logs --service rag-api | grep -i 'assertRequiredIndexes\|listening'
```

- [ ] `GET /ready` → 200 `{status:"ready"}`
- [ ] parser `/health` ok; a real parse from the worker does **not** 401
- [ ] worker logs: connected to pg-boss schema `pgboss`, polling
- [ ] migrations applied; HNSW + GIN indexes + tsv trigger exist
- [ ] `PARSER_SECRET` identical on parser + api + worker (no open parse endpoint)
- [ ] no service points at `localhost` — all cross-service URLs use `*.railway.internal`

When all boxes are checked, Phase 2 is complete → proceed to **Phase 3** (real
SharePoint source: Azure app registration, `POST /sources`, first sync).

---

## Quick reference — service config summary

| Service      | Root Dir             | Dockerfile selector                                     | Public? | Port | Healthcheck |
| ------------ | -------------------- | ------------------------------------------------------- | ------- | ---- | ----------- |
| rag-postgres | n/a (image)          | —                                                       | no      | 5432 | n/a         |
| rag-parser   | `services/parser-py` | default `Dockerfile` (remove `RAILWAY_DOCKERFILE_PATH`) | no      | 8000 | `/health`   |
| rag-api      | `/`                  | `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile`           | yes     | 3000 | `/health`   |
| rag-worker   | `/`                  | `RAILWAY_DOCKERFILE_PATH=apps/worker/Dockerfile`        | no      | —    | none        |
| rag-mcp      | `/`                  | `RAILWAY_DOCKERFILE_PATH=apps/mcp/Dockerfile`           | yes     | 3001 | `/health`   |
