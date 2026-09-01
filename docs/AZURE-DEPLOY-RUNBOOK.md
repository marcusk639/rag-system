# Azure / Entra + Railway Deployment Runbook

**Audience:** Marcus (technical/ops lead). Every step here is human/infra work — Azure portal clicks, secret generation, Railway config. None of it can be done by an AI agent; the application code is already built and merged.

**Scope:** Stand up the two staff-facing surfaces of the RAG knowledge base for the firm:

1. **`apps/web`** — the Next.js chat app (Entra SSO, per-user scope).
2. **`apps/teams-bot`** — the Microsoft Teams conversational bot (Entra SSO, per-user scope, adaptive-card answers).

Both are BFFs over the same `apps/api` HTTP API and share the same identity model (`oid`) and the same `INTERNAL_SCOPE_JWT_SECRET`.

> **GATE — do not deploy for real staff use until the P0 gates in `docs/PILOT-MANUAL-RUNBOOK.md` are done:** (1) content audit of what's indexed, (2) counsel + carrier sign-off, (3) backup/restore drill. This runbook stands the infrastructure up; the P0 gates decide whether real staff may use it. It is fine to do this runbook against a **pilot/you-only** deployment first.

---

## 0. Prerequisites

- Owner/admin access to the firm's Microsoft 365 / Entra ID tenant (or someone who has it and can do the app registrations with you — likely Chris or whoever manages the firm's M365).
- Access to the Railway project hosting `rag-api` / `rag-postgres`.
- `openssl` locally (for secret generation).

You will produce, across this runbook, these values (write them down as you go — several are reused across both apps):

| Value                                         | Where it comes from                                  | Used by                                  |
| --------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `AUTH_ENTRA_TENANT_ID`                        | the firm's Entra tenant id                           | web + (as `MICROSOFT_APP_TENANT_ID`) bot |
| `AUTH_ENTRA_CLIENT_ID` / `_SECRET`            | Web app Entra registration (§2)                      | web                                      |
| `AUTH_SECRET`                                 | `openssl rand -base64 32` (§2)                       | web (NextAuth session key)               |
| `RAG_ADMINS_GROUP_ID`                         | `RAG-Admins` security group object id (§1)           | web (admin gate)                         |
| `INTERNAL_SCOPE_JWT_SECRET`                   | `openssl rand -hex 32` — **one value, shared** (§5)  | web + bot + api (must match)             |
| `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` | Azure Bot / bot Entra registration (§3)              | bot                                      |
| `BOT_ENTRA_SSO_SCOPE`                         | `api://botid-<MICROSOFT_APP_ID>/access_as_user` (§3) | bot + manifest                           |
| `BOT_OAUTH_CONNECTION_NAME`                   | Azure Bot OAuth **connection setting** name (§4)     | bot                                      |

---

## 1. Security group for the admin gate

The web app's admin pages (`/admin/access`, source management) are gated on membership of a security group.

1. Entra admin center → **Groups → New group** → type **Security**, name `RAG-Admins`.
2. Add yourself as a member (add Chris/Doug later only if they should administer access grants).
3. Open the group → copy its **Object Id** → this is `RAG_ADMINS_GROUP_ID`.

> Note: onboarding a Phase-1 firm-SOP-only user still requires an admin to grant them the firm-SOP source via `/admin/access` — the grant model is per-client, so a firm-wide index is a small manual grant today (see `docs/PILOT-MANUAL-RUNBOOK.md` item 4). This does not block deploy.

---

## 2. Entra app registration — web app (`apps/web`)

1. Entra admin center → **App registrations → New registration**.
   - Name: `the knowledge base — Web`.
   - Supported account types: **Single tenant** (this org only).
   - Redirect URI: **Web** → `https://<web-app-domain>/api/auth/callback/microsoft-entra-id` (the NextAuth Microsoft Entra provider callback; fill `<web-app-domain>` with the Railway domain from §6, come back and update if you deploy before you know it).
2. From **Overview**: copy **Application (client) ID** → `AUTH_ENTRA_CLIENT_ID`; copy **Directory (tenant) ID** → `AUTH_ENTRA_TENANT_ID`.
3. **Certificates & secrets → New client secret** → copy the **Value** immediately → `AUTH_ENTRA_CLIENT_SECRET`. (You cannot see it again after leaving the page.)
4. **Token configuration → Add groups claim** → select **Security groups** → this makes the user's group membership (incl. `RAG-Admins`) available in the token so the admin gate works. (The app already handles the Entra "groups overage" case by falling back to a Graph membership check.)
5. **API permissions**: the defaults (`openid`, `profile`, `email`, `offline_access` — delegated) are what the app requests; grant admin consent for the tenant so users aren't individually prompted.
6. Generate `AUTH_SECRET`: `openssl rand -base64 32` (NextAuth's session-signing key — **not** the scope JWT secret).

---

## 3. Azure Bot resource + bot Entra registration (`apps/teams-bot`)

The Teams bot needs its own identity (an Azure Bot resource, which creates/uses an Entra app) plus an SSO configuration.

1. Azure portal → **Create a resource → Azure Bot**.
   - Bot handle: `<tenant>-kb-bot`.
   - **Type of App: Single Tenant.**
   - App creation: **Create new Microsoft App ID** (or use an existing app registration you create manually — single-tenant either way).
2. After creation, open the bot's Entra app registration (Azure Bot → **Configuration → Manage** next to the Microsoft App ID):
   - Copy the **Application (client) ID** → `MICROSOFT_APP_ID`.
   - The tenant id is the same firm tenant → `MICROSOFT_APP_TENANT_ID` (= `AUTH_ENTRA_TENANT_ID`).
   - **Certificates & secrets → New client secret** → copy the **Value** → `MICROSOFT_APP_PASSWORD`.
3. **Messaging endpoint** (Azure Bot → Configuration): set to `https://<teams-bot-domain>/api/messages` (the Railway domain from §6 — come back and set this once the bot is deployed).
4. **Expose an API for SSO** (on the bot's Entra app):
   - **Expose an API → Application ID URI** → set it to `api://botid-<MICROSOFT_APP_ID>` (the `botid-` form Teams expects).
   - **Add a scope** named `access_as_user` (admin+users consent). The full scope string `api://botid-<MICROSOFT_APP_ID>/access_as_user` is your `BOT_ENTRA_SSO_SCOPE`.
   - **Add client applications** → pre-authorize the Teams first-party client IDs so the SSO token exchange is silent:
     - `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (Teams desktop/mobile)
     - `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (Teams web)
   - **API permissions**: add delegated `openid`, `profile`, `email`, `offline_access`; grant admin consent.

---

## 4. Azure Bot OAuth connection setting (`BOT_OAUTH_CONNECTION_NAME`)

This is the piece that makes the bot's server-side token acquisition work — it is **distinct** from the SSO scope URI. The bot calls `getUserToken`/`exchangeToken` against this connection.

1. Azure Bot resource → **Configuration → Add OAuth Connection Settings**.
2. Fill in:
   - **Name:** e.g. `TeamsSsoConnection` → this exact string is `BOT_OAUTH_CONNECTION_NAME`.
   - **Service Provider:** **Azure Active Directory v2**.
   - **Client id / Client secret:** the bot's `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` (from §3).
   - **Token Exchange URL:** `api://botid-<MICROSOFT_APP_ID>` (the Application ID URI — this is what enables the silent `signin/tokenExchange` flow).
   - **Tenant ID:** the firm tenant id.
   - **Scopes:** `openid profile email offline_access` (or `User.Read` — the identity claims are what matter; the bot only reads `oid`).
3. Save, then **Test Connection** on that setting — sign in with your own account and confirm it returns a token. If Test Connection fails, the bot cannot authenticate anyone; fix it here before deploying.

---

## 5. Generate the shared scope secret

The web app, the Teams bot, and the API all use one HS256 secret to sign/verify the per-user scope-assertion token. It must be **identical** across all three services and **at least 64 hex chars** (the code enforces this and refuses to start otherwise).

```bash
openssl rand -hex 32   # produces exactly 64 hex chars
```

Set the output as `INTERNAL_SCOPE_JWT_SECRET` on **rag-api, rag-web, and rag-teams-bot** (same value). Rotating it later is a coordinated redeploy (add new secret to the api's accepted list, deploy all, drop old — see `packages/core/src/internal-scope-auth.ts` rotation note).

---

## 6. Deploy on Railway

Both apps already have `Dockerfile` + `railway.json` (healthcheck `/api/health` for web, `/health` for the bot). Create one Railway service per app in the same project as `rag-api` / `rag-postgres`.

### 6a. `rag-web` service

Env vars: `AUTH_ENTRA_CLIENT_ID`, `AUTH_ENTRA_CLIENT_SECRET`, `AUTH_ENTRA_TENANT_ID`, `AUTH_SECRET`, `RAG_ADMINS_GROUP_ID`, `INTERNAL_SCOPE_JWT_SECRET`, `RAG_API_URL` (the internal api URL), `DATABASE_URL`, `DATABASE_SSL`. Leave `WEB_AUTH_MODE` unset (defaults to Entra; `static-fallback` is the emergency bypass only).
After deploy, note the domain and go back to §2 step 1 to set the redirect URI.

### 6b. `rag-teams-bot` service

Env vars: `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_APP_TENANT_ID`, `BOT_ENTRA_SSO_SCOPE`, `BOT_OAUTH_CONNECTION_NAME`, `INTERNAL_SCOPE_JWT_SECRET` (same as web/api), `RAG_API_URL`, `DATABASE_URL`, `DATABASE_SSL`, `PORT=3978`.
After deploy, note the domain and go back to §3 step 3 to set the Azure Bot **messaging endpoint** to `https://<domain>/api/messages`.

> The bot uses `MemoryStorage` for the SSO exchange dedupe/stash — keep it **single-instance** (1 replica). This is fine for a firm-scale pilot; multi-replica would need a shared store.

---

## 7. Package + upload the Teams app

The Teams app manifest lives at `apps/teams-bot/manifest/manifest.json` with `${...}` placeholders (see `apps/teams-bot/manifest/README.md`).

1. Fill the placeholders: `MICROSOFT_APP_ID` (bot id + `webApplicationInfo.id`), `BOT_ENTRA_SSO_SCOPE` (`webApplicationInfo.resource`), your bot/company name, and real icon files (replace the placeholder `color.png` 192×192 and `outline.png` 32×32 with real branding — this is the one bit of design work).
2. Zip `manifest.json` + the two icons into a Teams app package.
3. Teams admin center → **Teams apps → Manage apps → Upload new app** (or sideload via **Apps → Manage your apps → Upload a custom app** for a personal pilot). For a firm rollout, publish to the org's app catalog.
4. Install it for yourself, DM it a real question, and confirm you get an answer with citations.

---

## 8. Smoke test (both surfaces, you-only)

1. **Web:** open `https://<web-app-domain>`, sign in with your Microsoft account, ask a real firm-SOP question, confirm a streamed answer with clickable citations and the AI-draft disclaimer. (You need a source grant — grant yourself the firm-SOP source via `/admin/access`.)
2. **Teams bot:** DM the bot a question → confirm an adaptive-card answer with citations + disclaimer. @mention it in a test channel → confirm it answers only from firm-wide (channel-safe) sources.
3. **Audit:** confirm the queries appear in the `audit_log` table with `channel` = `api` (web) / `teams` (bot) and your `oid` as `principal_subject`.

**Done when:** you have personally gotten a real answer from both surfaces against real infrastructure. Real-staff rollout stays gated on the P0 items in `docs/PILOT-MANUAL-RUNBOOK.md`.

---

## Troubleshooting

- **Bot replies with a sign-in card every time:** the OAuth connection setting (§4) is misconfigured or its **Test Connection** fails — the bot can't acquire a user token. Also confirm `BOT_OAUTH_CONNECTION_NAME` on Railway exactly matches the connection setting's name, and that the Teams client IDs are pre-authorized (§3 step 4).
- **Bot 500s / never responds:** check the messaging endpoint (§3 step 3) points at the deployed `/api/messages`, and that `MICROSOFT_APP_ID`/`PASSWORD`/`TENANT_ID` are set and single-tenant.
- **Web sign-in fails / redirect mismatch:** the redirect URI (§2 step 1) must exactly match `https://<domain>/api/auth/callback/microsoft-entra-id`; `AUTH_SECRET` must be set.
- **Either app crash-loops at boot:** almost always a missing/short secret — both apps fail loud on a missing var, and `INTERNAL_SCOPE_JWT_SECRET` must be ≥64 chars.
- **Answers are empty for a real user:** they have no source grants yet — grant access via the web `/admin/access` page.
