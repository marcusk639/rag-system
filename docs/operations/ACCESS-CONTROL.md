---
title: Access control
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: Who can see which sources, through which mechanism (database grants for web and Teams users, API_TOKENS and API_PRINCIPALS for direct API and MCP tokens), and how to grant, check, revoke and verify access.
read_when: Granting or revoking someone's access, issuing an API or MCP token, turning on API_ENFORCE_SCOPING, or debugging empty answers.
supersedes: [CONFIGURE-PRINCIPALS.md]
code:
  [
    packages/core/src/access-control.ts,
    packages/core/src/internal-scope-auth.ts,
    packages/db/src/queries.ts,
    packages/db/src/manage-access.ts,
    apps/web/src/lib/scope-token.ts,
    apps/web/src/app/admin/access/actions.ts,
    apps/teams-bot/src/scope.ts,
    scripts/gen-tokens.sh,
    scripts/gen-principals.sh,
    scripts/deploy_tokens.sh,
  ]
---

# Access control

Every request reaches retrieval with a set of source ids it may read, and everything fails closed: an empty set
returns zero rows without touching the database. That set comes from one of two independent mechanisms:

| Caller                    | Mechanism                                                                                                    | Managed with                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Web and Teams users       | Database grants, resolved per request by `resolveSourceIdsForUser`, then signed into a 60-second scope token | `/admin/access` in the web app, or the `manage-access` CLI |
| Direct API and MCP tokens | `API_TOKENS` (admin) and `API_PRINCIPALS` (scoped), env vars on `rag-api` and `rag-mcp`                      | `scripts/gen-tokens.sh`, Railway variables                 |

The two don't share state. A database grant gives nothing to an API token, and an `API_PRINCIPALS` edit changes
nothing in the web app. When a source is recreated (for example after a [tenant switch](./SHAREPOINT-RUNBOOK.md#switching-tenants-and-re-syncing)),
both must be moved to the new id.

## How the API resolves a caller

`AUTH_PROVIDER=composite` (the default) tries verifiers in order: static tokens (`API_TOKENS`, `API_PRINCIPALS`), then
OIDC if `OIDC_*` is set, then the internal scope token if `INTERNAL_SCOPE_JWT_SECRETS` is set (`packages/runtime/src/index.ts`
`buildAuthProvider`). A caller that matches none gets 401. The resulting principal becomes an `AuthorizationScope`
(`packages/core/src/access-control.ts` `principalToScope`):

- `enforcedSourceIds: null`: admin, unrestricted.
- `enforcedSourceIds: [ids]`: scoped. A caller's own `sourceIds` filter can only narrow within it
  (`effectiveSourceFilter`).
- `enforcedSourceIds: []`: deny-all. Authenticates, sees nothing.

What a principal may do:

| Action                                                  | Admin | Scoped                                      |
| ------------------------------------------------------- | ----- | ------------------------------------------- |
| `/search`, `/ask`, `GET /documents/:id`                 | all   | only sources in scope; others look like 404 |
| `GET /sources`                                          | all   | only sources in scope                       |
| `POST /sources/:id/sync`, `DELETE /sources/:id` (purge) | all   | **sources in scope**                        |
| `POST /sources` (create)                                | yes   | 403 `FORBIDDEN`                             |

A scoped principal can purge a source it can see. Grant scoped API tokens only to people trusted with that.

## Web and Teams users: database grants

Three tables hold the grants (`packages/db/src/schema.ts`). Every grant is soft-deleted (`revoked_at`), never
hard-deleted, so grant history stays reconstructible.

| Table                       | Links           | Written by                                             |
| --------------------------- | --------------- | ------------------------------------------------------ |
| `staff_source_assignments`  | user ↔ source   | `/admin/access` (source grants), `manage-access grant` |
| `staff_client_assignments`  | user ↔ client   | `/admin/access` (client grants)                        |
| `source_client_assignments` | source ↔ client | No app or CLI path writes it; rows are added in SQL    |

`resolveSourceIdsForUser` (`packages/db/src/queries.ts`) returns the UNION of the user's direct source grants and every
source mapped to a client the user is actively assigned to. An unmapped user gets `[]`. The user id is the Entra
`oid`.

- **Web:** on every request the BFF resolves the user's sources fresh and mints a scope token
  (`apps/web/src/lib/scope-token.ts`). The token is HS256, valid for 60 seconds, and signed with
  `INTERNAL_SCOPE_JWT_SECRET`, so a revoke takes effect within about a minute. If the lookup fails, the request fails;
  it never falls back to a wider scope.
- **Teams:** the same in a direct message.

### Teams channel scope

In a channel, the bot never uses the asker's own grants. It signs the **intersection** of every member's grants, minus
`client_confidential` sources (`apps/teams-bot/src/scope.ts` `mintScope`, `queries.ts`
`resolveSharedSourceIdsForUsers`), so a channel answer can't expose a source any member lacks. The rationale is in
[`DECISIONS.md`](../architecture/DECISIONS.md).

### Granting and revoking

The normal path is `/admin/access` in the web app. Only `RAG-Admins` members can use it, and it needs `User.Read.All`
on the ingestion app to resolve an email to an `oid` ([`FRESH-DEPLOY-GUIDE.md` §1.1](./FRESH-DEPLOY-GUIDE.md#11-the-app-registrations)).

For scripting, or when the web app is down, use the CLI in `packages/db/src/manage-access.ts`. It calls the same typed
queries as the admin page. Inside a deployed container, run it as compiled JS (the image has no pnpm or tsx):

```bash
node node_modules/@rag/db/dist/manage-access.js sources
node node_modules/@rag/db/dist/manage-access.js check  --user <oid>
node node_modules/@rag/db/dist/manage-access.js list   --user <oid> [--revoked]
node node_modules/@rag/db/dist/manage-access.js grant  --user <oid> --source <source uuid> --by <admin>
node node_modules/@rag/db/dist/manage-access.js revoke --user <oid> --source <source uuid>
```

Locally the same commands are `pnpm --filter @rag/db access -- <command> …`. Exit codes: 0 success, 1 no-op, 2 usage,
3 operational, 4 needs attention. `check` reports exactly the scope the web BFF and the bot will resolve. `revoke` only
removes a direct grant. It warns, rather than reporting success, when access survives through a client assignment.

Deleting a source cascades to its grant rows. Recreating a source under a new id therefore starts with **no** grants,
which looks the same as never having had access.

Done when: `check --user <oid>` lists exactly the intended sources.

## Direct API and MCP tokens: `API_TOKENS` and `API_PRINCIPALS`

| Variable         | Principal                                | Sees                        |
| ---------------- | ---------------------------------------- | --------------------------- |
| `API_TOKENS`     | admin (until `API_ENFORCE_SCOPING=true`) | the whole corpus            |
| `API_PRINCIPALS` | scoped, or admin with `"isAdmin": true`  | only its `allowedSourceIds` |
| neither          | none                                     | 401                         |

Set `API_PRINCIPALS` to the **same value on `rag-api` and `rag-mcp`**; both authenticate with it. `API_TOKENS` must
also be on `rag-worker`, because the shared config rejects an empty list. A token present in both lists resolves to its
scoped entry: least privilege wins (`resolvePrincipal`).

`API_PRINCIPALS` is a JSON array of `{"token", "allowedSourceIds", "isAdmin"?}` (`parsePrincipalsConfig`). The rules:

- Malformed JSON, a non-array, or a bad entry is a startup error.
- A duplicate token is a startup error.
- `"isAdmin": true` is the only way to be admin once `API_ENFORCE_SCOPING=true`.
- `allowedSourceIds: []` without `isAdmin` is deny-all, which is how you quarantine an account.
- Ids are not checked against the database. An `API_PRINCIPALS` entry can name a source that no longer exists, and
  that principal then silently sees nothing.

### Issuing tokens

1. **List source ids.** `./scripts/gen-principals.sh` calls `GET /sources` with an admin token. It pulls the token from
   Railway unless you pass `--token` or set `RAG_ADMIN_TOKEN`; set `RAG_API_URL` to point it elsewhere. As of
   2026-10-21 the SharePoint source is `dbba75e2-cecb-41be-8998-4f923158f741`; re-list rather than trusting that.
2. **Generate tokens and the JSON.** Each argument is `"<label>:<id1>[,<id2>…]"` (scoped) or `"<label>::isAdmin"`:

   ```bash
   PRINCIPALS=$(./scripts/gen-tokens.sh "alice:<source-uuid>" "bob:<uuid-1>,<uuid-2>" "service-admin::isAdmin")
   ```

   stdout is the minified `API_PRINCIPALS` value. stderr is the TOKEN MAP (`label = <64 hex>`). The tokens can't be
   recovered later, so save the map now, and hand each person only their own token. Every run makes **new** tokens,
   so deploy the stdout you captured instead of re-running.

3. **Set and redeploy both services:**

   ```bash
   railway variables --service rag-api --set "API_PRINCIPALS=$PRINCIPALS"
   railway variables --service rag-mcp --set "API_PRINCIPALS=$PRINCIPALS"
   railway redeploy --service rag-api && railway redeploy --service rag-mcp
   ```

   `./scripts/deploy_tokens.sh "<user>:<ids>" …` does steps 2–3 in one go and always appends a `service-admin` admin
   principal. It **replaces the whole set**: anyone left out of the arguments loses access. It prints a fingerprint of
   the current and new sets first, never the token values.

### Updating and revoking

Read the current value (`railway variables --service rag-api --kv | grep '^API_PRINCIPALS='`), edit the JSON, set it on
both services, and redeploy both. Removing an entry revokes that token once the services restart. Regenerating with
`gen-tokens.sh` invalidates **every** token at once.

### Turning on `API_ENFORCE_SCOPING`

It defaults to `false`. When `true`, plain `API_TOKENS` still authenticate but resolve to deny-all, and admin comes only
from an `isAdmin` principal.

**Set an `isAdmin` principal first and confirm it works.** Turning enforcement on without one locks every caller out of
admin operations, including source creation and sync. Then set `API_ENFORCE_SCOPING=true` on `rag-api` and `rag-mcp`
and redeploy both.

### Verify a scoped token

```bash
API=https://rag-api-production-07b4.up.railway.app
curl -s "$API/search" -H "Authorization: Bearer $SCOPED_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"<known term>","topK":3}' | jq '[.results[].document.sourceId] | unique'
# expect only ids from that principal's allowedSourceIds

curl -s -o /dev/null -w '%{http_code}\n' "$API/sources/<forbidden-source-uuid>" -H "Authorization: Bearer $SCOPED_TOKEN"
# expect 404: indistinguishable from a source that doesn't exist
```

Done when: both checks hold for every new principal, and an admin token still sees all sources.

## Access patterns

| Use case                     | Configuration                                                  |
| ---------------------------- | -------------------------------------------------------------- |
| Staff member using web/Teams | Database grant per source, or a client assignment              |
| Partner who sees everything  | Grants to every source (web), or `"isAdmin": true` (API token) |
| Integration on one source    | `API_PRINCIPALS` entry with `allowedSourceIds: [id]`           |
| Quarantined API account      | `allowedSourceIds: []`, no `isAdmin`                           |
| Service or setup automation  | `isAdmin` principal; discard the token after setup             |

## Troubleshooting

| Symptom                                                    | Likely cause                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Startup fails: `API_PRINCIPALS is not valid JSON`          | JSON syntax; check with `echo "$VAL" \| jq .`                                      |
| Startup fails: `API_PRINCIPALS contains a duplicate token` | The same token appears twice                                                       |
| Startup fails: `API_PRINCIPALS[n] is invalid`              | An entry lacks `token` or `allowedSourceIds`, or `isAdmin` isn't a boolean         |
| Scoped token sees nothing                                  | Its ids don't match any current source (for example after a source was recreated)  |
| Admin token lost access after `API_ENFORCE_SCOPING=true`   | No `isAdmin` principal exists                                                      |
| 401 on a valid-looking token                               | In neither `API_TOKENS` nor `API_PRINCIPALS`, or the service wasn't redeployed     |
| Web or Teams user gets empty answers                       | No grant (`manage-access check --user <oid>`), or the grant names an old source id |
| Every web and Teams request 401s                           | `INTERNAL_SCOPE_JWT_SECRETS` (plural) missing on `rag-api`                         |
| `/admin/access` can't find a user by email                 | `User.Read.All` not consented, or `MS_*` missing on `rag-web`                      |
