# Automation Plan: SharePoint Go-Live

> **Goal:** Automate the four manual steps required to bring SharePoint ingestion live on
> the production Railway deployment.
>
> **Status:** Phase 1 complete. Phase 2 (create source + principals + sync) is next.
> **Date authored:** 2026-06-28 | **Last updated:** 2026-06-29
> **Prerequisites checked below in Phase 0.**
>
> **Session state (2026-06-29):**
>
> - ✅ Phase 1 done: MS_* set on rag-worker; auth canary passed
> - ✅ Drive enumeration done (see Phase 2 for confirmed IDs)
> - ✅ Scope locked: sync `Knowledge Base` subfolder only (Documents/Shared Documents drive)
> - ⬜ Phase 2: create source, update API_PRINCIPALS, trigger sync
> - ⬜ Phase 3: verify sync completion + E2E happy path

---

## Context

All code-level work (Phases A–G of `PLAN-SHAREPOINT-READINESS.md`) is **COMPLETE**. What
remains is pure operational: wire the secrets, create the source record, verify end-to-end,
and optionally enable download-original storage.

Four steps in dependency order:

1. Set `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` on Railway → `rag-worker`
2. Create a SharePoint source via `POST /sources`
3. Run Phase G E2E verification (checklist below)
4. _(Optional)_ Set `OBJECT_STORE_PROVIDER=s3` + bucket creds on Railway → `rag-api` + `rag-worker`

---

## Phase 0 — Prerequisites (READ FIRST — confirm before any action)

### 0.1 Tools required

| Tool                   | Check                                                                            |
| ---------------------- | -------------------------------------------------------------------------------- |
| `railway` CLI          | `railway --version`                                                              |
| `curl` + `jq`          | `curl --version && jq --version`                                                 |
| Railway project linked | `railway status` → shows `Project:` + `Environment:`                             |
| Admin bearer token     | Run `./scripts/gen-tokens.sh "service-admin::isAdmin"` and save the output token |

> **Admin token:** the `service-admin::isAdmin` principal has `isAdmin: true` → no source
> scoping. Use it for `POST /sources` and `POST /sources/:id/sync`. Keep it in an env var
> (`ADMIN_TOKEN=...`) for the duration of setup, then discard.

### 0.2 Known values

```bash
# Production API (verify via `railway variables --service rag-api | grep RAILWAY_PUBLIC_DOMAIN`)
export API_URL="https://rag-api-production-07b4.up.railway.app"

# SharePoint site — resolve the composite siteId BEFORE creating the source:
./scripts/resolve-siteid.sh https://<tenant>.sharepoint.com/sites/<SiteName>
# Output: "OK siteId = <tenant>.sharepoint.com,<guid1>,<guid2>"
# Copy the full composite siteId string.
export SITE_ID="<composite-siteId-from-above>"
```

### 0.3 Anti-pattern guards

- ❌ Do NOT hard-code secrets in scripts or commit them. Use env vars or `read -s`.
- ❌ Do NOT create the source before MS_* creds are live on `rag-worker` — the first sync
  will fail immediately if the connector can't authenticate.
- ❌ Do NOT skip `resolve-siteid.sh` — using a wrong siteId silently enqueues a sync that
  fails at the Graph layer with a cryptic 404.
- ❌ Do NOT use a user bearer token for source creation — use `service-admin::isAdmin`.

---

## Phase 1 — Set MS credentials on `rag-worker`

**Automates step 1. Depends on Phase 0. Blocks Phase 2.**

### Script to run

```bash
# Non-interactive (CI-safe) form — export creds in your shell first:
export MS_TENANT_ID="<directory/tenant-id>"
export MS_CLIENT_ID="<application/client-id>"
export MS_CLIENT_SECRET="<client-secret-value>"

./scripts/set-ms-credentials.sh
# Optionally also set on rag-api (not strictly required — worker handles syncs):
# ./scripts/set-ms-credentials.sh --with-api
```

The script (`scripts/set-ms-credentials.sh`) already exists. It:

- Prompts interactively if vars are not exported (secret is hidden)
- Sets `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` on `rag-worker` via Railway CLI
- Redeploys `rag-worker` automatically (use `--no-redeploy` to skip if you want to batch
  multiple var changes)

### Verification checklist

- [ ] `railway variables --service rag-worker | grep -i MS_` shows all three variables set
- [ ] Wait for `rag-worker` redeploy to complete (Railway dashboard → Deployments → green)
      before running resolve-siteid — SSH will fail against a mid-restart container
- [ ] `./scripts/resolve-siteid.sh https://<tenant>.sharepoint.com/sites/<SiteName>`
      returns `OK siteId = ...` (proves token + `Sites.Read.All` consent are both working)
- [ ] No `TOKEN_ERROR` or `GRAPH_ERROR` output from resolve-siteid

### Why resolve-siteid is the auth canary

The resolver script runs inside the `rag-worker` container via `railway ssh`. It mints a
token using the MS credentials set above and calls Graph's `/sites/{host}:{path}`. A clean
siteId proves: (a) the credentials are valid, (b) the redirect URI / consent is correct,
(c) the `Sites.Read.All` (and `Files.Read.All`) app permissions are admin-consented.

---

## Phase 2 — Create the SharePoint source via `POST /sources`

**Automates step 2. Depends on Phase 1 (auth canary must pass). Blocks Phase 3.**

### Generate an admin token

> **Token expiry:** Generate the token immediately before running Phase 2 — don't reuse one
> from an earlier session. Tokens in this system have a finite TTL; a stale token produces
> silent 401s with no indication that the token (not the API) is the problem.

```bash
# From the rag-system repo root:
export ADMIN_TOKEN=$(./scripts/gen-tokens.sh "service-admin::isAdmin" | jq -r '.[0].token')

# Guard: confirm non-empty before proceeding
echo "Admin token preview: ${ADMIN_TOKEN:0:20}..."
[ -z "$ADMIN_TOKEN" ] && echo "ERROR: ADMIN_TOKEN is empty — check gen-tokens.sh output" && exit 1
```

> If `jq` is unavailable or the format differs, run bare and copy manually:
> `./scripts/gen-tokens.sh "service-admin::isAdmin"`

### Create the source

```bash
export API_URL="https://rag-api-production-07b4.up.railway.app"
export SITE_ID="<composite-siteId-from-resolve-siteid>"

# Validate siteId format before writing to DB: must be host,guid,guid
echo "$SITE_ID" | grep -qE '^[^,]+,[a-f0-9-]+,[a-f0-9-]+$' \
  || { echo "ERROR: siteId format looks wrong — expected 'host,guid,guid' (copy from resolve-siteid output)"; exit 1; }

# Minimal config (all files, all document libraries in the site):
curl -fsS -X POST "$API_URL/sources" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "TWK SharePoint",
    "kind": "sharepoint",
    "config": {
      "siteId": "'"$SITE_ID"'"
    }
  }' | jq .

# Optional: scope to a specific drive and/or folder:
# "config": {
#   "siteId": "'"$SITE_ID"'",
#   "driveId": "<driveId>",       # omit to ingest ALL document libraries
#   "folderPath": "/Clients/2026" # omit to ingest from root
# }
```

Save the returned source `id` (UUID) — you'll need it for the remaining phases.

```bash
export SOURCE_ID="<uuid-from-POST-response>"
```

### Update API_PRINCIPALS to include the new source

Before triggering the sync, grant marcus and chris access to the new source. Without this
step their tokens are scoped to the old source list and `/ask` against `$SOURCE_ID` returns
empty results with no error.

```bash
# Update deploy_tokens.sh to add $SOURCE_ID to marcus + chris source lists, then:
./scripts/deploy_tokens.sh

# Or inline (replace <existing-uuids> with the current source UUIDs from the script):
PRINCIPALS=$(./scripts/gen-tokens.sh \
  "marcus:<existing-uuids>,$SOURCE_ID" \
  "chris:<existing-uuids>,$SOURCE_ID" \
  "service-admin::isAdmin")
railway variables --service rag-api --set "API_PRINCIPALS=$PRINCIPALS"
railway variables --service rag-mcp --set "API_PRINCIPALS=$PRINCIPALS"
railway redeploy --service rag-api --yes
railway redeploy --service rag-mcp --yes
```

### Trigger the first sync

```bash
# Full sync (re-ingests everything regardless of cursor state):
curl -fsS -X POST "$API_URL/sources/$SOURCE_ID/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}' | jq .
```

### Verification checklist

- [ ] `POST /sources` returns HTTP 201 with `id`, `kind: "sharepoint"`, `name` set
- [ ] `GET $API_URL/sources/$SOURCE_ID` returns the source record (config stripped)
- [ ] `POST /sources/$SOURCE_ID/sync` returns `{"enqueued": true}` (or equivalent)
- [ ] Railway dashboard → `rag-worker` logs show `"Starting sync for source"` within ~30s

---

## Phase 3 — Phase G E2E Verification

**Automates step 3. Depends on Phase 2 (first sync must have run and completed).**

**Wait for sync completion before running these checks.** Starting Phase 3 mid-sync gives
`documentsProcessed: 0` and empty `/ask` results, which looks like a failure but isn't.

Estimated sync time: ~5–20 min for a few hundred documents; sites with thousands of files
across many libraries may take 1–3 hours (per-page re-enqueue processes 5 pages/job).

### Wait for sync to finish

```bash
# Option A — stream worker logs and watch for the summary marker:
railway logs --service rag-worker --tail
# Look for: "marker":"ingest.run.summary"
# with documentsProcessed > 0. A continuation line means more pages are queued.

# Option B — poll pg-boss job state until no running jobs remain:
railway run --service rag-worker -- \
  node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); \
    p.query(\"SELECT state,count(*) FROM pgboss.job WHERE name='rag.sync_source' GROUP BY state\").then(r=>console.log(r.rows)).finally(()=>p.end())"
# All done when only 'completed' rows remain (no 'created' or 'active').
```

### 3.1 CI health

Confirm the latest `main` commit has a passing CI run before declaring go-live complete.
Check the GitHub Actions status or Railway build logs — the full test suite is already
validated by CI and doesn't need to re-run locally as part of this operational runbook.

```bash
# Quick local sanity check (typecheck only, skips the multi-minute test suite):
cd /Users/marcus/dev/rag-system && pnpm typecheck
```

If you hit a local typecheck failure that CI doesn't show, it's a local env issue (stale
build artifacts) — run `pnpm build` first, then recheck.

### 3.2 API health

```bash
curl -fsS "$API_URL/health" | jq .
```

### 3.3 Source sync status

```bash
# List sources — verify status is not "error":
curl -fsS "$API_URL/sources" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.sources[] | {id, name, kind, status}'

# Check document count (use marcus or chris token for scoped access):
export MARCUS_TOKEN="<marcus-bearer-token>"
curl -fsS "$API_URL/sources/$SOURCE_ID" \
  -H "Authorization: Bearer $MARCUS_TOKEN" | jq .
```

### 3.4 End-to-end happy path

```bash
# Ask a question that should be answerable from SharePoint content:
curl -fsS -X POST "$API_URL/ask" \
  -H "Authorization: Bearer $MARCUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What tax return types does TWK prepare?",
    "allowedSourceIds": ["'"$SOURCE_ID"'"]
  }' | jq '{answer: .answer, citations: [.citations[] | {title, url, downloadable}]}'
```

Expected: answer is substantive (Phase E), cites `[N]`, citations include `url` (SharePoint
`webUrl`), and `downloadable: false` (unless object store is configured — Phase 4).

### 3.5 Full Phase G checklist

From `PLAN-SHAREPOINT-READINESS.md` Phase G:

- [ ] Latest `main` CI run is green (GitHub Actions); local `pnpm typecheck` passes
- [ ] First sync completed — run summary shows nonzero `documentsProcessed`
- [ ] `documentsSkippedOversize` logged for any file > 50 MB (check worker logs)
- [ ] At least one answer is substantive, multi-source, cites `[N]`
- [ ] Citation `url` resolves to the SharePoint `webUrl` in the browser
- [ ] Web UI citation modal shows "Open source document" link (not just the document id)
- [ ] Anti-pattern greps return nothing bad:

```bash
cd /Users/marcus/dev/rag-system

# No pg/drizzle-orm imports outside packages/db:
grep -r "import.*from.*['\"]pg['\"]" packages/ apps/ --include="*.ts" \
  | grep -v "packages/db/" | grep -v ".test." && echo "FAIL: pg outside db" || echo "OK"

grep -r "from.*drizzle-orm" packages/ apps/ --include="*.ts" \
  | grep -v "packages/db/" && echo "FAIL: drizzle outside db" || echo "OK"

# No bytea for originals:
grep -r "bytea" packages/db/src/schema.ts && echo "FAIL: bytea in schema" || echo "OK"

# Download route goes through services (not ad-hoc DB in route):
grep -n "import.*db\|import.*queries" apps/api/src/routes/documents.ts \
  && echo "WARN: direct db in documents route" || echo "OK"

# Prompt still has safety clauses:
grep -c "untrusted\|only use\|\[N\]\|refuse" \
  packages/rag/src/generation/generator.ts && echo "OK: prompt safety intact"
```

- [ ] `env.example` has `OBJECT_STORE_*` vars (verify: `grep OBJECT_STORE env.example`)
- [ ] `docs/ARCHITECTURE.md` reflects download capability (review manually)

### 3.6 Scale reliability check (Phase B)

After a large sync or if you want to confirm per-page re-enqueue:

```bash
# Check worker logs for continuation messages:
railway logs --service rag-worker | grep -E "continuation|singleton|maxPages"

# Confirm rag.sync_source queue is set to singleton policy (check pg-boss queue row):
railway run --service rag-worker -- \
  node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); \
    p.query(\"SELECT name,policy FROM pgboss.queue WHERE name='rag.sync_source'\").then(r=>console.log(r.rows)).finally(()=>p.end())"
```

---

## Phase 4 — (Optional) Enable download-original via S3 object store

**Automates step 4. Independent — can run any time; re-sync sources afterward.**

### 4.1 Set Railway environment variables

```bash
# Set on BOTH rag-api (serves downloads) and rag-worker (uploads at ingest):
for SVC in rag-api rag-worker; do
  railway variables --service "$SVC" \
    --set "OBJECT_STORE_PROVIDER=s3" \
    --set "OBJECT_STORE_BUCKET=<your-bucket-name>" \
    --set "OBJECT_STORE_ENDPOINT=<endpoint-url-for-railway-or-s3>" \
    --set "OBJECT_STORE_REGION=us-east-1" \
    --set "OBJECT_STORE_ACCESS_KEY_ID=<access-key>" \
    --set "OBJECT_STORE_SECRET_ACCESS_KEY=<secret-key>" \
    --set "OBJECT_STORE_FORCE_PATH_STYLE=true"
done

# Redeploy both:
railway redeploy --service rag-api --yes
railway redeploy --service rag-worker --yes
```

For **Railway Buckets**: navigate to the bucket service → Connect → copy the S3 endpoint,
access key, secret key, and bucket name from the Railway dashboard.

### 4.2 Run the DB migration (if not already applied)

The `0002_documents_original_storage.sql` migration adds `storage_key`, `storage_bucket`,
`original_size_bytes` columns.

First, check whether it's already applied:

```bash
# Check migration status — "ALREADY APPLIED" means skip 4.2; "NEEDS MIGRATION" means run it.
railway run --service rag-api -- \
  node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); \
    p.query(\"SELECT id FROM drizzle.__drizzle_migrations WHERE id LIKE '%0002%'\") \
     .then(r=>console.log(r.rows.length ? 'ALREADY APPLIED' : 'NEEDS MIGRATION')) \
     .finally(()=>p.end())"
```

If `NEEDS MIGRATION`:

```bash
# Run migrations via Railway context (DATABASE_URL is injected automatically):
railway run --service rag-api -- pnpm db:migrate
```

Confirm: output shows migration `0002` applied.

### 4.3 Re-trigger a full sync so originals are captured

```bash
curl -fsS -X POST "$API_URL/sources/$SOURCE_ID/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}' | jq .
```

> Originals are only captured on content change. A full re-sync triggers `contentChanged`
> for all docs, which populates `storageKey` / `storageBucket` / `originalSizeBytes`.

### 4.4 Verify download works

```bash
# Get a document id from a citation:
DOC_ID="<document-id-from-ask-response>"

# Should stream the original file with Content-Disposition: attachment:
curl -fsSI "$API_URL/documents/$DOC_ID/download" \
  -H "Authorization: Bearer $MARCUS_TOKEN"
# Expect: 200 with Content-Type matching the file's MIME type

# Out-of-scope test (should be 404, not 403):
curl -fsS "$API_URL/documents/$DOC_ID/download" \
  -H "Authorization: Bearer <unrelated-user-token>" \
  && echo "FAIL: should have been 404" || echo "OK: 404 returned"
```

### 4.5 Verification checklist

- [ ] `railway variables --service rag-worker | grep OBJECT_STORE` shows all vars set
- [ ] After re-sync, worker logs show no `put` errors (look for `objectStore` error lines)
- [ ] `GET /documents/:id/download` returns 200 with correct `Content-Type` + attachment header
- [ ] Citation modal in web UI shows "Download original" button for downloadable docs
- [ ] Out-of-scope document returns 404 (not 403)
- [ ] `originalSizeBytes` > 0 for synced docs (check via admin DB query if needed)

---

## Execution order summary

```
Phase 0: Prerequisites check (5 min)
    ↓
Phase 1: Set MS_* creds + resolve-siteid canary (5 min)
    ↓
Phase 2: POST /sources + first sync trigger (5 min, then wait for sync)
    ↓
Phase 3: E2E verification checklist (15–30 min depending on corpus size)
    ↓ (independent — can run any time)
Phase 4: Object store setup + re-sync (optional, 10 min setup + sync time)
```

---

## Rollback notes

| Action               | Rollback                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| MS_* set on Railway  | `railway variables --service rag-worker --remove MS_TENANT_ID MS_CLIENT_ID MS_CLIENT_SECRET` then redeploy                         |
| Source created       | `DELETE $API_URL/sources/$SOURCE_ID` (cascades docs + chunks)                                                                      |
| Object store enabled | Set `OBJECT_STORE_PROVIDER=none`, redeploy both services — existing `storage_key` columns stay but downloads return 404 gracefully |
| DB migration `0002`  | Columns are nullable; migration doesn't break anything if rolled back to `none` store                                              |
