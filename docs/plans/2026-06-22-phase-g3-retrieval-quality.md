# Phase G3 — Retrieval Quality: Plan (2026-06-22)

**Status:** Phase 1 ✅ DONE (committed `8753199`, merged to `main`). Phase 2 ready. Phase 3 revised per plan-review (2026-06-22) — judge hardened, corpus-leakage + relevance rules added, asserts → report-with-loose-floor, judge-validation sub-phase added. Phases are self-contained; each can run in a fresh chat context.

**Revision note (plan-review 2026-06-22):** A RAG/LLM specialist review found Phase 3's _retrieval_ scaffolding sound but the _LLM-judge_ half under-specified and at risk of producing a "precise-looking number nobody should trust." All review findings (D1–D9 + corpus-leakage/relevance) are folded into Phase 3 below. The single biggest fix: **treat the judge as a measurement instrument that must itself be made deterministic, structured, and validated against human labels — not a drop-in metric.**

**Scope:** Three deliverables, in priority order:

1. **Prod DB migration drift** — verify/apply `0002_documents_original_storage` on the Railway DB (latent 500 on every `/ask` + `/search`); close the process gap that let it drift.
2. **Record the current baseline** — write the dated FakeEmbedder eval numbers into `docs/`, clearly caveated as a regression trip-wire (NOT a real-quality measurement).
3. **Build the REAL Phase G3 harness** — 30–50 labeled CPA questions + a real Gemini embedder path + an LLM faithfulness/citation judge wired into `pnpm eval`; record the real baseline.

> Origin: the local live DB was found missing the `storage_key` column while code in `packages/db/src/queries.ts` (`hybridSearch`) selects it. The eval harness 500'd until migration `0002` was applied locally. This plan generalizes that fix and finishes the G3 gate from `docs/PLAN-LAUNCH-READINESS.md` (§ Phase G3, lines 254–281).

---

## Phase 0 — Documentation Discovery (consolidated facts)

All findings below are **verified from source** (three discovery passes). Treat this as the "Allowed APIs" list — do not invent methods beyond these.

### Migration mechanism — `packages/db/src/migrate.ts` (87 lines)

- **Two-phase, idempotent.** Phase 1 always runs `0000_init.sql` as a single transaction blob (it has `DO $$…$$` blocks + HNSW/GIN/tsvector that drizzle's parser can't split, so it is deliberately NOT in the journal). Phase 2 hands off to drizzle's `migrate()` which reads `drizzle/meta/_journal.json` and applies anything not in `__drizzle_migrations`.
- **Env:** reads `DATABASE_URL` (line ~30); exits 1 if unset. Pool `max: 2`.
- **Journal** (`drizzle/meta/_journal.json`): `idx 0 → 0001_documents_metadata_gin`, `idx 1 → 0002_documents_original_storage`. `0000` is intentionally absent.
- **`0002_documents_original_storage.sql`** is idempotent: `ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_key text, storage_bucket text, original_size_bytes bigint;`
- **Run with:** `DATABASE_URL=… pnpm --filter @rag/db migrate` (root alias: `pnpm db:migrate`).

### The drift bug — column references

- `packages/db/src/queries.ts`, `hybridSearch`, **line ~477:** `(doc.storage_key IS NOT NULL) AS has_original`. Missing column ⇒ Postgres `42703` ⇒ 500 on EVERY hybrid search (so every `/ask` and `/search`).
- Other refs (all in `@rag/db`, none in apps yet): `deleteDocumentByExternalId` (returns `storage_key`, ~line 228), `setDocumentStorage` (UPDATE, ~lines 253–255), schema `packages/db/src/schema.ts` lines 108–110.

### How prod is migrated — **manual, not automatic**

- `apps/api/Dockerfile` & `apps/worker/Dockerfile`: `CMD ["node", "dist/main.js"]` — no pre-start migrate.
- `apps/api/railway.json` & `apps/worker/railway.json`: only healthcheck + restart policy. **No release/pre-deploy migration hook.**
- Documented procedure (`docs/PHASE-2-RAILWAY-RUNBOOK.md`, Step 5, lines ~199–236): `railway ssh --service rag-worker` → `cd /app && pnpm --filter @rag/db migrate`.
- **Boot-order trap** (runbook lines ~86–92, ~201–204): `rag-api`/`rag-mcp` run `assertRequiredIndexes` at boot and crash-loop until migrations exist — so you can't SSH into them. Run migrations from **`rag-worker`** (no index assert once it has `API_TOKENS`), then redeploy api/mcp.
- `docs/DEPLOYMENT.md` (lines ~52–69) states `pnpm db:migrate` "is idempotent — safe to re-run on every deploy" but nothing actually runs it on deploy. **That is the process gap.**

### Eval harness — `tests/e2e/src/eval/` + `specs/retrieval-eval.spec.ts`

- **`run-eval.ts`** exports `seedEvalCorpus(db, sourceId)`, `runRetrievalEval(db, externalIdByDocId, opts)`, `sweepWeights(...)`, `formatReport`, `formatMisses`, types `RrfWeights`/`PerQuestionResult`/`EvalReport`, const `DEFAULT_KS = [1,3,5,10]`.
  - **Retriever build, line ~111:** `new Retriever(db, new FakeEmbedder(), { topK: poolK, denseWeight, sparseWeight })` ← **this is the embedder swap point.**
- **`corpus.ts`** exports `EvalDoc {externalId,title,text}`, `EvalQuestion {id,query,relevant[],note?}`, `EVAL_DOCS` (14 docs), `EVAL_QUESTIONS` (17 q; 14 single-, 3 multi-doc).
- **`metrics.ts`** exports `recallAtK`, `precisionAtK`, `ndcgAtK`, `reciprocalRank`, `mean` (pure, no DB). Reuse as-is.
- **`retrieval-eval.spec.ts`** thresholds (lines 61–64): `recall@5 ≥ 0.8`, `recall@3 ≥ 0.7`, `ndcg@5 ≥ 0.6`, `mrr ≥ 0.6`. Lifecycle: `openTestDb()` → `truncateAll(db)` → `createCustomSource(db,"eval-corpus")` → `seedEvalCorpus(db,sourceId)`.
- **Seeding path:** `seedEvalCorpus` → `FakeConnector(plainTextDoc(...))` → `runOneIngestion(db, sourceId, connector)`. **`tests/e2e/src/helpers/ingestion.ts` hardcodes `new FakeEmbedder()` (~line 30)** — so documents are embedded with the fake too. A real-embedder eval must override the embedder on BOTH the ingestion side and the retriever side.
- **`env.ts`:** `env.databaseUrl = E2E_DATABASE_URL || DATABASE_URL || postgres://rag:rag@localhost:5432/rag`. `pnpm eval` = `vitest run src/specs/eval-metrics.spec.ts src/specs/retrieval-eval.spec.ts`.

### Real embedder + judge — production interfaces (copy these)

- **`EmbeddingProvider`** (`packages/core/src/interfaces.ts` 14–38): `embed(text)`, `embedBatch(texts)`, optional `embedQuery(text)` (Gemini uses `RETRIEVAL_QUERY` vs `RETRIEVAL_DOCUMENT`).
- **`createEmbeddingProvider(cfg: Config["embedding"])`** (`packages/rag/src/embeddings/factory.ts` 16–47) — `gemini` requires `cfg.apiKey`. `GeminiEmbeddingProvider` defaults `gemini-embedding-001`, dims 768, retries 5, batch 100.
- **`Generator`** (`packages/rag/src/generation/generator.ts` 14–29): `answer(question, context): Promise<GenerationResult>`, `answerStream(...)`. **`createGenerator({provider,model,apiKey,maxOutputTokens})`** (lines 219–239). Use it to generate the ANSWER under test (`gemini-2.5-flash`).
- **⚠ Judge-critical facts (drive §3C hardening):**
  - `Generator` **hardcodes `temperature: 0.2`** (`generator.ts` ~128, 148, 182, 204) and uses **no JSON mode** (free-text system prompt). You CANNOT get a temp-0 / structured-output judge through `Generator.answer()`. The judge needs its own `GoogleGenAI.generateContent` call with `config: { temperature: 0, responseMimeType: "application/json", responseSchema }` — built in the e2e helper `judge.ts`, NOT a `@rag/core` interface (so the "don't invent a core interface" rule still holds).
  - `GenerationResult.citations` are **derived deterministically from context order** by `buildCitations` (`generator.ts` 88–100) — they are NOT the `[N]` markers the model emitted in prose. Citation-correctness MUST parse `[N]` tokens out of `answer` text and map index→documentId→externalId itself (see §3C step 3).
  - The answer generator and the judge would share the **Gemini family ⇒ self-preference bias** (a model rates its own family's output higher). Note it; optionally judge with a different model.
- **Config/env** (`packages/core/src/config.ts`, `env.example`): `EMBEDDING_PROVIDER=gemini`, `EMBEDDING_MODEL=gemini-embedding-001`, `EMBEDDING_DIMENSIONS=768`, `GEMINI_API_KEY`, `EMBEDDING_MAX_RETRIES=5`; `GENERATION_PROVIDER=gemini`, `GENERATION_MODEL=gemini-2.5-flash`, `GENERATION_MAX_OUTPUT_TOKENS`. Generation reuses the embedding API key.
- **Working real-embedder example to copy:** `scripts/reembed-chunks.ts` (uses `createEmbeddingProvider(config.embedding)` + `embedder.embed()`).
- **Fakes to mirror:** `tests/e2e/src/fakes/fake-embedder.ts`, `fake-generator.ts`.

### Anti-patterns to avoid (these APIs do NOT exist / are wrong)

- ❌ No `JudgeProvider`/`createReranker` judge exists — build the judge on the **existing `Generator`** interface, don't invent a new core interface unless a phase explicitly adds one.
- ❌ Don't call a non-existent `embedder.embedDocuments()` — the methods are `embed` / `embedBatch` / `embedQuery`.
- ❌ Don't add a migration to the journal by hand for `0000` — it is bootstrap-only by design.
- ❌ Don't make `pnpm eval` require `GEMINI_API_KEY` unconditionally — keep the default run deterministic/free; gate the real path behind a flag (Phase 3).

---

## Phase 1 — Prod DB migration: verify, fix, prevent — ✅ DONE (2026-06-22)

**Outcome:** Verified prod (`rag-postgres`) was at `0001` and missing the three storage columns — but prod was **NOT broken**: the `storage_key` feature is uncommitted WIP, and the deployed image had zero `storage_key` refs (deployed code matched deployed schema). The real risk was a **next-deploy landmine**. Fixed by adding `deploy.preDeployCommand: "pnpm --filter @rag/db migrate"` to `apps/worker/railway.json` (single migration owner; runs against the new image before traffic) + documenting ownership/ordering in `docs/DEPLOYMENT.md`. Committed `8753199`, merged to `main`. The migration applies automatically when this branch ships (worker first). Residual checklist item: confirm a live prod `/search` returns 200 **after** the branch deploys.

<details><summary>Original Phase 1 plan (for reference)</summary>

**Goal:** Guarantee the Railway prod DB has `storage_key`/`storage_bucket`/`original_size_bytes`, and that future DBs can't silently drift.

### 1A. Verify (read-only first)

1. Connect to the prod DB (TCP-proxy or `railway ssh --service rag-worker`). Inspect:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name='documents'
     AND column_name IN ('storage_key','storage_bucket','original_size_bytes');
   ```
2. Also confirm which migrations are recorded:
   ```sql
   SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at;
   ```
   (Local live DB had only `0001` recorded; `0002` pending.)

### 1B. Apply if missing (idempotent, safe to re-run)

Per `docs/PHASE-2-RAILWAY-RUNBOOK.md` Step 5 — run from the **worker** (api/mcp may be crash-looping):

```bash
railway ssh --service rag-worker
cd /app && pnpm --filter @rag/db migrate
exit
# then, if api/mcp were crash-looping on assertRequiredIndexes:
railway redeploy --service rag-api --yes
railway redeploy --service rag-mcp --yes
```

Confirm with the 1A query (3 columns present) and a live `/search` returning 200.

### 1C. Close the process gap (pick ONE; recommend a release command)

The drift happened because **nothing runs `db:migrate` on deploy**. Make it automatic:

- **Recommended — Railway pre-deploy/release command** on the worker service (worker boots without the index assert): add a `deploy.startCommand` wrapper or Railway "pre-deploy command" that runs `pnpm --filter @rag/db migrate` before the app starts. Edit `apps/worker/railway.json` (`deploy` block) per Railway docs (use context7 / Railway MCP to confirm exact key — `preDeployCommand` vs `startCommand` wrapper).
- **Alternative — entrypoint wrapper:** a small `apps/worker/scripts/start.sh` that runs `node dist/migrate.js || pnpm --filter @rag/db migrate` then `exec node dist/main.js`; point the worker Dockerfile `CMD` at it. Keep migrate ONLY on the worker, not api/mcp (avoid N services racing the same migration).
- **Minimum — CI guard:** a GitHub Action step that runs `pnpm db:migrate` against the target DB on deploy, plus a doc update.

Whichever is chosen, **update `docs/DEPLOYMENT.md`** so the "safe to re-run on every deploy" line reflects reality (now actually automated, or an explicit manual gate in the release checklist).

### Verification checklist — Phase 1

- [ ] Prod `documents` has all three storage columns (1A query returns 3 rows).
- [ ] A real prod `/search` (or `/ask`) returns 200, not 500.
- [ ] Migration now runs automatically on deploy (release command/entrypoint) OR is an enforced checklist gate; chosen mechanism documented in `docs/DEPLOYMENT.md`.
- [ ] Re-running the migrate is still a no-op (idempotency preserved).

### Anti-pattern guards — Phase 1

- ❌ Don't run migrations from `rag-api`/`rag-mcp` while they crash-loop — use the worker.
- ❌ Don't have every service run migrate on boot (race). One owner (worker).
- ❌ Don't hand-edit prod tables with raw `ALTER` — go through `pnpm db:migrate` so `__drizzle_migrations` stays consistent.

</details>

---

## Phase 2 — Record the dated baseline (FakeEmbedder trip-wire)

**Goal:** Tick the G3 checklist item "baseline numbers recorded in a doc, dated" — honestly labeled.

### What to do

1. Run the harness against the live local DB (already migrated in this session):
   ```bash
   DATABASE_URL="postgres://rag:rag@localhost:5432/rag" pnpm eval
   ```
2. Create `docs/EVAL-BASELINE.md` recording, **dated 2026-06-22**, the numbers from `formatReport` + the weight sweep:
   - Default weights (dense=0.7/sparse=0.3), 17 questions: recall@{1,3,5,10}, precision@k, nDCG@k, MRR; the single recall@5 miss (`q-pg-indexes`); the flat weight sweep.
   - Observed this session: recall@1 91.2%, recall@3 97.1%, recall@5 97.1%, recall@10 100%, nDCG@5 97.3%, MRR 1.000.
3. **Caveat prominently** (copy the spec's honesty note, `retrieval-eval.spec.ts` lines 99–104): this uses the deterministic **FakeEmbedder (bag-of-words)**, so dense==sparse signal and the weight sweep is meaningless; these are a **regression trip-wire**, NOT a real-quality or production-weight conclusion. State that the REAL G3 baseline (Phase 3) supersedes it.

### Verification checklist — Phase 2

- [ ] `docs/EVAL-BASELINE.md` exists, dated, with the metric table + weight sweep.
- [ ] The FakeEmbedder caveat is the first thing a reader sees (not a footnote).
- [ ] Doc links to `docs/PLAN-LAUNCH-READINESS.md` Phase G3 and to this plan.

### Anti-pattern guards — Phase 2

- ❌ Don't present these numbers as production retrieval quality.
- ❌ Don't tune any weights off this sweep — it's lexically degenerate by construction.

---

## Phase 3 — Build the REAL Phase G3 harness (hardened per plan-review)

**Goal:** A real, labeled CPA eval with a real Gemini embedder and a **calibrated** LLM faithfulness/citation judge, wired into `pnpm eval` behind a flag, producing a **distribution-reported** real baseline (not a single asserted number). Mirrors `docs/PLAN-LAUNCH-READINESS.md` Phase G3 items 1–3.

> Keep the default `pnpm eval` deterministic and free. The real path is **opt-in** via an env flag so CI doesn't need a key or spend tokens.

> **Two-axis trust model (read first).** Retrieval metrics (recall/nDCG/MRR/MAP/hit-rate) are scored against human labels → trustworthy IF corpus leakage is controlled (§3A). Judge metrics (faithfulness/citation) are a model's _opinion_ → trustworthy ONLY after the judge is made deterministic + structured (§3C) AND validated against a human gold set (§3E). Do NOT present them as epistemically equal, and do NOT call anything "authoritative" until §3E passes.

### 3A. Real labeled corpus — with leakage + relevance controls

1. Author `tests/e2e/src/eval/corpus.cpa.ts` exporting `CPA_EVAL_DOCS: EvalDoc[]` and `CPA_EVAL_QUESTIONS: EvalQuestion[]` — **same types** as `corpus.ts` (copy the shape; don't change `EvalDoc`/`EvalQuestion`). 30–50 questions, each labeled with `relevant[]` externalIds. Synthetic/public/consented CPA content only (Phase G1; no real client data).
2. Documents: realistic CPA KB material (tax topics, filing procedures, rulings) with distinct-enough content that labels are defensible.
3. **Leakage control (fixes review C4 — the existing corpus admits term-sharing, `corpus.ts:15–19`, which inflates recall).** Write questions in **natural user phrasing** — how a CPA would actually ask — ideally by someone NOT reading the target doc; **prohibit copying doc terminology**. The existing `q-hnsw`/`pg-hnsw` pair is the anti-example (near-verbatim salient terms).
4. **Automated leakage tripwire.** Add a tiny check (script or test) computing token-overlap (Jaccard) between each question and its labeled doc(s); **flag outliers** (questions whose overlap is far above the corpus median) as likely lexical echoes to rewrite. This is a guard, not a gate — log flagged questions.
5. **Relevance model (fixes review C5).** Target **≥30% multi-relevant-doc questions**; if you adopt graded relevance (0/1/2) you must extend `EvalQuestion` + `metrics.ts` (out of scope unless chosen — otherwise stay binary and **state explicitly** that under single-doc binary labels nDCG≈MRR, so reporting both is partly redundant).

### 3B. Real embedder path (opt-in)

1. Add env flag `EVAL_REAL_EMBEDDER=1` (+ require `GEMINI_API_KEY`). Unset ⇒ `FakeEmbedder` exactly as today.
2. **Inject the embedder on BOTH sides** (the fake is hardcoded in two places — this is the #1 silent-failure mode):
   - Retriever side: `run-eval.ts` line ~111 — replace `new FakeEmbedder()` with a parameterized embedder (default `FakeEmbedder`; real = the provider built in step 3).
   - Ingestion side: `tests/e2e/src/helpers/ingestion.ts` (~line 30 hardcodes `new FakeEmbedder()`) — add an optional `embedder` override to `runOneIngestion`, threaded from `seedEvalCorpus`. **Same provider/model both sides or cosine scores are meaningless.**
3. **Build via the real config slice (fixes review D9).** `createEmbeddingProvider` takes `cfg: Config["embedding"]` (`factory.ts:16`), NOT a loose literal. Construct `config.embedding` the way `scripts/reembed-chunks.ts` does (load real `Config`), then pass `createEmbeddingProvider(config.embedding)`. Don't hand-roll the object.
4. **Dimension check:** `chunks.embedding` is `vector(768)`. Keep dims 768 (Gemini default). `embedQuery`→`RETRIEVAL_QUERY` and `embedBatch`→`RETRIEVAL_DOCUMENT` are already correct in `gemini.ts:51–60` and `retriever.ts:77` prefers `embedQuery` — rely on that, don't reinvent.
5. **Embedding cache (fixes review D8 — perf/cost).** `seedEvalCorpus`→`runOneIngestion` re-embeds the whole corpus every run (`run-eval.ts:53–66`). For the real embedder add a content-hash embedding cache (repo already has the `content-hash-cache-pattern` skill + SHA-256-by-content idempotency principle) so unchanged docs aren't re-embedded across runs/seeds. Document the cache location + invalidation (provider+model+dims+text-hash key).

### 3C. Hardened LLM judge (deterministic + structured)

1. Add `tests/e2e/src/eval/judge.ts`. **Do NOT route the judge through `Generator.answer`** — it hardcodes `temperature: 0.2` and has no JSON mode (Phase 0 judge-critical facts). Instead, in `judge.ts` construct a `GoogleGenAI` client (copy the construction at `generator.ts:105–115`) and call `generateContent` with `config: { temperature: 0, responseMimeType: "application/json", responseSchema: <schema below> }`. This stays an e2e-test helper — no `@rag/core` interface invented (rule preserved).
2. **Use `Generator` only to produce the ANSWER under test:** `createGenerator({ provider:"gemini", model:"gemini-2.5-flash", apiKey, maxOutputTokens })` (`generator.ts:219–239`).
3. **Data flow per question (real path):** `retriever.search()` → `generator.answer(question, context)` → `judge(question, answer, context)`. (Faithfulness requires an answer to exist first — ordering is correct.)
4. **Judge contract:** a rubric-bearing prompt that returns JSON `{ faithfulness: 0|1|2, citationsSupported: boolean, reasoning: string }` (ordinal rubric beats a vague 0..1 float; define each level in the prompt). Parse via the `responseSchema` (no fragile regex-on-prose).
5. **Citation-correctness algorithm (fixes review C2/D3 — `GenerationResult.citations` are context-order, NOT the model's `[N]` markers).** Compute it deterministically in the harness, NOT via the judge: regex `/\[(\d+)\]/g` over `GenerationResult.answer` → dedupe indices → map each `index` via `citations[index-1].documentId` (`buildCitations`, `generator.ts:88–100`) → externalId via the `externalIdByDocId` map already built in `run-eval.ts:68–73` → compare the cited externalId set to `EvalQuestion.relevant`. Report **citation precision/recall** (cited-and-relevant over cited; over labeled). The judge's `citationsSupported` is a separate, softer signal.
6. **Self-preference guard (fixes review C3):** record in the baseline doc that generator+judge share the Gemini family. _Recommended:_ judge with a **different model** than the generator to dampen self-preference; at minimum note the bias.

### 3D. Metrics + wiring (report a distribution, don't assert a point)

1. **Add the missing IR metrics (fixes review D7)** to `metrics.ts` (pure, no DB — mirror existing fns): **hit-rate@k** (binary any-relevant-in-top-k — best single predictor of answer quality) and **MAP** (mean average precision — the standard once multi-doc labels exist, §3A.5). Keep recall/precision/nDCG/MRR. (RAGAS-style context precision/recall is a stretch goal, not required.)
2. Add `tests/e2e/src/specs/retrieval-eval.cpa.spec.ts` gated `describe.skip` unless `EVAL_REAL_EMBEDDER=1`. Seeds `CPA_EVAL_*`, runs retrieval + answer + judge.
3. **Report, don't hard-assert (fixes review C1/D1 — real embedder + judge are STOCHASTIC; one run is n=1).** Run the judge **N≥3 times per question**; report **mean ± stddev** for faithfulness/citation. The only `expect()`s are a **deliberately loose floor** proving the pipeline ran (e.g. `recall@10 > 0`, `hitRate@10 > 0`, `meanFaithfulness > 0.5`) — NOT a tight quality assertion. This mirrors the existing harness philosophy (`retrieval-eval.spec.ts:59–64` "intentionally loose … guard against regressions").
4. Extend `tests/e2e/package.json` (`eval` stays fake/deterministic; add `eval:real` for the gated spec). `EVAL_REAL_EMBEDDER=1 GEMINI_API_KEY=… pnpm --filter @rag/e2e run eval:real`.

### 3E. Judge validation (NEW sub-phase — gate for "authoritative", fixes review C3/D4)

1. **Hand-label a gold set:** ~10–15 `(question, answer, context)` triples scored for faithfulness by a human (you), stored alongside the corpus.
2. Run the §3C judge over them; compute **judge↔human agreement** (% exact match and/or Cohen's κ).
3. **Record agreement in `docs/EVAL-BASELINE.md`.** If agreement is poor (e.g. κ < 0.4), the faithfulness number is untrustworthy → iterate the rubric/model before publishing, or publish it explicitly labeled "judge unvalidated — directional only."
4. **Only after acceptable agreement** may the real numbers be recorded as the **authoritative** G3 baseline that supersedes Phase 2's trip-wire. Record: recall@k, hit-rate@k, MAP, nDCG@k, MRR, citation precision/recall, faithfulness (mean ± stddev), judge↔human agreement, dated, with the leakage-tripwire summary and the self-preference note.

### Verification checklist — Phase 3

- [ ] `CPA_EVAL_QUESTIONS.length` 30–50; every `relevant[]` non-empty and all ids exist in `CPA_EVAL_DOCS`; **≥30% multi-doc**.
- [ ] Leakage tripwire run; flagged (high-overlap) questions reviewed/rewritten or justified.
- [ ] Default `pnpm eval` runs with NO `GEMINI_API_KEY` and stays green (fake path untouched).
- [ ] `eval:real` embeds docs AND queries with Gemini (grep confirms no `FakeEmbedder` on the real path) and prints recall/hit-rate/MAP/nDCG/MRR + citation precision/recall + faithfulness mean±stddev.
- [ ] Judge runs at `temperature: 0` with `responseSchema` JSON (no regex-on-prose parsing).
- [ ] Judge↔human agreement computed on the gold set and recorded (§3E).
- [ ] Real path **reports a distribution + asserts only a loose floor** — no tight thresholds set from n=1.
- [ ] `docs/EVAL-BASELINE.md` updated; labeled "authoritative" ONLY if §3E agreement is acceptable.
- [ ] No 768-dim mismatch; no document/query embedder mismatch.

### Anti-pattern guards — Phase 3

- ❌ Don't embed documents with the fake and queries with Gemini (or vice-versa) — same provider/model both sides.
- ❌ Don't route the judge through `Generator.answer` (temp 0.2, no JSON) — use a dedicated temp-0 structured `generateContent` call in `judge.ts`.
- ❌ Don't derive citation-correctness from `GenerationResult.citations` (those are context-order, not the model's `[N]` markers) — parse `[N]` from the answer prose.
- ❌ Don't hard-assert thresholds on the stochastic real path from a single run — report mean±stddev over N≥3, assert only a loose floor.
- ❌ Don't call the result "authoritative" before judge↔human validation (§3E) passes.
- ❌ Don't write questions while reading the target doc (lexical-echo inflation) — natural phrasing, independent authoring.
- ❌ Don't make CI/default eval depend on a network/API key. Don't invent a `@rag/core` judge interface. Don't send real client data to Gemini.

---

## Final Phase — Verification

1. **Phase 1 ✅:** deploy-time migrate hook in `apps/worker/railway.json` + documented (`8753199`, on `main`). Remaining: confirm live prod `/search` 200 **after** this branch deploys.
2. **Phase 2:** `docs/EVAL-BASELINE.md` dated with the fake-path table + caveat.
3. **Phase 3:** default `pnpm eval` green without a key; real path (`eval:real`) produces retrieval + IR (hit-rate/MAP) + citation precision/recall + faithfulness **mean±stddev**; judge runs temp-0/JSON-schema; judge↔human agreement recorded; baseline labeled "authoritative" only if §3E passes.
4. **Repo health:** `pnpm typecheck && pnpm lint && pnpm test` green; `pnpm eval` green.
5. **Grep guards:**
   - `rg "storage_key" packages/db/src/queries.ts` still present (we did NOT remove the column ref).
   - `rg "FakeEmbedder" tests/e2e/src/eval tests/e2e/src/helpers` — confirm the real path bypasses it when `EVAL_REAL_EMBEDDER=1`.
   - `rg "db:migrate|preDeployCommand|startCommand" apps/*/railway.json apps/*/Dockerfile docs/DEPLOYMENT.md` — confirm the deploy-time migration hook exists.

---

## Suggested execution order & sizing

| Phase                            | Effort  | Risk if skipped                                            |
| -------------------------------- | ------- | ---------------------------------------------------------- |
| 1 — prod migration + process gap | ✅ done | (was) next-deploy 500 on every search/ask                  |
| 2 — record fake baseline         | XS      | Low — checklist hygiene                                    |
| 3 — real G3 harness (hardened)   | L       | Medium — G3 gate not truly satisfied; misleading if rushed |

Phase 1 is complete. Do **Phase 2** next (cheap), then **Phase 3** — the real gate. Within Phase 3, the order is 3A→3B→3C→3D→3E; **§3E (judge validation) gates the "authoritative" label** — do not skip it to save time (that's the deferred-risk anti-pattern the review flagged).

## Effort note for Phase 3

Phase 3 is genuinely Large and now has a hard human-in-the-loop step (§3A independent authoring + §3E gold-set labeling). Budget for: ~1 day to author/label a defensible 30–50q corpus, ~0.5 day embedder/cache wiring, ~0.5 day judge + citation algorithm, ~0.5 day validation + reporting. The judge work is the easy-to-underestimate part — treat it as building a measurement instrument, not a prompt.
