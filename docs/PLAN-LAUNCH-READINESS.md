# PLAN: Launch Readiness (Reusable RAG Knowledge-Base Platform)

**Status:** Draft — created 2026-06-14; recalibrated 2026-06-14 after data-sensitivity review.
**Goal:** Take the RAG system from "feature-complete + app-layer-hardened" to "safe to run in production as a reusable KB platform," launching first on the CPA firm's own SharePoint knowledge base.
**Execution model:** Each phase below is self-contained and can be executed in a fresh chat context. Do the phases roughly in order. Effort is scaled to **data sensitivity** (see below) — not every phase is a blocker for the first launch.

## Data-sensitivity posture (drives how hard each phase pushes)

Security is a spectrum; effort is proportional to the sensitivity of the data actually ingested.

- **Tenant #1 (this firm's SharePoint KB) = LOW–MODERATE sensitivity.** The KB is mostly general research, tax strategies, templates, how-to's, and SOPs. Real client data lives in **Onvio**, not the KB. There are likely a _small number_ of real client examples in the KB — these are the only elevated-sensitivity items.
- **Consequence:** IRC §7216 attaches only to taxpayer _return information_ — which this corpus is overwhelmingly **not**. So §7216 is **not a launch gate** for tenant #1; it is a narrow item handled by curating out (or tagging) the few client examples (see Phase G1, demoted).
- **Platform goal:** the system must serve _other_ firms/business clients later, whose data sensitivity will vary. The platform therefore carries a **per-source/per-tenant sensitivity tier (`dataClass`)** so security effort can be dialed up per client without re-architecting. The expensive isolation/compliance machinery is built **lazily** — only when a high-sensitivity client actually arrives.

**Gate semantics:** A "Gate (G)" phase is a hard blocker **only for the sensitivity tier it names**. For a LOW–MODERATE tenant, the gates reduce to a proportionate baseline (encrypted volume + delete path + curate client examples). For a future HIGH-sensitivity tenant, the full gate content applies.

---

## How to use this plan

- Each phase has: **What to implement**, **References** (existing files/patterns to COPY, not reinvent), **Verification checklist**, and **Anti-pattern guards**.
- "COPY the pattern from `X`" means read that file and mirror its structure. The codebase is internally consistent — almost every new thing has a sibling to copy.
- Before starting a phase, re-read the referenced files; they are the source of truth, not this plan.
- Mark items done in this file as you go (`[x]`).

---

## Phase 0 — Documentation Discovery & Decisions (ALWAYS FIRST)

This phase is **already substantially complete** — the discovery was done during planning. This section is the consolidated, citeable baseline. Re-verify any claim against the live tree before relying on it.

### What is ALREADY done (verified on `main`, do NOT redo)

| Area                                                                                                                                                              | Evidence                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Five-systems unification (services/runtime/validation/auth/connector utils)                                                                                       | `@rag/services`, `@rag/runtime`, `packages/core/src/validation.ts`, `packages/core/src/auth.ts`, `packages/connectors/src/util/` |
| C1 index-drift guard (HNSW + tsvector)                                                                                                                            | startup assertion; commit `3fdada5` in `main`                                                                                    |
| C2 parser shared-secret auth                                                                                                                                      | `PARSER_SECRET` / `X-Parser-Token`; commit `af5add2` in `main`                                                                   |
| P1 per-source access control (mandatory scope in `Retriever.search`)                                                                                              | `packages/core/src/access-control.ts`, `apps/api/src/routes/authz.ts`, commit `91ce2dc` in `main`                                |
| P2 PII/metadata sanitization at API boundary                                                                                                                      | commit `7f0fdee` in `main`                                                                                                       |
| H3 embedding-dimension startup guard                                                                                                                              | committed                                                                                                                        |
| H4 boundary-cast validation (parser/sourceKind/header)                                                                                                            | commit `89d302d`                                                                                                                 |
| Functional surfaces: 4 connectors, ingestion pipeline, 2 embedding providers, hybrid RRF retrieval, 8 API routes, 5 MCP tools, worker handler                     | all COMPLETE, zero TODO/stub markers (verified)                                                                                  |
| Retrieval eval harness (metrics + RRF weight sweep)                                                                                                               | `pnpm eval`; synthetic corpus only                                                                                               |
| App-layer ops: bearer auth, Zod validation, global error handler, pino logging, `/health` + `/ready`, pg-boss retry (3×/backoff/6h), DB pool + statement timeouts | verified present                                                                                                                 |

### Decisions (resolved during planning; revisit per future tenant)

- [x] **D1 — Deployment target (tenant #1) = single VM + docker-compose** on a cloud host with an **encrypted data volume**. Proportionate to LOW–MODERATE sensitivity; lowest ops; one data-residency story. Build it from a **parameterized template** (not a hand-written one-off) so it doubles as the per-tenant provisioning unit. [Eng]
- [x] **D2 — LLM provider data path = standard provider API terms (Gemini/OpenAI) for tenant #1**, contingent on D2a. No DPA/BAA or self-hosting required for a non-return-information corpus. A future HIGH-sensitivity tenant flips to (a) signed DPA/BAA or (b) self-hosted models via the `dataClass` gate. [Eng; legal sign-off for HIGH tenants]
  - [ ] **D2a — Curate client examples out of scope** (or tag them `client-confidential`) before/at ingestion. This is the one concrete §7216 action for tenant #1. [Domain owner — the firm]
- [x] **D3 — Data retention = implement a deletion path now; auto-expiry deferred.** For LOW–MODERATE, a working `purgeSource` / `DELETE` is sufficient; a firm-wide retention SLA is only required before a HIGH-sensitivity tenant. [Eng now; business later]
- [x] **D4 — Encryption-at-rest = encrypted volume/disk only for tenant #1.** App-level field encryption deferred until a HIGH-sensitivity tenant requires it. [Eng]
- [x] **D5 — Tenancy model = HYBRID, isolation built lazily.** Ship a per-source/per-tenant `dataClass` (sensitivity tier) now. Serve LOW-sensitivity clients from the simple stack; provision **isolated instances** (own DB + encrypted volume + credentials) for HIGH-sensitivity clients when they arrive. Do **not** build a shared multi-tenant `tenant_id`-commingled database for sensitive data. See **Phase T**. [Eng + business]

### Anti-patterns to avoid (project-wide)

- ❌ Importing `pg`/`drizzle-orm` directly in apps/packages — all DB access goes through `@rag/db` typed queries.
- ❌ Duplicating search/ask logic in a route or MCP tool — call the `@rag/services` functions.
- ❌ Building a second composition root — use `buildCoreDeps` from `@rag/runtime`.
- ❌ Editing `.env` or `pnpm-lock.yaml` (blocked by hooks). Edit `env.example`; run `pnpm install`.
- ❌ Making access scope an _optional filter_ — it is a _mandatory_ WHERE clause (see P1). Never weaken it.
- ❌ Inventing config keys — every env var flows through `packages/core/src/config.ts loadConfig()`. Add it there first.

---

## Phase 1 — CI Quality Gates

**Why:** Today CI runs only `.github/workflows/e2e.yml` (build + e2e). There is no lint/typecheck/unit-test gate, `pnpm lint` is a no-op (no ESLint config, zero packages define a `lint` script), and the three apps (`api`/`mcp`/`worker`) have **no unit tests**. Shipping to production without a green-gate pipeline is the cheapest high-value fix.

### What to implement

1. **Real lint.** Add a single shared ESLint flat config at repo root (TypeScript + import hygiene). Add a `"lint"` script to each `package.json` (or a root-level `eslint .` that covers the workspace). Make `pnpm lint` actually run.
2. **CI gate workflow.** Add `.github/workflows/ci.yml` running on PR + push to main: `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint` → `pnpm test` (unit). Keep `e2e.yml` separate (it needs the Postgres + parser services).
3. **Smoke unit tests for the 3 apps.** At minimum, one test per app that builds its `Deps`/composition wiring with mocks and asserts routes/tools/handlers register. Add `"test"` scripts to `apps/{api,mcp,worker}/package.json` (they're currently missing).
4. **Coverage visibility (not a hard gate yet).** Add vitest `coverage` reporting to the root test run; print summary in CI. Defer a hard threshold until apps have real coverage.

### References (COPY these patterns)

- Existing CI structure: `.github/workflows/e2e.yml` (service containers, pnpm setup, frozen lockfile, artifact capture on failure).
- Test style to mirror: any `packages/*/src/*.test.ts` (e.g. `packages/services/src/sources.test.ts`, `packages/services/src/ask.test.ts`) — these already mock `ServiceDeps`/logger.
- Root scripts: `package.json` (`build`/`typecheck`/`test`/`lint` already exist as fan-outs; you are filling in the missing per-package implementations).
- App wiring to smoke-test: `apps/api/src/main.ts`, `apps/mcp/src/main.ts`, `apps/worker/src/main.ts` and their `deps.ts`.

### Verification checklist

- [ ] `pnpm lint` exits non-zero on a deliberately introduced lint error, zero on clean tree.
- [ ] `pnpm typecheck` green workspace-wide.
- [ ] `pnpm test` runs and includes at least one test from each of `apps/api`, `apps/mcp`, `apps/worker`.
- [ ] New `ci.yml` passes on a PR; failing typecheck/lint/test blocks merge.
- [ ] `grep -rL '"lint"' */*/package.json` shows no package missing a lint script (or root eslint covers all).

### Anti-pattern guards

- ❌ Don't add an ESLint config per package — one flat config at root, referenced everywhere.
- ❌ Don't set a high coverage threshold that fails CI on day one — measure first, gate later.
- ❌ Don't fold e2e (needs DB+parser) into the fast `ci.yml` gate.

---

## Phase 2 — Deployment Artifacts

**Why:** Production Dockerfiles exist only for the Python parser. The three Node apps have **no Dockerfiles**, and there is **no deploy config** (no fly.toml/railway/render/k8s) and no production runbook. This is the single biggest infra blocker.

### Phase 2.0 — Deployment target (DECIDED: single VM + docker-compose)

**D1 is resolved: single VM + docker-compose with an encrypted data volume.** No selection step needed. Rationale (record in `docs/DEPLOYMENT-TARGET.md`): proportionate to LOW–MODERATE sensitivity, lowest ops burden for one-firm scale, full control of the encrypted volume and Postgres version (guarantees pgvector + HNSW), single data-residency story.

**Build it as a parameterized template, not a one-off.** The compose stack + its env/secrets must be reproducible per tenant (envsubst/`.env.<tenant>` or a small IaC wrapper — Ansible/Terraform). This is the per-tenant provisioning unit that **Phase T** reuses. K8s (namespace + DB-per-tenant) is the documented future step once isolated-tenant count grows; do not build it now.

### Phase 2.1 — Production Dockerfiles (target-independent)

- Write multi-stage Dockerfiles for `apps/api`, `apps/mcp`, `apps/worker`. Mirror the parser Dockerfile's discipline (slim base, non-root user, only prod deps).
- Because this is a pnpm workspace, the build context is the repo root; use `pnpm deploy --filter @rag/<app>` or a pruned build to avoid shipping the whole monorepo into each image.
- `.dockerignore` at root (exclude `node_modules`, `.worktrees`, `.git`, `docs`, test artifacts).

### Phase 2.2 — Deploy config + runbook (single VM + compose)

- Author `docker/compose.prod.yml`: Postgres (pgvector pg16) on an **encrypted volume**, parser, api, mcp, worker. Parameterize per-tenant values (DB name, ports, secrets, source creds) so the same file provisions any tenant.
- Wire health checks to existing endpoints: `/health` (liveness) and `/ready` (DB-connectivity readiness) for api; MCP `/health`. Worker has no HTTP — use process/queue liveness.
- Document the **migration runbook**: order is (1) `docker/init-db.sql` bootstrap (extensions: vector, pg_trgm, uuid-ossp), (2) `pnpm db:migrate`, (3) pg-boss auto-creates its schema on first worker connect.
- Document required production env (see `env.example`): `DATABASE_URL`, `GEMINI_API_KEY`/`OPENAI_API_KEY`, `API_TOKENS` and/or `API_PRINCIPALS`, `PARSER_SECRET` (now **mandatory** in prod — see Phase 3), MS/Google connector creds as needed.
- Document **backup/restore** for the encrypted volume (pg_dump schedule + restore test) — this is the HA mitigation for single-host.

### References (COPY these patterns)

- Production Dockerfile reference: `services/parser-py/Dockerfile` (multi-worker uvicorn, slim image).
- Local topology to translate to prod: `docker/docker-compose.yml` (Postgres pgvector pg16 + parser on 127.0.0.1:8000).
- DB bootstrap: `docker/init-db.sql`. Migrations: `packages/db/drizzle/*.sql`, runner `packages/db/src/migrate.ts`.
- Env contract: `env.example` (every required var is documented there).
- Existing deploy notes (verify/extend, may be partial): `docs/DEPLOYMENT.md`.

### Verification checklist

- [ ] `docs/DEPLOYMENT-TARGET.md` records the chosen target + rationale.
- [ ] Each of api/mcp/worker builds a runnable image: `docker build` succeeds; container starts and connects to a Postgres.
- [ ] Chosen-target deploy config boots the full stack; `/ready` returns 200 only after migrations applied.
- [ ] Runbook lets a fresh operator go from zero → migrated DB → all services healthy.
- [ ] Confirmed: managed Postgres (if PaaS) supports `pgvector` + HNSW index creation.

### Anti-pattern guards

- ❌ Don't bake secrets into images — inject at runtime via the target's secret store.
- ❌ Don't run containers as root.
- ❌ Don't copy the whole monorepo into each image — prune/deploy per app.
- ❌ Don't auto-run migrations from every app on boot — migrations are a deliberate, ordered step.

---

## Phase 3 — Operational Hardening

**Why:** Several production-ops gaps are ABSENT: HTTP rate limiting (H5), metrics, distributed tracing, external error reporting, dead-letter/alerting on exhausted jobs. `/ask` triggers an embedding + LLM call per request — unbounded.

### What to implement

1. **H5 Rate limiting.** Add `@fastify/rate-limit` to `apps/api` with stricter limits on `/ask` and `/sources/:id/sync` (cost-heavy). Apply per-principal (token) where possible. Add a limit to the MCP HTTP transport.
2. **Enforce `PARSER_SECRET` in production.** Today it's opt-in. Add a config assertion: when running in a networked/prod profile, a missing `PARSER_SECRET` is fatal at startup (fail-loud, mirror the embedding-dimension guard pattern).
3. **Error reporting.** Integrate Sentry (or equivalent) in all three apps' bootstrap + the parser. Capture unhandled errors and 5xx in the global error handler.
4. **Metrics.** Expose a `/metrics` (Prometheus) endpoint on api (and mcp http): request latency, error rate, and queue depth / job duration for the worker. Reuse pino context.
5. **Job failure visibility (DLQ + alerting).** pg-boss retries 3× then expires at 6h with no dead-letter inspection. Add a failed-job archive/inspection path and an alert (Sentry event or webhook) when a sync job exhausts retries.
6. **Circuit-breaker/timeout review.** Confirm timeouts exist for parser (`PARSER_TIMEOUT_MS`), embedding, and generation calls; add a breaker or bounded retry for downstream provider outages.

### References (COPY these patterns)

- Fastify wiring + global handler: `apps/api/src/server.ts`, `apps/api/src/error-handler.ts` (status mapping, no-secret redaction — extend it to also report to Sentry).
- Fail-loud startup assertion pattern: the H3 embedding-dimension guard and C1 index guard (mirror their shape for the `PARSER_SECRET` prod check).
- Worker retry/lifecycle: `packages/ingestion/src/queue.ts` (retryLimit/retryDelay/retryBackoff/expireInHours), `apps/worker/src/handlers/sync-source.ts` (running→completed/failed transitions — hook alerting into the failed branch).
- Logger setup to extend: `apps/{api,mcp,worker}/src/main.ts` (pino).

### Verification checklist

- [ ] Hitting `/ask` past the limit returns 429; normal traffic unaffected.
- [ ] Booting any app in prod profile without `PARSER_SECRET` exits non-zero with a clear message.
- [ ] A thrown error in a route appears in Sentry with request context but no secrets.
- [ ] `/metrics` returns Prometheus text; worker job duration + queue depth visible.
- [ ] A deliberately failing sync job (e.g., bad creds) exhausts retries and emits exactly one alert.

### Anti-pattern guards

- ❌ Don't log tokens, `DATABASE_URL`, or provider keys (the error handler already redacts — keep it that way through Sentry).
- ❌ Don't rate-limit `/health` or `/ready` (probes must always pass).
- ❌ Don't swallow downstream errors to "keep going" — surface them; the worker's throw-to-retry contract is intentional.

---

## Phase G1 — Data Classification & Provider Policy (tier-scaled)

**Not a launch blocker for tenant #1 (LOW–MODERATE).** This corpus is general research/templates/SOPs, not taxpayer return information, so §7216 does not gate it. The only action for tenant #1 is **D2a: curate the few real client examples out of ingestion scope (or tag them `client-confidential`).** The `dataClass` machinery below is built now (cheap, ~1 field + a boundary check) so the platform can gate HIGH-sensitivity tenants later — but for tenant #1 you only need steps 1 + 2.

**Becomes a hard gate** for any future tenant classified HIGH (real taxpayer return info / PII). At that point steps 3–4 are mandatory.

### What to implement

1. **D2a — curate client examples (tenant #1).** Identify the handful of docs/folders with real client specifics; exclude them from the ingested source scope, or tag them `client-confidential`. One-time domain-owner pass.
2. **Per-source `dataClass` flag (build now).** Add a classification field on sources (`public` | `internal` | `client-confidential`). Default to the **most restrictive** so unclassified data can't leak. Enforce at the ingestion + retrieval boundary: `client-confidential` may only be embedded/generated by an _approved_ provider. For tenant #1, the approved set = standard Gemini/OpenAI (D2); a HIGH tenant narrows it.
3. **(HIGH tenants) Disclosure audit trail.** Append-only record of which provider processed which source/document, so a §7216 disclosure can be reconstructed.
4. **(HIGH tenants, if declining provider DPAs) Self-hosted models.** Implement/register a self-hosted `EmbeddingProvider` + generator and re-point config; re-embedding required (embeddings are immutable per provider/model/dims).

### References (COPY these patterns)

- Provider interface + factory: `packages/rag/src/embeddings/{gemini.ts,openai.ts,factory.ts}` — add a new provider by implementing `EmbeddingProvider` and registering it.
- Enforcement-boundary pattern: P1 access-control (`packages/core/src/access-control.ts`) and P2 sanitization show how to add a _mandatory_ boundary check rather than an optional flag.
- Config plumbing: `packages/core/src/config.ts` (add `dataClass`/provider-allow config here first).
- Compliance context: `docs/CPA-COMPLIANCE-REQUIREMENTS.md`, `docs/CPA-KB-ADOPTION-PLAN.md`.

### Verification checklist

- [ ] (Tenant #1) Client examples curated out of scope or tagged; confirm a spot-check of ingested docs finds no real client return info.
- [ ] `dataClass` field exists, defaults restrictive; a `client-confidential` source refuses to ingest when the configured provider isn't approved (fail-loud test).
- [ ] (HIGH tenants) Disclosure audit row written for every document embedded, naming the provider.
- [ ] (HIGH tenants, if self-hosted) `pnpm eval` still runs against the new provider; dimensions match the `vector(N)` column (H3 guard passes).

### Anti-pattern guards

- ❌ Don't make `dataClass` default to a permissive value — default to the most restrictive (`client-confidential`) so unclassified data can't leak.
- ❌ Don't treat the provider-allow check as an optional filter — it's a mandatory gate (same lesson as P1).
- ❌ Don't over-build for tenant #1 — skip self-hosting and disclosure-audit until a HIGH-sensitivity tenant actually arrives.

---

## Phase G2 — Data Retention & Deletion (tier-scaled)

**Proportionate baseline for tenant #1; hard gate for HIGH tenants.** Ingestion only ever upserts — there's no "purge everything for source X" path. For tenant #1 the baseline is **encrypted volume (D4) + a working delete path (steps 2–4)**. App-level field encryption and auto-expiry retention are deferred to HIGH tenants.

### What to implement

1. **(HIGH tenants) Resolve D3 + D4 fully** (retention period + encryption standard); document in `docs/CPA-COMPLIANCE-REQUIREMENTS.md`. For tenant #1, D3/D4 are already set: encrypted volume + on-demand delete.
2. **`purgeSource` operation** in `@rag/db` (typed query): transactionally delete the source, its documents, and chunks; ensure pgvector/tsvector indexes stay consistent. **(build now — useful at every tier)**
3. **`DELETE /sources/:id` route** (api) + a `purge_source` MCP tool wired through `@rag/services` — with access-control scope enforced (only an authorized principal can purge a source). **(build now)**
4. **Encryption-at-rest:** encrypted Postgres volume/disk on the VM (tenant #1 baseline); document the choice. App-level field encryption only for HIGH tenants.
5. **(HIGH tenants) Retention enforcement:** a scheduled purge job (pg-boss) honoring the retention SLA.

### References (COPY these patterns)

- Service-layer op + thin adapters: `packages/services/src/sources.ts` (`triggerSync`, `listPublicSources`) — add `purgeSource` alongside; expose via api route + MCP tool the same way.
- DB query style: `packages/db/src/queries.ts` (typed functions; transactional `replaceChunks` is the closest analog for multi-table atomic mutation).
- Route + authz: `apps/api/src/routes/sources.ts` + `apps/api/src/routes/authz.ts` (scope enforcement).
- Scheduled jobs: `packages/ingestion/src/queue.ts` (pg-boss).

### Verification checklist

- [ ] `purgeSource` removes source + documents + chunks; a follow-up search returns nothing from that source; no orphan rows.
- [ ] `DELETE /sources/:id` enforces scope (unauthorized principal → 403/404, never deletes).
- [ ] Encryption-at-rest verified on the deployment target; documented.
- [ ] (If auto-retention) expired data is purged on schedule; audit row recorded.

### Anti-pattern guards

- ❌ Don't soft-delete-only when a hard purge was requested — §7216/right-to-delete needs real removal of content (keep only the minimal audit trail D2 requires).
- ❌ Don't leave dangling vector/tsvector index entries — verify index consistency post-purge.

---

## Phase G3 — GATE: Retrieval Quality Baseline

**Why:** The eval harness exists but runs on a 14-doc/17-question synthetic corpus with a `FakeEmbedder` and no answer-faithfulness judge. You cannot responsibly tune (or claim quality) without a real baseline.

### What to implement

1. **Real eval corpus:** 30–50 representative CPA questions labeled with relevant documents (use synthetic/public or properly-consented data). Replace the synthetic starter.
2. **LLM-judge** for answer faithfulness + citation correctness, wired into `pnpm eval`.
3. **Record baseline** (recall@k, nDCG@k, MRR, faithfulness) in `docs/` before any tuning.
4. **H1 reranking (measured):** add an optional `Reranker` interface (Cohere Rerank / Voyage / local cross-encoder); retrieve a larger pool (50–100), rerank, keep top 5–8. Ship **only if** eval improves materially over the recorded baseline. (Note: a placeholder comment for this already exists in `packages/rag/src/retrieval/retriever.ts`.)

### References (COPY these patterns)

- Eval harness: `tests/e2e/src/specs/retrieval-eval.spec.ts`, `eval-metrics.spec.ts`; runner via `pnpm eval`.
- Retriever to extend with rerank: `packages/rag/src/retrieval/retriever.ts` (the `search()` pool is what a reranker consumes).
- Optimization rationale: `docs/ISSUES-AND-OPTIMIZATIONS.md` (H1 rerank, OPT-C1 contextual retrieval).

### Verification checklist

- [ ] `pnpm eval` runs against the real corpus and prints recall@k / nDCG@k / MRR / faithfulness.
- [ ] Baseline numbers recorded in a doc, dated.
- [ ] Rerank PR includes before/after eval numbers; merged only if improved.

### Anti-pattern guards

- ❌ Don't tune retrieval weights/rerank by intuition — every change is justified by an eval delta.
- ❌ Don't send real client data to a third-party reranker without clearing it through Phase G1's provider rules.

---

## Phase 4 — Remaining Correctness Items (opportunistic)

Pull these in where they touch code you're already changing. Sourced from `docs/ISSUES-AND-OPTIMIZATIONS.md`.

- [ ] **H2 — Metadata filter full scan.** `metadata->>'key' IN (...)` isn't served by the `jsonb_ops` GIN index → full scan. Add B-tree expression indexes on filterable keys OR switch the filter to `@>` with a `jsonb_path_ops` GIN index. Verify with `EXPLAIN`.
- [ ] **H6 — Express version mismatch (MCP).** `apps/mcp` runs `express@4` but type-checks against `@types/express@5`. Align both to one major version.
- [ ] **M-N5 — Prompt-injection delimiter.** Generation guard only escapes `</document>`; escape both boundaries or use a non-textual delimiter.
- [ ] **M-N3 — Retrieval diversity.** Add a per-`document_id` cap or MMR over the pool so one long doc can't dominate top-K.
- [ ] Triage the remaining M-items (M2/M3/M6/M17/M19, M-N2, M-N4) in `docs/ISSUES-AND-OPTIMIZATIONS.md`; schedule only those with real production impact.

### Verification checklist

- [ ] H2: `EXPLAIN ANALYZE` on a metadata-filtered query shows an index scan, not a seq scan.
- [ ] H6: `apps/mcp` runtime express version === types major version; mcp typecheck green.
- [ ] Each pulled-in item has a test or an explicit manual-verification note.

---

## Phase T — Multi-Tenancy & Provisioning (build LAZILY)

**Do not build before tenant #1 go-live.** Tenant #1 is a single isolated stack; this phase is triggered when a _second_ tenant (especially a HIGH-sensitivity one) arrives. Per D5 the model is **hybrid: isolated instance per sensitive tenant**, never a shared `tenant_id`-commingled database for sensitive data.

### What to implement (when triggered)

1. **Parameterized provisioning.** Turn the Phase 2 compose template into a one-command "new tenant" spin-up (own DB, own encrypted volume, own credentials, own secrets). IaC wrapper (Ansible/Terraform) or a provisioning script.
2. **Per-tenant connector credentials.** Implement OPT-E4 (per-source credential references) so different tenants use different MS/Google tenant apps/accounts — prerequisite for multi-tenant.
3. **Tenant-scoped operations.** Backup/restore and `purgeSource` operate per tenant; document the per-tenant runbook.
4. **(At scale) K8s orchestration.** When isolated-tenant count makes N compose hosts unwieldy, move to k8s with **namespace + dedicated Postgres per tenant** (still isolated, not commingled). Reuse the same images and `dataClass` model.

### References (COPY these patterns)

- Provisioning unit: the Phase 2 `docker/compose.prod.yml` template.
- Per-source credentials: OPT-E4 in `docs/ISSUES-AND-OPTIMIZATIONS.md`; config plumbing in `packages/core/src/config.ts`.
- `dataClass` tier (from G1) decides isolated-vs-shared placement.

### Verification checklist

- [ ] One command provisions a fresh, fully-isolated tenant stack (own DB + encrypted volume).
- [ ] Two tenants share no database; a query in tenant A cannot reach tenant B's data (verified, not assumed).
- [ ] Per-tenant backup/restore + purge documented and tested.

### Anti-pattern guards

- ❌ Don't commingle sensitive tenants in one shared DB to save cost — isolation is the compliance story (D5).
- ❌ Don't build this for tenant #1 — premature; it adds ops surface with no tenant to use it.

---

## Phase 5 — FINAL: Go-Live Verification

**Run this as the last phase before going live with tenant #1's KB.** Gate items are scoped to the tenant's sensitivity tier (LOW–MODERATE for tenant #1).

### Build / test / types

- [ ] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test` all green.
- [ ] `pnpm e2e` green against the Postgres + parser stack.
- [ ] `pnpm eval` green; quality at/above recorded baseline (Phase G3).

### Anti-pattern greps (must return nothing meaningful)

- [ ] `grep -rn "TODO\|FIXME\|not implemented\|throw new Error(\"unimpl" packages apps services` → no production stubs.
- [ ] No direct `pg`/`drizzle-orm` import outside `@rag/db`: `grep -rn "from \"pg\"\|from \"drizzle-orm\"" apps packages | grep -v packages/db`.
- [ ] Scope enforcement intact: `Retriever.search` still takes a mandatory scope arg (P1 not regressed).
- [ ] No secrets in logs: spot-check error paths; `DATABASE_URL`/tokens/provider keys never logged.

### Data-handling gates (scoped to tenant's tier)

- [ ] G1: `dataClass` field live + defaults restrictive; **tenant #1** — client examples curated out / tagged. (HIGH tenants: provider DPA-or-self-host decided + disclosure audit live.)
- [ ] G2: `purgeSource` + `DELETE /sources/:id` work with scope enforced; encrypted volume verified. (HIGH tenants: retention SLA + field encryption.)
- [ ] No real taxpayer return information present in tenant #1's ingested corpus (spot-check).

### Deploy / ops

- [ ] Phase 2 stack deploys clean from the runbook on the chosen target; `/ready` gates on migrations.
- [ ] Rate limiting active; `PARSER_SECRET` enforced in prod; Sentry receiving; `/metrics` live.
- [ ] Failed-job alerting fires; retries/backoff confirmed.
- [ ] Rollback procedure documented (image pin + DB migration rollback note).

### Sign-off

- [ ] Eng sign-off (build/ops/quality).
- [ ] Business/legal sign-off (D2/D3/D4 compliance gates).

---

## Phase dependency summary

```
Phase 1 (CI gates) ───────────────────┐
Phase 2 (deploy: VM+compose template) ─┤
Phase 3 (ops hardening) ───────────────┤
Phase G1 (dataClass + curate examples) ┼──► Phase 5 (go-live, tenant #1)
Phase G2 (purge path + encrypted vol) ─┤
Phase G3 (eval baseline + rerank) ─────┤
Phase 4 (correctness, opportunistic) ──┘

           Phase T (multi-tenancy / isolation) ──► built LAZILY, when a 2nd
           tenant (esp. HIGH-sensitivity) actually arrives — not before go-live.
```

**Tier scaling:** For tenant #1 (LOW–MODERATE) the G phases reduce to: build `dataClass`, curate client examples, ship the delete path, run on an encrypted volume. The full §7216/retention/self-hosting content of G1–G2 activates only for a HIGH-sensitivity tenant. Phases 1–3 run in parallel with the G phases.

---

## Appendix: source documents consulted during discovery

- `docs/ISSUES-AND-OPTIMIZATIONS.md` (primary backlog: C/P/H/M items + OPT-A..E)
- `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/API.md`, `docs/MCP.md`, `docs/CONNECTORS.md`
- `docs/CPA-COMPLIANCE-REQUIREMENTS.md`, `docs/CPA-KB-ADOPTION-PLAN.md`, `docs/CPA-KB-IMPLEMENTATION-SPEC.md`, `docs/AUTH-AND-SESSIONS-RESEARCH.md`
- `docs/PLAN-FIVE-SYSTEMS.md`, `docs/PLAN-FIVE-SYSTEMS-RESUME.md`, `journey-into-rag-system.md`, `PATHFINDER-2026-06-06/`
- `.github/workflows/e2e.yml`, `docker/docker-compose.yml`, `docker/init-db.sql`, `services/parser-py/Dockerfile`, `env.example`, `package.json`
- Live code: `apps/{api,mcp,worker}/src`, `packages/{core,db,rag,services,runtime,ingestion,connectors}/src`
- Git verification: P1 `91ce2dc`, P2 `7f0fdee`, C1 `3fdada5`, C2 `af5add2` all confirmed ancestors of `main`.
