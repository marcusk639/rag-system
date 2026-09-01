# Plan: Sync SharePoint Knowledge Base Folder

> **Goal:** Create the SharePoint source scoped to `Documents/Knowledge Base`, grant user
> access, trigger the first sync, and verify ingestion.
>
> **Status:** COMPLETE — executed 2026-07-02. Source `b54dbd7b-7a0a-4e45-b89a-3f0d20b8de14`
> created, `API_PRINCIPALS` deployed to rag-api + rag-mcp, full sync ran to completion,
> E2E verification passed (substantive answer, 5 unique documents cited, all citation
> URLs point to `<tenant>.sharepoint.com/sites/<staff-site>/...`, no scoping bleed,
> no oversize/error log entries).
> **Date authored:** 2026-06-29
>
> **Prereqs already complete (do NOT redo):**
>
> - MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET are live on `rag-worker` ✅
> - Auth canary (`resolve-siteid.sh`) passed ✅
> - Drive enumeration done — IDs confirmed below ✅

---

## Phase 0 — Confirmed Facts (no discovery needed)

All values below are verified. Read this section before Phase 1 — it is the only context
a fresh session needs.

```bash
# Production API
export API_URL="https://rag-api-production-07b4.up.railway.app"

# SharePoint site (firm team site)
# Get this from Graph: GET /sites/<host>:/sites/<site-path>  -> the "id" field.
# Format is "<host>,<site-guid>,<web-guid>" — all three parts are required.
export SITE_ID="<tenant>.sharepoint.com,<site-guid>,<web-guid>"

# "Documents" = Shared Documents library (the only drive we want)
export DRIVE_ID="b!bF-YyZoLE0qWehInzz4EZBoLm3vljQdKh_q4PetDLu12KwPuu-7AQb7A96resDeQ"

# Subfolder to sync (relative to drive root)
export FOLDER_PATH="Knowledge Base"

# Existing source UUIDs already in deploy_tokens.sh:
#   52bb403e-2e59-472b-935a-c83f2eee7e4c  the operating tenant
#   d3461cbe-b99f-4253-aded-b3610afe56de  the tenant's test site
# The new SharePoint source UUID is unknown until Phase 1 creates it.
```

Other drives on the site (NOT syncing — for reference only):

- `the firm's training` — separate document library
- `Teams Wiki Data` — wiki, not relevant

---

## Phase 1 — Create the source

**Goal:** Register the scoped SharePoint source in the production API.

### 1.1 Generate admin token (do this immediately before the curl — tokens expire)

```bash
cd /path/to/rag-system
export ADMIN_TOKEN=$(./scripts/gen-tokens.sh "service-admin::isAdmin" | jq -r '.[0].token')
echo "Token preview: ${ADMIN_TOKEN:0:20}..."
[ -z "$ADMIN_TOKEN" ] && echo "ERROR: empty token — check gen-tokens.sh output" && exit 1
```

### 1.2 Validate siteId format

```bash
echo "$SITE_ID" | grep -qE '^[^,]+,[a-f0-9-]+,[a-f0-9-]+$' \
  || { echo "ERROR: siteId format wrong"; exit 1; }
```

### 1.3 POST /sources

```bash
curl -fsS -X POST "$API_URL/sources" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"the tenant's SharePoint — Knowledge Base\",
    \"kind\": \"sharepoint\",
    \"config\": {
      \"siteId\": \"$SITE_ID\",
      \"driveId\": \"$DRIVE_ID\",
      \"folderPath\": \"$FOLDER_PATH\"
    }
  }" | jq .
```

Save the returned `id`:

```bash
export SOURCE_ID="<uuid-from-response>"
```

### Verification checklist

- [ ] Response is HTTP 201 with `kind: "sharepoint"`, `name: "the tenant's SharePoint — Knowledge Base"`
- [ ] `GET $API_URL/sources/$SOURCE_ID` returns the record (config fields stripped from response)

### Anti-pattern guards

- ❌ Do NOT set `folderPath: "Documents/Knowledge Base"` — the drive is already scoped to
  the Documents library; the path is **relative to the drive root**, so `"Knowledge Base"` alone is correct.
- ❌ Do NOT omit `driveId` — without it, the connector would also enumerate the firm's training and
  Teams Wiki Data on every sync.

---

## Phase 2 — Grant user access (update API_PRINCIPALS)

**Goal:** Add `$SOURCE_ID` to marcus and chris's source scopes so their tokens can query it.
**Must run before triggering sync** — otherwise `/ask` against this source returns empty results.

### 2.1 Update deploy_tokens.sh

Open `scripts/deploy_tokens.sh` and add `$SOURCE_ID` to both users' source lists:

```bash
# Current (before edit):
PRINCIPALS=$(./scripts/gen-tokens.sh \
  "marcus:52bb403e-2e59-472b-935a-c83f2eee7e4c,d3461cbe-b99f-4253-aded-b3610afe56de" \
  "chris:52bb403e-2e59-472b-935a-c83f2eee7e4c,d3461cbe-b99f-4253-aded-b3610afe56de" \
  "service-admin::isAdmin")

# After edit (append $SOURCE_ID — replace <new-uuid> with the actual UUID from Phase 1):
PRINCIPALS=$(./scripts/gen-tokens.sh \
  "marcus:52bb403e-2e59-472b-935a-c83f2eee7e4c,d3461cbe-b99f-4253-aded-b3610afe56de,<new-uuid>" \
  "chris:52bb403e-2e59-472b-935a-c83f2eee7e4c,d3461cbe-b99f-4253-aded-b3610afe56de,<new-uuid>" \
  "service-admin::isAdmin")
```

### 2.2 Deploy the updated principals

```bash
./scripts/deploy_tokens.sh
# This sets API_PRINCIPALS on rag-api + rag-mcp and redeploys both.
```

### 2.3 Commit the updated deploy_tokens.sh

```bash
git -C /path/to/rag-system add scripts/deploy_tokens.sh
git -C /path/to/rag-system commit -m "chore: add SharePoint Knowledge Base source to principal scopes"
```

### Verification checklist

- [ ] `railway variables --service rag-api | grep API_PRINCIPALS` shows the new UUID in the value
- [ ] `railway variables --service rag-mcp | grep API_PRINCIPALS` same
- [ ] Both rag-api and rag-mcp redeployments succeed (green in Railway dashboard)

---

## Phase 3 — Trigger first sync

**Goal:** Kick off a full ingest of the Knowledge Base folder.

```bash
# Use a fresh admin token (regenerate if more than a few minutes have passed since Phase 1):
export ADMIN_TOKEN=$(./scripts/gen-tokens.sh "service-admin::isAdmin" | jq -r '.[0].token')

curl -fsS -X POST "$API_URL/sources/$SOURCE_ID/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}' | jq .
```

Expected response: `{"enqueued": true}` (or equivalent).

### Monitor sync progress

```bash
# Option A — stream worker logs, watch for the summary marker:
railway logs --service rag-worker --tail
# Look for: "marker":"ingest.run.summary"
# with documentsProcessed > 0. Continuation lines mean more pages still queued.

# Option B — poll pg-boss job state:
railway run --service rag-worker -- \
  node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); \
    p.query(\"SELECT state,count(*) FROM pgboss.job WHERE name='rag.sync_source' GROUP BY state\") \
     .then(r=>console.log(r.rows)).finally(()=>p.end())"
# Done when only 'completed' rows remain.
```

**Estimated time:** 5–20 min for a few hundred documents; up to 1–3 hrs for a large folder.

### Verification checklist

- [ ] `POST .../sync` returns `{"enqueued": true}`
- [ ] rag-worker logs show `"Starting sync for source"` within ~30s
- [ ] `ingest.run.summary` log appears with `documentsProcessed > 0`
- [ ] No `GRAPH_ERROR` or `TOKEN_ERROR` in worker logs during the sync run

---

## Phase 4 — Verify ingestion end-to-end

**Goal:** Confirm documents are searchable and answers are substantive.

### 4.1 Check document count

```bash
# Get a marcus token from API_PRINCIPALS (copy from Railway or regenerate):
export MARCUS_TOKEN="<marcus-bearer-token>"

curl -fsS "$API_URL/sources/$SOURCE_ID" \
  -H "Authorization: Bearer $MARCUS_TOKEN" | jq '{id, name, status}'
```

### 4.2 Ask a question against the Knowledge Base

```bash
curl -fsS -X POST "$API_URL/ask" \
  -H "Authorization: Bearer $MARCUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"question\": \"What topics are covered in the Knowledge Base?\",
    \"allowedSourceIds\": [\"$SOURCE_ID\"]
  }" | jq '{answer: .answer, citationCount: (.citations | length), citations: [.citations[] | {title, url}]}'
```

Expected: substantive answer, at least one citation with a `url` pointing to
`<tenant>.sharepoint.com/sites/<staff-site>/...`.

### 4.3 Spot-check a specific document

Browse to `https://<tenant>.sharepoint.com/sites/<staff-site>/Shared%20Documents/Knowledge%20Base`
in a browser and pick a document title. Ask about it specifically to confirm the content is
indexed correctly.

### 4.4 Verify scoping — no bleed from other sources

```bash
# This should return results only from the Knowledge Base source,
# not from the operating tenant or its test site:
curl -fsS -X POST "$API_URL/ask" \
  -H "Authorization: Bearer $MARCUS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"question\": \"What topics are covered in the Knowledge Base?\",
    \"allowedSourceIds\": [\"$SOURCE_ID\"]
  }" | jq '[.citations[] | .documentId]'
# All document IDs should belong to this source only (verify via GET /documents/:id).
```

### Verification checklist

- [ ] Source status is not `"error"` after sync completes
- [ ] `/ask` returns a non-empty, substantive answer with citations
- [ ] Citation URLs point to `<tenant>.sharepoint.com/sites/<staff-site>/...`
- [ ] No documents from other sources appear in citation list when scoped to `$SOURCE_ID`
- [ ] `documentsSkippedOversize` in worker logs is 0 or low (KB folder likely has small docs)

---

## Execution order summary

```
Phase 0: Read confirmed facts above (2 min)
    ↓
Phase 1: POST /sources → save $SOURCE_ID (5 min)
    ↓
Phase 2: Update deploy_tokens.sh → deploy principals → commit (5 min)
    ↓
Phase 3: Trigger sync → monitor until ingest.run.summary appears (5–20 min wait)
    ↓
Phase 4: Verify document count + ask a question + scoping check (10 min)
```

---

## Rollback

| Action             | Rollback                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Source created     | `curl -fsS -X DELETE "$API_URL/sources/$SOURCE_ID" -H "Authorization: Bearer $ADMIN_TOKEN"` — cascades docs + chunks |
| Principals updated | Revert `deploy_tokens.sh` to remove the new UUID, re-run the script                                                  |
| Sync triggered     | No rollback needed — DELETE source removes all ingested content                                                      |

---

## Reference: scripts in rag-system

| Script                          | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `scripts/gen-tokens.sh`         | Generate bearer tokens for named principals                |
| `scripts/deploy_tokens.sh`      | Set API_PRINCIPALS on rag-api + rag-mcp, redeploy both     |
| `scripts/set-ms-credentials.sh` | Set MS\_\* on rag-worker (already done)                    |
| `scripts/resolve-siteid.sh`     | Resolve composite siteId via rag-worker SSH (already done) |
