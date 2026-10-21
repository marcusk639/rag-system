---
title: Fresh deployment guide
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: The ordered steps and checklist for standing the whole system up from nothing on Railway against one Microsoft 365 / Entra tenant, including the web and Teams Azure portal detail.
read_when: Building a new deployment, rebuilding a service, registering Entra apps, or deploying the Teams bot.
supersedes:
  [
    AZURE-DEPLOY-RUNBOOK.md,
    TEAMS-MVP-REQUIREMENTS.md (deploy traps),
    PHASE-2-RAILWAY-RUNBOOK.md,
  ]
code:
  [
    apps/web/src/lib/graph-client.ts,
    apps/teams-bot/src/config.ts,
    apps/teams-bot/scripts/build-teams-package.mjs,
    packages/core/src/internal-scope-auth.ts,
    packages/core/src/config.ts,
  ]
---

# Fresh deployment guide

This is the order of operations for a from-zero deployment: Entra app registrations, secrets, every Railway service,
the first sync, access, Teams and backups. Each step links to the doc that owns its detail.
[`DEPLOYMENT.md`](./DEPLOYMENT.md) is the reference for what each service is and which variables it reads. Appendix A
holds the Azure portal detail for the web app and the Teams bot.

Standing the infrastructure up is fine for a you-only deployment. Real staff use stays gated on the P0 items in
[`LAUNCH-RUNBOOK.md`](../launch/LAUNCH-RUNBOOK.md); current gate state is in [`LAUNCH-STATUS.md`](../launch/LAUNCH-STATUS.md).
Never paste a real secret into a doc. Use `<PLACEHOLDER>`s; real values live only in sealed Railway variables.

## 0. Decisions to make first

These change which variables you set.

| Decision              | Options                                               | Consequence                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compliance mode       | `none` · `client-data`                                | `client-data` forces `local` embeddings with pre-warmed weights, a running content scanner, a DPA file in `docs/compliance/`, and TRI `block`. Read the `COMPLIANCE_MODE` block in `env.example`. |
| Embedding provider    | `gemini` (default) · `local` · `openai`               | Fixed once data is ingested; changing it means a re-embed. Must be identical on api, worker and mcp.                                                                                              |
| Generation provider   | `gemini` · `openai` · `claude` · self-hosted          | Every hosted vendor's host goes in `EGRESS_ALLOWED_HOSTS` and needs a DPA under `client-data`. Self-hosted: [`LOCAL-GENERATION.md`](./LOCAL-GENERATION.md).                                       |
| SharePoint permission | `Sites.Read.All` · `Sites.Selected` (least privilege) | `Sites.Selected` needs one admin grant per site (§1.2).                                                                                                                                           |
| Mail ingestion        | yes · no                                              | Yes adds `Mail.Read`, which reads every mailbox in the tenant unless an Exchange application access policy narrows it.                                                                            |
| Teams bot             | yes · no                                              | Yes needs an Azure subscription for the Azure Bot resource (free F0 tier). Nothing else in this guide does.                                                                                       |
| Backup destination    | `sharepoint` · `s3` · `azure`                         | [`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md).                                                                                                                                             |

## 1. Entra (Microsoft 365) setup

### 1.1 The app registrations

Create four registrations, each with its own client secret. Keep them separate: a client secret carries every
permission on its app, so merging them gives the broadest permission set to every service holding any one secret. All
four are single tenant ("Accounts in this organizational directory only").

| #   | App registration      | Env vars it fills                                                            | Permissions                                                                                                                        | Admin consent                               | Redirect URI                                                     |
| --- | --------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **Ingestion**         | `MS_TENANT_ID` · `MS_CLIENT_ID` · `MS_CLIENT_SECRET`                         | Application: `Sites.Read.All` + `Files.Read.All` (or `Sites.Selected` alone, §1.2) · `Mail.Read` (only for mail) · `User.Read.All` | Required                                    | none (client credentials)                                        |
| 2   | **Web sign-in**       | `AUTH_ENTRA_TENANT_ID` · `AUTH_ENTRA_CLIENT_ID` · `AUTH_ENTRA_CLIENT_SECRET` | Delegated: `openid` `profile` `email` `offline_access`                                                                             | Optional; grant it so staff aren't prompted | Web: `https://<web-domain>/api/auth/callback/microsoft-entra-id` |
| 3   | **Teams bot**         | `MICROSOFT_APP_ID` · `MICROSOFT_APP_PASSWORD` · `MICROSOFT_APP_TENANT_ID`    | Delegated: `openid` `profile` `email` `offline_access`                                                                             | Yes                                         | Web: `https://token.botframework.com/.auth/web/redirect`         |
| 4   | **Backup** (optional) | `GRAPH_TENANT_ID` · `GRAPH_CLIENT_ID` · `GRAPH_CLIENT_SECRET`                | Application: `Sites.Selected`, then `write` on one backup-only site                                                                | Required                                    | none                                                             |

**Why `User.Read.All` is on the ingestion app.** `apps/web` reuses the ingestion app's `MS_*` credentials
(`apps/web/src/lib/graph-client.ts`) for two app-only Graph calls. `GET /users/{email}` lets `/admin/access` resolve an
email to an `oid` before granting it a source. `checkMemberGroups` is the admin-gate fallback when a token carries too
many groups to list inline. Without `User.Read.All`, granting access from the admin page fails; asking questions still
works.

**Known trade-off.** Because of that reuse, `rag-web`, the public-facing service, holds a secret that can read all of
SharePoint (and all mail, if `Mail.Read` is granted). The cleaner shape is a fifth app with only `User.Read.All`, read
by the web app alone. That needs `graph-client.ts` to read its own env vars, and it is not built.

Per-app portal steps:

- **Ingestion:** [`SHAREPOINT-RUNBOOK.md`](./SHAREPOINT-RUNBOOK.md#register-the-ingestion-app), plus `Mail.Read` (if
  wanted) and `User.Read.All` on the same API permissions page, then **Grant admin consent**.
- **Web sign-in:** [Appendix A.1–A.2](#a2-web-app-registration). Add the groups claim and create the `RAG-Admins` group.
  For local dev, add a second redirect URI `http://localhost:3000/api/auth/callback/microsoft-entra-id`.
- **Teams bot:** [Appendix A.3–A.4](#a3-azure-bot-and-bot-registration).
- **Backup:** [`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md).

### 1.2 `Sites.Selected` instead of `Sites.Read.All`

`Sites.Selected` takes two stages; the first alone grants nothing.

1. **Consent (Entra).** Add `Sites.Selected` as an application permission on the ingestion app and grant admin consent.
   The app is now only eligible for per-site grants.
2. **Per-site grant (Graph or PowerShell; there is no portal button).** A SharePoint admin, or a tool holding
   `Sites.FullControl.All`, runs this once per site:

   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   Content-Type: application/json

   { "roles": ["read"],
     "grantedToIdentities": [ { "application": { "id": "<ingestion MS_CLIENT_ID>", "displayName": "RAG Ingestion" } } ] }
   ```

   or with PnP PowerShell:

   ```powershell
   Grant-PnPAzureADAppSitePermission -AppId <MS_CLIENT_ID> -DisplayName "RAG Ingestion" `
     -Site https://<tenant>.sharepoint.com/sites/<site> -Permissions Read
   ```

   Roles are `read`, `write`, `manage` and `fullcontrol`. Ingestion needs `read`; the backup app gets `write` on its
   site the same way.

Consequences:

- **Don't also grant `Files.Read.All`.** It is tenant-wide on its own (every site and every OneDrive) and undoes the
  scoping. Drive and delta calls on a granted site work under `Sites.Selected` alone.
- **Every new source site is an IT request.** A source on an ungranted site fails its sync with 403. The grant is
  whole-site; `folderPath` and `excludePaths` in the source config still narrow it.
- **IT needs the site URL or id** to run the grant. Before it, the app can't resolve the site id itself.
- **Switching an existing deployment:** grant every configured source site before removing `Sites.Read.All`, or the next
  sync fails.

Done when: each source site shows the grant, and `Files.Read.All` is absent from the ingestion app.

### 1.3 What to send IT

If you can't consent yourself (that needs Global Admin or Privileged Role Admin), send one request covering all four
apps: the permissions and redirect URIs above, the `RAG-Admins` group, the Teams pre-authorizations (Appendix A.3),
the Azure subscription question if a bot is wanted, and the custom-app upload policy (Appendix A.6). Offering to
create the registrations yourself, if tenant policy allows, and leaving IT only the consent clicks shortens it to
minutes.

## 2. Secrets to generate

Generate locally, set each on exactly the services listed, and seal it.

| Secret                                  | Generate                                       | Set on                                                                                                                             |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                     | `openssl rand -hex 24`                         | `rag-postgres`, and inside every `DATABASE_URL`                                                                                    |
| `PARSER_SECRET`                         | `openssl rand -hex 32`                         | `rag-parser`, `rag-api`, `rag-worker`, `rag-mcp`: identical, or every parse returns 401                                            |
| `API_TOKENS` (admin)                    | `openssl rand -hex 32`                         | `rag-api`, `rag-mcp` and `rag-worker` (the shared config rejects an empty list on every service)                                   |
| Scope secret                            | `openssl rand -hex 32` (64 hex, the minimum)   | `INTERNAL_SCOPE_JWT_SECRET` on `rag-web` and `rag-teams-bot`; the same value in `INTERNAL_SCOPE_JWT_SECRETS` (plural) on `rag-api` |
| `AUTH_SECRET`                           | `npx auth secret` or `openssl rand -base64 33` | `rag-web` (Auth.js session key, not the scope secret)                                                                              |
| Entra client secrets                    | §1; each is shown once, so record the expiry   | per the app table                                                                                                                  |
| `GEMINI_API_KEY` (or the chosen vendor) | vendor console                                 | `rag-api`, `rag-worker`, `rag-mcp`                                                                                                 |

The API reads only `INTERNAL_SCOPE_JWT_SECRETS` (comma-separated, for rotation). If only the singular is set on
`rag-api`, every web and Teams request fails auth, and the API logs a startup warning naming the mistake. Services
refuse to start with a scope secret under 64 characters (`packages/core/src/internal-scope-auth.ts`). Put every Entra
secret expiry in a calendar: a lapsed secret makes syncs 401, breaks sign-in and stops backups.

## 3. Railway services

One project and one `production` environment. The service list, build config, healthchecks and the full
who-reads-what variable table are in [`DEPLOYMENT.md`](./DEPLOYMENT.md#service-inventory). Don't set `PORT` anywhere
([why](./DEPLOYMENT.md#ports)).

### 3.1 Variables

Set variables from the [DEPLOYMENT variable table](./DEPLOYMENT.md#variables-per-service), reading each `env.example`
comment block before any compliance, embedding or egress variable. The block shared by `rag-api`, `rag-worker` and
`rag-mcp`:

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
COMPLIANCE_MODE=none                 # or client-data, see §0
LOG_LEVEL=info
```

For `rag-postgres`, after first boot, create a `postgres` superuser role as well. The image's housekeeping and
pgBackRest connect as `postgres`, and WAL archiving stops silently without it. `rag-web` and `rag-teams-bot` variables
are in Appendix A.2 and A.5.

### 3.2 Deploy order

1. **`rag-postgres`:** create it with the volume and variables, wait for Online, then create the `postgres` role.
2. **`rag-parser`:** set Root Directory `/services/parser-py` before the first build, because the Dockerfile's `COPY`
   paths assume that context. How the Dockerfile is selected is UNVERIFIED
   ([gotcha](./DEPLOYMENT.md#railway-gotchas)). Verify with `railway ssh --service rag-parser curl -fsS localhost:8000/health`.
3. **`ollama`** (if scanning): pull the model once onto its volume with
   `railway ssh --service ollama ollama pull <CONTENT_SCAN_MODEL>`.
4. **`rag-worker`:** deploy it first. Its pre-deploy command runs migrations, and api and mcp crash-loop until they
   have run. On every later schema-changing release, deploy the worker first too.
5. **`rag-api`** and **`rag-mcp`:** deploy, then generate their public domains.
6. **`rag-web`:** generate its domain, set the web app's redirect URI and `AUTH_URL` to it, then redeploy.
7. **`rag-teams-bot`** (if wanted): Appendix A.5.
8. **`rag-backup`:** its `DATABASE_URL` uses `sslmode=require`, because libpq rejects `no-verify`. Don't copy the Node
   services' URL. `services/backup/railway.json` sets only `restartPolicyType: NEVER`, so set the cron schedule in the
   dashboard (production uses `0 8 * * *` UTC; UNVERIFIED as of 2026-10-21), and only after one manual run has exited
   `Completed` ([`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md)).

Read the [Postgres image upgrade procedure](./DEPLOYMENT.md#upgrading-the-railway-postgres-image) before ever changing
that image.

Done when: every service is Online and the §7 infrastructure checks pass.

## 4. First source and first sync

Follow [`SHAREPOINT-RUNBOOK.md`](./SHAREPOINT-RUNBOOK.md): resolve the `siteId`, `POST /sources`, run a full sync, verify
with `/search`, then schedule incremental syncs. Connector config options are in
[`CONNECTORS.md`](../reference/CONNECTORS.md).

Confirm the tenant has SharePoint Online before launch. App-only Graph auth succeeds against a tenant with no
SharePoint licence, so the problem shows up only at the first sync, as `400 BadRequest: Tenant does not have a SPO
license.` This happened in production on 2026-10-21. Moving to another tenant later means new `MS_*` values, a
recreated source and moved grants:
[`SHAREPOINT-RUNBOOK.md` § Switching tenants](./SHAREPOINT-RUNBOOK.md#switching-tenants-and-re-syncing).

## 5. Access

- **Web and Teams users:** anyone in the tenant can sign in but sees nothing until granted a source. A `RAG-Admins`
  member grants sources at `/admin/access`, which needs `User.Read.All` (§1.1).
- **API and MCP tokens:** scoped per token via `API_PRINCIPALS`. Set an `isAdmin` principal before turning on
  `API_ENFORCE_SCOPING=true`.

Both models are in [`ACCESS-CONTROL.md`](./ACCESS-CONTROL.md).

## 6. Teams app package

Build the package with the builder and upload it (Appendix A.6). Never hand-edit the manifest.

## 7. Verification checklist

**Infrastructure**

- [ ] `curl https://<api-domain>/ready` returns `{"status":"ready"}`, and `/health` returns ok
- [ ] Worker logs show pg-boss connected to schema `pgboss` and polling
- [ ] Parser `/health` is ok, and a real parse from the worker doesn't 401
- [ ] `\di` on `rag-postgres` shows the HNSW and GIN indexes
- [ ] No service points at `localhost`; every internal URL is `*.railway.internal`
- [ ] `PARSER_SECRET` is identical on parser, api, worker and mcp; embedding vars are identical on api, worker and mcp

**Entra**

- [ ] Ingestion app: every application permission shows **Granted for `<tenant>`**
- [ ] Under `Sites.Selected`: each source site granted `read`, and `Files.Read.All` absent
- [ ] Web app: redirect URI matches the live domain exactly, and the groups claim is configured
- [ ] Bot: the OAuth connection's **Test Connection** returns a token
- [ ] Every client-secret expiry is in a calendar

**End to end**

- [ ] Web: sign in, get granted a source at `/admin/access`, and ask a real question; the answer streams with clickable citations
- [ ] Teams (if deployed): the Appendix A.7 smoke test passes
- [ ] `audit_log` rows appear with your `oid` as `principal_subject`
- [ ] The first backup lands with a plausible size, and a restore has been drilled ([`BACKUP-AND-RECOVERY.md`](./BACKUP-AND-RECOVERY.md))

## Troubleshooting map

| Symptom                                              | Likely cause                                                                                                   | Where                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| api/mcp crash-loop at boot                           | Migrations not run yet (deploy the worker first), or a missing or short secret                                 | §3.2, §2                 |
| Worker crash-loops with a `ZodError` on `api.tokens` | `API_TOKENS` missing on the worker                                                                             | §2                       |
| Every web/Teams request 401s at the API              | Scope secret set as the singular on `rag-api`                                                                  | §2                       |
| Sign-in: redirect_uri mismatch                       | Redirect URI isn't exactly `https://<web-domain>/api/auth/callback/microsoft-entra-id`, or `AUTH_URL` is wrong | A.2                      |
| `/admin/access` grant fails                          | `User.Read.All` not consented, or `MS_*` missing on `rag-web`                                                  | §1.1                     |
| Sync 403 at `validate()`                             | No admin consent, Delegated instead of Application, or site not granted under `Sites.Selected`                 | §1.2, SharePoint runbook |
| Sync 400 `Tenant does not have a SPO license`        | The `MS_TENANT_ID` tenant has no SharePoint Online                                                             | §4                       |
| Every parse 401s                                     | `PARSER_SECRET` mismatch                                                                                       | §2                       |
| Documents quarantined, none indexed                  | Content scanner unreachable, or its host missing from `EGRESS_ALLOWED_HOSTS`                                   | DEPLOYMENT variables     |
| Bot replies with a sign-in card every time           | OAuth connection misconfigured, name mismatch, or Teams clients not pre-authorized                             | A.3, A.4                 |
| Bot 500s or never responds                           | Messaging endpoint wrong, or `MICROSOFT_APP_*` missing or not single-tenant                                    | A.3, A.5                 |
| Answers empty for a real user                        | No source grants yet                                                                                           | §5                       |
| Backup fails "invalid sslmode value"                 | Node-style `sslmode=no-verify` copied into the backup's `DATABASE_URL`                                         | §3.2 step 8              |

## Appendix A: Web and Teams Entra and Azure detail

Both surfaces are BFFs over `apps/api`. They share the identity model (Entra `oid`) and the scope secret. `rag-web`
has been live since 2026-08-01 at `https://rag-web-production-1c0a.up.railway.app`, against app registration
`c885331a-8e73-47c0-9dff-263756a81942`. `rag-teams-bot` did not exist on 2026-09-12, and no Azure subscription was
reachable then. UNVERIFIED whether it exists now; check `railway status`. Teams gate status is in
[`LAUNCH-STATUS.md`](../launch/LAUNCH-STATUS.md).

### A.1 Admin security group

In the Entra admin center, go to **Groups → New group**, type **Security**, name `RAG-Admins`. Add only the people who
should administer access grants. The group's **Object Id** is `RAG_ADMINS_GROUP_ID`. It gates `/admin/access` and
source management in the web app.

### A.2 Web app registration

1. **App registrations → New registration**, single tenant, redirect URI (Web)
   `https://<web-domain>/api/auth/callback/microsoft-entra-id`. If you register before the domain exists, come back
   after §3.2 step 6.
2. From **Overview**: Application (client) ID is `AUTH_ENTRA_CLIENT_ID`; Directory (tenant) ID is `AUTH_ENTRA_TENANT_ID`.
3. **Certificates & secrets → New client secret**: copy the **Value** (not the Secret ID) as `AUTH_ENTRA_CLIENT_SECRET`.
4. **Token configuration → Add groups claim → Security groups** (sets `groupMembershipClaims=SecurityGroup`). The app
   falls back to a Graph membership check when a user has too many groups for the token.
5. **API permissions:** keep the delegated defaults and grant admin consent for the tenant.

`rag-web` variables:

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
DATABASE_URL=<same as api, sslmode=no-verify>
MS_TENANT_ID=<ingestion app>         # Graph: /admin/access lookups + group-overage check
MS_CLIENT_ID=<ingestion app>
MS_CLIENT_SECRET=<ingestion app>
```

The web app's auth model and its server-only credential rules are in [`apps/web/CLAUDE.md`](../../apps/web/CLAUDE.md).

### A.3 Azure Bot and bot registration

1. Azure portal → **Create a resource → Azure Bot**: type of app **Single Tenant**, app creation **Create new
   Microsoft App ID**, so the bot's id and secret are shared with no other app.
2. On the bot's Entra app (Azure Bot → **Configuration → Manage**): Application (client) ID is `MICROSOFT_APP_ID`, the
   tenant id is `MICROSOFT_APP_TENANT_ID`, and a new client secret **Value** is `MICROSOFT_APP_PASSWORD`.
3. **Messaging endpoint** (Azure Bot → Configuration): `https://<bot-domain>/api/messages`, set after A.5.
4. **Expose an API:**
   - Application ID URI `api://botid-<MICROSOFT_APP_ID>`, the `botid-` form Teams expects.
   - Add a scope `access_as_user` (admins and users). The full string `api://botid-<MICROSOFT_APP_ID>/access_as_user`
     is `BOT_ENTRA_SSO_SCOPE`.
   - **Add client applications:** pre-authorize the Teams first-party clients `1fec8e78-bce4-4aaf-ab1b-5451cc387264`
     (desktop and mobile) and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (web), so the SSO exchange is silent.
   - **API permissions:** delegated `openid`, `profile`, `email`, `offline_access`, with admin consent.
5. **Authentication → Add a platform → Web:** `https://token.botframework.com/.auth/web/redirect`. Without it, Test
   Connection (A.4) fails with a redirect mismatch.

### A.4 OAuth connection setting

This is what the bot calls `getUserToken` and `exchangeToken` against. It is not the SSO scope URI.

1. Azure Bot → **Configuration → Add OAuth Connection Settings**.
2. **Name:** for example `TeamsSsoConnection`. This exact string is `BOT_OAUTH_CONNECTION_NAME`.
3. **Service Provider:** Azure Active Directory v2. **Client id / secret:** the bot's `MICROSOFT_APP_ID` /
   `MICROSOFT_APP_PASSWORD`. **Token Exchange URL:** `api://botid-<MICROSOFT_APP_ID>`. **Tenant ID:** the tenant.
   **Scopes:** `openid profile email offline_access` (the bot reads only `oid`).
4. Save, then run **Test Connection** and sign in. Fix any failure here before deploying: a failed connection makes the
   bot answer every message with a sign-in card, which looks like a bot fault but isn't.

Done when: Test Connection returns a token.

### A.5 `rag-teams-bot` service

Variables: `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_APP_TENANT_ID`, `BOT_ENTRA_SSO_SCOPE`,
`BOT_OAUTH_CONNECTION_NAME`, `INTERNAL_SCOPE_JWT_SECRET`, `RAG_API_URL`, `DATABASE_URL` and optionally `DATABASE_SSL`.
Once A.3 and A.4 exist, it is one pass. `INTERNAL_SCOPE_JWT_SECRET` must equal one of the api's
`INTERNAL_SCOPE_JWT_SECRETS` values, so copy it from `rag-web`:

```bash
railway add --service rag-teams-bot
railway variables --service rag-teams-bot \
  --set MICROSOFT_APP_ID=... --set MICROSOFT_APP_PASSWORD=... \
  --set MICROSOFT_APP_TENANT_ID=... --set BOT_ENTRA_SSO_SCOPE=... \
  --set BOT_OAUTH_CONNECTION_NAME=... \
  --set INTERNAL_SCOPE_JWT_SECRET="$(railway variables --service rag-web --kv | grep '^INTERNAL_SCOPE_JWT_SECRET=' | cut -d= -f2-)" \
  --set RAG_API_URL=http://rag-api.railway.internal:8080 \
  --set DATABASE_URL="$(railway variables --service rag-api --kv | grep '^DATABASE_URL=' | cut -d= -f2-)"
railway up --service rag-teams-bot
railway domain --service rag-teams-bot
```

Then set the Azure Bot messaging endpoint to `https://<domain>/api/messages`. Keep one replica.

### A.6 Package and upload the Teams app

1. Replace the placeholder icons in `apps/teams-bot/manifest/` (`color.png` 192×192, `outline.png` 32×32, transparent
   background). The shipped ones only satisfy the schema.
2. Build with the builder; never hand-edit `manifest.json`:

   ```bash
   MICROSOFT_APP_ID=<bot app guid> \
   BOT_ENTRA_SSO_SCOPE=api://botid-<bot app guid>/access_as_user \
   DEVELOPER_NAME="<publisher name>" \
   DEVELOPER_WEBSITE_URL=https://... DEVELOPER_PRIVACY_URL=https://... DEVELOPER_TERMS_OF_USE_URL=https://... \
   pnpm --filter @rag/teams-bot package
   ```

   Output: `apps/teams-bot/manifest/dist/teams-app-<version>.zip`. The builder (`apps/teams-bot/src/manifest.ts`
   `renderManifest`) rejects a `botid-` prefix on the app id and an SSO scope that belongs to a different
   registration. Either would produce a bot that looks configured but authenticates nobody. Teams checks that the three
   developer URLs are real and reachable at upload time.

3. Upload in the Teams admin center (**Teams apps → Manage apps → Upload new app**), or sideload it for a personal
   pilot. Sideloading needs the tenant's custom-app upload policy to allow it. UNVERIFIED for this tenant as of
   2026-10-21; ask the tenant admin early, since the answer changes the plan.

### A.7 Smoke test (you only)

1. **Web:** sign in, grant yourself a source at `/admin/access`, ask a real question, and confirm a streamed answer with
   clickable citations and the AI-draft disclaimer.
2. **Teams DM:** confirm an adaptive-card answer with citations and the disclaimer.
3. **Teams channel:** @mention the bot in a test channel and confirm it answers only from channel-safe sources (the
   intersection of members' grants; [`ACCESS-CONTROL.md`](./ACCESS-CONTROL.md#teams-channel-scope)).
4. **Audit:** both queries appear in `audit_log` with `channel` = `api` (web) or `teams` (bot), and your `oid` as
   `principal_subject`.

Done when: you have personally had a cited answer from both surfaces against real infrastructure. Add pilot users only
after that, and only named ones.

### A.8 Day-one traps

- **Don't set `PORT`.** Railway injects it and probes it, and the bot reads it natively. The bot's own default is 3978;
  pinning that means retargeting the domain too.
- **Keep `?sslmode=no-verify`** on the copied `DATABASE_URL`. `require` fails against the self-signed certificate
  ([TLS rules](./DEPLOYMENT.md#database-tls-and-sslmode)).
- **One replica.** The SSO exchange lives in `MemoryStorage`.
- **A green `/health` doesn't prove the database is reachable.** The bot serves `/health` with Postgres down, by design,
  so a blip doesn't wedge it in a restart loop.
- **`BOT_OAUTH_CONNECTION_NAME` is the connection setting's name**, not the SSO scope URI.
