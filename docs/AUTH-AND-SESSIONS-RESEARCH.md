# Research: Auth Strategy + Server-Side Chat Sessions

> Supporting research for `CPA-KB-ADOPTION-PLAN.md`. Resolves the two open risks flagged at
> plan hand-off: (1) the PropelAuth → backend bearer-token flow, and (2) the absence of a
> server-side chat session store. Conducted 2026-06-07. All recommendations target the actual
> stack: Fastify API (bearer `API_TOKENS` + scoped `API_PRINCIPALS`, fail-closed
> `AuthorizationScope`), Next.js 15 UI with PropelAuth, Postgres + Drizzle, and Teams + SMS
> channels — under CPA confidentiality (IRC §7216).

---

## Part 1 — Authentication & Authorization

### The core rule

Two non-negotiables drive the whole design:

1. **No backend API token may ever live in browser JavaScript.** `NEXT_PUBLIC_*` env vars ship
   to the client — the Fastify token must be a non-prefixed var read only in server code.
2. **The client must never supply its own `sourceIds`.** Scope must be computed server-side from
   a verified identity, or any user can enumerate every source by crafting requests.

### Decision: Backend-for-Frontend (BFF) proxy — not direct JWT, not token-exchange

Three options were compared:

| Option                                      | What it is                                                                                                                                       | Verdict                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) BFF proxy** in Next.js Route Handlers | Server-side handler reads PropelAuth httpOnly session, computes the user's `sourceIds`, calls Fastify with a server-held `API_PRINCIPALS` token. | **Chosen.** No new service (it's a `route.ts`), Fastify unchanged, the static token never reaches the browser.                                            |
| (b) Validate PropelAuth JWT in Fastify      | Fastify verifies the RS256 access token via JWKS and reads org/role claims.                                                                      | Workable but forces two auth paths in Fastify (JWT for humans, bearer for machines) and couples it to PropelAuth's token format. Keep as a fallback only. |
| (c) Token exchange                          | Exchange PropelAuth identity for a short-lived scoped backend token.                                                                             | Most elegant, most infra. Disproportionate at 20 users.                                                                                                   |

**Why BFF fits:** the Next.js App Router is already the frontend's deployment surface, so the BFF
is just a Route Handler. Fastify's existing `API_PRINCIPALS` model (token + `allowedSourceIds[]`)
maps cleanly — the BFF is one more scoped principal. Machine callers (Teams, SMS) keep their own
scoped principals against Fastify; no backend token-format change.

**PropelAuth specifics:** issues RS256-signed JWT access tokens; verifier metadata at
`https://<auth-url>/api/v1/token_verification_metadata`. In the App Router, read the verified user
server-side via the PropelAuth Next.js SDK (`getUser()`/server helpers) — no manual JWT parsing in
the BFF. If option (b) is ever needed, `nearform/fastify-jwt-jwks` validates signature/`exp`/`iss`
against the JWKS.

### Identity → scope mapping (server-side, fail-closed)

For 20 users a **plain Postgres table is the right answer** — no policy engine (OpenFGA/Cedar/oso)
is warranted yet. Two append-only tables resolve a user to allowed sources:

```sql
-- A document source belongs to one or more CPA clients
CREATE TABLE source_client_assignments (
  source_id uuid REFERENCES sources(id),
  client_id uuid NOT NULL,
  PRIMARY KEY (source_id, client_id)
);
-- Staff are assigned to clients (this IS the access boundary)
CREATE TABLE staff_client_assignments (
  user_id    text NOT NULL,            -- PropelAuth user_id (or AAD UPN for Teams)
  client_id  uuid NOT NULL,
  granted_at timestamptz DEFAULT now(),
  granted_by text NOT NULL,
  revoked_at timestamptz,              -- soft-delete only — never hard-delete (audit trail)
  PRIMARY KEY (user_id, client_id)
);
```

Resolution at request time (returns `[]` → fail-closed deny-all in Fastify):

```sql
SELECT DISTINCT sca.source_id
FROM staff_client_assignments sta
JOIN source_client_assignments sca ON sca.client_id = sta.client_id
WHERE sta.user_id = $1 AND sta.revoked_at IS NULL;
```

Graduate to OpenFGA only if you need document-level (not source-level) perms, partner→report
inheritance, or auditable policy-evaluation logs. **§7216 note:** the mapping is itself a
compliance artifact — keep `granted_by`/`granted_at`, soft-delete with `revoked_at`, so you can
reconstruct "who could see client X on date Y."

### Channel auth

- **Teams (Bot Framework):** establish the user's Entra/AAD identity via Teams SSO; read the stable
  `oid`/`upn` from the AAD token; look up `sourceIds` from the same mapping table; call Fastify
  under a **scoped Teams service principal** (do not impersonate the user). New bots must be
  **Single-Tenant or User-Assigned Managed Identity** — Microsoft deprecated new multi-tenant bot
  registrations as of 2025-07-31.
- **SMS (Twilio) — the hard one:** SMS is **not** an AAL2 channel (NIST SP 800-63-4, finalized
  2025-07); caller ID is spoofable; SIM-swap is live. **Returning client-confidential data over SMS
  is an IRC §7216 exposure.** Therefore: restrict the SMS service principal's `allowedSourceIds` to
  **non-confidential internal sources only** (firm procedures, public deadlines, SOPs); enforce a
  **phone-number allowlist** (`(phone, staff_user_id)`) with a hard rejection for unlisted numbers;
  use **Twilio Verify** OTP for session establishment; instruct the SMS generation path to refuse
  client names/figures; **audit every SMS query**.

### Secrets & session (browser ↔ BFF leg)

- httpOnly, Secure, **SameSite=Strict** cookies (PropelAuth's Next SDK sets these). Never
  `localStorage`/`sessionStorage` (XSS-readable). Add a `__Host-`-prefixed CSRF token for
  state-mutating routes as defense-in-depth.
- BFF → Fastify leg: bearer `API_PRINCIPALS` token in `Authorization`, server-to-server only.
  Rotate without downtime by listing multiple comma-separated tokens, deploy, drop old, redeploy.

### What to avoid

- Any API token in the client bundle; any client-supplied `sourceIds`.
- SMS for anything touching client tax data; SMS endpoint with no allowlist.
- Fail-open scope defaults — missing/empty mapping must be `sourceIds: []`, never `undefined`/`*`.
- Hard-deleting access grants (lose the audit trail).

### Sources (auth)

- PropelAuth access tokens: https://docs.propelauth.com/recipes/access-tokens · authenticated requests: https://docs.propelauth.com/getting-started/making-authenticated-requests
- BFF pattern: https://nextjs.org/docs/app/guides/backend-for-frontend · https://blog.gitguardian.com/stop-leaking-api-keys-the-backend-for-frontend-bff-pattern-explained/
- `fastify-jwt-jwks`: https://github.com/nearform/fastify-jwt-jwks
- Secure Next.js BFF sessions: https://cybersierra.co/blog/secure-nextjs-bff-sessions/
- OpenFGA: https://openfga.dev/docs/authorization-concepts · RAG authz: https://www.couchbase.com/blog/securing-agentic-rag-pipelines/
- Teams SSO: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview
- NIST SP 800-63-4 / SMS: https://www.wwpass.com/blog/phishing-resistant-mfa-in-2025-buyer-s-guide-to-nist-sp-800-63-4-omb-m-22-09/ · Twilio Verify: https://www.twilio.com/docs/verify/developer-best-practices

---

## Part 2 — Server-Side Chat Session Storage

### Decision: roll your own with Drizzle (3 tables) — not Vercel AI SDK persistence, not LangGraph checkpointer

You already have Postgres + Drizzle. The schema below is ~80 lines and addresses every compliance
requirement directly. The two libraries were rejected for this stack:

- **Vercel AI SDK persistence** is coupled to Next.js server actions + `useChat`; awkward on
  Fastify and its schema can't easily carry `channel`/`externalUserId`/`purgedAt`.
- **LangGraph Postgres checkpointer** stores opaque serialized graph state — not SQL-queryable, so
  compliance purge can't be expressed as a simple `UPDATE`. Adopt only if the RAG pipeline is
  already a LangGraph graph (it isn't).

### Schema (Drizzle sketch)

```typescript
export const channelEnum = pgEnum("channel", ["web", "teams", "sms"]);
export const sessionStatusEnum = pgEnum("session_status", [
  "active",
  "archived",
  "deleted",
]);
export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: channelEnum("channel").notNull(),
    externalUserId: varchar("external_user_id", { length: 255 }).notNull(),
    internalUserId: uuid("internal_user_id"),
    title: text("title"),
    status: sessionStatusEnum("status").default("active").notNull(),
    tokenCount: integer("token_count").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    purgedAt: timestamp("purged_at"),
  },
  (t) => ({
    // LEADING composite index — required for RLS + every cross-channel lookup
    principalIdx: index("chat_sessions_principal_idx").on(
      t.channel,
      t.externalUserId,
    ),
  }),
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(), // app-layer AES-256-GCM encrypt before insert
    tokenCount: integer("token_count"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    sessionIdx: index("chat_messages_session_idx").on(t.sessionId, t.createdAt),
  }),
);

export const messageCitations = pgTable("message_citations", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => chatMessages.id, { onDelete: "cascade" }),
  chunkId: uuid("chunk_id").notNull(),
  chunkText: text("chunk_text"), // snapshot at answer time (chunks may be re-chunked)
  sourceLabel: text("source_label"),
  similarityScore: text("similarity_score"),
  rank: integer("rank"),
});

export const chatAuditLog = pgTable("chat_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id"),
  actorId: text("actor_id").notNull(),
  action: varchar("action", { length: 64 }).notNull(), // purge_session, view_session, ...
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Key decisions: **`(channel, external_user_id)` is the composite principal key** (multi-channel
anchor — Teams/SMS resolve a session via one indexed lookup); **normalized messages** (not a JSON
array on the session row) so per-message purge/window/citation queries are cheap; **`purgedAt` +
content-null tombstone** rather than row delete (keeps audit trail, removes regulated data);
**snapshot `chunkText`** in citations so you can reproduce what the assistant said even after
re-chunking.

### Stateful endpoint, not client-passed history

Teams and SMS are stateless webhook receivers — each turn is an independent POST with only a
conversation/From id. They physically cannot hold history. So state must be server-side: add
`POST /sessions/:id/messages` (loads windowed history server-side, runs RAG, persists turns).
Keep the existing stateless `/ask` for the public/embeddable case only. All three channel adapters
become thin identity-resolution shims over one stateful path.

### Multi-turn memory: history-aware query rewrite (do not skip)

A follow-up like "and for 2022?" has near-zero similarity to any chunk — sent raw to pgvector,
retrieval silently fails and the LLM hallucinates from history. Fix with **query condensation**:
`LLM(history + follow-up) → standalone query → embed → pgvector`. Use a small/fast model for the
rewrite. Default memory window = **last 6–8 turns (~1,500–2,500 tokens)**, computed from the stored
per-message `tokenCount` (no re-tokenizing per request). Pipeline:

```
{ sessionId, userMessage }
 → load windowed history (≤~2000 tok)
 → rewrite to standalone query
 → embed → pgvector top-K (existing /ask internals, unchanged)
 → prompt = system + history + chunks + userMessage → answer + citations
 → persist user row, assistant row, citation rows (one transaction, after stream)
```

### Compliance for transcripts (§7216)

- **Purge:** `purgeSession(id)` and `purgeByPrincipal(channel, externalUserId)` null content, set
  `purgedAt`, write an audit row — all in one transaction. Nightly pg-boss sweep for retention
  windows (e.g., 7y for engagement records, 90d for ephemeral threads).
- **Encryption:** layer it — cloud full-disk (free baseline) + `sslmode=no-verify` in transit (not
  `require`: `pg-connection-string` >= 2.10 aliases that to `verify-full`, which fails against
  Railway's self-signed cert. Note `no-verify` encrypts but does **not** validate the server
  certificate, so it does not defend against an on-path attacker — see
  `docs/PLAN-CPA-COMPLIANCE.md` Phase 3) +
  **application-level AES-256-GCM on `chat_messages.content`** (key in env→KMS; keeps plaintext out
  of the DB process; schema stays `text`). Skip `pgcrypto` unless a specific DB-admin threat model
  demands it.
- **RLS:** enable Row-Level Security on `chat_sessions`/`chat_messages` keyed to
  `(channel, external_user_id)` via `set_config('app.current_user_id', …)` per request — DB-level
  backstop even if app code has a bug. Requires the leading composite index (already in schema).
- **Audit:** write to `chat_audit_log` inside the same transaction; log action/actor/ids, **never
  message content**.

### What to avoid

- Messages as a JSON array on the session row; client-passed history for Teams/SMS.
- LangGraph checkpointer / Vercel persistence on this Fastify stack.
- Citations as freeform JSON in `content` (use the normalized table).
- Skipping query-rewrite; missing the `(channel, external_user_id)` leading index; pgcrypto without
  a key-management plan.

### Sources (sessions)

- Vercel AI SDK persistence: https://github.com/vercel-labs/ai-sdk-persistence-db/ · https://vercel.com/blog/ai-sdk-5
- LangChain query transformations / conversational RAG: https://www.langchain.com/blog/query-transformations · https://docs.langchain.com/oss/python/langchain/retrieval
- LangGraph Postgres checkpointer: https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres · https://langgraphjs.guide/persistence/
- Postgres encryption: https://www.postgresql.org/docs/current/encryption-options.html
- Postgres RLS multi-tenant: https://www.crunchydata.com/blog/row-level-security-for-tenants-in-postgres · https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html
