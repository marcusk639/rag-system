# rag-system — Pre-Launch Hardening & Gap-Closure Plan

_Authored: 2026-06-21 · Target repo: `/Users/marcus/dev/rag-system` @ HEAD `7b70b59` · Source of gaps: `docs/app-comparison-2026-06-21.md`, verified against current code + `docs/CPA-COMPLIANCE-REQUIREMENTS.md` (control matrix CR-1…CR-20)._

> **How to use this plan.** Each phase is self-contained and executable in a fresh chat context. Every task is framed to **copy an existing in-repo pattern** at a cited `file:line`, not to invent APIs. Do Phase 0 first (it's a read-only context primer), then work the **PRE-LAUNCH** phases in order. **POST-LAUNCH** and **CAN-WAIT** phases can be scheduled after the pilot gate.
>
> **Prioritization authority:** the firm's own tiering in `CPA-COMPLIANCE-REQUIREMENTS.md:57-69` (Mandatory-before-real-data / Within-90-days / Nice-to-have), reconciled with the comparison doc's "blocking" labels. Where they disagree it is called out inline.

---

## What is ALREADY DONE (verified — do NOT rebuild)

These were flagged as gaps historically but are present in current code. Confirm only; do not redo.

- **Mandatory per-principal ACL**, required non-optional arg, fail-closed, injection-safe (`packages/core/src/access-control.ts:42`; `packages/db/src/queries.ts:300,335-337,371-377,483`). _Caveat:_ per-**source** granularity only, env-driven store, and **admin-by-default for un-scoped tokens** — hardened in Phase 5, not rebuilt.
- **Constant-time token auth + fail-closed + OIDC** (`packages/core/src/auth.ts:21-47`; `apps/api/src/auth.ts:57-63`; `oidc-auth.ts:144-153`).
- **Gemini query/doc task-type fix** — query=`RETRIEVAL_QUERY`, doc=`RETRIEVAL_DOCUMENT` (`packages/rag/src/embeddings/gemini.ts:48-58,80`). Comparison item #9 = DONE.
- **No committed secrets / `.env`**; Zod-validated config; connector `config` blobs stripped via `toPublicSource` (`packages/db/src/queries.ts:595-598`).
- **Eval harness** (recall@k / precision@k / nDCG@k / MRR), unit-tested (`tests/e2e/src/eval/metrics.ts`). _Corpus is synthetic_ — replaced in Phase 12.
- **Web chat + sources are really wired** through a server-side BFF that injects the bearer token (`apps/web/src/app/api/chat/route.ts`, `lib/stream-chat.ts`, `api/sources/route.ts`); citations render (`chat-interface.tsx:90-103`). _Upload + session persistence + a11y_ are not — Phase 14.

---

## Phase 0 — Documentation Discovery & Allowed In-Repo Patterns (READ-ONLY)

**Goal:** prime any executing context with the exact APIs/patterns to copy, and the anti-patterns to avoid. No code changes.

### Allowed APIs / patterns (cite these; do not invent)

- **Embedding provider contract:** `EmbeddingProvider` interface — `packages/core/src/interfaces.ts:13-37` (`name`, `model`, `dimensions`, `embed`, `embedBatch`, optional `embedQuery`). `Embedding` shape: `{ vector:number[]; provider; model; dimensions }` (`gemini.ts:94-99`). Provider factory add-recipe: `packages/rag/src/embeddings/factory.ts:11-15,42-46`.
- **Drizzle table + migration:** copy `ingestionJobs` table shape (`packages/db/src/schema.ts:207-236`); migration mechanics + journal rules `packages/db/src/migrate.ts` (warning at `:63-68` — additive changes go through `drizzle-kit generate`, not hand-added `0000`-style SQL). FK cascade already hard-deletes chunks+vectors (`schema.ts:88,144,162`).
- **pg-boss job:** name/payload `packages/ingestion/src/queue.ts:9-32`; enqueue `queue.ts:92-110`; queue bootstrap loop `queue.ts:71-73`; consumer registration `apps/worker/src/main.ts:53-67`; handler analog `apps/worker/src/handlers/sync-source.ts`. (Recurring cron via `boss.schedule()` is **net-new** — no existing call.)
- **Mandatory-filter SQL injection point:** `enforcedSourceFilter` `sql.join(... ::uuid)` at `packages/db/src/queries.ts:365-390,483` — copy this to AND in any new always-on predicate (class guard, doc-ACL).
- **Combined row-delete + blob cleanup:** `packages/ingestion/src/pipeline.ts:154-179` (tombstone path) + `queries.ts:219` `deleteDocumentByExternalId` (returns `{deleted, storageKey}`).
- **Service retrieval choke point** (single place all queries pass): `packages/services/src/ask.ts:71` `ask()` / `:133` `askStream()`; search-only `search.ts:26`. HTTP entries `apps/api/src/routes/ask.ts:34,53`, `search.ts:27`; MCP `apps/mcp/src/tools/ask.ts:67`.
- **Reranker / query-rewrite / token-budget seams:** `packages/rag/src/retrieval/retriever.ts:51` (pre-embed) and `:60-70` (post-`hybridSearch`, pre-return); generation prompt build `packages/rag/src/generation/generator.ts:67-86`.
- **Fastify plugin registration:** `apps/api/src/server.ts:46` (after error handler) `:54` (auth hook) `:73-76` (routes); exempt `/health` `/ready` (`server.ts:56-70`). MCP is **Express** (`apps/mcp/src/transports/http.ts:2,113,118-123`) — use Express middleware there.
- **CI setup block to reuse:** `.github/workflows/e2e.yml:62-78` (pnpm/action-setup@v4, setup-node@22, frozen-lockfile).
- **Config schema + fail-loud validation:** `packages/core/src/config.ts` (embedding enum `:15`, loader `:257`); principal parser `access-control.ts:79-137`.

### Anti-pattern guards (do NOT do)

- Do **not** describe/move the ACL filter "into the ANN CTE" — it is deliberately a post-fusion `SELECT` filter to preserve HNSW/GIN index usage (`queries.ts:347-352,461-462`). Keep that placement.
- Do **not** hand-add numbered SQL to `drizzle/meta/_journal.json` (`migrate.ts:63-68`).
- Do **not** assume `pnpm lint` works — **no sub-package defines a `lint` script** and there is no ESLint config (Phase 9 must add them first).
- Do **not** add an embedding `baseUrl` by overloading `apiKey` — the embedding config object has **no endpoint field** (`config.ts:14-24`); add one explicitly.
- Do **not** invent a data-class taxonomy in the schema without reconciling it with `cpa-consulting/docs/rag/compliance-scope.md` (the 4-class A/B/C/D model lives there, **not** in this repo's docs — see Phase 5 note).
- Self-hosted embeddings must emit **768-d** vectors (matches `chunks.embedding`; startup guard `apps/api/src/main.ts:20`).

**Verification of Phase 0:** the executor can cite each pattern location above before writing code in later phases.

---

# PRE-LAUNCH (blocking — required before real firm/client data)

## Phase 1 — §7216 architecture: build the self-host path (embeddings **and** generation) + egress guard (CR-1, CR-4) ⛔ TOP GATE

**Why first:** `CR-1` is "the one decision that gates everything" (`CPA-COMPLIANCE-REQUIREMENTS.md:7`). TRI must never reach an external embedding/LLM API. Today `EMBEDDING_PROVIDER=local` throws (`factory.ts:42-46`), the generator enum is `gemini|openai` only (no self-host — `generator.ts:195-206`), and there is no egress control.

**Chosen direction (decided 2026-06-21):** build a **fully self-hostable path for BOTH embeddings and generation** so the firm can flip to zero-external-disclosure when needed (and unblock Class C/D later). **Operationally, continue using the enterprise cloud LLM for now** — but only for **Class A/B** data, behind a DPA/no-train + US-region posture, with the egress guard enforcing that **Class C/D never touches a cloud provider**. The self-host providers ship "ready and tested" even while cloud remains the default runtime selection.

**What to implement:**

1. **`LocalEmbeddingProvider`** — new `packages/rag/src/embeddings/local.ts`. Copy the class skeleton from `openai.ts:14-75` (simplest provider, no asymmetric task-type), swap the client for `fetch(\`${baseUrl}/v1/embeddings\`)`(Ollama OpenAI-compatible) or`/api/embeddings`. Implement `name/model/dimensions(=768)/embed/embedBatch`. Wrap calls in `retryOnRateLimit` (`retry.ts`). Return the exact `Embedding` object.
2. **`LocalGenerator` (self-hosted generation)** — new `packages/rag/src/generation/local.ts`. Copy the `OpenAIGenerator` shape from `generator.ts` (the `Generator` interface + `GenerationResult {answer, citations}`, prompt build `:67-86`, `buildCitations`, `SYSTEM_PROMPT` `:48-65`), pointing at a self-hosted OpenAI-compatible chat endpoint (Ollama / vLLM). Add `"local"` to the generation enum and to `createGenerator` (`generator.ts:195-206`). Keep streaming parity with the cloud generators.
3. **Config endpoint fields** — add `baseUrl` to the embedding Zod object (`config.ts:14-24`, loader `:292-299`) **and** a generation `baseUrl` (loader `:336`). Keep `EMBEDDING_PROVIDER`/`GENERATION_PROVIDER` defaulting to the **enterprise cloud** selection for now; `local` becomes a tested, switch-on option.
4. **Wire factories** — replace the throw at `factory.ts:42` with `return new LocalEmbeddingProvider(cfg)`; add the `local` case to `createGenerator`.
5. **Egress TRI pre-flight guard** (`CPA-KB-IMPLEMENTATION-SPEC.md:110`) — new module (greenfield; place in `@rag/core` next to `metadata-policy.ts`) that scans outbound embedding/generation payloads for SSN/EIN/named-taxpayer patterns and **blocks external send** whenever the provider is a cloud one. Startup assertion: **if any Class C/D source exists, BOTH embedding and generation providers MUST be `local`/self-hosted** (refuse to boot otherwise). For Class A/B, cloud is permitted.
6. **Cloud-now guardrails (CR-4)** — for the enterprise cloud LLM used today: pin US-region endpoints (CR-3), assert a signed DPA/no-train acknowledgment is on file before a cloud key activates (CR-2 config gate, mirrors `parsePrincipalsConfig` fail-loud style), and block provider telemetry egress. These let cloud run safely for Class A/B in the interim.

**Doc references:** `interfaces.ts:13-37`, `factory.ts:11-15,42`, `openai.ts:14-75`, `generator.ts:45-58,67-86,195-206`, `config.ts:14-24,257,336`, `metadata-policy.ts` (output-side allowlist to mirror, not reuse), `CPA-KB-IMPLEMENTATION-SPEC.md:110,229`.

**Verification checklist:**

- [ ] `EMBEDDING_PROVIDER=local EMBEDDING_BASE_URL=… pnpm -C apps/api dev` boots; dimension guard passes (768-d).
- [ ] `GENERATION_PROVIDER=local` produces a grounded, cited answer with streaming parity (eval/manual).
- [ ] Default (cloud) config still works for Class A/B; an `/ask` returns a cited answer.
- [ ] Automated egress test: with a Class C/D source present and any **cloud** provider selected, the app **refuses to boot** (CR-1); with `local` for both, it boots.
- [ ] Cloud key is rejected at startup when the §7216/DPA acknowledgment file is missing/expired (CR-2 gate).
- [ ] `grep -rn 'not yet implemented' packages/rag/src` returns nothing.
- [ ] Unit test for the TRI scanner: SSN/EIN sample → blocked on cloud path; clean SOP text → allowed.

**Anti-pattern guards:** don't reuse `apiKey` for the URL (add explicit `baseUrl` fields); don't let the scanner only redact output (that's `metadata-policy.ts`'s job) — it must block **input/egress**; don't let Class C/D fall back to cloud under any provider-error path (fail closed, never silently downgrade). **[COUNSEL]** the DPA/no-train + §7216 acknowledgment terms (CR-2/3/4) before relying on the cloud generation path even for Class A/B.

---

## Phase 2 — Data retention & secure purge (CR-18) ⛔

**Why:** Mandatory tier (`:61`). No `retain_until`, no purge job, no `DELETE /sources/:id` today (all ABSENT).

**What to implement:**

1. **Schema:** add `retain_until timestamptz NULL` to `documents` (and optionally a default policy per source type on `sources`). Copy the table/column + index style from `schema.ts:207-236`; generate the migration via `drizzle-kit generate` (follow `0001_*`/`0002_*` precedent).
2. **Purge job:** add `rag.purge_expired` to `JOB_NAMES` (`queue.ts:9-11`) + payload; add the queue to the bootstrap loop (`queue.ts:71-73`); register a `boss.schedule('rag.purge_expired', '<cron>')` (net-new — pg-boss v10 supports it) in worker bootstrap; implement a handler modeled on `handlers/sync-source.ts` that selects `documents` past `retain_until` and calls `deleteDocumentByExternalId` (cascade removes chunks **and** embedding vectors) then `objectStore.delete(storageKey)` — exactly the tombstone pattern at `pipeline.ts:154-179`. Log every purge.
3. **`DELETE /sources/:id`:** add route in `apps/api/src/routes/sources.ts` + service `deleteSource` in `packages/services/src/sources.ts` (mirrors `triggerSync` shape) — cascade delete + blob cleanup. Scope-guard with the existing `scopeFromRequest`.

**Verification checklist:**

- [ ] Test: insert a document with `retain_until` in the past → run purge → row, its chunks, its embedding, and its S3 blob are all gone (pgvector spot-check + object-store check).
- [ ] Purge writes a structured log line per deletion (feeds Phase 3/8).
- [ ] `DELETE /sources/:id` returns 404 for out-of-scope principals (no existence leak).

**Anti-pattern guards:** rely on FK cascade for chunks/vectors (don't hand-delete chunks separately); don't soft-delete (CR-18 requires **hard** delete + vector removal).

---

## Phase 3 — Retrieval/answer audit log (CR-10, in-code portion) + thread `Principal` ⛔ (in-code) / 90-day (off-host shipping)

**Why:** The audit log "is the Circular 230 defense" (rubric) and is prerequisite for CR-13 "reviewed by" records. The **in-code structured record** is treated pre-launch; **off-host shipping + anomaly alerts** are 90-day (Phase 8), per `:63-64`.

**What to implement:**

1. **`audit_log` table** (copy `ingestionJobs` shape): `id`, `user_id`, `ts`, `query_text` (or hash — decide with counsel), `source_ids[]`, `retrieved_chunk_ids[]`, `retrieved_document_ids[]`, `answer_text`, `model`, `model_version`, `tool_call_id`, `channel` (api/mcp/web). Migration via `drizzle-kit generate`.
2. **Thread `Principal` to the service layer.** Today services receive only `AuthorizationScope` (no stable user id) (`authz.ts:13`; `access-control.ts:40,50`). Extend `ask()`/`askStream()`/`searchDocuments()` signatures to accept the `Principal` (or a `principalId`) and pass from each transport: `apps/api/src/routes/ask.ts:34,53`, `search.ts:27`, `apps/mcp/src/tools/ask.ts:67`.
3. **Emit one audit record** at the choke point (`packages/services/src/ask.ts:71,133`) after retrieval+generation, capturing the field set above.

**Verification checklist:**

- [ ] One `/ask`, one `/search`, one MCP `ask` each produce exactly one `audit_log` row with non-null `user_id` and populated chunk/document ID arrays.
- [ ] `grep` shows no answer/query logging via `console.*`; only the structured table + pino.
- [ ] Existing tests still pass after signature changes (`pnpm test`).

**Anti-pattern guards:** don't log secrets/raw connector config; don't block the response on audit-write failure (write async but alert on failure); confirm with counsel whether to store verbatim query vs hash.

---

## Phase 4 — Human-in-the-loop disclaimer & draft labeling (CR-13, CR-14) ⛔

**Why:** Mandatory tier (`:61`); both ABSENT. Circular 230 §10.22/§10.35.

**What to implement:**

1. Add a non-optional `disclaimer` / `reviewStatus: "draft_requires_practitioner_review"` field to `GenerationResult` (`generator.ts:33-46`) and `AskResult` (`services/ask.ts:38-42`), and include it in the SSE `done` payload (`apps/api/src/routes/ask.ts`).
2. Render a **non-dismissible** banner on every assistant answer in `apps/web/src/components/chat-interface/chat-interface.tsx:80-104` (and any MCP/Teams adapter response text).
3. No direct client→AI path: keep answers labeled "Draft — requires practitioner review" (CR-14); a review-queue/"reviewed by [CPA]" record can reference the Phase-3 `audit_log`.

**Verification checklist:**

- [ ] UI test: every assistant message shows the disclaimer; it cannot be dismissed.
- [ ] API/MCP responses carry the `reviewStatus`/`disclaimer` field.
- [ ] `grep -rn 'disclaimer\|requires practitioner review' apps packages` now returns matches in generator, service, and UI.

**Anti-pattern guards:** disclaimer must be server-sourced (not a UI-only string a client can strip); make it a typed field, not free text in the answer body.

---

## Phase 5 — RBAC hardening + data-class enforcement (CR-5) ⛔

**Why:** CR-5 mandatory. Two real residual risks: (a) **un-scoped tokens default to admin/all-corpus** (`access-control.ts:24-31,161-163`; `env.example:70` ships an unrestricted `dev-token-change-me`); (b) **no data-class separation** — Phase 1 is supposed to be Class A+B only.

**What to implement:**

1. **Remove admin-by-default.** Make scoping mandatory: an `API_PRINCIPALS`/OIDC token with no mapped sources resolves to **deny-all**, not admin. Admin must be explicit (`isAdmin:true`) in `parsePrincipalsConfig` (`access-control.ts:79-137`). Update `env.example` to a scoped example.
2. **Data-class field + guards.** Add `data_class` enum (`A|B|C|D`) to `sources` (`schema.ts:50`). Ingestion refusal: gate in `pipeline.ts:221` `ingestOne` before `upsertDocument` — refuse to index a doc whose class isn't permitted for the target index/phase (Phase 1 ⇒ only A/B). Cross-class query guard: extend `Principal`/`AuthorizationScope` (`access-control.ts:40,50`) with allowed-classes and AND a class predicate at the proven injection point `queries.ts:365-390`.

> **Reconciliation note:** the 4-class A/B/C/D model is defined in `cpa-consulting/docs/rag/compliance-scope.md`, **not** in this repo's docs (which list "formal data-class taxonomy" as deferred, `CPA-COMPLIANCE-REQUIREMENTS.md:68`). Treat the binding contract as `compliance-scope.md`. Minimal pre-launch scope: tag every source's class, **block C/D ingestion entirely**, guarantee a `firm-sop` query cannot return a non-A/B chunk. Full per-class index routing can follow.

**Verification checklist:**

- [ ] Test: a plain (un-scoped) token retrieves **nothing** (no admin default).
- [ ] Test: staff-role token cannot retrieve an out-of-scope source (CR-5 verify row).
- [ ] Test: ingesting a Class C/D doc is refused; an A-class query never returns a B/C/D chunk.

**Anti-pattern guards:** keep the post-fusion filter placement; "scoped wins over admin" ordering must remain (least privilege); don't widen scope via caller filters (intersect only).

---

## Phase 6 — Encryption in transit & at rest; MFA posture (CR-6, CR-7, CR-8) ⛔ (code parts)

**What to implement (code-side):**

1. **DB TLS (CR-7):** add `ssl` to the `pg.Pool` config (`packages/db/src/client.ts:22-34` and `migrate.ts:36`); require `sslmode=require` in `DATABASE_URL` and document it in `env.example`.
2. **Parser TLS (CR-7):** parser defaults to `http://localhost:8000` (`env.example:30`) with only an optional shared secret — require HTTPS for any non-localhost `PARSER_URL`; add a config assertion.
3. **App-level AES-256-GCM (CR-6)** on stored sensitive content (chat transcripts once persisted in Phase 14, and any Class C/D `documents.markdown`/`chunks.text`). Greenfield module in `@rag/core` beside `auth.ts`; apply at the `queries.ts` upsert/read boundary (`:86-139`, `:141-144`). Reuse `timingSafeEqual`/key-fingerprinting patterns from `auth.ts:21-47`.

**Verification checklist:**

- [ ] App refuses to start with a non-TLS `DATABASE_URL` in production mode.
- [ ] Encrypted columns are unreadable in a raw DB snapshot without the key (round-trip test).
- [ ] `testssl`/manual check: no plaintext HTTP on data hops.

**Out-of-code (track, don't build here):** **CR-8 MFA** is IdP-side (Entra/PropelAuth conditional access) — but **static `API_TOKENS` callers have no MFA**; for human access prefer the OIDC path. Postgres disk/TDE encryption is infra (Railway volume) — assert/verify in the deploy runbook. **[INFRA]**

**Anti-pattern guards:** never store the AES key in the DB or repo; pull from env/secret manager. Don't encrypt content needed for BM25/`tsvector` indexing without a searchable-encryption plan — scope app-level encryption to Class C/D + transcripts initially.

---

## Phase 7 — Rate limiting & abuse protection ⛔ (cheap, do before exposure)

**Why:** `/ask` triggers embed+LLM per call; no limiter today. Supports CR-10 anomaly posture.

**What to implement:**

1. Add `@fastify/rate-limit`; register after `registerErrorHandler` and before routes (`apps/api/src/server.ts:46→73`); exempt `/health`/`/ready`. Per-principal keying using the auth context.
2. MCP (Express) — add `express-rate-limit` middleware at `apps/mcp/src/transports/http.ts:118-123` (it already has `MAX_SESSIONS`).

**Verification checklist:**

- [ ] Burst test: N+1 requests within the window returns 429.
- [ ] Health probes remain unthrottled.

**Anti-pattern guards:** key by principal, not just IP (shared egress); set limits high enough not to break the eval harness / sync.

---

# POST-LAUNCH — within 90 days of go-live (`CPA-COMPLIANCE-REQUIREMENTS.md:63-64`)

## Phase 8 — Off-host log shipping, observability & anomaly alerts (CR-10)

Ship the Phase-3 `audit_log` + pino streams to an independent aggregator (≥3yr retention); add anomaly alerts (bulk export, after-hours). Add OpenTelemetry traces and/or `prom-client` `/metrics` (none exist today — `apps/api`). Add Sentry for error tracking. **Verify:** simulated bulk-pull triggers an alert; aggregator shows retention policy.

## Phase 9 — CI/CD hardening

Add ESLint config + a `lint` script to **every** package/app first (none exist — `pnpm lint` currently fails). Then extend CI (new `.github/workflows/ci.yml`, reuse setup block `e2e.yml:62-78`) with jobs: `typecheck`, `test` + coverage gate, **secret scan** (gitleaks), **dependency audit** (`pnpm audit`/osv-scanner), and a `dependabot.yml`. **Verify:** PR fails on a planted secret, a lint error, and a high-sev CVE.

## Phase 10 — Backup & secure disposal (CR-20, CR-19)

Add tested `pg_dump` backup + a documented restore drill (none in repo/docs). Add a decommission checklist with cryptographic erasure + deletion certs. **Verify:** restore-drill log; backup monitoring.

## Process/legal track (parallel — not code, but gating go-live)

- **[COUNSEL]** CR-2/CR-3/CR-4 vendor DPA + signed §7216 acknowledgment + US-region pin; CR-1 final architecture sign-off.
- **[PROCESS]** CR-11 named Qualified Individual; CR-12 WISP names the RAG system; CR-9 vendor register; CR-15 staff AI-limitations training; CR-16/CR-17 breach runbook (FTC 30-day + IRS Stakeholder Liaison). Confirm GLBA pen-test exemption by counting consumer records (`:67-68`).

---

# CAN WAIT — quality, precision & polish (post-pilot)

## Phase 11 — Retrieval precision

Reranker at `retriever.ts:60-70` (cross-encoder or LLM re-score of `RetrievalResult[]`, feature-detected like `embedQuery?`); query rewriting/HyDE at `retriever.ts:51`; context-window token budget in `generator.ts:buildPrompt` (`:67-86`) so retrieved chunks are trimmed to a token cap before generation. **Verify:** eval nDCG@k improves vs baseline; prompt token count bounded.

## Phase 12 — CPA gold eval set

Replace the synthetic 14-doc/17-question corpus (`tests/e2e/src/eval/corpus.ts:22-37`) with 30–50 **real CPA** questions (firm golden questions from `cpa-consulting`); swap `FakeEmbedder` for the real embedder; add an LLM-judge faithfulness check (gaps noted at `docs/ISSUES-AND-OPTIMIZATIONS.md:421`). Keep `EvalDoc`/`EvalQuestion` shapes — harness untouched. **Verify:** `pnpm eval` reports top-3 recall against the CPA set (rubric bar).

## Phase 13 — Per-document / per-client ACL + ACL mirroring

Move from per-source to per-document/per-client-folder ACL (extend `isSourceAllowed` `access-control.ts:219-227` + add a doc-ACL predicate at `queries.ts:483`); add a **DB-backed principal store** (swap `resolvePrincipal` `:152-165` — module is designed for this); mirror SharePoint/Entra group ACLs into source/document ACLs (currently hand-maintained `OIDC_SCOPE_MAP`). **Verify:** revoking a SharePoint permission removes retrievability after next sync.

## Phase 14 — Web UI completion

Wire upload → a new `POST /api/documents` ingest route (none exists; `upload-modal.tsx` `onUpload` is unpassed); add **server-side chat session persistence** (today in-memory only, `use-chat-sessions.tsx:21-22` — ties into the Phase-3 audit log); add accessibility (zero `aria-*` today) — input labels, `aria-live` on the streaming message list, citation `aria-label`s, modal `role="dialog"` + focus trap. **Verify:** axe/lighthouse a11y pass; upload ingests a doc end-to-end; refresh preserves history.

---

# Final Phase — Verification (run after each milestone, and before go-live)

**Automated checks:**

- [ ] `pnpm -r build && pnpm typecheck && pnpm test` green.
- [ ] `pnpm eval` runs against the CPA gold set (post-Phase 12) and meets the top-3 recall bar.
- [ ] Egress test (Phase 1): no external embedding/LLM call occurs with Class C/D data present.

**Anti-pattern grep guards (should all return nothing / only intended hits):**

- [ ] `grep -rn 'not yet implemented' packages/rag/src` → empty (Phase 1).
- [ ] `grep -rn 'admin' packages/core/src/access-control.ts` → no default-admin-for-unscoped (Phase 5).
- [ ] No `console.log` of query/answer text (Phase 3); audit goes to the table.
- [ ] `grep -rn 'aria-' apps/web/src` → non-empty (Phase 14).

**Compliance gate (map to CR matrix before real data):** CR-1, CR-4, CR-5, CR-6, CR-7, CR-8, CR-13, CR-18 satisfied (Phases 1–6) and **[COUNSEL]/[PROCESS]** items (CR-2/3/9/11/12/16) signed off. CR-10 (full off-host) + CR-20 within 90 days.

---

## Priority summary (one screen)

| Tier                      | Phases                                                                                                                           | Controls                       | Rationale                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| **PRE-LAUNCH (blocking)** | 1 §7216+egress · 2 retention/purge · 3 audit log (in-code) · 4 HITL disclaimer · 5 RBAC+data-class · 6 encryption · 7 rate-limit | CR-1,4,5,6,7,8,13,14,18        | Mandatory-before-real-data tier; §7216 (Phase 1) gates everything |
| **POST-LAUNCH ≤90 days**  | 8 observability/log-shipping · 9 CI hardening · 10 backup/disposal · process/legal track                                         | CR-9,10,11,12,15,16,17,19,20   | Firm's 90-day tier; operational maturity                          |
| **CAN WAIT (quality)**    | 11 rerank/rewrite/budget · 12 CPA gold eval · 13 per-doc ACL+mirroring · 14 UI completion                                        | precision + UX; CR-5 deepening | Improves accuracy/usability; not legal blockers                   |

_Note on "blocking" reconciliation: the comparison doc labeled audit logging (Phase 3) and retention (Phase 2) "blocking." Retention stays pre-launch (CR-18 mandatory). Audit logging is split — the in-code structured record is pre-launch (needed for CR-13 review records); off-host shipping/alerts (CR-10) is 90-day per the firm's own tiering._
