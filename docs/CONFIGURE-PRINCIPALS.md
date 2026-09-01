# Configuring API Principals and Source Access

**Status:** Current · **Updated:** 2026-08-03

Step-by-step guide for setting up `API_PRINCIPALS` — the per-token source-ID
access control that walls staff off from clients they don't work.

## Overview

The RAG system has two tiers of bearer-token authorization:

| Variable         | Principal kind       | Who can see                |
| ---------------- | -------------------- | -------------------------- |
| `API_TOKENS`     | Admin (unrestricted) | **The entire corpus**      |
| `API_PRINCIPALS` | Scoped (enforced)    | Only the listed source IDs |

Use `API_TOKENS` for admin tools and service accounts. Use `API_PRINCIPALS` for
every staff member or end-user who should see only their slice of the corpus.

> **Fail-closed semantics:** a scoped principal with an empty `allowedSourceIds`
> (`[]`) can read **nothing** — zero rows, always. A token not listed in either
> variable returns HTTP 401.

---

## Prerequisites

- `railway` CLI installed and logged in (`railway login`)
- `curl` and `jq` installed (`brew install jq`)
- At least one source registered (`GET /sources` returns rows)

---

## Step 1 — List available sources

Use the helper script to see all registered source IDs and names:

```bash
cd ~/dev/rag-system
./scripts/gen-principals.sh
```

The script fetches the admin token from Railway automatically. To supply your
own token:

```bash
./scripts/gen-principals.sh --token <your-admin-token>
```

Example output:

```
Sources available:
  d3461cbe-b99f-4253-aded-b3610afe56de  sharepoint  Tax Workpapers 2024
  a1b2c3d4-...                          gmail       Engagement Email – Smith Co
  f9e8d7c6-...                          sharepoint  Staff Policies

[
  {
    "token": "<TOKEN-FOR-tax-workpapers-2024>",
    "allowedSourceIds": ["d3461cbe-b99f-4253-aded-b3610afe56de"],
    "_source_name": "Tax Workpapers 2024",
    "_source_kind": "sharepoint"
  },
  ...
]
```

Write down the UUID(s) for the source(s) each person should access.

---

## Steps 2 + 3 — Generate tokens and build the JSON (automated)

Use `gen-tokens.sh` to generate cryptographic tokens and produce the final
`API_PRINCIPALS` JSON in one step. Each positional argument defines one principal:

```
"<label>:<sourceId1>[,<sourceId2>,...]"   scoped to listed sources
"<label>::isAdmin"                        unrestricted admin grant
```

**Current registered sources** (run `./scripts/gen-principals.sh` to refresh):

| UUID                                   | Name                   |
| -------------------------------------- | ---------------------- |
| `52bb403e-2e59-472b-935a-c83f2eee7e4c` | the operating tenant   |
| `d3461cbe-b99f-4253-aded-b3610afe56de` | the tenant's test site |

```bash
# alice sees CPA Firm only; bob sees both; service-admin is unrestricted
./scripts/gen-tokens.sh \
  "alice:52bb403e-2e59-472b-935a-c83f2eee7e4c" \
  "bob:52bb403e-2e59-472b-935a-c83f2eee7e4c,d3461cbe-b99f-4253-aded-b3610afe56de" \
  "service-admin::isAdmin"
```

The script outputs:

- **stderr** — TOKEN MAP: `label = <64-char hex>`. Save this; it cannot be recovered.
- **stdout** — minified `API_PRINCIPALS` JSON, ready to pipe into `railway variables --set`.

> **Important:** each run generates _different_ tokens. Capture the stdout output
> and redeploy from it — don't re-run to recover a value.

Key JSON rules:

- **One entry per token** — duplicates cause a startup error.
- **Multiple sources per token** — put them all in `allowedSourceIds`.
- **Admin grant** — use `"isAdmin": true` (the only way to get admin when
  `API_ENFORCE_SCOPING=true`).
- **`allowedSourceIds: []` without `isAdmin`** — deny-all; authenticates but
  sees nothing (useful for quarantined accounts).

---

## Step 4 — Set the variable on Railway

Pipe `gen-tokens.sh` stdout directly into the Railway set command:

```bash
PRINCIPALS=$(./scripts/gen-tokens.sh \
  "alice:52bb403e-2e59-472b-935a-c83f2eee7e4c" \
  "service-admin::isAdmin")

# stdout is already minified JSON — set directly on both services
railway variables --service rag-api --set "API_PRINCIPALS=$PRINCIPALS"
railway variables --service rag-mcp --set "API_PRINCIPALS=$PRINCIPALS"
```

The services reload environment variables on the next deploy. Trigger a deploy
or restart to pick up the change immediately:

```bash
railway redeploy --service rag-api
railway redeploy --service rag-mcp
```

---

## Step 5 — Verify

Check that a scoped token returns only its sources:

```bash
API=https://rag-api-production-07b4.up.railway.app
SCOPED_TOKEN=a3f7b2c9d1e4f8...

# Should return 200 with results only from allowed sources
curl -s "$API/search" \
  -H "Authorization: Bearer $SCOPED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","limit":3}' | jq '.results[].sourceId'

# A source outside the allowed set must return 0 results or 404
curl -s "$API/sources/<forbidden-source-uuid>/documents" \
  -H "Authorization: Bearer $SCOPED_TOKEN"
# expect: 404 (indistinguishable from "doesn't exist")
```

---

## Step 6 (optional) — Enforce scoping on plain tokens

By default, tokens in `API_TOKENS` are still admin. To lock that down:

```bash
railway variables --service rag-api --set "API_ENFORCE_SCOPING=true"
railway variables --service rag-mcp --set "API_ENFORCE_SCOPING=true"
```

Once this is on, **plain `API_TOKENS` authenticate but grant nothing**. Admin
access must be granted explicitly with `"isAdmin": true` in `API_PRINCIPALS`.
Do this **after** you have at least one `isAdmin` entry set, or all API access
will be locked out.

---

## Updating principals

To add, remove, or modify a principal:

1. Fetch the current value from Railway:
   ```bash
   railway variables --service rag-api --kv | grep '^API_PRINCIPALS='
   ```
2. Edit the JSON (add/remove entries, adjust `allowedSourceIds`).
3. Re-set the variable with `railway variables --set` (Step 4 above).
4. Redeploy both services.

To **revoke** a token, remove its entry and redeploy. The token becomes 401
immediately after the service restarts.

---

## Multi-source access patterns

| Use case                       | Configuration                             |
| ------------------------------ | ----------------------------------------- |
| Partner: sees everything       | `API_TOKENS` (admin) or `"isAdmin": true` |
| Senior staff: assigned clients | `allowedSourceIds: [id1, id2, id3]`       |
| Staff: one engagement          | `allowedSourceIds: [id1]`                 |
| Quarantine / suspended         | `allowedSourceIds: []` (no `isAdmin`)     |
| Web app service account        | Scoped to the sources the app serves      |

---

## Troubleshooting

| Symptom                                                              | Likely cause                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Service fails to start with "API_PRINCIPALS is not valid JSON"       | JSON syntax error — validate with `echo "$VAL" \| jq .`        |
| "API_PRINCIPALS contains a duplicate token" on startup               | Same token appears twice in the array                          |
| Scoped token sees zero results                                       | `allowedSourceIds` IDs don't match any registered source       |
| Admin token lost all access after setting `API_ENFORCE_SCOPING=true` | No `isAdmin: true` entry exists — add one via `API_PRINCIPALS` |
| 401 on a valid-looking token                                         | Token not in `API_TOKENS` and not in `API_PRINCIPALS`          |

---

## Reference

- `packages/core/src/access-control.ts` — `parsePrincipalsConfig`, `resolvePrincipal`, `effectiveSourceFilter`
- `packages/core/src/config.ts` — Zod schema for `api.principals`
- `env.example` — all `API_*` variables with inline documentation
- `scripts/gen-principals.sh` — automates Step 1 (source listing + template generation)
- `scripts/gen-tokens.sh` — automates Steps 2+3 (token generation + JSON assembly)
