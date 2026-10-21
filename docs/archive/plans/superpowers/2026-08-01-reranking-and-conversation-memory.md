# Reranking + Conversation Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two highest-value gaps from
[`PROTOTYPE-READINESS-REVIEW-2026-08-01.md`](../../PROTOTYPE-READINESS-REVIEW-2026-08-01.md):
**H-5** (reranking built but disabled) and **H-2** (no conversation memory —
follow-up questions fail on both staff surfaces).

**Architecture:** Two tracks, **sequenced A → B deliberately** (see Phase 0c).
**Track A** makes the existing `HttpCrossEncoderReranker` safe to switch on — it
currently bypasses the egress allow-list that governs every other outbound
provider call — then enables and measures it. **Track B** adds _conversational
query condensation_: a small model call that rewrites a follow-up into a
standalone question **before retrieval only**. The grounding prompt still
receives the user's original question.

**Tech Stack:** TypeScript, Drizzle/Postgres (pg16 + pgvector 0.8.2), Fastify +
`fastify-type-provider-zod`, vitest, `@modelcontextprotocol` (MCP), botbuilder
4.23.3, Next.js 15.

---

## Global Constraints

- All DB access via `@rag/db` typed queries; never import `pg`/`drizzle-orm` in routes/services.
- Cross-package contracts live in `@rag/core`. Providers implement an interface and register in a factory.
- Business logic stays transport-agnostic in `@rag/services`; routes and MCP tools are thin adapters.
- **Additive only.** `AskInput`/`AskBody`/`AskResult`/SSE `done` gain optional fields; nothing is removed or renamed.
- Bound every new client-supplied input with zod caps, matching `filterSchema` (`packages/core/src/validation.ts:12-26`).
- Commit format `<type>: <description>`, no attribution footers. Pre-commit (prettier + secret scan + 800-line cap) runs on every commit — never `--no-verify`.
- `pnpm typecheck` is currently RED on `main` (5 pre-existing errors in `tests/e2e/src/specs/eval-faithfulness.spec.ts` — review § M-7). Not your regression; don't fix opportunistically inside these tasks.

---

# Phase 0 — Documentation Discovery (COMPLETE)

## 0a. Verified against the tree — cite these, don't re-derive

| #   | Finding                                                                                                                                                                                                                                                           | Evidence                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The reranker has no egress gate.** Bare `fetch`, no `EgressPolicy.assertAllowed`, no TRI scan.                                                                                                                                                                  | `packages/rag/src/retrieval/reranker.ts:35`; `grep -n "EgressPolicy\|assertAllowed\|scanForTRI"` returns **nothing**.           |
| 2   | **The runtime never hands it one**, unlike its siblings.                                                                                                                                                                                                          | `packages/runtime/src/index.ts:150` vs `:141-142` (embedder) and `:148` (audit sink); `egressPolicy` built at `:139`.           |
| 3   | Reranking is off by default.                                                                                                                                                                                                                                      | `packages/core/src/config.ts:613`; `env.example:255`.                                                                           |
| 4   | Enabling it changes the SQL pool: `fetchK = topK × poolMultiplier` (12 × 5 = 60), then `hybridSearch` uses `pool = fetchK × 8` = **480** per arm under a fixed `hnsw.ef_search = 100`. `Retriever` passes neither knob.                                           | `retriever.ts:84`; `queries.ts:529, 620`.                                                                                       |
| 5   | `capChunksPerDocument` runs **after** rerank truncation, so the generator can receive fewer than `topK` chunks.                                                                                                                                                   | `packages/services/src/ask.ts:128-131`.                                                                                         |
| 6   | **`CompleteFn` already exists** as the bare prompt→text port, deliberately separate from `Generator`.                                                                                                                                                             | `claim-extractor.ts:118-130`, exported `rag/index.ts:68`. Impl to copy: `scripts/extract-corpus.ts:213-223`.                    |
| 7   | Every layer carrying `question`.                                                                                                                                                                                                                                  | `services/ask.ts:43`, `api/routes/ask.ts:18`, `mcp/tools/ask.ts:17`, `teams-bot/rag-client.ts:29`, `web/lib/stream-chat.ts:10`. |
| 8   | Web client already holds history in the needed shape.                                                                                                                                                                                                             | `web/src/types/chat.ts:15-22` — `Message { role, content }`.                                                                    |
| 9   | `FakeGenerator` records `question` per call — how you prove the generator gets the ORIGINAL question.                                                                                                                                                             | `test-fixtures/fake-generator.ts:13-27`.                                                                                        |
| 10  | **No implementation of any of this exists.** `grep -rn "rewriteQuery\|condense\|conversationHistory\|chatHistory\|priorTurns"` over `packages/` + `apps/` → **zero hits**. No `chat_session`/`chat_message` table or migration exists (13 tables, `0000`→`0018`). | `packages/db/src/schema.ts`.                                                                                                    |
| 11  | `answerId` is **per-answer only** and does not anticipate threading — no `session_id`, `previous_answer_id`, or sequence column.                                                                                                                                  | `schema.ts:386-387, 403-405`.                                                                                                   |

## 0b. Allowed APIs — rerank providers (verified against official docs)

> **Headline: the "both providers share one shape" assumption in `reranker.ts:5-8` is TRUE today.** No field-name or nesting mismatch. The client will not silently return wrong results or throw. Task A2 is therefore _small_ — three efficiency/currency fixes, not a rewrite.

**Cohere** — `POST https://api.cohere.com/v2/rerank` ([ref](https://docs.cohere.com/reference/rerank))

- Request: `model`, `query`, `documents: string[]`, `top_n?`, `max_tokens_per_doc?` (default 4096), `priority?`.
- **v2 removed object support for `documents`** — strings only. The code is correct.
- Response: `{ results: [{ index, relevance_score }], id, meta }`. `index` is 0-based ("Original document list index"); `relevance_score` normalized to [0,1]; sorted best-first.
- Headers: `Authorization: Bearer` + `Content-Type: application/json`. Nothing else.
- Models: `rerank-v4.0-pro`, `rerank-v4.0-fast`, `rerank-v3.5`, `rerank-english-v3.0`, `rerank-multilingual-v3.0`. **The code's `rerank-v3.5` default is live and not deprecated**, but two generations back; v4.0 adds a 32k context window (v3.5 is 4096).
- `return_documents` defaults **false**.
- Limits: hard error above 10,000 documents; ≤1,000 recommended. **Rate limit: trial keys 10 req/min, production keys 1,000 req/min.**

**Jina** — `POST https://api.jina.ai/v1/rerank` (verified against the live OpenAPI spec at `https://api.jina.ai/openapi.json`)

- Request: `query`, `model`, `documents` (strings or `TextDoc`), `top_n?`, `return_documents?`, `max_doc_length?`, `return_embeddings?`.
- Response: `{ model, object: "list", usage: { total_tokens }, results: [{ index, relevance_score, document?, embedding? }] }`. `index` 0-based; sorted descending.
- Models include `jina-reranker-v3.5` (131K input tokens, 93 languages), `jina-reranker-v3`, `jina-reranker-m0`, and the code's default `jina-reranker-v2-base-multilingual` — **still live in the API enum**.
- **`return_documents` defaults `true`** — Jina echoes the full text of every reranked chunk back. The code never sets it.
- Rate limits: Free 100 RPM / 100K TPM; Paid 500 RPM / 2M TPM.

**Explicitly NOT verified — do not put numbers in a decision doc without checking the dashboard:**

1. Cohere per-search API pricing (absent from cohere.com/pricing; third-party sources conflict by 2× — $0.001 vs $0.002/search).
2. Jina per-1M-token pricing (authenticated dashboard only).
3. Any Cohere "recommended for English" model statement — the docs never say it.
4. Whether Cohere's 500-token _billing_ split and its 4,093-token _truncation_ chunking are independent mechanisms. If they are, this repo's ~800-token chunks bill as **~2 documents each**, so a 60-candidate pool ≈ 2 search units, not 1.

**Anti-pattern guard:** do not invent request fields because they "should" exist. Only send fields listed above.

## 0c. Prior art for conversation memory — a full design exists, and it contradicts the obvious approach

**Read this before writing any Track B code.** A complete server-side session
design was researched on 2026-06-07 and never built:

- **`docs/AUTH-AND-SESSIONS-RESEARCH.md` Part 2 (lines 123–275)** — 3-table Drizzle schema, purge, RLS, encryption. `:125` "roll your own with Drizzle (3 tables)". Crucially `:220-226`, **"Stateful endpoint, not client-passed history"**: _"Teams and SMS are stateless webhook receivers… They physically cannot hold history. So state must be server-side."_
- **`docs/CPA-KB-ADOPTION-PLAN.md:207-238`** — "Phase 5 — Server-side chat session storage". `:216` names four tables; `:229` acceptance criterion: _"Follow-up question ('and for 2022?') is rewritten to a standalone query before retrieval (assert the rewrite step ran)."_
- **`docs/CPA-KB-IMPLEMENTATION-SPEC.md:46`** — FR-6, and `:157-160` Phase E.
- **`docs/AUTH-AND-SESSIONS-RESEARCH.md:228-243`** — _"query condensation: `LLM(history + follow-up) → standalone query → embed → pgvector`"_, window "last 6–8 turns".

**Against that, three decisions on record point the other way:**

- **`docs/ARCHITECTURE.md:187`** — _"**Not a chat platform.** … Conversation memory, multi-turn refinement, and tool use beyond retrieval live in the consuming agent."_ This directly contradicts `AUTH-AND-SESSIONS-RESEARCH.md:220-226`. **Nothing in the repo reconciles them.**
- **`docs/PLAN-CHAT-FRONTEND.md:10, 237`** — sessions deliberately ephemeral: _"No DB, no persistence endpoints… ❌ Do NOT add DB tables, persistence endpoints, or localStorage for sessions."_
- **`docs/superpowers/specs/2026-07-16-teams-bot-design.md:167`** — multi-turn explicitly out of scope for v1.

**And a rule-out that does NOT apply here, but reads like it does:**
`~/dev/cpa-consulting/docs/rag/findings/r1-retrieval-open-items.md:26` marks
_"Query rewriting / decomposition (HyDE, multi-query, step-back, sub-question) —
**Not worth building for this corpus's query pattern**"_, because staff ask
single-document procedural questions. **That rule-out is about single-turn
rewriting to fix vocabulary mismatch. It is not about conversational
condensation of a follow-up**, which is a different problem — and the same
research file's sibling, `r2-domain-answer-quality.md:470-477`, is the source of
this plan's A-before-B ordering: _"The evidence says **add the reranker first**;
treat query rewriting as unproven under production constraints."_ No document in
either repo draws this distinction. **Draw it explicitly in any write-up, or the
next reader will cite r1 to kill this work.**

---

# Track A — Enable reranking safely

**Why this is not "flip an env var":** the reranker sends **firm SOP chunk text**
to a third-party vendor. Every other outbound path — embeddings, generation,
audit-log shipping — is gated by `EgressPolicy`. The audit sink's own doc comment
states the principle: skipping the gate "would make this the only outbound path
in the system with zero egress control." **Reranking is currently that path.**

### Task A1: Gate the reranker on `EgressPolicy` (FIRST)

**Files:** modify `packages/rag/src/retrieval/reranker.ts` (opts; `rerank()` at `:35`; `createReranker` at `:79`), `packages/runtime/src/index.ts:150`; test `packages/rag/src/retrieval/reranker.test.ts` (7 existing tests — read first).

**Interfaces:** `createReranker(cfg, opts?: { egressPolicy?: EgressPolicy })`, mirroring `createEmbeddingProvider` (`embeddings/factory.ts:17-23`). Default to `EgressPolicy.fromEnv()` inside the class, as `GeminiGenerator` does (`generator.ts:197`).

- [x] **Step 1: Failing tests.** ✅ 4 added to `reranker.test.ts`. Confirmed RED for the right reason first — both failures were `TypeError: Cannot read properties of undefined (reading 'ok')`, i.e. the code went straight to `fetch` instead of refusing.
- [x] **Step 2:** ✅ `egressPolicy?` on opts, defaulting to `EgressPolicy.fromEnv()` (matching `GeminiGenerator`); `assertAllowed` called **after** the empty-candidates short-circuit.
- [x] **Step 3:** ✅ `createReranker(config.rerank, { egressPolicy })` — `runtime/index.ts:153`.
- [x] **Step 4:** ✅ `env.example` documents the required host, the silent-degradation failure mode, and the Cohere trial-key rate limit from Phase 0b.

**✅ COMPLETE 2026-08-01.** `pnpm -r build` 0 · `@rag/rag` 151 tests · full workspace unit suite 455 tests · lint 0 errors · `typecheck` still exactly the 5 pre-existing `eval-faithfulness.spec.ts` errors. Both greps hit (`reranker.ts:66`, `runtime/index.ts:153`).

**Two decisions made during implementation, worth knowing:**

1. **The empty-candidates short-circuit runs BEFORE the egress check, and there is a test pinning that order.** A zero-candidate rerank makes no network call, so refusing it on egress grounds would fail a query whose text was never going to leave the process.
2. **The three pre-existing `HttpCrossEncoderReranker` tests had to gain an explicit `EgressPolicy`.** They passed before only because no check existed. They now pass `new EgressPolicy(["example.test"])` rather than relying on `fromEnv()`, so the suite does not depend on the runner's `EGRESS_ALLOWED_HOSTS`. If you see those three fail with `EgressError`, that is the guard working, not a regression.

### Task A2: Three small fixes from the verified API contract

Scope confirmed small by Phase 0b — the shape is correct. Do **only** these.

- [ ] **Step 1:** Send `return_documents: false` on the Jina path. It defaults `true`, so today every response echoes back the full text of all 60 candidates — pure wasted bandwidth and parse cost. Cohere already defaults false; this asymmetry means the "shared shape" holds for field _names_ but not _defaults_. Add a comment saying exactly that.
- [ ] **Step 2:** Add a test that captures the `fetch` spy's `body`, `JSON.parse`s it, and pins the exact request shape per provider, so the wire contract stops being an assumption.
- [ ] **Step 3:** Decide on model defaults. `rerank-v3.5` and `jina-reranker-v2-base-multilingual` are both live and not deprecated — **do not change them reflexively**. If you move to `rerank-v4.0-*` or `jina-reranker-v3.5`, do it as a deliberate, recorded choice (v4.0's 32k context vs v3.5's 4096 matters only if chunks approach that, which at ~800 tokens they do not).

### Task A3: Decide the rerank score contract

`relevance_score` is destructured in the response type and then **discarded** (`reranker.ts:60-66`); returned objects keep their pre-rerank RRF `score` while array _order_ reflects rerank relevance. Any consumer that sorts by `.score` or displays it will disagree with the order — and one does: the MCP `search_documents` tool prints `score ${score}` (`mcp/tools/search-documents.ts:51`), and `audit_log.topScore` records `retrieved[0].score`.

- [ ] **Step 1:** Decide — either (a) keep RRF score and document loudly that order ≠ score after reranking, or (b) carry the rerank score in a new optional field (`rerankScore`) and leave `score` alone. **(b) is preferred**: it is additive, it keeps `topScore`'s meaning stable across the rerank on/off switch, and it makes the disagreement inspectable instead of invisible.
- [ ] **Step 2:** Implement + test. Note the interaction with review § M-4 (scores are relative, top hit always 1.0) — this task does not fix M-4, and must not be described as if it does.

### Task A4: Decide the TRI posture for rerank egress

Generation has `GENERATION_TRI_POLICY` (default `warn`, forced `block` under `COMPLIANCE_MODE=client-data`). Rerank egress has **no equivalent** and ships the same chunk text.

- [ ] **Step 1:** Reuse the same policy rather than inventing a second knob. Under `client-data`, refuse a hosted reranker at construction — exactly as `createEmbeddingProvider` refuses a non-local embedder (`embeddings/factory.ts:24-31`).
- [ ] **Step 2:** Implement + test. Record the decision in the review's H-5 section.

### Task A5: Verify the HNSW pool interaction at production scale

Finding 4: with reranking on, the dense CTE runs `LIMIT 480` while `hnsw.ef_search` stays 100. **This could not be verified locally** — the dev DB holds 14 chunks, far below both bounds; production holds ~6,175.

- [ ] **Step 1:** Against a production-sized dataset (a restored dump per `docs/BACKUP-RESTORE-DRILL.md` — **never** live with a writable handle; use `createReadOnlyDb` + `assertReadOnly`), compare row counts and top-12 overlap at `ef_search=100 LIMIT 480` vs `ef_search=500 LIMIT 480`.
- [ ] **Step 2:** If recall degrades, plumb `efSearch` through `Retriever` → `hybridSearch` (the parameter already exists, `queries.ts:495-498`) and set it ≥ the effective pool. Add a test.
- [ ] **Step 3:** Record the measurement either way — a null result stops someone re-investigating.

### Task A6: Enable, measure, record

- [ ] **Step 1:** Set `RERANK_PROVIDER`, `RERANK_API_KEY`, add the host to `EGRESS_ALLOWED_HOSTS`. ⚠ **Check the key tier first — a Cohere trial key is 10 req/min**, which a 20-person pilot will exhaust immediately and which surfaces as reranker errors silently degrading to RRF order (`retriever.ts:111-116`).
- [ ] **Step 2:** Re-run `pnpm eval` and `pnpm eval:real` (gates: `API_TOKENS` non-empty, `AUTH_PROVIDER=static-token`, egress host allowed — `docs/EVAL-AND-FEEDBACK.md:136-144`).
- [ ] **Step 3:** Append to `docs/EVAL-BASELINE.md`.

> ⚠ **Expect the eval to show little or nothing.** The starter corpus sits at MRR
> 1.000 and cannot distinguish reranked from unreranked (§ H-1b). That is a known
> property, **not** evidence reranking is useless. The justification is
> structural: this corpus has confirmed near-duplicates, draft-vs-finalized pairs,
> and year-versioned twins — exactly what a cross-encoder resolves and RRF cannot.
> Record the flat result honestly; do not let it become an argument for reverting.

---

# Track B — Conversation memory

### Task B0 — ✅ DECIDED 2026-08-01 (no longer blocking)

**Decision: ephemeral in-flight history for the prototype; a server-side session
store is the destination.** Recorded by Marcus, 2026-08-01.

This resolves the contradiction between `ARCHITECTURE.md:187` ("memory lives in
the consuming agent") and `AUTH-AND-SESSIONS-RESEARCH.md:220-226` ("state must be
server-side") as a **sequencing** answer rather than a winner: the architecture
doc describes the service boundary _today_, the research doc describes where it
is going. Neither is retracted; both get a pointer to this decision.

**Why ephemeral is genuinely good enough to test with** — and the argument the
prior docs do not make: a server-side store creates a **conversation-transcript
retention surface this system has deliberately never had.** `audit_log` stores
only `questionHash` — _"SHA-256 of the question text (no raw PII stored here)"_
(`schema.ts:363-364`) — and the docs-gap digest was built aggregate-only for the
same reason. Whether to retain question text is **already an open, unowned
decision** (the firm launch status P1 #5, _"a real privacy tradeoff; Marcus's call"_).
Full transcripts are a strictly larger version of that same undecided question.
Ephemeral history buys the usability win **without forcing it**, and preserves
the deliberate `PLAN-CHAT-FRONTEND.md:10` ephemeral-sessions decision.

- [ ] **Step 1:** Add a one-paragraph pointer to this decision in `ARCHITECTURE.md:187` and `AUTH-AND-SESSIONS-RESEARCH.md:220-226` so neither reads as unqualified. Do **not** delete either — the research design is still the target.
- [ ] **Step 2:** Note in `CPA-KB-ADOPTION-PLAN.md:207-238` (Phase 5) that its query-condensation acceptance criterion (`:229`) is satisfied early by this work, and that Phase 5's remaining scope is now **persistence only**, gated on the P1 #5 retention decision.

---

#### ⚠ The constraint this decision puts on every task below

Because server-side storage **is** the destination, the swap must be a
**transport-layer change only**. Build the seam that way now, or Track B v2
becomes a re-plumb of five layers instead of one route.

The rule: **`@rag/services` receives already-resolved history and does not know
where it came from.** `AskInput.history` is the seam. Today the route populates
it from the request body; later the route populates it from a `sessionId` lookup.
`contextualizeQuestion`, `ask()`, `askStream()`, and every test against them stay
byte-identical across that change.

Two consequences that override the obvious implementation:

1. **Truncation and turn-capping policy lives server-side, in the condenser —
   never in the web client or the bot.** Clients send what they have (bounded by
   the zod cap for DoS reasons only); the service decides how many turns actually
   feed the rewrite. If a client decides "last 4 turns," that policy has to be
   re-implemented identically in three places today and moved again tomorrow.
2. **Do not add a `sessionId` field yet.** A field that is accepted but ignored
   is worse than absent — it implies a persistence guarantee that does not exist.
   Add it in v2, alongside the thing that honours it.

**The design, and the one line that matters:** the rewritten question is used
**for retrieval only**. `deps.generator.answer(...)` keeps receiving
`input.question`. History in the generation prompt would invite the model to
answer from conversation instead of documents — the one thing `SYSTEM_PROMPT` is
built to prevent. Forged history can only influence what a caller retrieves
**within its own already-enforced scope**.

### Task B1: The condenser (pure, provider-free)

**Files:** create `packages/rag/src/retrieval/contextualize.ts` + `.test.ts`; export from `packages/rag/src/index.ts`.
**Copy from:** `claim-extractor.ts:118-130` for the `CompleteFn` port and its "why not `Generator`" doc comment. **Reuse the exported `CompleteFn`; do not declare a second one.**

```ts
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}
export async function contextualizeQuestion(
  complete: CompleteFn,
  question: string,
  history: readonly ConversationTurn[],
  opts?: { maxTurns?: number; maxCharsPerTurn?: number },
): Promise<string>;
```

- [ ] **Step 1: Failing tests** (fake `CompleteFn`, no network):
  - Empty history ⇒ returns `question` unchanged and **never calls `complete`** (turn 1 must add zero latency).
  - With history ⇒ returns the trimmed rewrite.
  - `complete` throws ⇒ returns the ORIGINAL question (**fail open** — a rewrite failure must never fail the query).
  - Empty/whitespace model output ⇒ falls back to the original.
  - History truncated to last `maxTurns` (default 6, per `AUTH-AND-SESSIONS-RESEARCH.md:236`'s "last 6–8 turns") and each turn to `maxCharsPerTurn`.
- [ ] **Step 2:** Implement. Prompt: resolve pronouns/elisions from prior turns; output **only** the rewritten question; echo verbatim if already standalone.
- [ ] **Step 3:** Header comment: the output is a **search query, never instruction text**, and must not reach the generation system prompt.

### Task B2: Thread `history` through the service

**Files:** `packages/services/src/ask.ts` (`AskInput:42-48`, `ask():120-154`, `askStream():200-246`, `buildQuery():111-118`), `deps.ts`, `ask.test.ts` (read `:42` first for the harness).

- [ ] **Step 1: Failing tests:**
  - With history, `retriever.search` receives the **rewritten** query.
  - With history, `FakeGenerator.calls[0].question` is the **ORIGINAL** question. ← load-bearing.
  - Without history, no condenser call; behavior byte-identical to today.
  - Condenser throws ⇒ retrieval proceeds with the original question.
- [ ] **Step 2:** Optional `history?: ConversationTurn[]` on `AskInput`; optional `contextualize?` on `ServiceDeps`. Both optional so existing callers compile untouched.
- [ ] **Step 3:** Apply in **both** `ask()` and `askStream()` — separate code paths, and exactly the kind of change that lands in one and not the other.

### Task B3: Runtime wiring

- [ ] Build a `CompleteFn` from the configured generation provider in `buildCoreDeps`, copying `makeGeminiComplete` (`scripts/extract-corpus.ts:213-223`). It must honour the **same** `EgressPolicy` and TRI policy as generation — another provider call carrying firm text.
- [ ] Null when `config.generation` is absent, so `askQuestion` degrades to today's single-turn behavior rather than throwing.

### Task B4: Transports

- [ ] **API:** bounded `history` on `AskBody` (`api/routes/ask.ts:17-23`) — `z.array(z.object({ role: z.enum(["user","assistant"]), content: z.string().max(4000) })).max(12).optional()`.
- [ ] **MCP:** same optional field on `mcp/tools/ask.ts:16-41` with a `.describe()`.
- [ ] **Audit:** `questionHash` stays the hash of the **original** question. Add nothing that could reconstruct the conversation — Phase 3's privacy decision (`queries.ts:1094-1106`) forbids storing question content, and history _is_ question content.

### Task B5: Web surface

- [ ] `web/src/lib/stream-chat.ts:9-13` — add `history?` to `AskRequest`.
- [ ] `web/src/app/api/chat/route.ts` — BFF forwards the body as-is; confirm nothing strips the new field.
- [ ] `web/src/components/chat-interface/chat-interface.tsx:38-69` — send `session.messages` **as-is**, minus the just-added empty assistant placeholder (`:44`). Strip `citations`/`answerId`; only `role` + `content` cross the wire.
- [ ] ⚠ **Do not slice to "the last N turns" here.** Per B0's constraint, how many turns feed the rewrite is the condenser's decision (`maxTurns`, Task B1). A client-side slice is the same policy re-implemented per surface, and it has to be found and removed again when history moves server-side. The zod cap in B4 is a DoS bound, not a policy — if a session ever exceeds it, that is the cap doing its job, not a reason to add client-side trimming.

### Task B6: Teams surface

- [ ] `teams-bot/src/rag-client.ts:28-31` — add `history?` to `AskKbInput` and forward it.
- [ ] `teams-bot/src/bot.ts` — bounded ring buffer in the existing `deps.storage`, keyed exactly like `pendingQuestionKey` (`:109-121`), written after each successful answer.
- [ ] The bot's buffer bound is a **storage** bound (don't grow a `MemoryStorage` entry without limit), NOT the rewrite-window policy — size it comfortably above the condenser's `maxTurns` so the two are not silently coupled. If they were equal, changing `maxTurns` later would silently do nothing on Teams.
- [ ] Header note: this inherits `MemoryStorage`'s single-instance constraint (`index.ts:49-53`). Acceptable for a 20-user pilot; it degrades to single-turn (not to a wrong answer) on restart. **This is the concrete, accepted cost of shipping ephemeral history first** — state it, don't hide it.

---

# Final Phase — Verification

- [ ] `pnpm -r build` · `pnpm lint` (0 errors) · `pnpm -r --filter '!@rag/e2e' run test` green.
- [ ] `pnpm typecheck` shows **only** the 5 pre-existing `eval-faithfulness.spec.ts` errors.
- [ ] e2e retrieval/eval/metadata specs pass against a real Postgres.
- [ ] `grep -n "assertAllowed" packages/rag/src/retrieval/reranker.ts` → hit (A1 landed).
- [ ] `grep -rn "history" packages/rag/src/generation/generator.ts` → **no hits** (history never reached the generation prompt).
- [ ] Manual: ask a question, then a follow-up ("what about for partnerships?"), on web and in Teams. Confirm the follow-up retrieves relevantly **and** still cites documents.
- [ ] Update `docs/PROTOTYPE-READINESS-REVIEW-2026-08-01.md`: mark H-5 and H-2 resolved; add the reranker egress-gap finding to the record.
- [ ] Both `docs/ARCHITECTURE.md:187` and `docs/AUTH-AND-SESSIONS-RESEARCH.md:220-226` carry a pointer to the B0 decision (Task B0 Step 1). Leaving either unqualified is how the next person re-opens this.
- [ ] **Prove the v2 seam holds:** `grep -rn "slice(-\|maxTurns\|last N" apps/web/src apps/teams-bot/src` finds no rewrite-window policy outside the condenser. If a client is trimming, the transport-only swap to a server-side store is already broken.
- [ ] `grep -rn "sessionId" packages/services/src apps/api/src` → no hits. A field accepted but not honoured implies a persistence guarantee that does not exist (B0 constraint 2).
