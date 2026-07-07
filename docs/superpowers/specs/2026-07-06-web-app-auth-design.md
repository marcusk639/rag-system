# Design: Web App Per-User Authentication (with a Documented Teams Extension Path)

**Date:** 2026-07-06
**Status:** Approved design, ready for implementation planning
**Origin:** Finding #5 ("The web app has no real per-user authentication") in `docs/RAG-VALIDATION-REPORT.md`

## Problem

Every browser session against the Next.js web app shares one static, server-held bearer token
(`RAG_API_TOKEN` in `apps/web/src/lib/rag-api.ts`). The BFF forwards this same token for every
user, so there is no way to express "which clients can this specific staff member see" — everyone
using the web app shares the scope of the one configured token.

This is confirmed as the deliberate current state, not an oversight: `apps/web/CLAUDE.md` records
that the UI's original PropelAuth integration was stripped during migration from the deprecated
`cpa-knowledge-base` repo, and nothing replaced it. A prior research pass
(`docs/AUTH-AND-SESSIONS-RESEARCH.md`, 2026-06-07) designed an auth strategy assuming PropelAuth
would remain — that assumption is now stale, but its supporting infrastructure
(`staff_client_assignments` / `source_client_assignments` tables, `resolveSourceIdsForUser` query)
was built anyway and already exists unused in `packages/db/src/schema.ts` and
`packages/db/src/queries.ts:774`.

## Scope

**In scope (this design, build now):**

- Real per-user authentication for the Next.js web app via Microsoft Entra ID.
- A signed scope-assertion mechanism connecting the web app's resolved per-user scope to the
  existing Fastify `AuthorizationScope` enforcement, without modifying that enforcement itself.
- A productized admin UI (`/admin/access`) for granting/revoking staff access to clients.
- Admin-role determination via Entra ID group membership.

**Documented but explicitly NOT built in this pass:**

- An MS Teams bot/channel. The design below is chosen so a future Teams integration reuses the
  same identity resolution, scope-assertion mechanism, and grant/revoke logic — see
  [Teams extension path](#teams-extension-path-documented-not-built).

**Explicitly out of scope (separate concern):**

- Server-side chat session storage (`chat_sessions`/`chat_messages`/`message_citations`/
  `chat_audit_log` from `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 2). These tables were never
  built; the web app's current session UI (`sessions-menu`, `use-chat-sessions.tsx`) is unrelated
  to _who is allowed to search what_ and is not touched by this design.
- SMS/Twilio channel auth (also covered by the prior research doc, also not part of this pass).

## Architecture

### Why not the prior research doc's exact recommendation

The 2026-06-07 research doc recommended a BFF proxy using PropelAuth's session + a static
`API_PRINCIPALS` service token. PropelAuth is gone. Of the architectures considered to replace it:

| Approach                                                                                                                                   | Verdict                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chosen: BFF resolves scope from the DB, mints a signed short-lived scope-assertion JWT, Fastify gets a new `InternalScopeAuthProvider`** | Reuses `resolveSourceIdsForUser`/`staff_client_assignments` (already built, per-user, audit-trail-friendly) and fits the existing pluggable `AuthProvider` pattern (new provider class, same interface, same factory switch) rather than inventing a parallel mechanism. Extends cleanly to Teams later — any channel that resolves its own user's identity can mint the same token. |
| Forward the user's real Entra ID OIDC token straight to Fastify, using the existing `OidcAuthProvider`'s static `OIDC_SCOPE_MAP`           | Zero new Fastify code, but scope granularity becomes "per AAD security group" rather than per-user via the Postgres table, requiring an AAD group per client engagement (an IT burden) and ignoring the DB-driven mapping this codebase already built for exactly this purpose.                                                                                                      |
| HMAC-signed scope header instead of a JWT                                                                                                  | Same idea as the chosen approach with simpler crypto, but a bespoke protocol instead of a standard one — matters less for a future Teams channel to reuse.                                                                                                                                                                                                                           |

### Component overview

```
Browser          Next.js BFF (Auth.js)         Microsoft Entra ID
   │                    │                              │
   │  GET /login         │                              │
   │────────────────────>│                              │
   │                    │  OIDC auth code flow (PKCE)    │
   │                    │───────────────────────────────>│
   │                    │<───────────────────────────────│
   │                    │  id_token (oid, upn, groups)    │
   │  Set-Cookie: session │                              │
   │  (httpOnly, Secure,   │                              │
   │   SameSite=Strict)     │                              │
   │<────────────────────│                              │
```

- Auth.js (NextAuth v5) owns the OAuth/OIDC dance and the session cookie. No hand-rolled token
  handling — PKCE, state/nonce validation, and token refresh are Auth.js's job, not this
  codebase's.
- **A new Entra app registration is required for sign-in** (`AUTH_ENTRA_CLIENT_ID`/
  `AUTH_ENTRA_CLIENT_SECRET`/`AUTH_ENTRA_TENANT_ID` in the table below) — this is deliberately
  **separate** from the existing `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` used by the
  SharePoint/Outlook connectors. The connectors' app registration uses application (client
  credentials) permissions for Graph API calls with no user present; user sign-in needs a
  delegated-permissions app registration (authorization code flow + PKCE, a redirect URI, and
  `openid`/`profile`/`email`/`groups` scopes). Both registrations can live in the same Entra tenant,
  but they are not interchangeable — do not point Auth.js at the connectors' app id.
- The stable identity key is the AAD `oid` (object id) — an immutable GUID that survives email/UPN
  changes, unlike `upn`. `staff_client_assignments.user_id` is a bare opaque `text` column with no
  format constraint, so this is a free choice, not a migration.

### Request flow — resolving and asserting scope

```
Browser          Next.js BFF Route Handler        Postgres              Fastify API
   │                      │                            │                      │
   │ GET /api/sources     │                            │                      │
   │──────────────────────>│                            │                      │
   │                      │ read Auth.js session         │                      │
   │                      │ → oid = "a1b2-...-c3d4"     │                      │
   │                      │                            │                      │
   │                      │ resolveSourceIdsForUser(oid) │                      │
   │                      │─────────────────────────────>│                      │
   │                      │<─────────────────────────────│                      │
   │                      │ ["src-1", "src-2"]           │                      │
   │                      │                            │                      │
   │                      │ sign scope-assertion JWT:     │                      │
   │                      │ { sub: oid,                   │                      │
   │                      │   allowedSourceIds: [...],    │                      │
   │                      │   exp: now+60s }              │                      │
   │                      │ (HS256, INTERNAL_SCOPE_JWT_SECRET)                   │
   │                      │                            │                      │
   │                      │ GET /sources                 │                      │
   │                      │ Authorization: Bearer <jwt>   │                      │
   │                      │──────────────────────────────────────────────────────>│
   │                      │                            │  InternalScopeAuthProvider
   │                      │                            │  verifies signature+exp,
   │                      │                            │  trusts embedded scope
   │                      │<──────────────────────────────────────────────────────│
   │<──────────────────────│                            │                      │
```

- **`InternalScopeAuthProvider`** (new, `packages/core/src/internal-scope-auth.ts`) implements the
  existing `AuthProvider` interface (`authenticate(credential) → Principal | null`), matching
  `StaticTokenAuthProvider`'s and `OidcAuthProvider`'s shape exactly. It verifies the JWT's HMAC
  signature and `exp`, then returns `{ kind: "scoped", allowedSourceIds }` directly from the
  token's claims — no DB round-trip on the Fastify side, since the BFF already did that lookup.
- **Signing secret**: HS256 with a shared secret (`INTERNAL_SCOPE_JWT_SECRET`), consistent with
  this codebase's existing shared-secret pattern (`PARSER_SECRET`) rather than introducing
  asymmetric key management for an internal, single-hop credential.
- **Short expiry (60 seconds)**: minted fresh per BFF request, never cached as a session-length
  credential. Limits blast radius if a token ever leaked, and avoids revocation/blacklist
  complexity — an expired grant simply stops being issued on the next request.
- **Wired via the existing factory**: `AuthProviderConfig`
  (`packages/core/src/auth-provider-factory.ts`) gets a new `"internal-scope"` variant. `composite` can include it
  alongside `static-token`/`oidc`, so the API accepts the BFF's scope-assertion tokens, real
  end-user OIDC tokens, and legacy static service tokens simultaneously.
- **No new migration.** `resolveSourceIdsForUser`, `staff_client_assignments`, and
  `source_client_assignments` already exist exactly as needed.

### Fail-closed semantics

Consistent with the existing `AuthorizationScope` design (`packages/core/src/access-control.ts`):

- No Auth.js session → BFF route handlers return 401 immediately; never fall back to a
  shared/admin token.
- `resolveSourceIdsForUser(oid)` returns `[]` (no assignments, or all revoked) → the BFF still
  mints a scope-assertion JWT, just with `allowedSourceIds: []` → Fastify's existing
  `DENY_ALL_SCOPE` semantics apply automatically. No new enforcement code needed.
- Expired/malformed/unsigned scope-assertion JWT reaching Fastify →
  `InternalScopeAuthProvider.authenticate()` returns `null` (never throws) → falls through the `CompositeAuthProvider` chain
  like any other rejected credential → 401, identical to today's static-token rejection path.
- A user's Entra ID session outlives their access grant (e.g. revoked mid-session) → the next
  request re-resolves scope fresh from the DB (no caching of `allowedSourceIds` beyond the 60s
  token lifetime), so revocation takes effect within one request cycle, not "until they log out."

### Admin role determination

Reuses the exact pattern already built for direct-OIDC bearer tokens (`OidcConfig.adminClaims` in
`packages/core/src/oidc-auth.ts` — "if any of these claim values present → admin") rather than
inventing a parallel roles table:

- One AAD security group (e.g. `RAG-Admins`) is the single source of truth for "who can manage
  grants."
- Auth.js is configured to request/read the `groups` claim on sign-in (same claim name the
  existing `OidcConfig.claim` default already uses server-side).
- The BFF checks membership in that group directly from the session's claims to gate
  `/admin/access` and its server actions — the same claim-check logic `resolveOidcPrincipal`
  already implements, just invoked BFF-side against the Auth.js session instead of Fastify-side
  against a raw bearer JWT.
- No new `is_admin` column or roles table. AAD group membership already governs access for the
  SharePoint/Outlook connectors; this reuses the same source of truth.

### Admin UI

A dedicated route, `apps/web/src/app/admin/access/page.tsx`, gated by `RAG-Admins` group
membership:

- Search staff by email.
- Grant access to a client (the admin picks/searches a `client_id`).
- Revoke access (soft-delete — sets `revoked_at`, never a hard `DELETE`, matching the schema's
  existing audit-trail design).
- View grant history per staff member (`granted_at`/`granted_by`/`revoked_at`).

Server actions behind this page:

1. Resolve the target staff member's email → AAD `oid` via a Microsoft Graph `/users/{email}`
   lookup, reusing the existing `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` credentials
   already configured for the SharePoint/Outlook connectors — no new Graph app registration.
2. Insert (or un-revoke) one `staff_client_assignments` row, recording `granted_by` from the
   acting admin's own resolved identity.
3. Revoke sets `revoked_at`; never deletes the row.

### Teams extension path (documented, not built)

Chosen specifically so Teams becomes "just another BFF" reusing this design's mechanism, not a
parallel auth system:

- **Sign-in:** Teams SSO resolves the caller's own Entra ID `oid` (Bot Framework's standard SSO
  flow — the bot never sees the user's password, only a token it can exchange for identity).
- **Scope resolution:** the bot calls the same `resolveSourceIdsForUser(oid)` and mints the same
  HS256 scope-assertion JWT the web app's BFF does, calling Fastify through the same
  `InternalScopeAuthProvider` — no Fastify-side changes needed when Teams is eventually built.
- **Admin command pattern (Teams' slash-command equivalent):** a Bot Framework messaging
  extension / bot command, e.g. a user typing to the bot:
  ```
  /access grant client=acme-2024 user=jane@firm.com
  ```
  The bot: (1) resolves the caller's own `oid` via Teams SSO, (2) checks the caller is a member of
  the `RAG-Admins` group before executing — the same check the web admin UI performs — (3) calls
  the **same** grant/revoke service function the web admin UI's server actions call (not a
  duplicated implementation), (4) replies with a confirmation message.
- New bot registrations must be **Single-Tenant or User-Assigned Managed Identity** — Microsoft
  deprecated new multi-tenant bot registrations as of 2025-07-31 (per
  `docs/AUTH-AND-SESSIONS-RESEARCH.md`).

## New/changed files

| File                                                      | Purpose                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/lib/auth.ts`                                | Auth.js config — Entra ID provider, session callback exposing `oid` + `groups`                                                                                                       |
| `apps/web/src/app/api/auth/[...nextauth]/route.ts`        | Auth.js route handler (standard Next.js App Router convention)                                                                                                                       |
| `apps/web/src/lib/scope-token.ts`                         | Resolves scope via `resolveSourceIdsForUser`, signs the scope-assertion JWT                                                                                                          |
| `apps/web/src/app/admin/access/page.tsx` + server actions | Admin UI: search/grant/revoke, gated by the `RAG-Admins` group check                                                                                                                 |
| `packages/core/src/internal-scope-auth.ts`                | New `InternalScopeAuthProvider` (verifies HS256 JWT, mirrors `StaticTokenAuthProvider`'s shape)                                                                                      |
| `packages/core/src/auth-provider-factory.ts`              | Add `"internal-scope"` to `AuthProviderConfig`, wire into `composite`                                                                                                                |
| `packages/db/src/queries.ts`                              | Grant/revoke helpers for the admin UI (soft-delete semantics on `staff_client_assignments`)                                                                                          |
| `env.example`                                             | `INTERNAL_SCOPE_JWT_SECRET`, `AUTH_ENTRA_CLIENT_ID`/`AUTH_ENTRA_CLIENT_SECRET`/`AUTH_ENTRA_TENANT_ID` (separate app registration — see Component overview), `RAG_ADMINS_GROUP_CLAIM` |

No new database migration — `staff_client_assignments`, `source_client_assignments`, and
`resolveSourceIdsForUser` already exist exactly as needed.

## Testing

- `InternalScopeAuthProvider`: unit tests mirroring `auth.test.ts`'s existing
  `StaticTokenAuthProvider` coverage — valid token → scoped principal, expired → null, tampered
  signature → null, empty `allowedSourceIds` → deny-all.
- Admin UI server actions: unit tests for grant/revoke logic (soft-delete semantics, `granted_by`
  recorded), extending the existing `queries.access-control.test.ts` pattern.
- E2E: a new spec exercising sign-in → scoped search returns only assigned sources → revoke → same
  user's next search returns nothing (mirrors the existing `governance-taxonomy.spec.ts`/
  `audit-log-parity.spec.ts` style).
- No changes needed to existing Fastify auth tests — `InternalScopeAuthProvider` is additive, not
  a replacement.

## Error handling

Covered under [Fail-closed semantics](#fail-closed-semantics) above. The guiding principle,
consistent with the rest of this codebase's access-control design: every failure mode (missing
session, revoked grant, expired/tampered token) degrades to **zero access**, never to the prior
shared-admin-token behavior.
