# RAG System Evaluation — 2026-07-13

**Purpose of this document:** a single, current, evidence-based assessment of `rag-system` as it exists today, organized so it can be handed directly to `/make-plan` or `superpowers:writing-plans` to produce an execution plan toward real-world (TWK CPA firm) launch. Every finding below carries a file:line citation or an explicit "operational, not code" label — this codebase has a documented history of stale audit docs creating false confidence in both directions (claiming fixed things are broken, and broken things are fixed), so this pass re-verified every carried-forward claim against current code AND current live production state, rather than trusting prior docs or the codebase alone.

**Method:** direct code reads/greps against the current branch (`feat/kb-governance-phase3-audit-parity`, itself already merged to `main` via PR #33) plus four parallel focused re-verification passes (RAG-quality specifics, test coverage, security/compliance, deployment/ops — the last including live, read-only Railway CLI and production-database checks), reconciled against this session's own hands-on work (fixed a 21-day-silent production outage, ran a real backup/restore drill). Supersedes `docs/TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md` and `docs/RAG-VALIDATION-REPORT.md` as the current source of truth.

---

## 0. One-paragraph verdict

**The codebase is in materially better shape than what's actually running.** Every one of the 2026-07-08 assessment's P0/P1 items has a real, verified fix in the current codebase — but §3's top finding (P0-1) is that **production has not been redeployed since 2026-07-04**, so none of that work is live. The compliance gates this whole review process exists to protect (`data_class` ingestion enforcement, the §7216 disclosure audit trail, per-source access grants, the 64-char JWT secret minimum) are sitting in git, not serving traffic. This is the same failure shape as the `rag-parser` incident fixed earlier today (a stale container silently serving old code) but at a larger scale — three of the five production services, not one — and caused by a different mechanism (nobody redeployed after merging, not a healthcheck bug). The platform engineering itself is genuinely strong once live: transport-agnostic service layer, SQL-enforced authorization, real prompt-injection defenses, a real per-user auth feature, and a now-verified Postgres restore path. But "the fix exists in the repo" and "the fix is protecting real users" are two different claims, and right now only the first one is true for most of this session's compliance work.

---

## 1. System overview (for context, not a finding)

Five-stage pipeline: **Connectors** (SharePoint, Google Drive, Gmail, Outlook) → **Python parser sidecar** (`services/parser-py/`, FastAPI + MarkItDown/Unstructured, converts every format to markdown) → **chunker** (~800-token windows, heading/list/code-aware) → **embedder** (Gemini `text-embedding-004`/`gemini-embedding-001` default, local ONNX fallback for §7216 compliance mode, OpenAI supported) → **Postgres + pgvector** (hybrid dense+sparse retrieval via RRF). Exposed via HTTP API (`apps/api`) and MCP server (`apps/mcp`, the agent-facing surface); ingestion runs async via `apps/worker` + pg-boss. `apps/web` is a Next.js BFF chat UI with per-user Entra ID auth. Deployed to Railway (production project, 5 services: `rag-postgres`, `rag-parser`, `rag-api`, `rag-worker`, `rag-mcp`), via manual `railway up`/CLI pushes — **not** GitHub-integrated auto-deploy (confirmed: every deploy in Railway's history shows `cliCaller`, not a git-push trigger).

---

## 2. Strengths (calibration — this is not a document of only problems)

- **Authorization is enforced in SQL, not application logic.** `Retriever.search` takes a mandatory `AuthorizationScope` argument threaded into `hybridSearch`'s WHERE clause (`packages/core/src/access-control.ts`, `packages/db/src/queries.ts`) — scope can't be silently bypassed by a route/tool forgetting to filter.
- **Transport-agnostic service layer.** `@rag/services`'s five functions (`searchDocuments`, `askQuestion`, `triggerSync`, `listPublicSources`, `getDocumentById`) are the single source of truth for business logic, shared by both HTTP API and MCP — no duplicated search/ask logic to drift out of sync.
- **Real, adversarially-tested prompt-injection defenses**, confirmed both-sided this pass: `escapeForAttribute` (title/section, `generator.ts:43-48`) and body-text escaping (`generator.ts:68-70`) both neutralize `<document`/`</document>` injection attempts, with explicit test coverage (`generator.test.ts:32-64`) for both an injected closing tag and an attribute breakout.
- **Two-level idempotency**: documents keyed by `(source_id, external_id)`, chunks content-hashed — re-ingesting an unchanged file is a genuine no-op, not a re-embed-and-diff.
- **Authorization/authz test coverage is genuinely solid where it exists**: `purge_source`'s scope gate (`apps/mcp/src/tools/purge-source.test.ts`) exercises admin/in-scope/out-of-scope/deny-all against the real handler, not a mock. Migration-journal monotonicity has a real strict-increase assertion, not just a DROP-statement scan.
- **No SQL injection, XSS, or hardcoded-secret findings** in this pass's OWASP sweep — parameterized queries throughout, no `innerHTML`/`dangerouslySetInnerHTML`/`eval` in the web app, all credentials `process.env`-sourced with fail-loud config validation.
- **This session's own work, verified**: real-embedder (Gemini) retrieval baseline recorded (see §4 for caveats), index-backed metadata filtering, a real Postgres backup/restore drill executed against production and verified byte-for-byte, and a 21-day silent `rag-parser` outage diagnosed and fixed today (see §5).

---

## 3. Findings, by priority

Severity tags: 🔴 CRITICAL/P0 (gate — do not broaden real usage until closed), 🟠 HIGH/P1 (close before adding real users beyond a tight internal check), 🟡 MEDIUM/P2 (real, schedule it), ⚪ LOW/P3 (polish).

### 🔴 P0 — gates

**P0-1. Production `rag-api`/`rag-worker`/`rag-mcp` are running code from 2026-07-04 — 9 days and ~95 commits stale.** _(NEW, most severe finding in this review — discovered via live, read-only Railway + production-DB checks, 2026-07-13.)_ All three services show "Online" in `railway status`, which is misleading — "Online" means the last successfully-deployed build is still running, not that it reflects current `main`. Confirmed via direct evidence:

- `railway deployment list` for all three services: last deploy timestamp `2026-07-04T17:24`–`18:37`.
- Production `drizzle.__drizzle_migrations` (queried read-only via `railway ssh`): **7 migrations applied**; the repo has migrations through `0017`. Migrations `0012`–`0017` are **not applied** — these add `staff_source_assignments`, `docs_gap_digest_runs`, `audit_log_shipper_state`, the `git_markdown`/`ecfr_part4` source kinds, and the `audit_log` provider-disclosure columns.
- `pgboss.schedule`: **0 rows**. No recurring job is scheduled at all — `docsGapDigest` (added 2026-07-06) and `shipAuditLog` (added 2026-07-10) have never fired in production because the running worker binary predates both `boss.schedule()` calls.
- **Concretely, none of the following — despite being verified fixed in the codebase this session (see §6) — are actually protecting production traffic right now**: the `sourceDocClass`/`data_class` ingestion gate, the §7216 disclosure audit trail (API+MCP), the 64-char `INTERNAL_SCOPE_JWT_SECRETS` minimum, direct per-source access grants, and index-backed metadata filtering.
- **Secondary, not fully resolvable read-only**: historical deploy manifests for these three services show `healthcheckPath: null`/`preDeployCommand: null` even for deploys made after the corresponding `railway.json` files were added to the repo — suggesting Railway's config-as-code linkage may not actually be wired to these services' dashboards (in contrast to today's `rag-parser` deploy, whose manifest correctly reflects its repo `railway.json`). If true, `apps/worker`'s documented "single migration owner via `preDeployCommand`" contract (root `CLAUDE.md`) may not be firing automatically even after a redeploy — worth confirming in the Railway dashboard (Settings → Config-as-code path) before relying on it.
  _Impact if unaddressed:_ every compliance and quality fix verified in this document as "resolved" remains theoretical for real users until this closes. This is the actual current state of the production system, and it is materially less protected than the codebase suggests.
  _Owner:_ Eng. Fix path: redeploy `rag-worker` first (per `CLAUDE.md`'s documented migration-owner order), confirm `drizzle.__drizzle_migrations` reaches 18 rows and `pgboss.schedule` populates 2 rows on boot, then redeploy `rag-api`/`rag-mcp`. Same `railway up --service <name>` mechanism used to fix `rag-parser` today, but three services with pending schema migrations — higher blast radius, warrants explicit sign-off before executing, not a blind repeat of today's fix.

**P0-2. No recurring Postgres backup job exists.** `rag-postgres` is a self-hosted `pgvector/pgvector:pg16` container on a Railway volume (`rag-postgres-volume`), not Railway's managed Postgres plugin — confirmed via `railway variables` (raw `POSTGRES_USER`/`PASSWORD`/`DB` env vars, no `DATABASE_PUBLIC_URL`) and `railway volume list` (no backup/snapshot metadata for the volume). Nothing is currently producing a scheduled `pg_dump` or equivalent. **The restore path itself IS verified** (a manual `pg_dump` restores cleanly with correct row counts and rebuilt indexes, drilled today) — but that was pulled by hand; there is no ongoing protection. Documented with implementation options in `docs/DEPLOYMENT.md`'s "Backup & restore" section.
_Impact if unaddressed:_ total, permanent loss of every chunk, embedding, source, and the compliance audit log itself, with zero warning.
_Owner:_ Eng — a scoped build (pg-boss recurring job mirroring the `docsGapDigest`/`shipAuditLog` pattern, once P0-1 makes that pattern actually live — or a Railway cron service independent of it).

**P0-3. Vendor DPA is still provisional — the actual legal/counsel step has not happened.** `docs/compliance/vendor-dpa-google-gemini.md`'s status line, verbatim as of this writing: _"STATUS: PROVISIONAL — NOT COUNSEL-CONFIRMED. This file exists to satisfy the `COMPLIANCE_MODE=client-data` boot gate... It is explicitly not a substitute for the verification steps in Phase 1.2/1.3 of `docs/PLAN-CPA-COMPLIANCE.md`, and does not resolve CR-2/CR-3/CR-4..."_ The code-level gate checks that _a_ DPA file exists on disk — it cannot and does not assert counsel-confirmation or that Cloud Billing status has been verified for the production project.
_Impact if unaddressed:_ the §7216/GLBA compliance story has an unclosed legal link, independent of how solid the code-level gates are (and independent of P0-1 — this is open regardless of deploy state).
_Owner:_ Business/legal — not resolvable by code.

**P0-4. Nobody has audited what's actually indexed in production today.** Unchanged since 2026-07-04: pull the live `sources` table and the actual synced SharePoint folder list, confirm by hand that everything synced is genuinely firm-internal (per the domain owner's own estimate, a few real client examples may have slipped in).
_Impact if unaddressed:_ the compliance story is theoretical until someone confirms actual index contents match intended scope.
_Owner:_ Marcus/Chris (domain owner) — production DB access + human judgment call on content.

### 🟠 P1 — close before broadening beyond a tight internal pilot

**P1-1. RAG-quality correctness edges, re-verified against current code 2026-07-13:**

- **Citation filter drops grouped/ranged citations silently.** `packages/rag/src/generation/generator.ts:94` — `answer.matchAll(/\[(\d+)\]/g)` matches `[3]` but produces zero matches on `[1, 2]`, `[1,2]`, or `[1-3]`; the entire group is silently dropped from the audit trail, not partially matched. No test exercises this. Mitigated somewhat by the system prompt instructing singular `[N]` notation, but the parser has no defense if a model emits a grouped form anyway.
- **Inline Word/PDF tables get character-sliced, not row-preserved.** `packages/rag/src/chunking/composite-chunker.ts:41-49` — `TableChunker` only activates for spreadsheet-origin tables (`sheetType != null`); the comment at lines 16-18 explicitly defers inline PDF/DOCX tables as "a v1 concern." `markdown-chunker.ts` has no table-row detection anywhere — an oversized inline table gets hard-split by sentence regex then raw character-offset slicing, corrupting row/column semantics.
- **No document versioning/supersession.** `packages/db/src/schema.ts:110-174` — `documents` is keyed by `(sourceId, externalId)` with no effective-date or supersession pointer. A `lifecycleStatus` field exists (default `"active"`) but is never referenced in `hybridSearch`'s query — an "archived" document retrieves identically to a current one.
- **Sparse search uses AND-only semantics.** `packages/db/src/queries.ts:526` — `plainto_tsquery('english', ...)`, not `websearch_to_tsquery`. A verbose real-world question (8+ words) requiring co-occurrence of every term in one chunk collapses the sparse side to zero hits, degrading hybrid search to dense-only for such queries.
- **Per-document diversity cap is partial.** `capChunksPerDocument` (`packages/services/src/ask.ts:18-30`) is wired into `ask`/`askStream` — genuinely new since the 2026-07-08 assessment — but `packages/services/src/search.ts` (`searchDocuments`, backing `/search` and the `search_documents` MCP tool) never calls it, and `packages/rag/src/retrieval/retriever.ts` itself has no cap/MMR logic. The plain search endpoint/tool can still be dominated by one long document.
- **Reranking remains unvalidated by design, deferred deliberately** (2026-07-12 decision, documented in `docs/EVAL-BASELINE.md`): the current 14-doc/17-question corpus is already at a measurement ceiling, so an A/B today would be noise. Revisit once real usage data exists via `getWeakResultAuditEvents`.

**P1-2. Test coverage gaps, re-verified against current code 2026-07-13:**

- **Gmail/Outlook/Google Drive connectors have zero test files.** Confirmed: `packages/connectors/src/{gmail,outlook,gdrive}/` contain only implementation files, no `.test.ts`. Contrast with SharePoint/custom/ecfr-part4/git-markdown, which all have connector-specific tests. A pagination/cursor/error-handling regression in any of these three would ship undetected.
- **`packages/runtime/src/index.ts` (`buildCoreDeps`/`buildAuthProvider`) has no test coverage at all** — the package has zero test files. This is the dependency-graph wiring every one of the three backend services calls to construct itself, including the `AUTH_PROVIDER` dispatch switch (static/oidc/composite). A wiring regression would only surface in production or a full e2e run.
- **`GET /documents/:id` and `/documents/:id/download` have no route-level test.** The underlying service function (`getDocumentDownload`) IS well-tested (`packages/services/src/documents.test.ts`, covers cross-scope 404/missing-doc/null-storageKey/disabled-store) — the gap is specifically the Fastify route layer (status codes, header sanitization at the HTTP boundary).
- **Confirmed still solid, no regression**: `purge_source` MCP authorization test, migration-guard monotonicity test.
- **Broader stub/TODO sweep: clean.** No `TODO`/`FIXME`/`not implemented` in source (only in docs, some of which are themselves stale about what's implemented), no disabled/focused tests anywhere.

**P1-3. Decide the non-technical-partner MCP access path, explicitly.** stdio transport requires hand-editing JSON containing a direct Postgres connection string + embedding-provider API key on the partner's own laptop, with unrestricted `ADMIN_SCOPE` (stdio has no per-user scoping by design). HTTP transport is properly scoped but requires MCP "custom connector" client configuration — still non-trivial for a non-technical partner. Product decision, not a code gap, but undecided and blocks re-promising "just ask inside Claude" with confidence.
_Owner:_ Marcus (product decision).

**P1-4. Run the Phase 1 baseline usage diary before quoting cost estimates.** Unchanged since 2026-07-04. Needs real pilot usage (Doug + 1-2 staff) over time, not code.
_Owner:_ Operational — requires the pilot to actually run (and requires P0-1 to close first, since the pilot should run against live current code, not 9-day-stale code).

**P1-5. Web app security headers are entirely absent.** `apps/web/next.config.ts` contains only `{ reactStrictMode: true }` — no `headers()` block; `apps/web/src/middleware.ts` never sets response headers. No CSP, X-Frame-Options, HSTS, X-Content-Type-Options, or Referrer-Policy anywhere in the app or its Railway config. On a GLBA/§7216-relevant chat UI, this means no clickjacking protection and no CSP defense-in-depth against XSS.
_Owner:_ Eng — small, well-scoped fix (a `headers()` block or middleware addition).

### 🟡 P2 — real, schedule it, not a pilot blocker

- **`WEB_AUTH_MODE=static-fallback` has no expiry or deploy-time assertion.** It's a complete, unexpiring bypass of per-user auth by design (documented as a manual-removal emergency rollback), and every fallback-served request IS logged (`console.warn`) — but nothing prevents it from being silently left on indefinitely. Worth a TTL or startup assertion, not urgent given the logging exists.
- **No Sentry PII-scrubbing hook configured**, and — newly discovered this pass — **`SENTRY_DSN` isn't actually set on any of the four backend/parser Railway services**, meaning Sentry error reporting is not live anywhere in production right now, independent of the scrubbing-hook question. Manual `captureException` call sites only pass safe metadata today, which limits blast radius, but there's no structural scrubber and no error visibility at all currently.
- **The audit-log webhook sink (`AUDIT_SINK_PROVIDER`/`AUDIT_SINK_WEBHOOK_URL`/`AUDIT_SINK_WEBHOOK_TOKEN`) is implemented but unconfigured** on any Railway service — defaults to a safe no-op, but the off-host audit-log shipping feature does nothing until these are set (moot until P0-1 closes anyway, since the shipping job itself isn't deployed).
- **Upload MIME validation is client-trusted for anything except empty/`octet-stream`.** The parser sidecar only content-sniffs (`libmagic`) when the caller-supplied MIME is generic; a specific, allow-listed but lied-about MIME skips sniffing. Low real risk (parsed output is text/markdown, never executed), not urgent.
- Build the weekly digest and KB-gap queue as an actual deliverable — a real admin UI (`/admin/docs-gap-digest`) exists, a genuine improvement over the prior "one log line," but it's still pull-only, not the promised Friday push notification to Doug/Chris.
- Add the missing citation-metadata trust fields from the original design (`document_type`, `modified_at`, `section`, `class`, `scope_caption`, `max_source_age_days`, `older_sources_warning`) — currently only `index`/`title`/`url` are populated.
- Column-level encryption at rest and single-client-within-source deletion — both deliberately deferred (documented, not silently skipped); whole-source purge already ships.

### ⚪ P3 — not urgent for a small-scale internal pilot

- **`docs/DEPLOYMENT-TARGET.md` is confirmed stale** — describes a "single VM + docker-compose" target that was superseded by the actual 5-service Railway deployment, and was never updated. Doesn't affect running systems, but will mislead anyone reading it as current architecture (especially its encryption-at-rest story, which doesn't address Railway's actual volume posture).
- No alerting beyond Sentry (and per P2 above, Sentry isn't even configured yet) — no Slack/PagerDuty/email integration exists anywhere in the codebase.
- Document the rollback procedure.
- Retention/purge policy beyond the whole-source purge that already exists.

---

## 4. Retrieval-quality baseline — current state, with caveats

Real-Gemini baseline recorded 2026-07-11 (`docs/EVAL-BASELINE.md`): recall@5=100%, nDCG@5=99.1%, MRR=1.000, flat across the entire dense/sparse RRF weight sweep. **Read this correctly**: the corpus (14 docs/17 questions, deliberately vocabulary-distinctive, explicitly labeled a "STARTER set") has no remaining headroom to discriminate weight tuning or reranking — these numbers are a regression trip-wire, not evidence of real-world quality on genuinely ambiguous CPA questions. Corpus growth was deliberately deferred (2026-07-12) in favor of harvesting a real query set from actual usage once the pilot is live (via `getWeakResultAuditEvents` + the docs-gap-digest infra), rather than hand-authoring synthetic near-neighbor questions now — though note this harvesting path is itself blocked on P0-1, since `docsGapDigest` isn't running in production yet.

---

## 5. Verified fixed in code this session — but NOT yet live in production (see P0-1)

Every item below has a real, direct-code-verified fix as of 2026-07-13. **None of them are protecting production traffic right now** — production `rag-api`/`rag-worker`/`rag-mcp` predate all of this (see P0-1). Listed separately from §3 to avoid the exact "resolved" false-confidence failure mode this document exists to prevent — these are resolved-in-git, not resolved-in-production.

| Item                                                          | Code evidence                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `sourceDocClass` gate wired into real ingestion               | `apps/worker/src/handlers/sync-source.ts:124-129`                  |
| MCP audit-logging (`ask`/`search_documents`)                  | `apps/mcp/src/tools/ask.ts:144`, `search-documents.ts:120`         |
| `purge_source` MCP authorization test                         | `apps/mcp/src/tools/purge-source.test.ts`                          |
| Migration-timestamp monotonicity regression guard             | `packages/db/src/migration-guard.test.ts:90-116`                   |
| `INTERNAL_SCOPE_JWT_SECRETS` minimum length                   | `.min(64)` hex chars, `packages/core/src/config.ts:110-119`        |
| Direct per-source access grants (not just per-client)         | `apps/web/src/app/admin/access/page.tsx`                           |
| H2 — index-backed metadata filtering                          | `@>` containment + numeric/boolean fallback, GIN-indexed           |
| 512-token silent truncation on local embedder                 | `DEFAULT_MAX_TOKENS = 512`, `packages/rag/src/embeddings/local.ts` |
| Disclosure audit trail (embedding provider/model)             | `audit_log.embeddingProvider`/`embeddingModel`, both API and MCP   |
| `docs/ISSUES-AND-OPTIMIZATIONS.md`'s false "DPA signed" claim | Corrected 2026-07-12                                               |
| Prompt-injection delimiter escaping, both sides               | `generator.ts:43-48,68-70`, tested                                 |

**Genuinely live in production (verified via Railway, not just code):**

| Item                                                                           | Evidence                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Postgres restore path                                                          | Real drill executed against production + verified 2026-07-12/13 (row counts, HNSW index rebuild)                                     |
| `rag-parser` 21-day silent deploy failure                                      | Diagnosed and fixed 2026-07-13, verified live via `railway status` + a private-network health check against the new replica          |
| `PARSER_SECRET` rotation                                                       | Rotated on both `rag-parser`/`rag-worker`, restarted, both confirmed `SUCCESS`                                                       |
| No sibling service has `rag-parser`'s exact healthcheck-vs-private-network bug | `rag-api`/`rag-mcp` both have public domains (healthcheck routes correctly); `rag-worker` has no `healthcheckPath` configured at all |

---

## 6. Next step

This document is structured for `/make-plan` or `superpowers:writing-plans`: §3's P0/P1 items are the actionable findings, each with file:line/system context sufficient to scope a task without re-discovery. **Recommended sequencing differs from a naive priority read**: P0-1 (redeploy) should likely come first among the _code_ items despite being listed after nothing — it's what makes §5's already-written fixes actually matter, and P1-4 (the usage diary) explicitly depends on it. P0-2/P0-3/P0-4 are independent of P0-1 and of each other. P1 items can mostly proceed in parallel once P0-1 closes, except P1-3 (product decision) gates how urgently P1-2's MCP-adjacent gaps matter.
