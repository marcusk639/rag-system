# Phase 3 — Go Live with a Real SharePoint Source (runbook)

Self-contained steps to take a real Microsoft SharePoint library from "nothing" to
"ingested and searchable" against the live Railway deployment. Phase 2 (deploy +
parser) is already complete; this covers the Entra app registration, wiring the
credentials, creating the source, the first sync, and verification.

> **Never paste real secret values into this file.** All secrets (`MS_CLIENT_SECRET`,
> `API_TOKENS`, `DATABASE_URL` password) live only in Railway variables (sealed) and
> your local shell — use the `<PLACEHOLDER>` form here.

## How auth works (why these exact permissions)

The SharePoint connector uses **app-only (client-credentials)** Microsoft Graph
auth — no user sign-in. It authenticates against
`https://login.microsoftonline.com/{tenantId}` and requests the
`https://graph.microsoft.com/.default` scope
(`packages/connectors/src/sharepoint/client.ts`). That means you need **Application**
(not Delegated) Graph permissions, and they require **admin consent** to take effect.

The three credentials are read from env by `createConnector`
(`packages/connectors/src/factory.ts:47`) and map as:

| Env var            | Entra value             |
| ------------------ | ----------------------- |
| `MS_TENANT_ID`     | Directory (tenant) ID   |
| `MS_CLIENT_ID`     | Application (client) ID |
| `MS_CLIENT_SECRET` | Client secret **Value** |

They are shared across all Microsoft sources (SharePoint + Outlook). Per-source
scoping (`siteId`, `driveId`, `folderPath`) lives in `sources.config`
(`packages/connectors/src/sharepoint/config.ts`), **not** in env.

---

## Step 1 — Register the Entra (Azure AD) app

1. **[Entra admin center](https://entra.microsoft.com)** → **Identity** →
   **Applications** → **App registrations** → **New registration**.
   (Equivalent: Azure Portal → **Microsoft Entra ID** → **App registrations**.)
2. **Name**: `rag-system-sharepoint`.
3. **Supported account types**: **Accounts in this organizational directory only**
   (single tenant).
4. **Redirect URI**: leave blank (app-only flow, no interactive login).
5. **Register**.

✅ Done when the app's **Overview** page loads.

### 1b — Copy the two IDs

From the **Overview** page:

- **Application (client) ID** → `MS_CLIENT_ID`
- **Directory (tenant) ID** → `MS_TENANT_ID`

---

## Step 2 — Add Application Graph permissions

1. App → **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Application permissions** (NOT "Delegated permissions").
2. Add **both**:
   - `Sites.Read.All`
   - `Files.Read.All`
3. **Add permissions**.

> Tighter alternative: `Sites.Selected` grants access only to specific sites you
> later authorize per-site (via Graph), instead of all sites. It's more secure but
> adds a per-site grant step. Start with `Sites.Read.All` for the first launch
> unless your tenant policy requires least-privilege from day one.

---

## Step 3 — Grant admin consent (required)

App-only permissions do nothing until consented at the tenant level.

1. On **API permissions**, click **Grant admin consent for `<tenant>`** → **Yes**.
2. Confirm both permissions show **Status = "Granted for `<tenant>`"** (green check).

> If you aren't a Global Admin / Privileged Role Admin, the button is disabled —
> have an admin click it. Without this, `connector.validate()` fails at sync time
> with a 403 from Graph.

---

## Step 4 — Create a client secret

1. App → **Certificates & secrets** → **Client secrets** → **New client secret**.
2. Description: `rag-system`; Expiry: per policy (e.g. 12–24 months — record the
   expiry; you must rotate before it lapses or syncs start 401ing).
3. **Add**, then **immediately copy the secret's `Value`** (the long string, NOT
   the "Secret ID") → `MS_CLIENT_SECRET`. It is shown only once.

✅ You now have all three: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.

---

## Step 5 — Set the credentials on Railway (rag-api + rag-worker)

Both services build connectors: `rag-api` may construct one (e.g. on validate),
`rag-worker` runs the actual sync. Set all three on **both**, then redeploy so they
pick up the new env.

Dashboard (preferred — set as **sealed**):
Service → **Variables** → add `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` on
**rag-api** and **rag-worker** (environment **production**) → seal.

Or CLI (lands in shell history — rotate later if you care):

```bash
for s in rag-api rag-worker; do
  railway variables --service "$s" \
    --set "MS_TENANT_ID=<MS_TENANT_ID>" \
    --set "MS_CLIENT_ID=<MS_CLIENT_ID>" \
    --set "MS_CLIENT_SECRET=<MS_CLIENT_SECRET>"
done
railway redeploy --service rag-api --yes
railway redeploy --service rag-worker --yes
```

✅ Done when both services are back **Online** and the three vars are present
(`railway variables --service rag-worker | grep -i MS_`).

---

## Step 6 — Resolve the Graph `siteId`

The connector needs the site in Graph's composite form
`"hostname,siteCollectionId,siteId"`. Resolve it from the human site URL
`https://<tenant>.sharepoint.com/sites/<SiteName>`.

Easiest: a one-off Graph call from inside a running container (so it uses the same
creds and network). Replace the host/path:

```bash
railway ssh --service rag-worker
# inside the container — get an app-only token, then resolve the site:
TENANT=<MS_TENANT_ID>; CID=<MS_CLIENT_ID>; SECRET=<MS_CLIENT_SECRET>
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
  -d "client_id=$CID" -d "client_secret=$SECRET" \
  -d "scope=https://graph.microsoft.com/.default" \
  -d "grant_type=client_credentials" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com:/sites/<SiteName>" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("siteId =",d["id"])'
exit
```

The printed `id` (looks like `contoso.sharepoint.com,<guid>,<guid>`) is your
`siteId`.

> Optional scoping:
>
> - **Single library/drive**: list drives with
>   `GET /sites/{siteId}/drives` and copy the target drive's `id` → `driveId`.
> - **Folder**: set `folderPath` (e.g. `"Marketing/2024"`). Honored only on the
>   initial cursor-less sync.

---

## Step 7 — Create the source

`POST /sources` stores the config row; it does **not** hit Graph yet (validation
happens at sync time). Use an **admin** `API_TOKENS` bearer. Run against the public
API domain.

```bash
API=https://rag-api-production-07b4.up.railway.app
ADMIN_TOKEN=<API_TOKENS-admin-value>

curl -s -X POST "$API/sources" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "sharepoint",
    "name": "<library name>",
    "config": { "siteId": "<siteId>" }
  }'
# capture the returned "id" -> SOURCE_ID
```

(Add `"driveId"` / `"folderPath"` inside `config` if scoping.)

✅ 201 with a source `id`. Body shape: `apps/api/src/routes/sources.ts:37`.

---

## Step 8 — Trigger the first full sync

```bash
SOURCE_ID=<id from step 7>
curl -s -X POST "$API/sources/$SOURCE_ID/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"full"}'
# expect 202 {jobId, ingestionId, mode}
```

Watch the worker run `validate()` (auth probe) → pages → fetch → parser → chunks →
embeddings:

```bash
railway logs --service rag-worker | tail -60
```

> `full` = cursor-less (re-scan everything). `incremental` = uses the stored delta
> cursor (`apps/worker/src/handlers/sync-source.ts`). `singletonKey` prevents
> overlap — a second sync while one runs returns 409, which is expected.

---

## Step 9 — Verify

```bash
# 1. Search returns SharePoint-cited hits for a term you KNOW is in a doc.
curl -s -X POST "$API/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"<known term>"}' | python3 -m json.tool | head -40

# 2. Indexes/trigger present and chunks landed.
railway ssh --service rag-postgres psql -U rag -d rag -c \
  "SELECT count(*) FROM chunks;"
```

Checklist (Phase 3 "done"):

- [ ] `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` set + sealed on rag-api + rag-worker
- [ ] Admin consent granted on `Sites.Read.All` + `Files.Read.All`
- [ ] `POST /sources` → 201 with a source id
- [ ] `POST /sources/:id/sync {mode:"full"}` → 202; worker completes; ingestion row → `completed`
- [ ] `POST /search {query:"<known term>"}` returns SharePoint-cited results
- [ ] A second `{mode:"incremental"}` sync advances the cursor / updates `lastSyncedAt` and processes only changed files
- [ ] A bad `siteId` surfaces at `connector.validate()` in worker logs (fail-loud, not silent)

---

## Step 10 — Schedule incremental syncs (optional, recommended)

Add a Railway **cron** (or a small scheduler service) that periodically calls
`POST /sources/:id/sync {mode:"incremental"}`. The delta cursor keeps these cheap.
Overlap is safe (409 if one's already running).

---

## Troubleshooting

| Symptom (worker logs)                                 | Cause / fix                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `requires microsoft credentials (MS_TENANT_ID, …)`    | Env not set/redeployed on rag-worker. Step 5, then `railway redeploy`.                       |
| `403` / `Authorization_RequestDenied` at `validate()` | Admin consent not granted, or wrong permission type (Delegated instead of Application).      |
| `401` / `invalid_client` getting the token            | Wrong `MS_CLIENT_SECRET` (copied Secret ID not Value), or the secret expired. Recreate it.   |
| `404` resolving the site                              | Wrong site URL/path in Step 6. Confirm `https://<tenant>.sharepoint.com/sites/<SiteName>`.   |
| Sync 202 but 0 chunks                                 | `folderPath` scoped to an empty/wrong folder, or files exceed `maxFileBytes` (50MB default). |
| `429` Too Many Requests                               | Graph throttling (shared with Outlook). Backoff is built in; stage large re-syncs.           |

## Reference (exact symbols)

- Connector: `packages/connectors/src/sharepoint/index.ts` (`validate`/`list`/`fetch`)
- Config schema: `packages/connectors/src/sharepoint/config.ts`
- Graph client + auth: `packages/connectors/src/sharepoint/client.ts`
- Credential wiring + missing-creds error: `packages/connectors/src/factory.ts:47`
- Create source body: `apps/api/src/routes/sources.ts:37`
- Sync body: `apps/api/src/routes/sources.ts:76`
- Trigger service: `packages/services/src/sources.ts` (`triggerSync`)
- Full vs incremental cursor: `apps/worker/src/handlers/sync-source.ts`
