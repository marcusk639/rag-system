# apps/teams-bot — Microsoft Teams KB Bot Design

**Status:** Approved design — 2026-07-16.
**Goal:** Let firm staff ask the knowledge base a question from inside Microsoft Teams — by DMing the bot or @mentioning it in a channel — and get an answer as an adaptive card with citations and the "AI-generated draft, requires review" disclaimer, while preserving the exact per-user access scoping and audit logging the web/API/MCP surfaces already enforce.

**Relationship to existing work:** Greenfield app (no existing Teams code). Reuses the rag-system backend unchanged. The Azure Bot resource + bot Entra app registration are human/infra steps (like `apps/web`'s Entra registration in `docs/PILOT-MANUAL-RUNBOOK.md` item 4) and are documented in the companion Azure deploy runbook, not built here.

---

## 1. Core architecture — the bot is another BFF

The web app is a BFF (browser-facing frontend that holds the backend credential server-side): it authenticates the user via Entra ID, resolves the user's `oid`, calls `resolveSourceIdsForUser` fresh from Postgres, mints a 60-second `signInternalScopeToken`, and calls the RAG HTTP API with that token as its bearer credential. Fastify's `InternalScopeAuthProvider` verifies the token into a scoped `Principal` and does all enforcement + audit.

**The Teams bot is the same pattern with a Teams front door instead of a browser front door.** On each question it:

1. Authenticates the Teams user via Entra SSO → obtains the user's `oid`.
2. Computes the appropriate **scope source-id set** (DM vs. channel — §3).
3. Mints the identical `signInternalScopeToken({ sub: askerOid, allowedSourceIds }, INTERNAL_SCOPE_JWT_SECRET)`.
4. Calls the existing RAG HTTP API `ask` endpoint with that bearer token and an `X-RAG-Channel: teams` header.
5. Renders the returned answer + citations as an adaptive card.

**The bot contains zero authorization or retrieval logic.** Per-user scope enforcement and audit logging already live at the API boundary; the bot only decides _what source-id set goes into the token_. This is the whole safety argument: the confidentiality boundary is not reimplemented on a second code path.

**Reused unchanged:** `signInternalScopeToken` (`@rag/core`), `resolveSourceIdsForUser` (`@rag/db`), the HTTP API `ask` endpoint and its `InternalScopeAuthProvider` + audit logging.

### Rejected alternative

The bot could call the API directly with the user's Entra token via the on-behalf-of (OBO) flow, making the API accept Entra ID tokens and resolve scope itself. Rejected: it duplicates the corpus-wide confidentiality boundary onto a second enforcement path and requires changing the API's auth. Bot-as-BFF reuses the already-reviewed scope-token path with no API auth change.

---

## 2. Authentication — Teams SSO → `oid`

The bot's Entra app registration exposes an API (`api://botid-<appId>/access_as_user`) and pre-authorizes the Teams first-party client IDs; the Teams app manifest declares `webApplicationInfo` (bot app id + resource URI). The Bot Framework SDK silently exchanges the user's existing Teams/Entra session for an access token (no interactive prompt in the common case), falling back to an OAuth sign-in card if SSO can't complete (e.g. consent not yet granted).

- The identity used everywhere is the token's **`oid`** claim — the same stable AAD object id the web app binds scope to (`apps/web/src/lib/auth.ts`). Email/UPN are never used as the identity key.
- **Fail closed:** if SSO yields no verified `oid`, the bot refuses to answer and returns a sign-in / error card. It NEVER falls back to an admin or default scope. (Mirrors `getScopeAssertionToken`'s fail-closed contract.)
- The bot is a **query surface only** — no admin actions — so it does not consult the `RAG-Admins` group. Any authenticated staff member with source grants can ask.

---

## 3. Scope selection — DM vs. channel (the compliance core)

The scope token's `allowedSourceIds` is the only lever, and the bot sets it per surface:

### DM / personal chat

`allowedSourceIds = resolveSourceIdsForUser(db, askerOid)` — the asker's complete personal access, including any client-scoped grants. The answer is only ever visible to the asker, so it exactly matches their scope. Identical semantics to the web app.

### Channel / group chat (@mention) — member-intersection

A channel answer is visible to **every** channel member, so it must draw only from sources **every current member can already access**. Scope is therefore the **intersection of all channel members' grants**, minus client-confidential:

```
members   = Teams membership of the channel/chat (AAD oids), excluding the bot itself
            and any member without an oid (e.g. unauthenticated guests)
channelScope = { s : s ∈ resolveSourceIdsForUser(m) for EVERY m ∈ members }
               AND sources.data_class != 'client_confidential'
```

- **Provably leak-free by construction:** a source appears only if all members are individually granted it, so no member ever sees content they lacked access to. The firm-wide SOP index (granted to everyone) flows through naturally; anything not universally granted is auto-hidden.
- **Fail-closed on unknowns:** a guest or any member without a resolvable `oid`/grant collapses the intersection toward empty — the safe direction.
- **`client_confidential` exclusion is belt-and-suspenders:** even if some client-confidential source were somehow universally granted, it is still never surfaced in a channel.
- **Efficiency:** the intersection is one SQL query, not N round-trips — a new read-only `resolveSharedSourceIdsForUsers(db, oids: string[])`:

  ```sql
  SELECT source_id
  FROM ( <same UNION that resolveSourceIdsForUser uses, but WHERE user_id = ANY($1)> ) grants
  JOIN sources ON sources.id = grants.source_id
  WHERE sources.data_class <> 'client_confidential'
  GROUP BY source_id
  HAVING count(DISTINCT user_id) = $2   -- $2 = number of distinct member oids
  ```

  This reuses the exact grant-resolution logic of `resolveSourceIdsForUser` (client-routed + direct grants) so the two never drift.

- **Audit identity is still the asker.** The scope token's `sub` is the asker's `oid` (so the audit row's `principalSubject` correctly names who asked); only `allowedSourceIds` is the intersection. Empty intersection → the "no shared firm sources here" card (§4), never a blank or an error that leaks whether sources exist.

---

## 4. Response — a single adaptive card

Teams bots cannot token-stream, so the bot: sends a typing indicator, calls the API's **non-streaming** `ask` (the same call the MCP `ask` tool makes), and posts one adaptive card containing:

- The answer text.
- Numbered citations (title; a link or download affordance where the API returns one).
- A non-dismissible **"⚠️ AI-generated draft — verify before relying on it"** disclaimer, matching the web app's disclaimer verbatim in intent.

Empty-scope outcomes return a friendly card rather than a blank:

- DM, user has no grants → "You don't have access to any knowledge sources yet — ask an admin to grant you access."
- Channel, empty intersection → "No firm-wide sources are available to everyone in this channel. Ask me in a direct message to search everything you personally have access to."

---

## 5. Components / files

```
apps/teams-bot/
  src/
    index.ts        # HTTP server + POST /api/messages (Bot Framework adapter); /health
    bot.ts          # TeamsActivityHandler: route DM vs channel, strip @mention, orchestrate
    auth.ts         # Teams SSO token exchange → verified oid; fail-closed
    scope.ts        # DM scope (resolveSourceIdsForUser) vs channel scope
                    #   (membership → resolveSharedSourceIdsForUsers); mints scope token
    rag-client.ts   # call the RAG HTTP API `ask` with the scope token + X-RAG-Channel: teams
    cards.ts        # adaptive-card builders (answer, citations, disclaimer, empty-scope, error)
    config.ts       # env loading + validation (fail-loud on missing required vars)
  manifest/         # Teams app manifest.json (+ color/outline icons)
  Dockerfile        # mirrors apps/web (Node, non-root, prod-only deps, pnpm deploy)
  railway.json
  package.json      # @rag/core, @rag/db deps; botbuilder; a small HTTP server (restify/express)
```

New shared code:

- `@rag/db`: `resolveSharedSourceIdsForUsers(db, oids, { excludeDataClass })` (§3 query).
- `@rag/core` **or** apps/api: record the `X-RAG-Channel` header value on the audit row (§6) — extend the audit `channel` field to accept `"teams"` (today `"api" | "mcp"`).

---

## 6. Audit

Bot queries flow through the API, so they are audited automatically with `principalSubject = askerOid`. To make Teams usage distinguishable in the compliance audit log, the bot sends `X-RAG-Channel: teams`; the API records it in the audit row's `channel` column (extending the existing `"api" | "mcp"` set to include `"teams"`, defaulting to `"api"` when the header is absent so existing callers are unaffected). This is the one small, additive API-side change in this design.

---

## 7. Error handling

Same fail-closed discipline as the web BFF:

- Scope resolution throws (DB down, etc.) → the request fails with an error card; NEVER degrades to a broader scope.
- No verified `oid` → sign-in/error card, no answer.
- API unreachable / non-200 → a clear "the knowledge base is temporarily unavailable" card; upstream error bodies are not leaked verbatim.
- Secrets (`INTERNAL_SCOPE_JWT_SECRET`, bot app password, `DATABASE_URL`) are never logged; the config loader fails loud at startup if a required var is missing.

---

## 8. Testing

All testable without a live Teams tenant, using the Bot Framework `TestAdapter` and mocked `@rag/db`/API:

- **auth.ts:** verified `oid` extracted from an SSO token; missing-`oid` → fail-closed (no answer, no fallback scope).
- **scope.ts:** DM → asker's full `resolveSourceIdsForUser`; channel → `resolveSharedSourceIdsForUsers` intersection, and the **isolation test**: a member lacking a grant to source X removes X from the channel scope even when the asker has it (the test that catches a leak). `client_confidential` excluded from channel scope even if universally granted.
- **cards.ts:** the disclaimer is present on every answer card; empty-scope cards render for both DM and channel.
- **bot.ts:** DM vs channel routing; @mention text stripping.
- **rag-client.ts:** sends the scope token as bearer + `X-RAG-Channel: teams`; maps API errors to error cards.
- **DB:** `resolveSharedSourceIdsForUsers` intersection + `client_confidential` exclusion, incl. the isolation case, against real Postgres (e2e).

Coverage note: this app must not be added to any Docker-dependent CI-blocking path beyond the existing e2e workflow; unit tests carry the logic.

---

## 9. Deployment (code deliverables only; human/infra steps live in the runbook)

- New Railway service `rag-teams-bot` from `apps/teams-bot/Dockerfile`, with a public HTTPS `/api/messages` endpoint.
- Env (documented in `env.example`): `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_APP_TENANT_ID` (bot registration); `BOT_ENTRA_SSO_*` (SSO app/resource); `INTERNAL_SCOPE_JWT_SECRET` (same secret the API verifies); `RAG_API_URL`; `DATABASE_URL` (for grant resolution, exactly as the web BFF uses it).
- The **human/infra steps** — create the Azure Bot resource, register the bot's Entra app + SSO scope, upload the Teams app manifest, point the messaging endpoint at the deployed service — are covered in the companion Azure deploy runbook and gated behind the same P0 items (content audit, counsel sign-off) as the web app's real-staff deployment.

---

## 10. Out of scope (v1)

- Token-by-token streaming in Teams (single adaptive card is the v1 answer).
- Proactive/unsolicited messages, meeting extensions, message-extension search commands.
- Admin actions via the bot (grants, sync, purge remain web/API only).
- Conversation memory / multi-turn context (each question is independent in v1).
- Any change to the per-user grant model or the `dataClass` taxonomy.

---

## 11. Global constraints (bind every implementation task)

- TypeScript only; the bot is a new pnpm workspace app under `apps/`. No Python.
- All DB access via `@rag/db` typed queries; never import `pg`/`drizzle-orm` directly.
- All backend calls go through the RAG HTTP API via a minted scope token; never a shared static token, never direct DB reads of chunks/embeddings.
- Fail closed everywhere identity or scope can't be positively established.
- Edit `env.example`, never a real `.env` (hook-blocked).
- Match existing test patterns; the isolation test in §8 is mandatory, not optional.
- `resolveSharedSourceIdsForUsers` MUST reuse the same grant UNION as `resolveSourceIdsForUser` (import/share the SQL fragment) so channel scope and DM scope can never diverge in what "a grant" means.
