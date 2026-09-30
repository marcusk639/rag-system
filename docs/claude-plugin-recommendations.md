# wshobson/agents — Adoption Analysis for rag-system

> **Verdict (2026-09-15, against the marketplace snapshot of 94 plugins / 202 agents / 183 skills / 105 commands / 16 orchestrator workflows at `wshobson/agents`, already registered on this machine as `claude-code-workflows`):** install **one plugin** — `security-scanning` — keep the already-enabled `documentation-standards` and start using it, pull three individual skills, and **disable `llm-application-dev`**. That is a deliberately short list, and it is shorter than it looks: the user has already triaged this catalog and set ~50 of 56 registered plugins to `false` (§2), so every item here must beat a considered rejection rather than an empty slate. The plugin whose name matches this repo's domain most exactly, `llm-application-dev`, is **rejected in full** — and is **currently enabled**, so §7's verdict is a removal, not a decline: its eight skills teach the RAG design decisions this repo already made, tested, and documented (`packages/rag/src/retrieval/`, `tests/e2e/src/eval/metrics.ts`, `docs/EVAL-BASELINE.md`), putting generic tutorial guidance in live competition with the repo's own hard-won, tenant-specific conclusions. The single highest-value addition is `security-scanning`, the one recommendation that was never on the menu (absent from both config dirs): `CODEBASE-REVIEW.md` carries three CRITICAL and four HIGH findings that are all security-shaped, `[C2]` (unauthenticated Python parser sidecar) is still an open decision, and `.github/workflows/ci.yml` runs **no** SAST, **no** dependency audit, and **no** coverage gate. Net footprint change: +2 agents (both Opus-tier), +3 commands, +3 skills, −8 skills and −3 agents removed.

---

## 1. Repository profile

A generic Retrieval-Augmented Generation service, currently operating a CPA-firm pilot on Railway.

| Dimension       | Concrete                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager | `pnpm@9.12.0`, Node `>=22.9.0`; workspaces are `packages/*`, `apps/*`, `tests/*`, `examples/*` (`pnpm-workspace.yaml`). **No Turborepo, no Nx** — verified: `turbo.json` and `nx.json` absent                        |
| Apps            | `apps/api` (Fastify + zod), `apps/mcp` (`@modelcontextprotocol/sdk` + express), `apps/worker` (pg-boss), `apps/teams-bot` (botbuilder + Entra SSO + Adaptive Cards), `apps/web` (Next.js 15)                         |
| Packages        | `connectors`, `core`, `db`, `ingestion`, `rag`, `runtime`, `services`, `test-fixtures`                                                                                                                               |
| Non-TS service  | `services/parser-py/` — FastAPI document parser sidecar (MarkItDown/LibreOffice/Unstructured/Tesseract), pytest                                                                                                      |
| Database        | Postgres + pgvector. `chunks.embedding vector(768)`, HNSW `m=16, ef_construction=64`, GIN on `tsv` and on `documents.metadata` — all hand-authored in `packages/db/drizzle/0000_init.sql`                            |
| Retrieval       | Hybrid dense + sparse with RRF fusion, `packages/rag/src/retrieval/retriever.ts`; optional reranker (`reranker.ts`, off by default) that degrades to RRF order on failure                                            |
| Embeddings      | `packages/rag/src/embeddings/` — Gemini `gemini-embedding-001` (default), `local` ONNX, OpenAI; with `retry.ts`, `throttle.ts`, `egress-compliance.test.ts`                                                          |
| Test runner     | Vitest 2.1.8; 73 colocated test files; `pnpm test`, `pnpm test:coverage`, `pnpm e2e`, `pnpm eval`, `pnpm eval:real`                                                                                                  |
| Eval harness    | `tests/e2e/src/eval/` — `metrics.ts` (recall@k, precision@k, MRR, nDCG@k), `faithfulness.ts`, `corpus.ts`, `gold-set.ts`, `run-eval.ts`, `run-real-eval.ts`                                                          |
| CI              | `.github/workflows/ci.yml` (build → typecheck → lint → format:check → tenant-name grep → unit tests; plus a `parser` pytest job) and `.github/workflows/e2e.yml` (pgvector/pgvector:pg16 service + parser container) |
| Git hooks       | `.husky/pre-commit` → `lint-staged`, `scripts/check-secrets.mjs`, `scripts/check-file-sizes.mjs`; `.husky/pre-push`                                                                                                  |
| Error reporting | `packages/runtime/src/monitoring.ts` — `@sentry/node`, no-op when DSN absent. `pino` in api/mcp/worker. **No prom-client, no OpenTelemetry, no `/metrics` endpoint**                                                 |
| Deployment      | Railway (`rag-worker` owns migrations via `preDeployCommand`); also `docker/compose.prod.yml` single-VM                                                                                                              |

The work that actually happens here, judging by `docs/` (70+ files) and `CLAUDE.md`: adding connectors (`packages/connectors/src/{sharepoint,gdrive,gmail,outlook,git-markdown,ecfr-part4}/`), tuning retrieval, keeping a pilot tenant's knowledge base in sync, running production runbooks (`docs/BACKUP-SCHEDULE-RUNBOOK.md`, `docs/PHASE-2-RAILWAY-RUNBOOK.md`), and fighting documentation drift.

---

## 2. Claude tooling already in place

### Repo-local (`~/dev/rag-system/.claude/`)

| Item                                     | Kind     | What it does                                                                                                                                                                                                                                                 |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents/rag-reviewer.md`                 | Agent    | Sonnet 4.6, read-only. Reviews a diff against the repo's layering contract. Has a three-bullet "Security checks (always)" section: secrets, scope-boundary crossing, missing input validation                                                                |
| `agents/retrieval-eval-runner.md`        | Agent    | Sonnet 4.6. Runs `pnpm eval`, reports metric deltas, explicitly forbidden from inventing metric names or thresholds; warns when embeddings changed                                                                                                           |
| `skills/judge-review/SKILL.md`           | Skill    | Adversarial pre-review on a Tier C model (OpenRouter DeepSeek V4 Flash). Prompt enumerates 5+ repo-specific failure modes (missing zod on Fastify routes, unregistered pg-boss error handlers, `.execute()` without `await`, MCP tool missing `inputSchema`) |
| `skills/rag-add-provider/SKILL.md`       | Skill    | Four-step recipe for adding a connector / embedding provider / auth provider, with per-provider caveats                                                                                                                                                      |
| `hooks/git-guard.mjs`                    | Hook     | PreToolUse on Bash. **Blocks `git commit --no-verify`/`-n`** and `git add -f/--force`                                                                                                                                                                        |
| `hooks/command-guard.mjs`                | Hook     | PreToolUse on Bash; complements git-guard                                                                                                                                                                                                                    |
| `hooks/migration-guard.mjs`              | Hook     | PreToolUse on Edit\|Write — guards `packages/db/drizzle/` migrations                                                                                                                                                                                         |
| `rules/tdd.md`, `rules/quality-gates.md` | Rules    | Repo-committed TDD and gate policy                                                                                                                                                                                                                           |
| `settings.json`                          | Settings | Tiered allow/ask/deny. Denies `Read(.env*)`; asks on `git push`, `pnpm db:migrate`, `pnpm docker:down`                                                                                                                                                       |

### Marketplace baseline — `wshobson/agents` is already registered, and mostly switched off

**Do not run `/plugin marketplace add wshobson/agents`.** It is already registered under the alias **`claude-code-workflows`**, in both config dirs:

```json
"claude-code-workflows": { "source": { "source": "github", "repo": "wshobson/agents" } }
```

Verify with:

```bash
grep -o '"[a-z0-9-]*@claude-code-workflows": *\(true\|false\)' "$CLAUDE_CONFIG_DIR/settings.json" | sort
```

**This machine has two config dirs and they disagree.** `CLAUDE_CONFIG_DIR=/Users/marcusklein/.claude-acct2`, so `~/.claude-acct2/settings.json` is the live one; `~/.claude/settings.json` belongs to the other account. Both have the marketplace cloned under `plugins/marketplaces/claude-code-workflows/`.

| Config dir                    | Registered entries | Enabled (`true`)                                                                                                                     |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.claude-acct2/` (**live**) | 56                 | `before-you-build`, `code-documentation`, `comprehensive-review`, `documentation-standards`, `llm-application-dev`, `llm-finetuning` |
| `~/.claude/`                  | 54                 | `before-you-build`, `code-documentation`, `comprehensive-review`                                                                     |

**This raises the bar for every recommendation below.** The user has already walked this catalog and explicitly set ~50 plugins to `false`. A recommendation is therefore no longer "this looks useful" — it must be "this was evaluated and turned off (or was never registered at all), and here is the rag-system-specific reason that judgment should change."

Three consequences that change what this document is actually asking for:

1. **`security-scanning` is not registered in either config dir** — the only security-adjacent entry is `security-compliance`, which is `false` and aimed at SOC2/HIPAA/GDPR attestation rather than SAST. So §4.1 is a **genuine install**, not a flag flip, and it is the one Tier-1 item that was never triaged. See "Why it clears the §2 bar" in §4.1.
2. **`documentation-standards` is already enabled in the live config dir.** §4.2 therefore needs **no action** — `grounded-vault` and `hads` are loaded right now. That recommendation collapses to "start using the skill you already have." (It is absent from `~/.claude/`, so that account would need a real install.)
3. **`llm-application-dev` is currently enabled in the live config dir** — the plugin §7 rejects in full is live today, contributing `rag-implementation`, `embedding-strategies`, `hybrid-search-implementation`, `similarity-search-patterns`, `vector-index-tuning`, `llm-evaluation`, `langchain-architecture`, and `prompt-engineering-patterns`, plus the `ai-engineer`, `prompt-engineer`, and `vector-database-engineer` agents. So §7's verdict is not "do not install" but **"turn this off"** — see §8 step 4. This is the single highest-impact change in the document, because it is removing advice that actively contradicts `CLAUDE.md` and `docs/EVAL-BASELINE.md` rather than merely declining to add some. `comprehensive-review` and `code-documentation`, also rejected in §7, are enabled in both dirs; those are lower-stakes duplicates rather than sources of contradictory guidance, so leave them unless you are separately trimming context.

### Global (`~/.claude/`)

37 agents, of which these overlap candidate offerings: `code-reviewer`, `typescript-reviewer`, `typescript-pro`, `security-reviewer`, `database-reviewer`, `debugger`, `devops-incident-responder`, `e2e-runner`, `tdd-guide`, `prompt-engineer`, `architect`, `refactor-cleaner`, `doc-updater`, `build-error-resolver`, `verifier`, `mech-executor`.

~70 global skills, of which these matter here: `code-doc-audit`, `doc-code-audit`, `documentation-review`, `codebase-review`, `code-review`, `iterative-review`, `c4-architecture`, `llm-application-dev`, `repo-claude-advisor`, `post-edit-checks`, `investigate-first`.

**Baseline consequence:** anything that is "a code reviewer", "a TypeScript expert", "a debugger", "a doc generator", or "a prompt engineer" is already covered twice over. To earn a place, an offering must do something none of these do.

---

## 3. Selection criteria

Each candidate had to pass all six:

1. **Does it target a constraint that exists in _this_ repo today?** — named file, script, CI step, or open finding, not a category resemblance.
2. **Does it beat the incumbent?** — if `rag-reviewer`, `judge-review`, `security-reviewer`, `database-reviewer`, or a global skill already covers it, what specifically does this add?
3. **Is the stack right?** — Airflow/dbt/Spark/Terraform/Kubernetes/LangChain/Prometheus guidance is worthless here; the stack is pnpm + Fastify + pg-boss + pgvector + Railway.
4. **Does it risk contradicting a documented decision?** — this repo records _why_ it chose 768 dims, `m=16`, RRF, pg-boss over Temporal, and an empty gold set. Advice that unknowingly argues the other way is a net negative.
5. **Is the plugin's payload mostly signal?** — a plugin is the unit of install; six agents to get three skills is a bad trade.
6. **Is the cost defensible?** — Opus-tier agents and 400-line `references/details.md` files both cost real money and real context.

---

## 4. Tier 1 — Install now

### 4.1 `security-scanning`

**What ships with it**

- Agents: `security-auditor` (**model: opus**), `threat-modeling-expert` (**model: opus**) — namespaced on install as `security-scanning-security-auditor`, `security-scanning-threat-modeling-expert`.
- Commands: `/security-scanning:security-sast`, `/security-scanning:security-dependencies`, `/security-scanning:security-hardening`.
- Skills: `sast-configuration`, `stride-analysis-patterns`, `attack-tree-construction`, `security-requirement-extraction`, `threat-mitigation-mapping`.

**Why it fits this repo**

Three verified facts, not a category guess:

1. **CI has no security stage at all.** `.github/workflows/ci.yml` steps are: Install → Build → Typecheck → Lint → Format check → "No tenant name in the repo" → Unit tests, plus a `parser` job running pytest. A repo-wide grep for `codeql|semgrep|snyk|trivy|npm audit|pnpm audit|dependabot` across `.github/`, `.husky/`, and `scripts/` returns **zero matches**. The `sast-configuration` skill and `/security-scanning:security-sast` exist precisely to close that.
2. **The open findings are security findings.** `CODEBASE-REVIEW.md` [C2] — the Python parser sidecar exposes `POST /parse` with no auth, and is only partially mitigated (bound to `127.0.0.1` in `docker/docker-compose.yml:36`); the recommended `X-Parser-Token` shared secret spans `services/parser-py/app/main.py`, the Node `HttpParserClient`, and `env.example`, and is explicitly parked pending approval. [C1] leaked connector config, [C3] unbounded MCP filters, [H1] leaked DB connection string — all fixed, but the pattern is clear.
3. **Nothing installed does threat modeling.** `rag-reviewer`'s security section is three bullets scoped to a diff. `security-reviewer` (global) finds vulnerability classes in code. Neither produces a STRIDE decomposition of a system that ingests a CPA firm's SharePoint, Gmail, and Outlook under a pluggable `AuthProvider` with scope-threaded retrieval. That is an architecture-level question, and `threat-modeling-expert` + `stride-analysis-patterns` is the only offering in the marketplace aimed at it.

**Concrete use cases**

- _Situation:_ You are ready to decide [C2] and want the attack surface written down before choosing between a shared secret, mTLS, and network-only isolation.
  _Invocation:_ ask for the **`security-scanning-threat-modeling-expert`** agent on `services/parser-py/app/main.py`, `packages/rag/src/parser/`, `docker/docker-compose.yml`, and `docker/compose.prod.yml`.
  _Expect back:_ a STRIDE table per trust boundary (browser → `apps/web` → `apps/api` → parser sidecar; connector → worker → parser), with the specific elevation path — arbitrary binary into LibreOffice/Tesseract bypassing `PARSER_MAX_UPLOAD_BYTES` — named and mapped to candidate mitigations. This is the artifact `CODEBASE-REVIEW.md` says the decision is waiting on.
- _Situation:_ You want a SAST stage in `ci.yml` that actually fits a pnpm + TypeScript + Python-sidecar repo rather than a generic template.
  _Invocation:_ `/security-scanning:security-sast`, then `/security-scanning:security-dependencies`.
  _Expect back:_ a Semgrep/CodeQL configuration covering both `packages/**/*.ts` and `services/parser-py/**/*.py`, plus a dependency-audit step. Add it as a third job in `ci.yml` alongside `quality` and `parser` so it does not slow the existing 15-minute gate.

**Why it clears the §2 bar (never-evaluated, not re-litigated)**

Unlike every other candidate here, `security-scanning` is **not** one of the ~50 plugins the user looked at and set to `false`. It is absent from `enabledPlugins` in both `~/.claude-acct2/settings.json` and `~/.claude/settings.json` — the only security-adjacent entry registered is `security-compliance` (SOC2/HIPAA/GDPR documentation and compliance checklists), which is `false` and solves a different problem: regulatory attestation, not SAST or threat modeling. So this is not a request to reverse a considered rejection; it is the one Tier-1 item that was never on the menu when the catalog was triaged. The rag-system-specific case for adding it is the three verified facts above — an empty security stage in `ci.yml`, an open `[C2]` decision, and no threat-modeling capability anywhere in the installed roster — none of which apply to a generic project and none of which the currently-enabled `comprehensive-review` covers (its `security-auditor` is a per-diff reviewer, not an architecture-level threat modeler).

**Overlap / conflict and how to resolve it**

`security-scanning-security-auditor` substantially duplicates the global `security-reviewer` agent, and both are expensive here (Opus tier). **Resolution: keep invoking `security-reviewer` for routine per-diff review and never name `security-scanning-security-auditor` directly.** Install this plugin for the threat-modeling agent, the three commands, and the five skills; treat the second auditor as dead weight you accept to get them. There is no _name_ collision — installed agents are namespaced — so nothing breaks; the risk is purely that you invoke the pricier duplicate by habit.

### 4.2 `documentation-standards`

**What ships with it**

Skills only — `grounded-vault` and `hads`. **No agents, no commands, no hooks.** This is the cheapest install in the marketplace and carries no per-invocation model cost.

**Why it fits this repo**

Documentation drift is this repo's demonstrated, recurring failure mode, and it is expensive because the docs are load-bearing runbooks.

- `CODEBASE-REVIEW.md`'s **Priority 1** section is literally "Docs ↔ Code Discrepancies," with five auto-fixed drift items: the `Connector` interface documented as `list/fetch/delta` when it is `validate/list/fetch`; a comment pointing at a non-existent `0001_init.sql`; `docs/API.md` examples showing a `config` field that `sanitizeSource` strips; a missing `includeAttachments` field in `docs/CONNECTORS.md`; four env vars read in code but absent from `env.example`.
- `docs/` holds 70+ files including `DOCUMENTATION-REVIEW-2026-08-03.md` and `PURGE-RECORD-2026-08-03.md` — evidence that drift has already been audited and purged once, by hand.
- `grounded-vault` addresses this structurally rather than by re-auditing: a `raw/` → `wiki/` → `archive/` layout, per-claim provenance links, and a **git fingerprint in each page header (`> Fingerprint: git:5b237fa`) so staleness is a `git diff` rather than a re-read of the codebase.** The global `code-doc-audit` / `doc-code-audit` skills _detect_ drift by reading everything; this _prevents_ it and makes the check nearly free. Different mechanism, not a duplicate.

**Concrete use cases**

- _Situation:_ `docs/RAG-ARCHITECTURE-GUIDE.md` and `docs/ARCHITECTURE.md` describe code in `packages/rag/src/retrieval/` and `packages/db/drizzle/0000_init.sql` that changes under them.
  _Invocation:_ "Restructure `docs/ARCHITECTURE.md` as a grounded-vault wiki page" — the skill auto-activates on the task description.
  _Expect back:_ the page rewritten with a header naming its source files and a git fingerprint, every stated constant (`vector(768)`, `m=16`, `ef_construction=64`, ~800-token chunks) linked to the line that defines it. Thereafter `git diff <fingerprint>..HEAD -- packages/db/drizzle/` answers "is this page stale?" in one command.
- _Situation:_ The empty `tests/e2e/src/eval/gold-set.ts` and `docs/EVAL-GOLD-SET-GUIDE.md` encode an epistemic constraint (only a credentialed CPA may author expected answers) that must survive being re-read by future agents.
  _Invocation:_ apply the grounded-vault page-header contract to `docs/EVAL-GOLD-SET-GUIDE.md`, citing `docs/EVAL-BASELINE.md` as `raw/`.
  _Expect back:_ a page where the "the weight sweep is flat, dense=0 changes nothing" claim links to the 2026-08-01 baseline run that established it, so nobody re-derives it or quietly contradicts it.

**Overlap / conflict**

`hads` (the second skill) is a documentation _writing convention_ with semantic tagging. It does not conflict with anything, but **do not retrofit 70 existing docs into HADS** — the current docs are dense, opinionated, and human-voiced, which is a feature. Consider `hads` only for new machine-consumed reference pages. You get it for free with the install; ignore it otherwise.

---

## 5. Tier 2 — Install when the trigger fires

### 5.1 `observability-monitoring` — **trigger: a metrics backend exists**

Agents `observability-engineer`, `performance-engineer`, `network-engineer` (sonnet), `database-optimizer`; commands `/observability-monitoring:monitor-setup`, `/observability-monitoring:slo-implement`; skills `prometheus-configuration`, `grafana-dashboards`, `distributed-tracing`, `slo-implementation`.

The gap is real — `packages/runtime/src/monitoring.ts` is Sentry error capture only, with `pino` logs alongside, and there is no `/metrics` endpoint, no OpenTelemetry, and no SLO defined anywhere in `docs/`. But three of the four skills are concretely Prometheus/Grafana/Jaeger/Tempo, and Railway supplies none of those. **Promote when you stand up a Prometheus-compatible scrape target** (or move to the `docker/compose.prod.yml` single-VM stack where you control the sidecars). Until then take `slo-implementation` skills-only (§6.2), whose SLI/SLO/error-budget method is stack-independent.

### 5.2 `incident-response` — **trigger: the pilot becomes a paying multi-tenant deployment**

Skills `postmortem-writing`, `incident-runbook-templates`, `on-call-handoff-patterns` are relevant to a service with `docs/BACKUP-SCHEDULE-RUNBOOK.md`, a **known-broken Railway PITR restore path (err 088)**, and `docs/CI-PARSER-DISK-EXHAUSTION.md`. But the plugin ships **six agents** (`code-reviewer`, `debugger`, `devops-troubleshooter`, `error-detective`, `incident-responder`, `test-automator`), five of which duplicate the global roster including `devops-incident-responder`. Bad ratio for a single-operator pilot. Promote when there is an on-call rotation with more than one person — `on-call-handoff-patterns` only means something then.

### 5.3 `cicd-automation` — **trigger: leaving Railway, or a real multi-stage deploy pipeline**

`github-actions-templates`, `deployment-pipeline-design`, `secrets-management` skills are useful; `terraform-specialist`, `kubernetes-architect`, `cloud-architect` agents are not, given Railway plus `docker/compose.prod.yml`. `docs/DEPLOYMENT.md` documents a hand-managed ordering constraint (deploy `rag-worker` first on schema-changing releases, because it owns `preDeployCommand`) that a pipeline could encode. Take `github-actions-templates` skills-only today (§6.3); promote the plugin when that ordering constraint needs to live in CI rather than in a doc.

### 5.4 `llm-application-dev`, skills-only `vector-index-tuning` — **trigger: chunk count approaches 1M, or p95 search latency regresses**

Covered under §6.1. The plugin itself stays rejected (§7).

---

## 6. Skills-only picks

The plugin is the unit of marketplace install; these three are worth pulling alone. Use either form:

```bash
gh skill install wshobson/agents vector-index-tuning
# or
npx skills add wshobson/agents --skill vector-index-tuning
```

### 6.1 `vector-index-tuning` (from `llm-application-dev`)

**Why alone:** this is the _only_ one of `llm-application-dev`'s eight skills that covers ground the repo has not already settled. `0000_init.sql` sets `m=16, ef_construction=64` with a comment calling them "sensible defaults for <1M chunks" — build-time parameters. The skill additionally covers **`efSearch` (query-time recall/latency trade-off)** and **quantization (FP16 / INT8 / binary)**, neither of which appears anywhere in `packages/db/` or `packages/rag/`. At 768 dimensions × FP32, memory is 3 KB per vector before index overhead; halfvec would halve it. That is a genuine future lever.

**Why not the plugin:** see §7 — the other seven skills re-teach decisions this repo already made and documented.

### 6.2 `slo-implementation` (from `observability-monitoring`)

**Why alone:** the SLI → SLO → error-budget method is stack-agnostic and applies today: the pilot has users, `docs/PILOT-LAUNCH-STATUS.md` and `docs/PLAN-LAUNCH-READINESS.md` exist, and no reliability target is written down anywhere. **Caveat:** the skill's examples are PromQL. Read it for the method, translate the SLIs onto whatever you actually have (Sentry rates, Railway metrics, pg-boss job outcomes in `apps/worker/src/handlers/`).

**Why not the plugin:** `prometheus-configuration` and `grafana-dashboards` presume infrastructure that does not exist here; `distributed-tracing` is Jaeger/Tempo over microservices, and this is five services behind one Railway project.

### 6.3 `sql-optimization-patterns` (from `developer-essentials`)

**Why alone:** EXPLAIN-driven index analysis is the exact shape of two live findings — `[H2]` (the HNSW and tsvector GIN indexes are invisible to Drizzle, so the next `pnpm db:generate` would DROP them) and `[H3]` (`documents_metadata_gin_idx` uses `jsonb_ops`, which supports `@>`/`?`/`?&`/`?|` but **not** the `->>` text extraction the metadata post-filter actually performs, so the index does not accelerate it). It activates automatically on the task rather than requiring you to remember to summon `database-reviewer`.

**Why not the plugin:** `developer-essentials` ships 11 skills. `monorepo-management` is Turborepo/Nx-centric and `bazel-build-optimization`, `nx-workspace-patterns`, `turborepo-caching` are all dead here — verified: no `turbo.json`, no `nx.json`, plain `pnpm -r`. `e2e-testing-patterns` is Playwright/Cypress; this repo's e2e is Vitest against a Postgres service and a parser container. `auth-implementation-patterns` is more generic than the repo's existing `AuthProvider` contract (`packages/core/src/{auth,oidc-auth,auth-provider-factory}.ts`). `code-review-excellence`, `debugging-strategies`, `git-advanced-workflows`, `error-handling-patterns` duplicate the global roster.

---

## 7. Considered and rejected

18 candidates rejected.

| Offering                                                                                                      | Why it looked relevant                                                                       | Why it is not                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`llm-application-dev` (plugin)**                                                                            | Exact domain match: "RAG systems, vector search"                                             | The plugin's payload is a LangChain/LangGraph-oriented toolkit for building a RAG system. This repo _is_ one, with no LangChain anywhere. See the six rows below for the skill-by-skill verdict; only `vector-index-tuning` survives, as a skills-only pick.                                                                                                                                                                                            |
| `rag-implementation` (skill)                                                                                  | "Build RAG systems with vector databases and semantic search"                                | 138-line tutorial + 410-line `references/details.md` on chunking, vector-DB selection, and retrieval basics — all decided here and documented in `CLAUDE.md`'s seven-step pipeline. Worse, it would introduce vector-DB alternatives into a repo whose `chunks.embedding vector(768)` and HNSW index are load-bearing.                                                                                                                                  |
| `hybrid-search-implementation` (skill)                                                                        | The repo's core retrieval is hybrid dense + sparse                                           | The skill's content is a fusion-methods table (RRF / Linear / Cross-encoder / Cascade) and "tune weights empirically". `packages/rag/src/retrieval/retriever.ts` already implements RRF with cross-encoder reranking behind `RERANK_PROVIDER`, and `docs/EVAL-BASELINE.md` records that the weight sweep was already run and came back flat.                                                                                                            |
| `embedding-strategies` (skill)                                                                                | The repo has three embedding providers                                                       | Model-comparison tables. The choice is made and constrained: `gemini-embedding-001` at 768 dims, with `text-embedding-004` explicitly forbidden in `CLAUDE.md` and a documented re-embed + index-rebuild cost for any change. Generic "pick a better model" advice actively fights that.                                                                                                                                                                |
| `similarity-search-patterns` (skill)                                                                          | Semantic search is the product                                                               | Distance-metric formulas (cosine/L2/dot). `0000_init.sql` commits to `vector_cosine_ops`. Zero decision left to make.                                                                                                                                                                                                                                                                                                                                   |
| `llm-evaluation` (skill)                                                                                      | The repo runs `pnpm eval` / `pnpm eval:real`                                                 | Its RAG section lists MRR, NDCG, Precision@K, Recall@K — exactly what `tests/e2e/src/eval/metrics.ts` already implements, as pure unit-tested functions with documented tie-breaking and zero-relevant-set handling. The repo's `faithfulness.ts` goes further than the skill does. And the actual blocker is not methodology: `gold-set.ts` is empty because authoring expected answers is a **credentialed-CPA judgment**, which no skill can supply. |
| `langchain-architecture` (skill), `/llm-application-dev:langchain-agent`, `/llm-application-dev:ai-assistant` | Shipped alongside the RAG skills                                                             | Zero LangChain/LangGraph dependencies in any of the 13 workspace `package.json` files. Adopting them would violate `CLAUDE.md`'s layering rules (`@rag/services` is transport-agnostic; `@rag/runtime` owns the dep graph).                                                                                                                                                                                                                             |
| `vector-database-engineer` (agent)                                                                            | "pgvector for RAG applications"                                                              | Its capability list is breadth across Pinecone, Weaviate, Qdrant, Milvus, IVF/PQ/DiskANN, billions of vectors. This repo has one vector store, one index type, and a pilot-scale corpus. The 95% that does not apply is context you pay for on every invocation.                                                                                                                                                                                        |
| `ai-engineer`, `prompt-engineer` (agents)                                                                     | LLM application work                                                                         | `prompt-engineer` duplicates `~/.claude/agents/prompt-engineer.md` exactly. `ai-engineer` is a generic LLM-app builder; `rag-reviewer` + `judge-review` + `CLAUDE.md` encode far more specific constraints for this codebase.                                                                                                                                                                                                                           |
| **`data-engineering`**                                                                                        | "ETL pipeline construction, batch processing" — matches `packages/ingestion/src/pipeline.ts` | Its four skills are `airflow-dag-patterns`, `dbt-transformation-patterns`, `spark-optimization`, `data-quality-frameworks`. The repo's pipeline is TypeScript functions dispatched as pg-boss jobs (`apps/worker/src/handlers/sync-source.ts`). No Airflow, no dbt, no Spark, no plan for any. Pure keyword collision.                                                                                                                                  |
| **`database-cloud-optimization`**                                                                             | pgvector performance; cloud cost                                                             | `database-optimizer` and `database-architect` duplicate the global `database-reviewer` (a PostgreSQL specialist). The `/cost-optimize` command targets AWS/Azure/GCP spend; this runs on Railway. The genuine need — EXPLAIN on the HNSW/GIN paths — is met by `sql-optimization-patterns` skills-only (§6.3).                                                                                                                                          |
| **`database-migrations`**                                                                                     | Hand-authored SQL in `packages/db/drizzle/`, a real migration ordering constraint            | `/sql-migrations` generates conventional ORM migrations. That is the precise behavior `.claude/hooks/migration-guard.mjs` exists to intercept, and `[H2]` warns that a naive `drizzle-kit generate` would DROP `chunks_embedding_hnsw_idx` and `chunks_tsv_idx`. Installing a command that encourages it is a net risk.                                                                                                                                 |
| **`block-no-verify`**                                                                                         | `.husky/pre-commit` runs `check-secrets.mjs`; bypassing it would be serious                  | Already solved locally. `.claude/hooks/git-guard.mjs:24` regex-blocks `git commit --no-verify` and the `-n` short form, and also blocks `git add -f/--force`. Installing this would add a second hook doing the same job.                                                                                                                                                                                                                               |
| **`comprehensive-review`**, **`performance-testing-review`**, **`tdd-workflows`**                             | Code review and TDD are daily work here                                                      | Every agent (`code-reviewer`, `architect-review`, `security-auditor`, `test-automator`, `tdd-orchestrator`) duplicates the global roster or `.claude/rules/tdd.md`, and none knows this repo's layering contract the way `rag-reviewer` does. `judge-review` already provides the adversarial second pass, on a cheap model.                                                                                                                            |
| **`javascript-typescript`**                                                                                   | TypeScript monorepo                                                                          | `typescript-pro` and `javascript-pro` duplicate the global `typescript-pro` and `typescript-reviewer`. `nodejs-backend-patterns` and `typescript-advanced-types` are general; `CLAUDE.md`'s "Architectural ground rules" are stricter and more useful.                                                                                                                                                                                                  |
| **`backend-development`**                                                                                     | Async job orchestration in `apps/worker`                                                     | Its skills are Temporal, saga orchestration, CQRS, event sourcing, projections. `CLAUDE.md` states flatly that ingestion is async via pg-boss and the API enqueues while the worker executes. Introducing event-sourcing vocabulary is architecture creep against a documented decision.                                                                                                                                                                |
| **`c4-architecture`**, **`code-documentation`**, **`documentation-generation`**                               | 70+ docs, an `ARCHITECTURE.md`, an `API.md`                                                  | `~/.claude/skills/c4-architecture` already exists globally; `docs-architect` / `tutorial-engineer` / `api-documenter` overlap the global `doc-updater` and `documentation-review` skill. The repo's documentation problem is drift and provenance, not generation volume — which is why `documentation-standards` made Tier 1 and these did not.                                                                                                        |
| **`agent-teams`**, **`skill-forge-essentials`**, **`avoid-ai-writing`**                                       | Generic agent-workflow improvements                                                          | None ties to a rag-system constraint. `avoid-ai-writing` in particular is aimed at machine-sounding prose; `CLAUDE.md` and the `docs/` runbooks are distinctly human-voiced and opinionated. `skill-forge-essentials`' file-bloat concern is already handled by `scripts/check-file-sizes.mjs`.                                                                                                                                                         |

**One gap the marketplace does not fill:** `apps/teams-bot` (botbuilder, Entra SSO token exchange, Adaptive Cards, `MemoryStorage` single-instance constraint) has **no** matching offering in any of the 94 plugins. `backend-api-security`'s `backend-security-coder` is the nearest thing and is generic OAuth/JWT guidance already covered by the global `security-reviewer`. Keep `apps/teams-bot/src/auth.ts` and `scope.ts` under `rag-reviewer` + `security-reviewer` review; nothing here improves on that.

---

## 8. Installation plan

**Precondition:** the marketplace is already registered as `claude-code-workflows` (§2). Do **not** run `/plugin marketplace add wshobson/agents` — that double-registers the same upstream repo under a second alias and gives you two copies of all 94 plugins. Confirm which config dir you are about to change first:

```bash
echo "$CLAUDE_CONFIG_DIR"   # expect /Users/marcusklein/.claude-acct2
grep -o '"[a-z0-9-]*@claude-code-workflows": *\(true\|false\)' "$CLAUDE_CONFIG_DIR/settings.json" | sort
```

```bash
# 1. Tier 1a — security-scanning. GENUINE INSTALL: it is absent from both
#    config dirs (only the unrelated `security-compliance` is registered, false).
/plugin install security-scanning@claude-code-workflows
#    Verify: /security-scanning:security-sast resolves as a command, and
#    `security-scanning-threat-modeling-expert` appears in the agent picker.
#    Names are namespaced, so no collision with the global `security-reviewer`.
#    See the user-scope warning below before accepting this globally.

# 2. Tier 1b — documentation-standards. NO ACTION NEEDED in the live dir:
#    already `"documentation-standards@claude-code-workflows": true` in
#    ~/.claude-acct2/settings.json. grounded-vault and hads are loaded now.
#    Verify: ask "restructure docs/ARCHITECTURE.md as a grounded-vault page"
#    and confirm the skill fires and emits a `> Fingerprint: git:<sha>` header.
#    Only if working under ~/.claude/ (absent there):
#      /plugin install documentation-standards@claude-code-workflows
#    Do NOT bulk-convert docs/ to HADS.

# 3. Skills-only picks — no agents, no commands, no plugin payload, no
#    enabledPlugins entry. Preferred shape for all three (see §9 user-scope row).
gh skill install wshobson/agents sql-optimization-patterns
gh skill install wshobson/agents slo-implementation
gh skill install wshobson/agents vector-index-tuning
#    (equivalently: npx skills add wshobson/agents --skill <name>)
#    Verify: each lands as a skill only; confirm no new agents appeared.

# 4. REMOVAL — the one change §7 actually demands. llm-application-dev is
#    currently `true` in ~/.claude-acct2/settings.json, so the eight skills and
#    three agents rejected in §7 are live in every session today. Flip to false:
#      "llm-application-dev@claude-code-workflows": false
#    (or `/plugin uninstall llm-application-dev@claude-code-workflows`)
#    Verify: rag-implementation, embedding-strategies, hybrid-search-implementation,
#    similarity-search-patterns and the vector-database-engineer agent disappear
#    from the session's skill/agent listing. Re-add vector-index-tuning via the
#    skills-only installer in step 3 — that one skill is worth keeping.
```

**Prefer repo-scoped enablement over the global flip.** For step 1, the cheaper form is to add an `enabledPlugins` block to `~/dev/rag-system/.claude/settings.json` (verified: that file has no `enabledPlugins` key today, only `$schema`, `permissions`, and `hooks`) so `security-scanning` loads in this repo and nowhere else, and the decision is committed to git beside the existing hooks. Use the global `/plugin install` only if you want it in every project.

**After the whole sequence**, run one throwaway session and check that context at session start has not materially grown — step 4 should more than pay for step 1. Then run `pnpm test && pnpm typecheck` to confirm nothing installed touched the repo.

**Do not** add any of these to `.claude/settings.json` permissions until you have seen what commands they actually run; the existing allow/ask/deny tiering is well-tuned and worth preserving.

## 9. Risks and caveats

| Risk                                         | Detail and mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opus-tier cost**                           | Both `security-scanning` agents are `model: opus`. `security-scanning-security-auditor` is a near-duplicate of the global `security-reviewer`; invoking it by reflex means paying Opus rates for work a cheaper incumbent already does. Name `security-scanning-threat-modeling-expert` explicitly when you want threat modeling, and otherwise stay on `security-reviewer` / `rag-reviewer` / `judge-review`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Enablement is user-scope, not repo-scope** | This is the biggest hidden cost here. `enabledPlugins` in `$CLAUDE_CONFIG_DIR/settings.json` is **global**: flipping `security-scanning` to `true` for rag-system loads its 2 Opus agents, 3 commands, and 5 skills into **every** session on this machine — `recovery-platform`, `smm-therapy`, `cpa-consulting`, all of them. That is precisely why ~50 of the 56 registered entries are already `false`. Two cheaper alternatives, in preference order: (a) **repo-scoped enablement** — put `enabledPlugins` in `~/dev/rag-system/.claude/settings.json` (currently unused there; verified no `enabledPlugins` key in either the committed or `.local` file), so the plugin loads only in this repo and the choice is version-controlled alongside the existing hooks and permissions; (b) **skills-only installers** — `gh skill install` / `npx skills add` pull a single skill with no agents, no commands, and no plugin payload, which is the right shape for all three §6 picks. Reserve global enablement for something you want everywhere. |
| **Two config dirs drift apart**              | `CLAUDE_CONFIG_DIR=/Users/marcusklein/.claude-acct2` is live; `~/.claude/` belongs to the other account and has 54 entries to acct2's 56, with a different enabled set (`documentation-standards` and `llm-finetuning` exist only in acct2; `llm-application-dev` is `true` in acct2 and `false` in `~/.claude/`). Any instruction in §8 applies to whichever dir is live when you run it. Check `echo $CLAUDE_CONFIG_DIR` before editing, and expect a recommendation applied in one account to be silently absent in the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Agent-roster dilution**                    | Installing these adds 2 agents to a picker that already holds 37 global + 2 repo-local. The repo-local `rag-reviewer` and `retrieval-eval-runner` are the ones that know this codebase; the more generic reviewers sit beside them, the more likely a session picks the wrong one. Consider a line in `CLAUDE.md` stating that `rag-reviewer` is the default reviewer for this repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Context cost of `references/`**            | 149 of the 183 marketplace skills carry a `references/details.md`; the three skills-only picks have 453, ~500, and ~400-line reference files that load on demand. That is fine when triggered deliberately and wasteful when triggered by a loose keyword match. If `vector-index-tuning` starts firing on unrelated pgvector work, uninstall it — the repo has no 1M-chunk problem yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Advice contradicting recorded decisions**  | The real hazard with this marketplace in this repo. `CLAUDE.md`, `docs/EVAL-BASELINE.md`, `0000_init.sql`, and `gold-set.ts` all record _why_ a choice was made. Generic skills do not know that. This is the entire reason `llm-application-dev` is rejected, and it is why any future addition should be checked against §3 criterion 4 before installing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **No external-service dependency**           | Nothing recommended here needs an MCP server, API key, or SaaS account. `sast-configuration` will suggest tools (Semgrep/CodeQL) that do need CI setup — that is a deliberate, separate decision, not an install-time dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Third-party marketplace drift**            | `wshobson/agents` is not vendored and moves without notice: plugin contents, skill bodies, and model tiers can all change under you. This document reflects the 2026-09-15 snapshot (94 plugins / 202 agents / 183 skills / 105 commands). Re-verify before trusting any name here more than a quarter from now, and treat `/plugin marketplace update` as a change that warrants the same scrutiny as a dependency bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Interaction with existing hooks**          | `.claude/hooks/migration-guard.mjs` fires on Edit\|Write and `git-guard.mjs` / `command-guard.mjs` on Bash. None of the recommended plugins ships hooks (only `protect-mcp` and `review-agent-governance` do in the whole marketplace), so there is no hook-ordering risk from this install set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
