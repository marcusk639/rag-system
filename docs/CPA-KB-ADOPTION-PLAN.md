# CPA Firm Knowledge Base — Adoption & Build Plan

> **Decision (settled 2026-06-07):** Adopt `rag-system` as the foundation. Salvage the
> `cpa-knowledge-base` Next.js UI as a thin chat client. Build thin Teams + SMS adapters
> against the HTTP `/ask` endpoint. Retire `cpa-backend` (harvest Textract only if an eval
> justifies it). Do **not** merge the two backends.
>
> Rationale and the full comparison live in the session that produced this plan. Short
> version: `cpa-backend` runs 8 services but has no working retrieval path (embeddings never
> persisted, chunking never invoked, no search endpoint, no answer generation, broken
> multi-tenancy, zero tests). `rag-system` already does the hard 80% — hybrid RRF retrieval,
> SharePoint/GDrive/Gmail/Outlook connectors, an MCP automation surface, ACL + PII
> sanitization (on a branch), and 316 tests — on fewer moving parts (one Postgres).
>
> **Companion research:** `docs/AUTH-AND-SESSIONS-RESEARCH.md` resolves the two risks flagged at
> hand-off — the PropelAuth→backend auth flow (answer: a **BFF proxy**) and the missing
> server-side chat session store (answer: **3 Drizzle tables**). Those conclusions are folded
> into Phases 1, 5, 6, and 8 below.

This plan is written to be executed **one phase per fresh chat context**. Each phase is
self-contained: it cites exact files/lines to copy from, gives a verification checklist, and
lists anti-patterns to avoid. Do not invent APIs — every endpoint/config name below was
verified against the code on 2026-06-07.

---

## Phase 0 — Discovery consolidation (READ FIRST, do not skip)

### Repos in play

| Repo               | Path                                   | Role                                                                                                                       |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| rag-system         | `/Users/marcus/dev/rag-system`         | **Foundation.** TS monorepo: `apps/{api,mcp,worker}`, `packages/{core,db,ingestion,connectors,rag}`, `services/parser-py`. |
| cpa-knowledge-base | `/Users/marcus/dev/cpa-knowledge-base` | **UI shell to salvage.** Next.js 15.0.3, currently 100% mock data.                                                         |
| cpa-backend        | `/Users/marcus/dev/cpa-backend`        | **To retire.** Vespa/Mongo/Redis/SQS/Textract; incomplete RAG loop.                                                        |

### Allowed APIs (verified — copy these, do not assume others exist)

**HTTP API** (`apps/api/src/routes/`, Fastify + Zod, bearer auth on every route except `/health`,`/ready`):

- `POST /search` → body `{ query: string(1..1000), topK?: 1..100, sourceIds?: UUID[], filter?: Record<string,string|string[]> }` → `{ results: RetrievalResult[] }` — `routes/search.ts:30-57`
- `POST /ask` → body `{ question: string(1..2000), topK?: 1..100, sourceIds?: UUID[], filter? }` → `{ answer, citations: {index,title,url?,documentId}[], retrieved }` — `routes/ask.ts:20-75`
- `GET /documents/:id` → full document — `routes/documents.ts`
- `GET /sources` → `{ sources: {id,kind,name,config(STRIPPED),cursor,...}[] }` — `routes/sources.ts`
- `POST /sources` → body `{ kind: "sharepoint"|"gdrive"|"gmail"|"outlook"|"custom", name, config }` → `201 {id,...}` — `routes/sources.ts:39-44`
- `POST /sources/:id/sync` → body `{ mode: "full"|"incremental" }` → `202 {jobId,ingestionId,mode}` — `routes/sources.ts:46-48`
- Auth: `Authorization: Bearer <token>`, constant-time SHA-256, tokens from `API_TOKENS` (comma-sep) — `apps/api/src/auth.ts:34-66`; public paths `Set(["/health","/ready"])` at `auth.ts:8`.

**MCP tools** (`apps/mcp/src/tools/`, same bearer tokens, HTTP or stdio transport):

- `search_documents` `{query, topK?:1..50, sourceIds?, filter?}` — `tools/search-documents.ts:53-75`
- `ask` `{question, topK?:1..50, sourceIds?, filter?}` — `tools/ask.ts:54-114`
- `get_document` `{documentId: UUID}` — `tools/get-document.ts`
- `list_sources` `{}` — `tools/list-sources.ts:5-37`
- `trigger_sync` `{sourceId: UUID, mode?: "full"|"incremental"}` — `tools/trigger-sync.ts:22-71`
- HTTP transport auth guard — `apps/mcp/src/transports/http.ts:70-79`; `MCP_ALLOWED_ORIGINS` allowlist.

**Config / env** (`packages/core/src/config.ts:75-153`, `env.example`): `DATABASE_URL` (req), `API_TOKENS` (req), `EMBEDDING_PROVIDER` (gemini default, 768d) / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS`, `GEMINI_API_KEY`/`OPENAI_API_KEY`, `PARSER_URL` (default `http://localhost:8000`), `GENERATION_PROVIDER`/`GENERATION_MODEL`, `MCP_TRANSPORT`/`MCP_HTTP_PORT`, MS/Google connector creds, `CHUNK_SIZE`/`CHUNK_OVERLAP`, `HYBRID_DENSE_WEIGHT`/`HYBRID_SPARSE_WEIGHT`. `loadConfig(env)` throws loudly on missing required.

**Access control (ON A BRANCH, NOT main):** worktree `feat-hardening-cpa-blockers`:

- `packages/core/src/access-control.ts` — `parsePrincipalsConfig(raw)` (`:79-137`), `resolvePrincipal`, `principalToScope`, `computeEnforcedSourceIds`, `ADMIN_SCOPE = {enforcedSourceIds:null}` (`:56`), `DENY_ALL_SCOPE = {enforcedSourceIds:[]}` (`:63`).
- `apps/api/src/routes/authz.ts:13-17` — `scopeFromRequest(request)` → `DENY_ALL_SCOPE` fallback.
- Env `API_PRINCIPALS` = JSON `[{ "token": "...", "allowedSourceIds": ["s1","s2"] }]`. **Not in main `config.ts`/`env.example` yet.**
- `packages/core/src/metadata-policy.ts` — PII metadata sanitization (P2), worktree only.
- Tests: `packages/core/src/access-control.test.ts` (multi-tenant isolation pattern at `:64-96`).

### Known issues referenced by this plan (`docs/ISSUES-AND-OPTIMIZATIONS.md`)

- **C1** index-drift: HNSW + tsvector GIN indexes invisible to Drizzle (`:26`) — latent retrieval-killer.
- **C2** parser sidecar has no auth (`:37`) — mitigated by loopback only.
- **H1** no reranking stage (`:46`) — highest-ROI quality upgrade.
- **H2** metadata filter is a full scan (`:57`).
- **H3** no embedding-dimension startup guard (`:62`).
- **P1** no access control (`:228`), **P2** PII flows to callers (`:235`), **P3** §7216 provider agreement, **P4** retention/deletion. §11 roadmap, §12 eval-harness recommendation.
- **Docs are stale**: they list P1/P2 as OPEN, but the worktree implements them. Phase 1 reconciles this.

### Companion research (read before Phases 1, 5, 6, 8)

- `docs/AUTH-AND-SESSIONS-RESEARCH.md` — **Part 1** (BFF auth, identity→scope mapping, Teams/SMS, secrets) and **Part 2** (chat session schema, history-aware retrieval, transcript compliance). Every design choice below traces to it.

### Global anti-patterns (apply to every phase)

- ❌ Do not import `pg`/`drizzle-orm` in apps — go through `@rag/db` typed queries.
- ❌ Do not run a full source sync inside an HTTP request — enqueue via pg-boss.
- ❌ Do not add an endpoint/tool that isn't in the Allowed APIs list above without first reading the route file.
- ❌ Do not put any backend token in browser JS, and never let a client supply its own `sourceIds`.
- ❌ Do not change `EMBEDDING_PROVIDER`/dimensions without re-embedding (Phase 2 adds the guard).
- ❌ Do not put real client data into the system until Phases 1–2 and the P3/P4 gate (Phase 8) are done.

---

## Phase 1 — Land the CPA security blockers on `main` + identity→scope mapping (P1 ACL + P2 PII)

**Why first:** the hard work exists but lives on `feat-hardening-cpa-blockers`. Until it's on
`main` with config + tests wired, the system is read-all-for-any-token — unacceptable for
client-confidential data. This phase also adds the **identity→scope mapping** that every caller
(BFF, Teams, SMS) uses to compute `sourceIds` server-side.

### What to implement (COPY from the worktree, don't re-derive)

1. Merge/cherry-pick `access-control.ts`, `metadata-policy.ts`, `apps/api/src/routes/authz.ts`, and their tests from `feat-hardening-cpa-blockers` into `main`. Copy the multi-tenant test from `access-control.test.ts:64-96` verbatim.
2. Add `API_PRINCIPALS` to the config schema next to `API_TOKENS` (`packages/core/src/config.ts:123-126`) and to `env.example` (after line 40). Parse with `parsePrincipalsConfig`.
3. Confirm `Retriever.search(query, scope)` takes the **mandatory** `AuthorizationScope` and that `/search` + `/ask` derive it via `scopeFromRequest(request)` (copy from `routes/authz.ts:13-17`). Fallback must be `DENY_ALL_SCOPE`, never admin.
4. Thread per-session scope through the MCP **HTTP** transport (`apps/mcp/src/transports/http.ts`); stdio stays `ADMIN_SCOPE` (local trust).
5. Apply `metadata-policy` sanitization at both API and MCP boundaries (mirror `sanitizeSource` at `routes/sources.ts:26`).
6. **Identity→scope mapping** (new, in `@rag/db`): add append-only tables and a resolver query (full sketch in `AUTH-AND-SESSIONS-RESEARCH.md` Part 1):
   - `source_client_assignments(source_id, client_id)` and `staff_client_assignments(user_id, client_id, granted_at, granted_by, revoked_at)`.
   - `resolveSourceIdsForUser(userId)` → `SELECT DISTINCT sca.source_id … WHERE sta.user_id = $1 AND revoked_at IS NULL`. Returns `[]` (→ fail-closed) when unmapped.
   - Soft-delete only (`revoked_at`), never hard-delete — §7216 reconstructibility.

### Documentation references

- Worktree: `/Users/marcus/dev/rag-system/.worktrees/feat-hardening-cpa-blockers/{packages/core/src/access-control.ts, .../metadata-policy.ts, apps/api/src/routes/authz.ts, packages/core/src/access-control.test.ts}`.
- Mapping schema + resolver: `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 1 "Identity → scope mapping".
- Main targets: `apps/api/src/routes/{search,ask}.ts`, `apps/mcp/src/transports/http.ts`, `packages/core/src/config.ts`, `packages/db/src/schema.ts`.

### Verification checklist

- [ ] `pnpm typecheck` and `pnpm test` green on `main`.
- [ ] `grep -rn "DENY_ALL_SCOPE\|scopeFromRequest" apps/api apps/mcp` shows fallback wired in `/search`, `/ask`, MCP HTTP.
- [ ] Integration test: two distinct tokens return disjoint result sets from `/search`.
- [ ] Integration test: a token with `allowedSourceIds: []` gets **zero** results (fail-closed), not all.
- [ ] `/search` response no longer contains `from`/`to`/`subject` metadata for a scoped token (P2).
- [ ] `resolveSourceIdsForUser` returns `[]` for an unmapped user and the correct set for a mapped one (test both).
- [ ] `API_PRINCIPALS` documented in `env.example`; `loadConfig` throws on malformed JSON.

### Anti-pattern guards

- ❌ Do not leave the scope argument optional or default it to admin "for now."
- ❌ Do not enforce ACL only in the route while leaving `hybridSearch` filterable — enforcement must be a mandatory SQL `WHERE`, not a caller-supplied filter (`packages/db/src/queries.ts`).
- ❌ Do not hard-delete access grants; soft-delete with `revoked_at`.
- ❌ Do not merge the worktree wholesale without re-running the full suite; reconcile stale `ISSUES-AND-OPTIMIZATIONS.md` (flip P1/P2 to DONE).

---

## Phase 2 — Close latent breakage (C1 index-drift, H3 dim-guard, C2 parser auth)

**Why:** silent foot-guns that corrupt retrieval or waste embedding spend with no error. Cheap to
fix, expensive to discover in production.

### What to implement

1. **C1** — Make the HNSW + GIN indexes visible to Drizzle so `drizzle-kit generate` can't `DROP` them. Either declare them in `pgTable` index definitions or add a guard test that asserts both exist after `db:migrate`. Reference hand-authored SQL at `packages/db/drizzle/0000_init.sql:97-102`.
2. **H3** — Add a startup assertion (in `loadConfig` or DB bootstrap) that `EMBEDDING_DIMENSIONS` matches the `chunks.embedding vector(N)` column; throw before spending embedding credits. Schema at `packages/db/src/schema.ts`.
3. **C2** — Add a shared-secret header check to the parser sidecar (`services/parser-py/app/main.py:107`) and send it from `parser-client.ts`. Keep loopback binding as defense-in-depth.

### Verification checklist

- [ ] Test asserts `pg_indexes` contains the HNSW and GIN index names after migrate (C1).
- [ ] Booting api/worker with mismatched `EMBEDDING_DIMENSIONS` throws a clear error before any insert (H3).
- [ ] Parser rejects an unauthenticated request with 401; pipeline works with the secret set (C2).
- [ ] `pnpm test` green.

### Anti-pattern guards

- ❌ Do not "fix" C1 by re-creating indexes in app code at runtime — they belong in migrations.
- ❌ Do not silently coerce dimension mismatches — fail loudly.

---

## Phase 3 — Retrieval evaluation harness (§12) — measure before tuning

**Why:** Phase 4 (reranking) and any chunking/weight changes must be measured, not guessed.

### What to implement

1. Harness with **30–50 representative CPA-firm questions** + known-relevant document ids, scored on **recall@k** and **nDCG@k**. Synthetic/public docs only at this stage (no client data — Phase 8 gates that).
2. Baseline run against `/search`; record default weights (`HYBRID_DENSE_WEIGHT=0.7`, `HYBRID_SPARSE_WEIGHT=0.3`).
3. Wire as `pnpm eval`; record numbers in `docs/EVAL-BASELINE.md`.

### Documentation references

- `docs/ISSUES-AND-OPTIMIZATIONS.md:369-371` (§12). Retrieval impl: `packages/db/src/queries.ts:179-350`, `packages/rag/src/retrieval/retriever.ts:29-44`.

### Verification checklist

- [ ] `pnpm eval` prints recall@k and nDCG@k for the baseline; fixture committed; stable on re-run.

### Anti-pattern guards

- ❌ Do not tune weights or add reranking before a baseline exists.
- ❌ Do not let questions trivially leak their answer docs.

---

## Phase 4 — Reranking (H1), gated by Phase 3

**Why:** highest-ROI quality upgrade — but only ship it if the eval shows a real gain.

### What to implement

1. Add a rerank stage after RRF in `packages/rag/src/retrieval/retriever.ts:29-44` (candidate pool already over-fetches 8×). Cross-encoder or provider rerank API behind the factory pattern (`packages/rag/src/embeddings/factory.ts:16-45`).
2. Re-run `pnpm eval`; ship only if nDCG@k improves materially; record in `EVAL-BASELINE.md`.

### Verification checklist

- [ ] `pnpm eval` shows improved nDCG@k vs baseline; rerank is config-gated; latency impact recorded; `pnpm test` green.

### Anti-pattern guards

- ❌ Do not add reranking with no measured improvement — revert if flat.
- ❌ Do not hardcode a provider — use the factory pattern.

---

## Phase 5 — Server-side chat session storage (multi-channel)

**Why:** the system is stateless today, and Teams + SMS are stateless webhook receivers that
**cannot** hold conversation history — so state must live server-side, shared across all three
channels. This phase is a prerequisite for the web client (Phase 6) and channels (Phase 7).
Full design + schema in `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 2.

### What to implement (COPY the schema from the research doc)

1. **Three Drizzle tables** in `@rag/db` (+ an audit table): `chat_sessions` (with **leading composite index `(channel, external_user_id)`**), `chat_messages` (normalized rows, not a JSON array), `message_citations` (normalized; snapshot `chunkText` at answer time), `chat_audit_log`. Copy the Drizzle sketch from the research doc verbatim.
2. **Stateful endpoints** (new; keep stateless `/ask` for the public/embeddable case): `POST /sessions`, `GET /sessions/:id/messages`, `POST /sessions/:id/messages`, `DELETE /sessions/:id` (soft), `DELETE /sessions/:id/purge` (hard, §7216), `GET /users/:principalId/sessions`. Each call carries the same `AuthorizationScope` from Phase 1.
3. **History-aware retrieval** in `POST /sessions/:id/messages`: load a windowed history (last 6–8 turns / ~2000 tokens via stored `tokenCount`), run a **query-rewrite/condense** step (small model) → standalone query → existing `/ask` retrieval internals unchanged → persist user row, assistant row, citation rows in one transaction after the stream.
4. `chatRepository.ts`: `createSession`, `appendMessage`, `loadWindow`, `purgeSession`, `purgeByPrincipal`, `listSessionsForPrincipal`.

### Documentation references

- `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 2 (schema, pipeline, purge functions, RLS, encryption).
- Existing retrieval internals to reuse: `apps/api/src/routes/ask.ts:20-75`, `packages/rag/src/retrieval/retriever.ts`.

### Verification checklist

- [ ] A web turn and a Teams turn for the same person resolve via `(channel, external_user_id)` — verify the index is used (`EXPLAIN`).
- [ ] Follow-up question ("and for 2022?") is rewritten to a standalone query before retrieval (assert the rewrite step ran).
- [ ] `purgeSession` nulls content, sets `purgedAt`, writes an audit row — all in one transaction (test).
- [ ] A session is only readable by its own principal (RLS or scope check enforced).
- [ ] `pnpm test` green.

### Anti-pattern guards

- ❌ Do not embed messages as a JSON array on the session row.
- ❌ Do not pass history from Teams/SMS clients — they can't hold it; load it server-side.
- ❌ Do not skip the query-rewrite step (raw follow-ups retrieve nothing and the LLM hallucinates).
- ❌ Do not adopt the LangGraph checkpointer or Vercel AI SDK persistence here — roll-your-own Drizzle is the proportionate, SQL-purgeable choice.

---

## Phase 6 — Thin web chat client via BFF (salvage `cpa-knowledge-base` UI)

**Why:** the UI is the one reusable asset. Repoint it at the real API through a **Backend-for-
Frontend** so no backend token reaches the browser and `sourceIds` are computed server-side from
the verified PropelAuth user. This is the resolution of the hand-off auth risk.
See `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 1.

### What to implement

1. **BFF Route Handlers** in the Next.js app (`src/app/api/ask/route.ts`, `.../search/route.ts`, `.../sessions/...`): read the verified user from the PropelAuth server SDK (httpOnly session, no manual JWT parsing), call `resolveSourceIdsForUser(user.userId)` (Phase 1), then call Fastify with the **server-held** `API_PRINCIPALS` token (non-`NEXT_PUBLIC_` env var) and the computed `sourceIds`. The browser calls only the BFF, never Fastify.
2. **Modify `src/hooks/use-documents.tsx:6-49`** — replace the hardcoded array (`:11-42`) with a `useEffect` + `fetch('/api/...')` to the BFF; preserve the return shape `{ documents, selectedDocument, setSelectedDocument }`.
3. **Modify `src/hooks/use-chat-sessions.tsx:6-86`** — back it with the Phase 5 `/sessions` endpoints via the BFF; preserve the return shape.
4. **Modify `src/components/knowledge-base/knowledge-base.tsx:107`** — replace `onSendMessage={() => {}}` with a handler that appends the user `Message`, POSTs to the BFF (`selectedDocument` → server-side `sourceIds`/`filter`), then appends the assistant answer + citations. Add a try/catch error state (the UI has none today).
5. **Env:** `.env.local.example` with the **non-public** Fastify base URL + the BFF service token; never a `NEXT_PUBLIC_` token.

### Documentation references

- UI wiring points: `use-documents.tsx:11-42`, `use-chat-sessions.tsx:7-36`, `knowledge-base.tsx:107`, `chat-interface.tsx:21-29` (send), `:36-53` (render). Types: `src/types/{chat,document}.ts`. Auth: `src/app/page.tsx:6-7`.
- BFF pattern + secret handling: `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 1 ("Decision: BFF", "Secrets & session").

### Verification checklist

- [ ] `grep -rn "Q4 Tax Planning Guide\|onSendMessage={() => {}}" src/` returns nothing (mocks + no-op gone).
- [ ] No backend token in the client bundle: `grep -rn "NEXT_PUBLIC_.*TOKEN\|Bearer" src/` shows none in client code; token only in Route Handlers.
- [ ] Sending a message round-trips through the BFF to `POST /ask` (or `/sessions/:id/messages`) and renders answer + citations.
- [ ] A user with no client assignments gets an empty/"no accessible documents" result (fail-closed), not another user's data.
- [ ] A failed/timed-out call shows an error state.

### Anti-pattern guards

- ❌ Do not add axios/swr/react-query — native `fetch()` to the BFF is sufficient.
- ❌ Do not change the `Message`/`ChatSession`/`Document` type shapes.
- ❌ Do not call Fastify directly from browser code or pass browser-supplied `sourceIds`.

---

## Phase 7 — Teams + SMS adapters (thin, identity-scoped, against the API)

**Why:** the actual delivery channels. Both are stateless adapters that resolve the caller's
identity → `sourceIds`, then call the API under a **scoped service principal**. Neither repo has
any Teams/Twilio/webhook code today (verified by grep). See research Part 1.

### What to implement

1. **Teams** (Bot Framework, **Single-Tenant or User-Assigned Managed Identity** — multi-tenant bot registration deprecated 2025-07-31): establish the user's Entra/AAD identity via Teams SSO, read stable `oid`/`upn`, map to `sourceIds` (Phase 1), call `POST /sessions/:id/messages` (or `/ask`) under a **scoped Teams `API_PRINCIPALS` token** — do not impersonate the user. Reply with `answer` + citation links.
2. **SMS** (Twilio) — **restricted channel**: service principal's `allowedSourceIds` limited to **non-confidential internal sources only** (firm procedures, public deadlines, SOPs — never client engagement data); **phone-number allowlist** `(phone, staff_user_id)` with hard rejection for unlisted numbers; **Twilio Verify** OTP for session establishment; SMS generation path instructed to refuse client names/figures; **audit every query**.
3. Both map `(channel, conversationId|From)` → a Phase 5 session; stateless otherwise (one question → one grounded answer for MVP).

### Documentation references

- Integration point: `apps/api/src/routes/ask.ts:20-75` (minimal body `{ "question": string }`) and Phase 5 `/sessions/:id/messages`. Auth: `apps/api/src/auth.ts:34-66`.
- Channel auth + SMS restriction rationale (NIST SP 800-63-4, §7216): `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 1 ("Channel auth").

### Verification checklist

- [ ] A Teams message round-trips to a grounded, ACL-scoped answer with ≥1 citation.
- [ ] An inbound SMS from an allowlisted number returns a non-confidential answer; an unlisted number is hard-rejected.
- [ ] The SMS principal **cannot** retrieve any client-engagement source (test it returns nothing for such a query).
- [ ] Adapters have no direct DB/MCP access — API only; each uses a scoped (not admin) token.

### Anti-pattern guards

- ❌ Do not return client-confidential data over SMS (IRC §7216 + NIST AAL2 failure).
- ❌ Do not give adapters an admin `API_TOKENS` token or direct Postgres access.
- ❌ Do not register a new multi-tenant Teams bot.

---

## Phase 8 — Compliance gate + transcript protection + operator UX (P3 §7216, P4 retention, OPT-E)

**Why:** the go/no-go gate before any **real client data** enters the system, plus transcript
encryption/RLS and the non-developer operator experience (Marcus operates this).

### What to implement

1. **P3 (decision, then code):** confirm a data-processing agreement with the embedding/LLM provider **or** switch to self-hosted embeddings before client tax data flows out. Record the decision in `docs/`.
2. **P4 (deletion/retention):** `DELETE /sources/:id` + `purgeSource` (documents + chunks + jobs); plus the Phase 5 `purgeSession`/`purgeByPrincipal` for transcripts. Nightly pg-boss retention sweep. Documented retention policy.
3. **Transcript protection** (research Part 2): application-level **AES-256-GCM on `chat_messages.content`** (key in env→KMS), `sslmode=no-verify` (not `require`, and it does not authenticate the server — see `docs/PLAN-CPA-COMPLIANCE.md` Phase 3), cloud full-disk encryption baseline, and **RLS** on `chat_sessions`/`chat_messages` keyed to `(channel, external_user_id)`.
4. **OPT-E (operator UX):** config validation + "test connection" before first sync; an ingestion status view (`GET /sources/:id/status`); per-source credentials if onboarding multiple client tenants (`OPT-E4`).

### Documentation references

- `docs/ISSUES-AND-OPTIMIZATIONS.md` §9 (P1–P4, `:224-260`), §11, OPT-E.
- Transcript encryption/RLS/purge: `docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 2 ("Compliance for transcripts").
- Engagement constraints: `/Users/marcus/dev/cpa-consulting/CLAUDE.md` (IRC §7216, Circular 230 §10.22).

### Verification checklist

- [ ] §7216 decision documented; DPA reference recorded if external provider.
- [ ] `DELETE /sources/:id` removes all documents/chunks/jobs; `purgeByPrincipal` nulls all of a user's transcript content (test both).
- [ ] `chat_messages.content` is ciphertext at rest; RLS blocks cross-principal transcript reads.
- [ ] Operator can create a source and run a sync without hand-editing JSON.
- [ ] Only after this gate passes: first real-client source ingested.

### Anti-pattern guards

- ❌ Do not ingest real client data before P3 is resolved and P4 deletion works.
- ❌ Do not store transcripts unencrypted or without RLS.
- ❌ Do not skip per-source credentials for separate client Microsoft tenants (`OPT-E4`).

---

## Phase 9 — Decommission & final verification

### What to do

1. Archive `cpa-backend` and the mock `cpa-knowledge-base` branch to a reference tag; stop running the Vespa/Mongo/Redis/SQS stack.
2. Confirm the live system is: Postgres(+pgvector) + parser sidecar + api + mcp + worker + the BFF/UI + Teams/SMS adapters.

### Final verification checklist

- [ ] `pnpm typecheck && pnpm test` green across the workspace.
- [ ] `grep -rn "enforcedSourceIds" apps/api apps/mcp` confirms ACL on every retrieval path.
- [ ] End-to-end: ingest a SharePoint source → ask via web UI, Teams, and SMS → all return grounded, cited, ACL-scoped answers (SMS only on non-confidential sources).
- [ ] `pnpm eval` numbers meet the Phase 3/4 bar.
- [ ] `ISSUES-AND-OPTIMIZATIONS.md` updated: C1, C2, H1, H3, P1, P2, P4 resolved; remaining items reprioritized.
- [ ] No process still depends on `cpa-backend`.

---

## Execution order summary

| Phase | Goal                                                    | Gates                                           |
| ----- | ------------------------------------------------------- | ----------------------------------------------- |
| 0     | Discovery consolidation                                 | —                                               |
| 1     | Land ACL + PII on `main` + identity→scope mapping       | blocks real data                                |
| 2     | Close latent breakage (C1/H3/C2)                        | blocks prod                                     |
| 3     | Eval harness baseline                                   | blocks Phase 4                                  |
| 4     | Reranking (if eval justifies)                           | measured                                        |
| 5     | Server-side chat session storage (multi-channel)        | blocks Phases 6–7                               |
| 6     | Thin web client via BFF                                 | needs Phases 1 + 5                              |
| 7     | Teams + SMS adapters (scoped)                           | needs Phases 1 + 5; SMS = non-confidential only |
| 8     | §7216 + retention + transcript encryption + operator UX | **blocks real client data**                     |
| 9     | Decommission + final verification                       | —                                               |

Phases 1–2 are prerequisites for everything. Phase 3 precedes 4. Phase 5 precedes 6 and 7. Phases
6 and 7 can run in parallel once 1 and 5 land. Phase 8 is the hard gate before any real client
engagement data.
