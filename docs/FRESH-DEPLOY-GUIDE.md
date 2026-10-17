# Fresh Live Deployment Guide

**Status:** Current · **Updated:** 2026-10-17 · **Target:** Railway + one Microsoft 365 / Entra tenant

End-to-end order of operations for standing the whole system up from nothing:
Entra app registrations and permissions, every Railway service, secrets,
first sync, access, Teams, and backups. It is the **sequence and the checklist**;
where a step has its own detailed runbook, this guide links to it rather than
repeating it.

> **Gate.** Standing the infrastructure up is fine for a you-only deployment.
> Real staff use stays gated on the P0 items in
> [`PILOT-MANUAL-RUNBOOK.md`](./PILOT-MANUAL-RUNBOOK.md) (content audit, counsel
> sign-off, a proven restore).

> **Never paste real secret values into this file** or any doc. Use the
> `<PLACEHOLDER>` form; real values live only in Railway variables (sealed).

---

## 0. Decisions to make first

These change which variables you set, so settle them before touching anything.

| Decision              | Options                                               | Consequence                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compliance mode       | `none` · `client-data`                                | `client-data` forces `local` embeddings with pre-warmed weights, a running content scanner, a DPA file in `docs/compliance/`, and TRI `block`. Read the `COMPLIANCE_MODE` block in `env.example` in full. |
| Embedding provider    | `gemini` (default) · `local` · `openai`               | Fixed once data is ingested — changing it means a re-embed. Must be **identical** on api, worker and mcp.                                                                                                 |
| Generation provider   | `gemini` · `openai` · `claude` · self-hosted          | Every hosted vendor's host must be in `EGRESS_ALLOWED_HOSTS`, and needs a DPA under `client-data`.                                                                                                        |
| SharePoint permission | `Sites.Read.All` · `Sites.Selected` (least privilege) | `Sites.Selected` needs one admin grant per site (§1.2).                                                                                                                                                   |
| Mail ingestion        | yes · no                                              | Yes adds `Mail.Read` (reads **every** mailbox in the tenant — no per-mailbox scoping without an Exchange application access policy).                                                                      |
| Teams bot             | yes · no                                              | Yes needs an **Azure subscription** (for the Azure Bot resource, free F0 tier) — the only part of this guide that does.                                                                                   |
| Backup destination    | `sharepoint` · `s3` · `azure`                         | See [`BACKUP-SCHEDULE-RUNBOOK.md`](./BACKUP-SCHEDULE-RUNBOOK.md).                                                                                                                                         |

---

## 1. Entra (Microsoft 365) setup

### 1.1 The app registrations

Four registrations, each with its own client secret. Keep them separate: a
client secret carries **every** permission on its app, so merging them hands the
broadest permission set to every service that holds any one secret.

| #   | App registration      | Env vars it fills                                                            | Permissions                                                                                                                                     | Admin consent                                                  | Redirect URI                                                     |
| --- | --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **Ingestion**         | `MS_TENANT_ID` · `MS_CLIENT_ID` · `MS_CLIENT_SECRET`                         | **Application:** `Sites.Read.All` + `Files.Read.All` (or `Sites.Selected` alone — §1.2) · `Mail.Read` (only if indexing mail) · `User.Read.All` | **Required**                                                   | none (client-credentials, no browser)                            |
| 2   | **Web sign-in**       | `AUTH_ENTRA_TENANT_ID` · `AUTH_ENTRA_CLIENT_ID` · `AUTH_ENTRA_CLIENT_SECRET` | **Delegated:** `openid` `profile` `email` `offline_access`                                                                                      | Optional (user-consentable; grant it so staff aren't prompted) | Web: `https://<web-domain>/api/auth/callback/microsoft-entra-id` |
| 3   | **Teams bot**         | `MICROSOFT_APP_ID` · `MICROSOFT_APP_PASSWORD` · `MICROSOFT_APP_TENANT_ID`    | **Delegated:** `openid` `profile` `email` `offline_access`                                                                                      | Yes                                                            | Web: `https://token.botframework.com/.auth/web/redirect`         |
| 4   | **Backup** (optional) | `GRAPH_TENANT_ID` · `GRAPH_CLIENT_ID` · `GRAPH_CLIENT_SECRET`                | **Application:** `Sites.Selected`, then `write` on **one** backup-only site                                                                     | **Required**                                                   | none                                                             |

All four are **single tenant** ("Accounts in this organizational directory only").

**Why `User.Read.All` is on the ingestion app.** `apps/web` reuses the
ingestion app's `MS_*` credentials (`apps/web/src/lib/graph-client.ts`) for two
app-only Graph calls: `GET /users/{email}` (the `/admin/access` page resolves an
email to an `oid` before granting it a source) and `checkMemberGroups` (the
admin-gate fallback when a user's token carries too many groups to list
inline). Without `User.Read.All`, granting access via the admin page fails;
asking questions is unaffected.

> ⚠ **Known trade-off.** Because of that reuse, `rag-web` — the public-facing
> service — holds a secret that can also read all of SharePoint (and all mail, if
> `Mail.Read` is granted). The cleaner shape is a fifth app with only
> `User.Read.All`, used only by the web app. That needs `graph-client.ts` to read
> its own env vars; it is not built yet.

**Per-app portal steps:**

- **Ingestion** — detailed walkthrough in
  [`PHASE-3-SHAREPOINT-RUNBOOK.md`](./PHASE-3-SHAREPOINT-RUNBOOK.md) Steps 1–4.
  Add `Mail.Read` and `User.Read.All` alongside the SharePoint permissions on the
  same **API permissions** page, then **Grant admin consent**.
- **Web sign-in** — [`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md) §1–2.
  Also **Token configuration → Add groups claim → Security groups** (sets
  `groupMembershipClaims=SecurityGroup`), and create the `RAG-Admins` security
  group — its object id is `RAG_ADMINS_GROUP_ID`. For local dev, add a second
  redirect URI `http://localhost:3000/api/auth/callback/microsoft-entra-id`.
- **Teams bot** — [`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md) §3–4.
  The Azure Bot resource creates or links this registration: choose **Create new
  Microsoft App ID** (recommended), so the bot's ID — and its secret — are not
  shared with any other app. On it: Application ID URI `api://botid-<MICROSOFT_APP_ID>`,
  scope `access_as_user`, pre-authorize the two Teams client IDs, add the
  `token.botframework.com` redirect URI above, then create the OAuth connection
  setting and confirm **Test Connection** passes.
- **Backup** — [`BACKUP-SCHEDULE-RUNBOOK.md`](./BACKUP-SCHEDULE-RUNBOOK.md) §2b–2d.

### 1.2 `Sites.Selected` instead of `Sites.Read.All` (least privilege)

`Sites.Selected` is two stages; the first alone grants **nothing**.

1. **Consent (Entra).** Add `Sites.Selected` as an **application** permission on
   the ingestion app and grant admin consent. The app is now merely _eligible_
   for per-site grants.
2. **Per-site grant (SharePoint, via Graph or PowerShell — no portal button).**
   A SharePoint admin (or a tool holding `Sites.FullControl.All`) runs, once per
   site to be indexed:

   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   Content-Type: application/json

   {
     "roles": ["read"],
     "grantedToIdentities": [
       { "application": { "id": "<ingestion MS_CLIENT_ID>", "displayName": "RAG Ingestion" } }
     ]
   }
   ```

   or with PnP PowerShell:

   ```powershell
   Grant-PnPAzureADAppSitePermission -AppId <MS_CLIENT_ID> -DisplayName "RAG Ingestion" `
     -Site https://<tenant>.sharepoint.com/sites/<site> -Permissions Read
   ```

   Roles are `read`, `write`, `manage`, `fullcontrol`. Ingestion needs `read`;
   the backup app gets `write` on its site the same way.

Consequences:

- **Do not also grant `Files.Read.All`.** It is tenant-wide on its own — every
  site and every user's OneDrive — and undoes the scoping. Drive and delta calls
  on a granted site work under `Sites.Selected` alone.
- **Every new source site is an IT request.** A source on an ungranted site fails
  its sync with 403 until the grant is run. The grant is whole-site;
  `folderPath` / `excludePaths` in the source config still do the narrowing.
- **IT needs the site URL or id** to run the grant — before it, the app cannot
  even resolve the site's id itself.
- **Switching an existing deployment:** grant every site already configured as a
  source _before_ removing `Sites.Read.All`, or the next sync fails.

### 1.3 What to send IT

If you can't consent yourself (needs Global Admin or Privileged Role Admin),
send one request covering all four apps: the permission column and redirect
URIs above, the `RAG-Admins` group, the Teams pre-authorizations, and — if a
Teams bot is wanted — the Azure subscription question. Offering to create the
registrations yourself (tenant policy permitting) and handing over only the
consent clicks shortens it to minutes.

---

## 2. Secrets to generate

Generate locally; set each on exactly the services listed, sealed.

| Secret                                  | Generate                             | Set on                                                                                                                                   |
| --------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                     | `openssl rand -hex 24`               | `rag-postgres` (and inside every `DATABASE_URL`)                                                                                         |
| `PARSER_SECRET`                         | `openssl rand -hex 32`               | `rag-parser`, `rag-api`, `rag-worker`, `rag-mcp` — **identical**, or every parse 401s                                                    |
| `API_TOKENS` (admin)                    | `openssl rand -hex 32`               | `rag-api`, `rag-mcp`, **and** `rag-worker` (the shared config rejects an empty list)                                                     |
| scope secret                            | `openssl rand -hex 32` (≥ 64 hex)    | `INTERNAL_SCOPE_JWT_SECRET` on `rag-web` + `rag-teams-bot`; the **same** value in `INTERNAL_SCOPE_JWT_SECRETS` (**plural**) on `rag-api` |
| `AUTH_SECRET`                           | `openssl rand -base64 33`            | `rag-web`                                                                                                                                |
| Entra client secrets                    | from §1 (shown once — record expiry) | per the app table                                                                                                                        |
| `GEMINI_API_KEY` (or the chosen vendor) | vendor console                       | `rag-api`, `rag-worker`, `rag-mcp`                                                                                                       |

> The API reads **`INTERNAL_SCOPE_JWT_SECRETS`** (comma-separated, for rotation);
> only `apps/web` and `apps/teams-bot` read the singular. Setting only the
> singular on `rag-api` makes every web and Teams request fail auth — the API
> logs a startup warning saying exactly this.

Put every Entra client-secret expiry in a calendar. A lapsed secret fails
silently: syncs 401, sign-in breaks, backups stop.

---

## 3. Railway services

One project, one `production` environment. All Node services build from the
**repo root** with a per-service config file; cross-service URLs always use
`*.railway.internal`.

| Service         | Source                                                  | Config / build                                                      | Public domain  | Healthcheck   |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------- | -------------- | ------------- |
| `rag-postgres`  | image `ghcr.io/railwayapp-templates/postgres-ssl:16.14` | volume at **exactly** `/var/lib/postgresql/data`                    | no             | —             |
| `rag-parser`    | repo, **Root Directory `/services/parser-py`**          | `RAILWAY_DOCKERFILE_PATH=Dockerfile`                                | no             | `/health`     |
| `rag-worker`    | repo, root `/`                                          | config file `apps/worker/railway.json` (runs migrations pre-deploy) | no             | none          |
| `rag-api`       | repo, root `/`                                          | config file `apps/api/railway.json`                                 | yes, port 8080 | `/health`     |
| `rag-mcp`       | repo, root `/`                                          | config file `apps/mcp/railway.json`                                 | yes, port 8080 | `/health`     |
| `rag-web`       | repo, root `/`                                          | config file `apps/web/railway.json`                                 | yes            | `/api/health` |
| `rag-teams-bot` | repo, root `/`                                          | config file `apps/teams-bot/railway.json`; **1 replica only**       | yes            | `/health`     |
| `ollama`        | image `ollama/ollama`                                   | volume at `/root/.ollama`                                           | no             | —             |
| `rag-backup`    | repo, root `/`                                          | config file `services/backup/railway.json`; cron `0 8 * * *` (UTC)  | no             | —             |

`ollama` is the self-hosted Layer 1.5 content scanner — required under
`COMPLIANCE_MODE=client-data`, optional otherwise. `rag-teams-bot` and
`rag-backup` are optional.

**Ports.** Don't set `PORT` anywhere. Railway injects `PORT=8080`, and api/mcp
fall back to it (`packages/core/src/config.ts`); the bot and web read it natively.
If you do pin `API_PORT` / `MCP_HTTP_PORT`, the domain's target port must match.

### 3.1 Variables per service

`env.example` is the authoritative reference for every variable below — read its
comment block before setting anything compliance-, embedding- or egress-related.

**`rag-postgres`** — `POSTGRES_USER=rag`, `POSTGRES_DB=rag`, `POSTGRES_PASSWORD`,
`PGDATA=/var/lib/postgresql/data/pgdata` (the entrypoint refuses to boot
otherwise), a `DATABASE_URL` on the service itself (so `railway connect` works),
and the six `WAL_ARCHIVE_*` vars for point-in-time recovery
([`BACKUP-SCHEDULE-RUNBOOK.md`](./BACKUP-SCHEDULE-RUNBOOK.md)). After first boot,
create a `postgres` superuser role too — the image's housekeeping and pgBackRest
connect as `postgres`, and WAL archiving stops silently without it.

**Shared by `rag-api`, `rag-worker`, `rag-mcp`:**

```env
DATABASE_URL=postgresql://rag:<POSTGRES_PASSWORD>@rag-postgres.railway.internal:5432/rag?sslmode=no-verify
PG_BOSS_SCHEMA=pgboss
PARSER_URL=http://rag-parser.railway.internal:8000
PARSER_SECRET=<PARSER_SECRET>
API_TOKENS=<admin token>
EMBEDDING_PROVIDER=gemini            # identical on all three
EMBEDDING_MODEL=gemini-embedding-001 # never text-embedding-004 (retired)
EMBEDDING_DIMENSIONS=768
GEMINI_API_KEY=<key>
EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com
COMPLIANCE_MODE=none                 # or client-data — see §0
LOG_LEVEL=info
```

`sslmode=no-verify` is deliberate: the image serves a self-signed cert, and
`pg-connection-string` treats `require` as `verify-full`, which fails. (The
backup service is the exception — §3.2.)

**`rag-api`** adds: `AUTH_PROVIDER=composite`, `INTERNAL_SCOPE_JWT_SECRETS`,
`GENERATION_PROVIDER` / `GENERATION_MODEL` / `GENERATION_TRI_POLICY`,
optionally `API_PRINCIPALS` / `API_ENFORCE_SCOPING`
([`CONFIGURE-PRINCIPALS.md`](./CONFIGURE-PRINCIPALS.md)) and `OBJECT_STORE_*`
(needed for downloadable citations).

**`rag-worker`** adds: `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`
(the worker is the only backend service that builds connectors),
`WORKER_CONCURRENCY`, `OBJECT_STORE_*` (same values as api), and if scanning:
`CONTENT_SCAN_PROVIDER=ollama`,
`CONTENT_SCAN_BASE_URL=http://ollama.railway.internal:11434/v1`,
`CONTENT_SCAN_MODEL=<model>` — and add `ollama.railway.internal` to
`EGRESS_ALLOWED_HOSTS`, or every scan throws and documents quarantine.
Optionally `EMBEDDING_REQUESTS_PER_MINUTE=60` if bulk ingest hits rate limits.

**`rag-mcp`** adds: `MCP_TRANSPORT=http`, `AUTH_PROVIDER=composite`, the
generation vars, `API_PRINCIPALS` if used, and `MCP_ALLOWED_ORIGINS` (blank
allows all origins — development only).

**`rag-web`:**

```env
AUTH_ENTRA_TENANT_ID=<tenant id>
AUTH_ENTRA_CLIENT_ID=<web app id>
AUTH_ENTRA_CLIENT_SECRET=<web app secret>
AUTH_SECRET=<AUTH_SECRET>
AUTH_URL=https://<web-domain>        # exact public base URL; drives the redirect_uri
AUTH_TRUST_HOST=true
RAG_API_URL=http://rag-api.railway.internal:8080
INTERNAL_SCOPE_JWT_SECRET=<scope secret>
RAG_ADMINS_GROUP_ID=<RAG-Admins object id>
DATABASE_URL=<same as api>
MS_TENANT_ID=<ingestion app>         # Graph: /admin/access + group-overage check
MS_CLIENT_ID=<ingestion app>
MS_CLIENT_SECRET=<ingestion app>
```

Leave `WEB_AUTH_MODE` at its `entra` default. `static-fallback` disables
authentication and gives every visitor one shared token — emergency only.

**`rag-teams-bot`** — the list and a one-pass CLI recipe are in
[`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md) §6b.

**`rag-parser`** — `PARSER_SECRET`, optionally `PARSER_MAX_UPLOAD_BYTES`.

### 3.2 Deploy order

1. **`rag-postgres`** — create with the volume and variables above; wait for
   Online; create the `postgres` role.
2. **`rag-parser`** — set the Root Directory **before** the first build (the
   Dockerfile's `COPY` paths assume that context). Verify:
   `railway ssh --service rag-parser curl -fsS localhost:8000/health`.
3. **`ollama`** (if scanning) — then pull the model once onto its volume:
   `railway ssh --service ollama ollama pull <CONTENT_SCAN_MODEL>`.
4. **`rag-worker` first** — its pre-deploy command runs migrations
   (`0000_init.sql` also creates the `vector`, `pg_trgm` and `uuid-ossp`
   extensions). api and mcp assert required indexes at boot and crash-loop until
   this has run. Never add the migrate command to api/mcp — concurrent bootstrap
   runs contend. On every later schema-changing release, deploy the worker first
   too.
5. **`rag-api`** and **`rag-mcp`** — then generate their public domains.
6. **`rag-web`** — generate its domain, then go back to the web app registration
   and set the redirect URI and `AUTH_URL` to it, and redeploy.
7. **`rag-teams-bot`** (if wanted) — generate its domain, then set the Azure Bot
   messaging endpoint to `https://<bot-domain>/api/messages`.
8. **`rag-backup`** — note it connects with **libpq** (`pg_dump`), which rejects
   `sslmode=no-verify`; its `DATABASE_URL` must use `sslmode=require` instead.
   Do not copy the Node services' URL.

Image-change and reindex rules for `rag-postgres` are in
[`DEPLOYMENT.md`](./DEPLOYMENT.md#upgrading-the-railway-postgres-image) — read
them before ever changing that image.

---

## 4. First source and first sync

Full walkthrough with troubleshooting:
[`PHASE-3-SHAREPOINT-RUNBOOK.md`](./PHASE-3-SHAREPOINT-RUNBOOK.md) Steps 6–10.
In short:

1. Resolve the Graph `siteId`
   (`GET /v1.0/sites/<tenant>.sharepoint.com:/sites/<SiteName>`).
   Under `Sites.Selected` the site must be granted first (§1.2).
2. `POST /sources` with an admin token:
   `{"kind":"sharepoint","name":"…","config":{"siteId":"…","excludePaths":[…]}}`.
3. `POST /sources/<id>/sync` with `{"mode":"full"}` → 202; watch
   `railway logs --service rag-worker`.
4. `POST /search` for a term you know is in a document → SharePoint-cited hits.
5. Schedule `{"mode":"incremental"}` syncs.

Connector config options (`driveId`, `folderPath`, `excludePaths`, Outlook
`userId`) are in [`CONNECTORS.md`](./CONNECTORS.md).

---

## 5. Access

- **Web users** — anyone in the tenant can sign in, but sees **nothing** until
  granted a source. A `RAG-Admins` member grants sources per user at
  `/admin/access` (needs `User.Read.All` — §1.1).
- **API / MCP tokens** — scoped per token via `API_PRINCIPALS`; see
  [`CONFIGURE-PRINCIPALS.md`](./CONFIGURE-PRINCIPALS.md). Once an `isAdmin`
  principal exists, set `API_ENFORCE_SCOPING=true`.

---

## 6. Teams app package

Build the manifest package with `pnpm --filter @rag/teams-bot package` (never
hand-edit the manifest) and upload it via the Teams admin center —
[`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md) §7. Org-wide upload may
need a tenant setting changed; see [`EMAIL-IT-TEAMS-APP-UPLOAD.md`](./EMAIL-IT-TEAMS-APP-UPLOAD.md).

---

## 7. Verification checklist

**Infrastructure**

- [ ] `curl https://<api-domain>/ready` → `{"status":"ready"}`; `/health` → ok
- [ ] Worker logs: pg-boss connected to schema `pgboss`, polling
- [ ] Parser `/health` ok, and a real parse from the worker does not 401
- [ ] `\di` on `rag-postgres` shows the HNSW + GIN indexes
- [ ] No service points at `localhost`; all internal URLs are `*.railway.internal`
- [ ] `PARSER_SECRET` identical on parser/api/worker/mcp; embedding vars identical on api/worker/mcp

**Entra**

- [ ] Ingestion app: every application permission shows **Granted for `<tenant>`**
- [ ] Under `Sites.Selected`: each source site granted `read`; `Files.Read.All` **absent**
- [ ] Web app: redirect URI matches the live domain exactly; groups claim configured
- [ ] Bot: OAuth connection **Test Connection** returns a token
- [ ] Every client-secret expiry is in a calendar

**End to end**

- [ ] Web: sign in, get granted a source via `/admin/access`, ask a real question → streamed answer with clickable citations
- [ ] Teams (if deployed): DM the bot → adaptive-card answer with citations
- [ ] `audit_log` rows appear with your `oid` as `principal_subject`
- [ ] First backup lands at its destination with a plausible size, and a restore
      has been drilled ([`BACKUP-RESTORE-DRILL.md`](./BACKUP-RESTORE-DRILL.md))

---

## Troubleshooting map

| Symptom                                 | Likely cause                                                                                        | Where                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| api/mcp crash-loop at boot              | migrations not run yet (deploy worker first), or a missing/short secret                             | §3.2                          |
| Every web/Teams request 401s at the API | scope secret set as singular on `rag-api`; it reads `INTERNAL_SCOPE_JWT_SECRETS`                    | §2                            |
| Sign-in: redirect_uri mismatch          | redirect URI ≠ `https://<web-domain>/api/auth/callback/microsoft-entra-id`, or `AUTH_URL` wrong     | §1.1, §3.1                    |
| `/admin/access` grant fails             | `User.Read.All` not consented, or `MS_*` missing on `rag-web`                                       | §1.1                          |
| Sync 403 at `validate()`                | admin consent missing, Delegated instead of Application, or site not granted under `Sites.Selected` | §1.2, Phase-3 runbook         |
| Every parse 401s                        | `PARSER_SECRET` mismatch                                                                            | §2                            |
| Documents quarantined, none indexed     | content scanner unreachable or its host not in `EGRESS_ALLOWED_HOSTS`                               | §3.1                          |
| Bot sends a sign-in card every time     | OAuth connection misconfigured / Teams client IDs not pre-authorized                                | Azure runbook troubleshooting |
| Backup fails "invalid sslmode value"    | Node-style `sslmode=no-verify` copied into the backup's `DATABASE_URL`                              | §3.2 step 8                   |
