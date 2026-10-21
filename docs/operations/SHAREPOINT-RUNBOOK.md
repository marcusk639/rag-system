---
title: SharePoint runbook
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: How to connect a SharePoint library to production, from Entra app to verified search results, and how to move to another tenant and re-sync without losing access.
read_when: Adding a SharePoint source, rotating or changing Microsoft credentials, switching tenants, or debugging a SharePoint sync.
supersedes:
  [
    PHASE-3-SHAREPOINT-RUNBOOK.md,
    PLAN-SHAREPOINT-GOLIVE.md,
    PILOT-MANUAL-RUNBOOK.md item 3a procedure,
  ]
code:
  [
    packages/connectors/src/sharepoint/index.ts,
    packages/connectors/src/sharepoint/config.ts,
    packages/connectors/src/sharepoint/client.ts,
    packages/connectors/src/factory.ts,
    apps/api/src/routes/sources.ts,
    packages/services/src/sources.ts,
    apps/worker/src/handlers/sync-source.ts,
    scripts/set-ms-credentials.sh,
    scripts/resolve-siteid.sh,
  ]
---

# SharePoint runbook

A SharePoint source goes live in seven steps: register the ingestion app, set `MS_*` on `rag-worker` and `rag-web`,
resolve the composite `siteId`, `POST /sources`, grant access to the new source id, run a full sync, and verify with
`/search`. Moving to another tenant reuses those steps and adds one rule: move access to the new source **before**
purging the old one.

Current state (2026-10-21): production has one SharePoint source, "Knowledge Base"
(`dbba75e2-cecb-41be-8998-4f923158f741`). It can't re-sync because the tenant in `MS_TENANT_ID` lost its SharePoint
Online licence, so the fix is the [tenant switch](#switching-tenants-and-re-syncing). Gate context and what is
waiting on the re-sync are in [`LAUNCH-STATUS.md`](../launch/LAUNCH-STATUS.md). Connector config options are in
[`CONNECTORS.md`](../reference/CONNECTORS.md). Never paste a real secret here; use `<PLACEHOLDER>`s.

## How auth works

The connector uses app-only (client-credentials) Microsoft Graph auth with no user sign-in. It authenticates against
`https://login.microsoftonline.com/{tenantId}` and requests `https://graph.microsoft.com/.default`
(`packages/connectors/src/sharepoint/client.ts`). That needs **Application** (not Delegated) permissions, which take
effect only after admin consent.

| Env var            | Entra value             |
| ------------------ | ----------------------- |
| `MS_TENANT_ID`     | Directory (tenant) ID   |
| `MS_CLIENT_ID`     | Application (client) ID |
| `MS_CLIENT_SECRET` | Client secret **Value** |

The three are shared by every Microsoft source (SharePoint and Outlook). They are read by exactly two services:
`rag-worker`, the only service that builds connectors (`apps/worker/src/deps.ts`), and `rag-web`, which uses Graph for
`/admin/access` email-to-`oid` lookups and group-overage checks (`apps/web/src/lib/graph-client.ts`). `rag-api` and
`rag-mcp` don't read them. Per-source scope (`siteId`, `driveId`, `folderPath`, `excludePaths`, `maxFileBytes`) lives in
the source's `config` (`packages/connectors/src/sharepoint/config.ts`), not in env. `POST /sources` doesn't call Graph;
validation happens when the worker syncs.

## Register the ingestion app

1. Entra admin center → **App registrations → New registration**. Name it (for example `rag-system-sharepoint`), choose
   single tenant, and leave the redirect URI blank.
2. From **Overview**, copy the Application (client) ID (`MS_CLIENT_ID`) and the Directory (tenant) ID (`MS_TENANT_ID`).
3. **API permissions → Add a permission → Microsoft Graph → Application permissions.** Add `Sites.Read.All` +
   `Files.Read.All`, **or** `Sites.Selected` alone with a per-site grant
   ([`FRESH-DEPLOY-GUIDE.md` §1.2](./FRESH-DEPLOY-GUIDE.md#12-sitesselected-instead-of-sitesreadall)). Never combine
   `Sites.Selected` with `Files.Read.All`. Also add `User.Read.All`, which `rag-web` needs.
4. **Grant admin consent for `<tenant>`.** Every permission must show "Granted for `<tenant>`". The button is disabled
   unless you are a Global Admin or Privileged Role Admin.
5. **Certificates & secrets → New client secret.** Copy the **Value**, not the Secret ID, as `MS_CLIENT_SECRET`. It is
   shown once. Put the expiry in a calendar; a lapsed secret makes every sync 401.
6. Confirm the tenant has SharePoint Online. Auth succeeds without a licence, and only the sync fails.

Done when: you hold all three values and the permissions show as granted.

## Set the credentials

Set `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` on **`rag-worker` and `rag-web`**, sealed in the dashboard,
then redeploy both. `./scripts/set-ms-credentials.sh` sets and redeploys `rag-worker` only (`--no-redeploy` skips the
redeploy). It never touches `rag-web`, so set that one by hand. Its `--with-api` flag is unnecessary. Stale `MS_*`
values left on `rag-api` from an earlier run do nothing.

Done when: `railway variables --service rag-worker | grep -i MS_` shows all three, the same three are on `rag-web`, and
both services are Online.

## Resolve the siteId

The connector needs Graph's composite site id, `<host>,<siteCollectionGuid>,<siteGuid>`.

```bash
./scripts/resolve-siteid.sh https://<tenant>.sharepoint.com/sites/<SiteName>
# OK siteId = <tenant>.sharepoint.com,<guid>,<guid>
```

**Why this is the auth canary.** The script runs inside `rag-worker` over `railway ssh`, so the secret never leaves
Railway. It mints a token with the live `MS_*` values and calls `GET /sites/{host}:/sites/{name}`. A clean siteId proves
the credentials are valid and the application permissions are consented. `TOKEN_ERROR` means bad credentials;
`GRAPH_ERROR` means consent or site. It does **not** prove the tenant has a SharePoint licence. Wait for the worker
redeploy to finish first, because SSH fails against a restarting container. Before creating the source, check the
shape:

```bash
echo "$SITE_ID" | grep -qE '^[^,]+,[a-f0-9-]+,[a-f0-9-]+$' || echo "siteId format is wrong"
```

A wrong siteId enqueues a sync that fails at Graph with an unhelpful 404.

Optional narrowing:

- **One library:** `GET /sites/{siteId}/drives` and copy the drive's `id` as `driveId`. Without it, every document
  library in the site is ingested.
- **One folder:** `folderPath` (for example `"Knowledge Base"`). It is honoured only when `driveId` names that same
  drive, and only on the initial cursor-less sync (`index.ts` `initialDeltaUrl`); later delta syncs follow the stored
  cursor.
- **Exclusions:** `excludePaths` adds to the built-in `DEFAULT_EXCLUDED_PATH_FRAGMENTS`. A path that becomes excluded is
  treated as deleted.

## Create the source

`POST /sources` needs an **admin** principal; anything else gets 403 `FORBIDDEN`. Use a plain `API_TOKENS` token
(while `API_ENFORCE_SCOPING` is off) or an `isAdmin` principal ([`ACCESS-CONTROL.md`](./ACCESS-CONTROL.md)).

```bash
API=https://rag-api-production-07b4.up.railway.app
curl -fsS -X POST "$API/sources" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"sharepoint","name":"<name>","config":{"siteId":"'"$SITE_ID"'"}}'
# 201 with the source; save its "id" as SOURCE_ID
```

Add `driveId`, `folderPath` or `excludePaths` inside `config` if narrowing. There is no endpoint to edit a source's
config. Changing the site means a new source with a new id.

## Grant access to the new source

Access is keyed by source id in two places, and a new source starts with no grants in either. Grant it before relying
on scoped results; otherwise scoped callers get empty answers with no error.

- **Database grants** (web and Teams users): `/admin/access`, or `manage-access grant` in a service container.
- **`API_PRINCIPALS`** (direct API and MCP tokens): the same value on `rag-api` and `rag-mcp`, then redeploy both.

Both procedures are in [`ACCESS-CONTROL.md`](./ACCESS-CONTROL.md).

## Run and watch the sync

```bash
curl -fsS -X POST "$API/sources/$SOURCE_ID/sync" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"mode":"full"}'
# 202 {"jobId": "...", "ingestionId": "...", "mode": "full"}
```

- `full` ignores the stored cursor; `incremental`, the default mode, uses the Graph delta cursor.
- A second sync while one is active also returns 202: the `rag.sync_source` queue runs under pg-boss's `singleton`
  policy, so the new job **queues behind** the active one and never runs concurrently (`packages/ingestion/src/queue.ts`
  `enqueueSync`). 409 `SYNC_ALREADY_RUNNING` appears only if pg-boss returns no job id.
- A failed job is retried by pg-boss (`retryLimit` 3, `retryDelay` 60 s, with backoff). The connector itself doesn't
  retry Graph 429s or honour `Retry-After`.
- Each job processes up to 5 connector pages (`sync-source.ts` `PAGES_PER_RUN`), persists the cursor after each page, and
  re-enqueues itself. `lastSyncedAt` is stamped only when the final page completes.
- Rough duration: 5–20 minutes for a few hundred documents, 1–3 hours for sites with thousands of files.

Watch `railway logs --service rag-worker` for `"marker":"ingest.run.summary"` with `documentsProcessed > 0`.
`ingest.continuation` means more pages are queued, and `ingest.sync.failed` means the run failed. Or poll the queue
until no `created` or `active` rows remain:

```sql
SELECT state, count(*) FROM pgboss.job WHERE name = 'rag.sync_source' GROUP BY state;
SELECT status, started_at, completed_at FROM ingestion_jobs WHERE source_id = '<SOURCE_ID>' ORDER BY created_at DESC LIMIT 1;
```

Don't verify mid-sync. A partial run shows `documentsProcessed: 0` and empty answers, which looks like a failure.

## Verify

1. `POST /search` with `{"query":"<a term you know is in a document>"}` returns hits whose
   `.results[].document.sourceId` is the new source, for an admin token **and** for each scoped principal.
2. The newest `ingestion_jobs` row for the source is `completed`, not `failed`, and `ingest_log` has no unexpected
   `failed` or `blocked` rows.
3. A citation `url` opens the SharePoint `webUrl`.
4. Later, an `incremental` sync advances `lastSyncedAt` and processes only changed files.
5. A deliberately bad `siteId` on a scratch source fails loudly at `validate()` in the worker logs.

Done when: checks 1–3 pass for the new source.

## Schedule incremental syncs

Nothing in the repo schedules syncs today. Run `POST /sources/:id/sync {"mode":"incremental"}` from a Railway cron
service or an external scheduler. Overlap is safe: a trigger during an active run queues behind it. Keep the interval
longer than a typical run, so queued jobs don't pile up. The delta cursor keeps each run cheap.

## Switching tenants and re-syncing

Use this when the tenant in `MS_TENANT_ID` changes or loses its SharePoint licence. If the **same** tenant gets its
licence back, no variables change: go straight to step 6 and re-sync the existing source.

1. **Confirm the target tenant has SharePoint Online.** Auth succeeds without it.
2. **Register the ingestion app in the new tenant** ([above](#register-the-ingestion-app)). IT may need to do the consent;
   [`FRESH-DEPLOY-GUIDE.md` §1.3](./FRESH-DEPLOY-GUIDE.md#13-what-to-send-it) says what to send.
3. **Set the three `MS_*` variables on `rag-worker` and `rag-web`**, then redeploy both ([above](#set-the-credentials)).
4. **Resolve the new site's `siteId`** with `./scripts/resolve-siteid.sh`, which also proves the new credentials work.
5. **Create a new SharePoint source.** The old source's `siteId` belongs to the old tenant and config can't be edited,
   so the new source gets a **new id**.
6. **Run a full sync** and watch it until the `ingestion_jobs` row is `completed` and `ingest_log` shows no unexpected
   failures.
7. **Move access to the new id**, in both places:
   - `API_PRINCIPALS` on `rag-api` and `rag-mcp`: replace the old id in every principal's `allowedSourceIds` with the
     same value on both, then redeploy both. As of 2026-10-21, `marcus` is scoped to the old id, and `chris` is scoped
     to three ids that no longer exist (so that principal sees nothing). Fix both in the same edit.
   - Database grants: grant the new source to every user who had the old one
     (`node node_modules/@rag/db/dist/manage-access.js grant --user <id> --source <new id> --by <admin>`), then
     `check --user <id>`. As of 2026-10-21, one `staff_source_assignments` row points at the old source.
8. **Verify, then purge the old source.** Run [Verify](#verify) check 1 for an admin and every scoped principal. Only
   then `DELETE /sources/<old id>`. The delete cascades to the old source's documents, chunks **and access grants**,
   which is why step 7 comes first. Recreating a source never carries its grants over.
9. **Re-upload manual documents if needed.** The "Manual Uploads" source (`custom` kind, no connector) has nothing to
   sync. Re-upload its document only if it should get the current parser output.

Done when: a full sync of the new source is `completed`, every principal and web user who should have access gets
new-source results from `/search`, and the old source is purged.

## Optional: downloadable originals

Citations become downloadable when an object store is configured. Set the same `OBJECT_STORE_*` values on `rag-api`
(serves `GET /documents/:id/download`) and `rag-worker` (stores originals at ingest), redeploy both, then run a `full`
sync. Originals are captured only when content changes, and a full sync counts every document as changed. For Railway
Buckets, copy the endpoint, keys and bucket name from the bucket's Connect tab. Check the result:
`GET /documents/<id>/download` returns 200 with the file's `Content-Type`. A token without access to that source gets
**404, not 403**.

## Rollback

| Action                | Rollback                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MS_*` set            | Restore the previous values on `rag-worker` and `rag-web` (or remove them) and redeploy both                   |
| Source created        | `DELETE /sources/<id>`: cascades to its documents, chunks and grants                                           |
| Object store enabled  | `OBJECT_STORE_PROVIDER=none` on api and worker and redeploy; downloads then return 404, the rest is unaffected |
| `API_PRINCIPALS` edit | Re-set the previous value on `rag-api` and `rag-mcp` and redeploy; tokens from the discarded run stop working  |

## Troubleshooting

| Symptom (worker logs)                                                   | Cause and fix                                                                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharepoint connector requires microsoft credentials (MS_TENANT_ID, …)` | `MS_*` missing on `rag-worker`, or it wasn't redeployed                                                                                                         |
| `403` / `Authorization_RequestDenied` at `validate()`                   | No admin consent, Delegated instead of Application, or (under `Sites.Selected`) the site isn't granted                                                          |
| `401` / `invalid_client` getting a token                                | Secret ID copied instead of Value, or the secret expired                                                                                                        |
| `404` resolving the site                                                | Wrong site URL or path                                                                                                                                          |
| `400` `Tenant does not have a SPO license.`                             | The `MS_TENANT_ID` tenant has no SharePoint Online: [switch tenants](#switching-tenants-and-re-syncing)                                                         |
| `202` but 0 chunks                                                      | `folderPath` points at an empty or wrong folder (or `driveId` is missing), or files exceed `maxFileBytes` (default 50 MB; logged as `documentsSkippedOversize`) |
| Sync fails with `ingest.sync.gate_failure_quarantine`                   | The content scanner errored on at least one document; fix the scanner, then re-run                                                                              |
| `429 Too Many Requests`                                                 | Graph throttling, shared with Outlook. Only pg-boss job retries apply (3 × 60 s with backoff); stage large re-syncs                                             |
| Scoped token gets empty answers                                         | The new source id isn't in that principal's grants                                                                                                              |

## Code reference

- Connector: `packages/connectors/src/sharepoint/index.ts` (`validate`, `list`, `fetch`, `initialDeltaUrl`)
- Config schema: `packages/connectors/src/sharepoint/config.ts` `SharePointConfigSchema`
- Graph client and auth: `packages/connectors/src/sharepoint/client.ts`
- Credential wiring and the missing-credentials error: `packages/connectors/src/factory.ts` `createConnector`
- Request bodies: `apps/api/src/routes/sources.ts` `CreateSourceBody`, `SyncBody`
- Sync trigger: `packages/services/src/sources.ts` `triggerSync`
- Paging and continuation: `apps/worker/src/handlers/sync-source.ts`, `packages/ingestion/src/pipeline.ts`
