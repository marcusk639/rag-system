# Plan: the knowledge base — Autonomous E2E Testing, Answer-Quality Gate, and Feedback Loop

**Created:** 2026-07-16. **Revised:** 2026-07-16 (post plan-review — resolved C1/C2/C3 + notes). **Repo:** `rag-system`.
**Goal:** Make the firm's knowledge base a fully usable, trustworthy self-serve tool — queryable from the web app or MS Teams, producing accurate/substantive/helpful answers with correct, downloadable citations — and stand up an **autonomous agent that builds, runs, and fixes end-to-end tests** so quality stays high. Add a **feedback mechanism** (Helpful / Not Helpful) that feeds improvement.

**Execution model:** Phased; each phase is self-contained and runnable in a fresh chat context. Do them in order (later phases depend on earlier). Every phase cites exact files to COPY patterns from — do not invent APIs.

> **Scope note (from the requester):** "click a citation → jump to the exact spot in the source document" is explicitly **deferred to a later plan** (it needs char-offset/anchor tracking through ingestion). This plan delivers downloadable + openable citations, which already exist, and everything else.

> **Buildable-now vs gated:** Phase 0.5 → Phase 4 (plus Phase 5's harness on a seeded corpus) are buildable immediately. **Phase 5's real gold set needs Doug**, and **Phase 6 needs the P0 content audit + Azure creds** — these are correctly gated, not deferred risk (the harness and everything else works without them; only real-firm-data validation waits).

---

## Phase 0 — Allowed APIs, patterns, and anti-patterns (READ FIRST)

Consolidated from a codebase discovery pass; every load-bearing claim below was independently re-verified against the live tree. Re-verify any line number before relying on it.

### Run + test-auth (the enablers)

- **Local stack:** `pnpm docker:up` (Postgres 16+pgvector on `5432`, Python parser on `127.0.0.1:8000`) → `pnpm db:migrate` → `pnpm dev:api` (Fastify, `API_PORT=3000`) → `pnpm dev:worker` (ingestion; needed only to load docs) → web via `pnpm --filter @rag/web dev` (**port collision: Next dev also defaults to 3000 — run web on another port and set `RAG_API_URL` to the API's port**).
- **Answering a real question needs:** Postgres + api + an **embedding provider** (`EMBEDDING_PROVIDER=local` = no API key, the §7216-compliant default; `gemini`/`openai` need keys) + a **generator** (`GENERATION_PROVIDER=gemini`, needs `GEMINI_API_KEY`). Ingestion additionally needs the parser + worker.
- **Test-auth bypass (critical):** set `WEB_AUTH_MODE=static-fallback` + `RAG_API_STATIC_FALLBACK_TOKEN=<token>` on the web server. Then `middleware.ts:30-32` skips the sign-in redirect and `rag-api.ts:66-95` serves every request with that static bearer — no Microsoft login, no cookie.
  - **⚠️ C1 — the token's RESOLVED SCOPE must be able to see the seeded corpus, or every answer is empty.** `resolvePrincipal` (`packages/core/src/access-control.ts:175-198`) resolves a token to `{kind:"admin", enforcedSourceIds:null}` (sees everything) ONLY when it's a plain `API_TOKENS` entry with scoping enforcement OFF, OR to `{kind:"scoped", allowedSourceIds:[...]}` for an `API_PRINCIPALS` entry. **With scoping enforced, a plain `API_TOKENS` token resolves to deny-all (`allowedSourceIds: []`) → zero rows → every answer hits the "not enough information" short-circuit.** The E2E harness MUST use either an **admin `API_PRINCIPALS` token** or a **scoped principal whose `allowedSourceIds` includes the seeded source id**. This is a hard config precondition (see Phase 0.5/3).

### Ask / citation / download contract

- `POST /ask` → `AskResult` (`packages/services/src/ask.ts:60`): `{ answer, citations, retrieved, reviewStatus, disclaimer }`. **No `id` field today** (verified). Also `POST /ask/stream` SSE: `event: token` / `event: done {citations, retrieved, reviewStatus, disclaimer}` / `event: error`.
- **Citation** (`packages/rag/src/generation/generator.ts:101`): `{ index, documentId, title, url?, downloadable, chunkId, score }`.
- **Download:** `GET /documents/:id/download` (`apps/api/src/routes/documents.ts:37`), scope-gated, 404 on forbidden/missing/no-original. Web BFF proxy: `apps/web/src/app/api/documents/[id]/download/route.ts`. UI renders "Download original" at `apps/web/src/components/knowledge-base/knowledge-base.tsx:154`.

### Web UI anchors + the missing test-ids

`apps/web/src/components/chat-interface/chat-interface.tsx`: input (`:129`), send button (`:140`, icon-only), answer prose (`:85`), citation buttons `[N] title` (`:88-101`), disclaimer `<p role="note">` (`:102-113`). Modal + "Download original": `knowledge-base.tsx:108-165`. **ZERO `data-testid` in `apps/web/src` — adding them is a prerequisite for stable E2E.**

### Service / route / MCP / migration patterns (copy these)

- **DB query:** copy `logAskEvent` (`packages/db/src/queries.ts:791`) — note it does `await db.insert(...).values(...)` with **no `.returning()`** and is called fire-and-forget from `auditAsk`.
- **Service:** copy `triggerSync` (`packages/services/src/sources.ts:36`) — `(deps, input, scope) => Promise<T>`, export from `packages/services/src/index.ts`.
- **API route:** copy `apps/api/src/routes/documents.ts` (thin Zod-body adapter, `scopeFromRequest(request)`).
- **MCP tool:** copy `apps/mcp/src/tools/trigger-sync.ts`.
- **Migration (highest = `0017`; next = `0018`, journal `idx:17`):** hand-author `packages/db/drizzle/0018_<name>.sql` (`--> statement-breakpoint`; `uuid_generate_v4()` PKs), add the `pgTable` to `packages/db/src/schema.ts`, append the journal entry. **Do NOT run `drizzle-kit generate`** — it emits `DROP INDEX` for the HNSW/tsvector indexes owned by `0000_init.sql` (schema.ts:228-247 warning, runtime-guarded by `assertRequiredIndexes()`). Deploy `rag-worker` first on schema releases.

### Backend E2E + eval (reuse, don't reinvent)

- Backend e2e (`tests/e2e/`): vitest, in-process Fastify via `buildTestApi(...).inject()`, fakes from `@rag/test-fixtures`; helpers `openTestDb`, `truncateAll`, `createCustomSource`, `runOneIngestion`; `globalSetup` boots docker unless `E2E_SKIP_DOCKER_UP=1`. **This suite has "no browser to test" — UI E2E is net-new. It also owns per-user scope-isolation testing (multi-principal); the UI suite cannot.**
- Eval (`pnpm eval` / `eval:real`): **retrieval IR metrics only** (`recall/precision/ndcg/mrr`); corpus `tests/e2e/src/eval/corpus.ts` (14 synthetic docs / 17 questions). **NO answer-faithfulness / LLM-judge anywhere** (verified) — Phase 5 adds it.

### Agent format + delegation targets

- Custom agent: `<repo>/.claude/agents/<name>.md`, frontmatter **only** `name, description, tools, model` (adding `memory:` silently drops it from `/agents`). Repo convention: `tools: Read, Grep, Glob, Bash`, `model: claude-sonnet-4-6`; add `Write, Edit` for a build/fix agent. Model on `.claude/agents/retrieval-eval-runner.md`.
- **Delegation targets (all verified to exist):** `build-error-resolver`, `typescript-reviewer` (`~/.claude/agents`), `rag-reviewer`, `retrieval-eval-runner` (repo `.claude/agents`), `e2e-runner`.
- **Browser driving:** greenfield (no Playwright). This plan adds `@playwright/test` as a repo devDep so tests are first-class artifacts the autopilot can run headless.

### Anti-patterns (do NOT)

- Do not add `data-testid`s ad hoc — add them deliberately (Phase 2/0.5) as a reviewed change.
- Do not attach feedback to `question_hash` or the un-returned `audit_log.id` — add a real `answerId` (Phase 1). **Do not FK `answer_feedback.answer_id` to `audit_log`** — audit writes are best-effort (C3).
- Do not `drizzle-kit generate` (index-drop regression).
- Do not claim "accurate answers" from the retrieval eval alone — Phase 5's judge is required.
- Do not send **client-confidential (Class C/D)** content to external models. Firm-SOP (Class A/B) already flows through Gemini per **decision D2** (`docs/PLAN-LAUNCH-READINESS.md`) — the judge is no different (see C2 note, Phase 5/6).

---

## Phase 0.5 — Walking-skeleton E2E spike (de-risk the glue FIRST)

**Why (plan-review suggestion #1):** The riskiest net-new piece is the bring-up-script + static-fallback + seeded-corpus + Playwright chain (C1 lives here), not the feedback UI. Prove it end-to-end before investing in UI/test-ids, so the autopilot (Phase 4) has a known-good baseline and C1 surfaces immediately.

### What to implement

1. Add `@playwright/test` devDep + minimal `playwright.config.ts` (repo root or `tests/e2e-ui/`); root script `pnpm e2e:ui`.
2. An **idempotent bring-up script** (`scripts/e2e-ui-up.sh` or Playwright `globalSetup`): `pnpm docker:up` → `db:migrate` → seed ONE known source + a couple of docs (reuse `tests/e2e/src/helpers/createCustomSource` + `runOneIngestion`) → start `dev:api` (`EMBEDDING_PROVIDER=local`) → start web on a non-3000 port with `WEB_AUTH_MODE=static-fallback` and **`RAG_API_STATIC_FALLBACK_TOKEN` set to an admin `API_PRINCIPALS` token (or a scoped principal that includes the seeded source id)** per C1.
3. **One** Playwright test: load the app (no MS login), type a seeded-corpus question, assert a non-empty answer renders (proves auth-bypass + corpus visibility + generation all work as a chain).

### Verification checklist

- [ ] `pnpm e2e:ui` runs the single test green, headless, with no Microsoft login and no real firm data.
- [ ] The answer is non-empty (proves C1's token-scope precondition is satisfied — if the answer is the "not enough information" short-circuit, the token scope is wrong; fix the token, not the app).

### Anti-pattern guards

- If the spike returns empty answers, the FIRST hypothesis is the C1 token-scope precondition, not an app bug. Do not "fix" the app to make an empty answer pass.

---

## Phase 1 — Per-answer identity + feedback backend

**Why:** Feedback must reference a specific answer. None exists. Add `answerId`, surface it on all three transports, persist it, and build the feedback write path.

### What to implement (copy, don't transform)

1. **Generate `answerId`** (a uuid) in `askQuestion`/`askQuestionStream` (`packages/services/src/ask.ts`). Add `answerId: string` to `AskResult` (`:60`), the SSE `done` event (`apps/api/src/routes/ask.ts` + consumer `apps/web/src/lib/stream-chat.ts:18-19`), and the MCP ask `structuredContent` (`apps/mcp/src/tools/ask.ts:154`). **Back-compat:** this is purely additive (consumers ignore unknown fields) — grep for any MCP consumer that validates `structuredContent` against a closed schema; if none, note it and proceed.
2. **Persist the answerId** via `logAskEvent` (add an `answer_id text` column to `audit_log` in migration 0018, populated from the generated id). This lets feedback join to answer context (question_hash, sources, model) **best-effort** — see C3.
3. **New `answer_feedback` table** (migration `0018_answer_feedback.sql` + `schema.ts`, model on `auditLog` `:344`): `id uuid pk uuid_generate_v4()`, **`answer_id text not null`** (a plain column — **NOT a FK to `audit_log`**, because the audit write is best-effort and may be absent; C3), `principal_subject text`, `rating text not null` (`'helpful'|'not_helpful'`), `comment text`, `channel text` (`web|teams`), `created_at timestamptz`. **Unique index on `(answer_id, principal_subject)` with last-write-wins** (`INSERT ... ON CONFLICT DO UPDATE`, like `grantClientAccess`) so a user changing 👍→👎 updates one row rather than double-counting. Export `$inferSelect`/`$inferInsert`.
4. **DB queries** (`packages/db/src/queries.ts`, copy `logAskEvent`): `submitAnswerFeedback(db, row)` (upsert) and `getFeedbackStats(db, {since?})` (counts by rating + recent not-helpful comments — the improvement signal).
5. **Service** (`packages/services/src/feedback.ts`, copy `triggerSync`): `submitAnswerFeedback(deps, {answerId, rating, comment}, scope)` — **derive `principal_subject` from `scope`, never from the client** (an answerId is client-supplied and unverified-ownership, which is acceptable, but the identity must come from the token). Export from the barrel.
6. **API route** `POST /feedback` (`apps/api/src/routes/feedback.ts`, copy `documents.ts`): Zod body `{ answerId: string, rating: enum, comment?: string(max 1000) }`, `scopeFromRequest`, returns `204`.
7. **(Optional) MCP tool** `submit_feedback` (copy `trigger-sync.ts`).

### Decisions to record IN THIS PHASE (plan-review)

- **Comment free-text is a new confidentiality vector** — staff could paste client-identifying text into a system otherwise careful never to store question text. **Decision (default): keep the comment field, but (a) cap 1000 chars, (b) never surface raw comments to any external model, (c) document in `env.example`/the feature that comments are firm-internal ops signal only.** If the firm prefers zero free-text, ship rating-only and drop `comment`. Record which was chosen.
- Dedup semantic: **last-write-wins per `(answer_id, principal_subject)`** (chosen above).

### Verification checklist

- [ ] TDD: query + service unit tests; a `POST /feedback` route test asserting a row with the right `answer_id`, `rating`, scope-derived `principal_subject`; an upsert test (👍 then 👎 → one row, rating updated).
- [ ] `pnpm --filter @rag/db test && --filter @rag/services test && --filter @rag/api test` green.
- [ ] `AskResult`, SSE `done`, MCP `structuredContent` all carry `answerId` (grep + test).
- [ ] Migration 0018 applies from a fresh volume; `_journal.json` idx=17, monotonic `when`. No FK from `answer_feedback` to `audit_log`.

### Anti-pattern guards

- No raw question text stored. `principal_subject` from scope only. No `audit_log` FK (C3). No `drizzle-kit generate`.

---

## Phase 2 — Feedback UI on web (Teams = tracked follow-up) + E2E test-ids

**Completion bar = web.** (plan-review #4) Teams feedback is a tracked follow-up so Phase 3 isn't blocked on bot plumbing.

### What to implement

1. **Web feedback control** (`chat-interface.tsx`, after the disclaimer `:102-113`): 👍 Helpful / 👎 Not Helpful (optional one-line comment on 👎), shown once `message` has content + `answerId` (thread `answerId` from the `done` handler `:52`). Fire-and-forget POST to a BFF route — a feedback failure must never break the chat.
2. **Web BFF route** `apps/web/src/app/api/feedback/route.ts` (copy `documents/[id]/download/route.ts`; reuse `resolveRequestBearerToken` so `static-fallback` E2E works) → forwards to API `POST /feedback`.
3. **`data-testid`s** for E2E: `question-input` (`:129`), `send-button` (`:140`), `answer` (`:85`), `citation-{index}` (`:91`), `disclaimer` (`:106`), `citation-modal` / `download-original` (`knowledge-base.tsx`), `feedback-helpful` / `feedback-not-helpful`.
4. **Teams (follow-up, tracked not blocking):** `Action.Submit` "Helpful/Not Helpful" on `answerCard` (`apps/teams-bot/src/cards.ts`), handled in `bot.ts` → API `POST /feedback` via `rag-client.ts`. Scope/answerId from the ask response.

### Verification checklist

- [ ] Web: ask → 👍/👎 → a `POST /api/feedback` fires and an `answer_feedback` row lands with the right `answer_id` + `rating`; 👍→👎 updates (upsert).
- [ ] Every listed `data-testid` present (grep).
- [ ] `pnpm --filter @rag/web test`, lint, typecheck green. (Teams tests green when that follow-up lands.)

### Anti-pattern guards

- Feedback POST never blocks/breaks answer rendering. No backend token in the browser (BFF only).

---

## Phase 3 — Full web E2E suite (Playwright)

Builds on the Phase 0.5 skeleton. Same bring-up script + C1 token precondition.

### What to implement — core flows (`tests/e2e-ui/*.spec.ts`, using the test-ids)

- **ask → answer:** seeded question → answer fills + disclaimer appears.
- **citations render + open + download:** ≥1 citation → modal → "Download original" returns bytes (200 + content-disposition).
- **feedback:** 👍 records; 👎 + comment records; re-vote updates.
- **auth bypass sanity:** app loads + answers with no Microsoft login.
- **empty/guard:** empty question doesn't crash; a no-results question yields the "not enough information" answer, not an error.

### Verification checklist

- [ ] `pnpm e2e:ui` green headless against the seeded corpus.
- [ ] Induced failure (break a selector) emits a trace + screenshot (artifacts for Phase 4).
- [ ] No dependency on real Microsoft login or real firm data.
- [ ] **Scope-testing honesty (plan-review):** this suite authenticates as ONE principal — it does NOT validate multi-user confidentiality isolation. That remains the backend vitest suite's job (`tests/e2e/`). Do not let Phase 7's "per-user scope" checkbox claim the UI suite covers it.

### Anti-pattern guards

- Use test-ids, not brittle text. Bring-up script idempotent + self-contained. Don't require a real `GEMINI_API_KEY` for structural flows (answer-quality assertions belong in Phase 5).

---

## Phase 4 — The autonomous E2E build/run/fix agent

**Why:** an agent that autonomously builds, runs, and fixes E2E tests, repairing broken features itself or by delegation.

### What to implement

1. **`.claude/agents/e2e-autopilot.md`** (frontmatter modeled on `retrieval-eval-runner.md`: `name, description, tools: Read, Grep, Glob, Bash, Write, Edit, model: claude-sonnet-4-6`). Procedure: bring up stack → run `pnpm e2e:ui` → on green, report + stop → on failure, **triage** each spec from trace/screenshot/console/network → **classify** test-bug vs app-bug → **fix**: test-bug → fix the spec; build/type break → delegate `build-error-resolver`; route/service logic bug → minimal fix then delegate review to `rag-reviewer` + `typescript-reviewer`; suspected retrieval regression → delegate `retrieval-eval-runner` → **re-run** (≤3 iterations/failure) → **report** root cause + fix or blocker with file:line.
2. **Guardrails (non-negotiable, in the agent doc):**
   - Never weaken a compliance/security assertion (per-user scope, the disclaimer, the auth boundary) to make a test pass — a test failing because the app dropped one is a REAL app bug to fix.
   - **Never edit a migration, the `schema.ts` index block, or auth/scope code without human sign-off** (the repo's documented footguns — plan-review #2).
   - Never `--no-verify`; bounded iterations; escalate rather than loop.
3. **Invocation:** documented usage ("dispatch after changes touching `apps/web`/`apps/api`/`packages/services`"); optionally a repo command. Not a blocking hook (it's heavy).

### Verification checklist

- [ ] Against a deliberately-broken feature (e.g. break the download route) → identifies from the trace, fixes or correctly delegates, returns to green, names the root cause.
- [ ] Against a clean tree → runs + reports pass, no changes.
- [ ] Its diffs never weaken a compliance/security assertion and never touch migrations/schema-index/auth without sign-off.

### Anti-pattern guards

- Distinguish "test wrong" vs "app broken"; prefer real app fixes. No unbounded loops. No silent assertion-weakening. Delegate build/type/retrieval/footgun concerns.

---

## Phase 5 — Answer-quality gate (accuracy, substance, correct citations)

**Why:** Retrieval ranking ≠ answer faithfulness. This is the core "is it actually good" gate.

### C2 — external-model posture (resolved via decision D2)

Firm-SOP content (Class A/B, non-return-information) is **already accepted to flow through the Gemini generator per decision D2** (`docs/PLAN-LAUNCH-READINESS.md`). The answer-quality judge (Claude) sees the same generated answer + cited firm-SOP chunk the generator already processed — **no new disclosure boundary for Class A/B.** The invariant is: **client-confidential (Class C/D) is excluded from the KB corpus and must never reach any external model** (generator or judge). So Phase 5/6 may judge firm-SOP content with an external judge; it must NOT judge client-confidential content (which shouldn't be in the corpus anyway). If the firm later declines external processing entirely, swap the judge (and generator) to a self-hosted model — the `EmbeddingProvider`/generator factory pattern already supports that.

### What to implement

1. **LLM-as-judge** (`tests/e2e/src/eval/judge.ts` + `run-answer-eval.ts`, modeled on `run-real-eval.ts`): per gold question → `POST /ask` → Claude judge scores **groundedness** (claims supported by cited chunks), **citation-correctness** (each `[N]`'s chunk supports its sentence), **substance/helpfulness**, **completeness**. Aggregate → `docs/EVAL-ANSWER-BASELINE.md`.
2. **Judge calibration FIRST (plan-review):** before treating any threshold as a ship-gate, hand-label ~10 answers (grounded / not, correct-cite / not) and confirm the judge agrees with the human labels (report the agreement rate). A judge that disagrees with humans isn't a gate. Only then set thresholds.
3. **Gold corpus** (`tests/e2e/src/eval/corpus.ts`): grow toward 30–50 CPA questions. **Real questions need Doug** (`docs/PILOT-MANUAL-RUNBOOK.md` item 7); turning his list into corpus entries is mechanical. Until then seed realistic _fictional_ CPA SOP questions + near-neighbor distractors. **Keep seeded (fictional) and real (Doug) sets in physically separate files, seeded loudly labeled**, so a synthetic question can never be mistaken for a validated firm question in a shipped baseline (plan-review #5).
4. **Thresholds** (post-calibration): e.g. ≥0.9 grounded, zero unsupported citations — record baseline, ratchet. Retrieval-side regressions → `retrieval-eval-runner`.
5. **Wire into the autopilot** as a runnable check (a low groundedness score = an app/retrieval bug to investigate, not a test to relax).

### Verification checklist

- [ ] Judge calibration report shows acceptable human-agreement before any threshold is enforced.
- [ ] `run-answer-eval` produces per-question + aggregate scores → `docs/EVAL-ANSWER-BASELINE.md` (real generator).
- [ ] An injected hallucination scores low groundedness; a mismatched citation is caught.
- [ ] Seeded and real corpora are separate files; seeded is labeled.

### Anti-pattern guards

- Judge checks answer claims against the _cited_ chunk (not just retrieval recall). Label seeded questions as synthetic. **Never send Class C/D content to the judge** (C2 invariant).

---

## Phase 6 — Real the tenant's SharePoint corpus (GATED — human/infra prerequisites)

### Prerequisites (human/infra — see `docs/PILOT-MANUAL-RUNBOOK.md` + `docs/AZURE-DEPLOY-RUNBOOK.md`)

- [ ] **P0 content audit** (runbook item 1) — confirm the libraries are firm SOPs, not client files, _with Chris/Doug_.
- [ ] **Azure app** (`Sites.Read.All`+`Files.Read.All` + admin consent) → `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` on the worker.
- [ ] Resolve the Graph `siteId` (runbook Step 6).

### What to run

1. Create + sync (copy `docs/PHASE-3-SHAREPOINT-RUNBOOK.md:162-198`): `POST /sources` (admin) `{kind:"sharepoint", name, config:{siteId,...}}` → `POST /sources/:id/sync {mode:"full"}`; watch the worker + `ingestion_jobs`.
2. Verify: documents/chunks present, `data_class` correct (the `client_confidential` gate blocks mis-tags), originals stored (citations downloadable).
3. Re-run Phase 3 E2E + Phase 5 answer-eval against the real corpus with **Doug's real gold questions**. Record real-corpus scores. **(C2: firm-SOP content to Gemini/Claude is within D2; re-confirm no Class C/D leaked into the corpus before judging.)**

### Verification checklist

- [ ] A real firm-SOP question through web (and Teams) → accurate, cited answer + working "Download original".
- [ ] The judge meets threshold on the real gold set.
- [ ] No `client_confidential` in a channel answer (Teams intersection gate re-verified).

### Anti-pattern guards

- No ingestion before the audit clears the library. Never point at client-engagement libraries (Onvio is system of record). Re-run the quality gate on real content (synthetic pass ≠ real pass).

---

## Phase 7 — Final verification + "optimal for the tenant"

### Full green gate

- [ ] `pnpm -r build && typecheck && lint && test` (unit) green.
- [ ] `pnpm e2e:ui` (Playwright) green; `e2e-autopilot` runs clean on a fresh tree.
- [ ] `run-answer-eval` meets thresholds (seeded now, real post-Doug).
- [ ] Feedback loop end-to-end on web (👍/👎 → `answer_feedback` → `getFeedbackStats`); Teams when that follow-up lands.
- [ ] Downloadable citations verified.

### "Optimal for the tenant" checklist

- [ ] **Compliance:** `EMBEDDING_PROVIDER=local` for client-adjacent content; the practitioner-review disclaimer on every answer (web + Teams); per-user scope enforced (**validated by the backend vitest suite — the UI suite tests a single principal**); every query audited with the asker's `oid`; Class C/D never sent to any external model.
- [ ] **Usability/value:** a staff member asks in plain English on either surface and gets an accurate, cited, downloadable answer without asking a colleague.
- [ ] **Improvement flywheel:** `getFeedbackStats` (not-helpful + comments) + the docs-gap-digest feed corpus/retrieval improvements; the answer-quality baseline is recorded and ratcheted.

### Deferred (future plan)

- **Citation deep-linking** — click → exact passage in the source doc (needs char-offset/anchor tracking through parser + chunker + a viewer).

---

## Phase dependency summary

```
P0 (facts) ─► P0.5 (walking-skeleton E2E spike — de-risks C1) ─► P1 (answerId + feedback backend)
P1 ─► P2 (feedback UI web + test-ids; Teams = follow-up) ─► P3 (full Playwright E2E) ─► P4 (autopilot agent)
P1/P3 ─► P5 (answer-quality judge; seeded now, Doug's gold set later)
                    ▼
P6 (real the tenant's SharePoint — GATED: P0 content audit + Azure creds) ─► P7 (final verify + optimal-for-the firm)
```

P0.5→P4 (+ P5 harness on seeded corpus) are buildable now; P5's real gold set needs Doug; P6 needs the firm gates. None of the buildable-now work is blocked on the gated parts.
