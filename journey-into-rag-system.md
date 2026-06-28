# Journey Into rag-system

_A technical history of how a generic RAG service was built, hardened, and deployed — written from 501 persistent memory observations spanning June 6–27, 2026._

---

## 1. Project Genesis

The first traces in memory appear at 11:34 PM on June 6, 2026. They are not glamorous: observations 157 and 158 record that `nvm` was installed but not sourced in the shell configuration, and then that the initialization was added to `.zshrc`. Before a single line of application code could run, the developer had to fix their own environment.

Two sessions ran that night — S65 (nvm/PATH fix) and S67 (Pathfinder analysis) — and by 11:45 PM the real work began. Observations 166 through 173, filed in a compressed eleven-minute burst, document the first architectural survey: embeddings system, hybrid retrieval, worker job lifecycle, parser sidecar wire contract, chunking router, connectors factory, MCP server, and HTTP API. This was not planning; it was reconnaissance. Someone arriving at an existing codebase — or re-acquainting themselves with one after a gap — was building a mental map.

What problem was being solved? The architecture that emerged from that first scan makes it clear: a Retrieval-Augmented Generation service designed as infrastructure for knowledge retrieval across enterprise document sources. SharePoint, Google Drive, Gmail, Outlook — the connectors cover the standard Microsoft/Google productivity stack. The output surface was dual: an HTTP API for direct browser/chat integration and an MCP server for agent-facing usage. The domain context that surfaced later (session S316 on June 13, which triggered a full codebase learning pass) confirmed this was positioned as a confidential-corpus knowledge base for a professional services firm.

The first decisive observation came at 11:53 PM on June 6: observation 189, "Five-system architectural proposal to unify duplication and fix critical bugs in rag-system." This single decision note — a `⚖` decision marker in the timeline — set the agenda for the next five days of work. The five systems identified were transport-agnostic services, shared runtime dependency graph, unified validation and security, connector pagination abstraction, and parser type single-sourcing. The follow-up handoff prompts (observation 192) specified execution order and included anti-pattern guards. The project had a name — the five-systems unification — before a single refactoring commit was written.

---

## 2. Architectural Evolution

### Phase 1: The Status Quo (Pre-June 8)

Before the refactoring sprint began, the codebase had observable duplication problems documented in observation 186 (11:51 PM, June 6): the HTTP API and MCP server each implemented search and ask logic independently, with behavioral drift between them. The composition root for core dependencies (database pool, embedder, retriever, queue) was being rebuilt independently in each app. Filter validation schemas existed in multiple places. The bearer-token verifier was not shared. The Python parser's TypeScript types were hand-authored and could drift from the actual Pydantic models. Connector pagination logic — cursor codec, page loop — was copy-pasted across all four connectors.

These were not catastrophic bugs, but they were the kind of compounding debt that makes large changes dangerous. A security fix in one place would fail to land in another. A schema change in the parser would silently break TypeScript consumers.

### Phase 2: The Services Layer (June 8, 1:48–2:50 AM)

In a two-hour sprint starting before 2 AM, the core architecture was restructured. Observations 522 through 571 document this at granular resolution:

- `@rag/services` package created with five transport-agnostic service functions: `searchDocuments`, `askQuestion`, `getDocumentById`, `triggerSync`, `listPublicSources`.
- `@rag/runtime` package extracted: `buildCoreDeps()` wires the DB pool, embedder, retriever, queue, and optional generator once, shared by all three apps.
- HTTP routes and MCP tools refactored to be thin delegation adapters calling the service layer.
- `createTokenVerifier` extracted to `@rag/core` and tested (observations 567–568).
- `toPublicSource` promoted to `@rag/db` to replace the duplicated `sanitizeSource` function in each route (observations 561–564).
- Filter validation schema consolidated to `@rag/core` with DoS bounds (observations 555–557).

By 2:36 AM (observation 552), the workspace built successfully. By 2:49 AM (observation 568), tests passed. This is an unusually clean refactoring sprint for 2 AM — the prior Pathfinder analysis had been precise enough to script the execution rather than discover it.

### Phase 3: Connector Pagination (June 9, 6:09–6:19 PM)

Observations 612 through 630 document a systematic pass through all four connectors — Outlook, SharePoint, Google Drive, Gmail — extracting the cursor codec and `paginate()` helper into shared utilities. The pattern was identical in each case: extract cursor codec, consolidate pagination into `paginate()`, refactor `runInitial` and `runDelta` to single-page fetchers. The connector package compiled and tests passed within ten minutes of the last change (observation 630). The `paginate()` helper was formally canonized in observation 722 on June 10.

### Phase 4: Python Parser as Single Source of Truth (June 10, 9:07–9:20 AM)

Observations 702 through 716 document the resolution of a subtle but important problem: the Python parser's TypeScript types were manually maintained, meaning they could drift from the actual Pydantic models on the FastAPI sidecar.

The solution was to generate them from the parser's live OpenAPI schema. Observation 704 records adding a `gen:parser-types` script to `package.json`. By observation 712, "single-source-of-truth types working end-to-end." A code review (observation 714) surfaced one HIGH issue: the `metadata` field lacked `additionalProperties` in the OpenAPI schema, meaning the TypeScript type was not truly accurate. Observation 715 confirmed the root cause. The fix involved updating the Pydantic model to emit proper `additionalProperties`.

This pattern — generate from source, detect drift in code review, fix the source — is the right sequence for keeping a polyglot contract honest.

### Phase 5: Authorization Threading (June 11, 10:51 PM–11:18 PM)

The most complex merge conflict in the project's history was resolved between 10:51 and 11:18 PM on June 11. Observations 1233 through 1280 document a 14-file conflict resolution. The root divergence: two branches had independently evolved the same codebase — one adding authorization scope threading, one implementing the five-systems service refactoring. Observation 1234 identified the key behavioral difference: the HTTP API derived scope per-request, while the MCP server used per-session scope parameters.

The resolution required not just mechanical merge resolution but semantic integration: `searchDocuments`, `askQuestion`, and `getDocumentById` all needed a `scope` parameter added to the service signatures, so the service layer could enforce authorization without the routes reimplementing it. Fourteen files resolved, stale `.d.ts` files rebuilt, workspace-wide typecheck passed by observation 1274.

### Phase 6: Pluggable Auth (June 15, 2:41–2:58 AM)

Observations 1703 through 1730 document the last major architectural pivot of this period: authentication abstracted from a hardcoded static-token verifier to a pluggable `AuthProvider` interface supporting `static-token`, `oidc`, and `composite` strategies. The composite strategy — try static first, fall back to OIDC — was designed so that a zero-OIDC-config deployment behaved identically to the legacy static-token setup, preserving backward compatibility.

Two bugs were found and fixed during this work (observations 1710–1711): a missing `await` on an `async scopeForRequest()` call in MCP session initialization, and the need to wrap async auth middleware for Express 4's synchronous error propagation model.

---

## 3. Key Breakthroughs

**The five-systems handoff (June 6, 11:54 PM).** The single most leveraged moment was observation 192 — a set of five operationalization prompts with execution order. A planning session produced not just a design but a script for future sessions to execute. The next session (June 8) ran that script almost verbatim. The memory system made this handoff lossless.

**`buildCoreDeps` as composition root (June 8, 2:30 AM).** Observation 546 records the moment `@rag/runtime` was extracted and the three apps (`api`, `mcp`, `worker`) all delegated dependency construction to `buildCoreDeps`. This was the architectural keystone that made the rest of the refactoring safe — there was now a single place where the core dependency graph was wired, and it could be tested independently.

**OpenAPI type generation going live (June 10, 9:16 AM).** Observation 712: "single-source-of-truth types working end-to-end." This closed a category of bugs — parser schema drift — that could not be caught at compile time before this point.

**The first streaming endpoint (June 20).** Observation 2199 records "Streaming Q&A support added to Generator interface." This was the feature that made the system useful for interactive chat rather than just batch retrieval.

**Gemini embedding model discovery (June 20, 11:22 PM).** Observation 2240: "Gemini text-embedding-004 model no longer available in v1beta API." The fix (observations 2241, 2244) was simple — switch to `gemini-embedding-001` — but the discovery was only possible because a billing account was configured (observation 2207) and the system actually ran. This is the kind of breakage that only surfaces in production.

---

## 4. Work Patterns

The timeline reveals three distinct rhythms:

**Late-night architectural sessions (midnight–3 AM).** The June 8 services extraction, the June 15 pluggable auth, and the June 11 merge conflict resolution all happened between midnight and 3 AM. These sessions share a pattern: no exploratory observations early on, just a sequence of `↻` (refactor) and `✓` (change) markers with occasional `○` (discovery) when something unexpected surfaced. The prior planning sessions had loaded enough context that the execution was mechanical.

**Daytime verification and integration (9 AM–12 PM).** June 9, 10, and 13 all show verification and integration work in mid-morning: running tests, pushing PRs, reconciling roadmaps. These sessions are heavier on `○` (discovery) markers — surfacing things that had been overlooked.

**Evening deployment and infrastructure (7–11 PM).** The Railway deployment work (June 16), SharePoint planning (June 17–19), and quality gate work (June 26–27) predominantly happened in the evening. These sessions are messier: more debugging, more unexpected blockers, more `●` (bugfix) markers.

The observation type breakdown confirms this pattern quantitatively: 195 discoveries, 155 changes, 76 features, 51 refactors, 21 bugfixes, 19 decisions. The project spent more time discovering and changing than it did building new features or fixing bugs — the signature of a refactoring-heavy phase.

---

## 5. Technical Debt

**The `ingestion_jobs` double-write (C2a bug).** One of the earliest named bugs was a duplication issue where both the API trigger path and the worker handler were writing to `ingestion_jobs`. Observations 522–527 show the fix: `ingestionId` added to `SyncSourcePayload`, `SyncAlreadyRunningError` introduced, worker updated to only update producer-created rows. But the debt wasn't fully paid until observation 781 (June 10): "Hardened triggerSync error handling to prevent audit trail corruption." The error cleanup path had a secondary bug — if the cleanup `delete` threw, the original error was masked. Two separate sessions were required to fully close this.

**The metadata type boundary.** Observation 773 (June 10) notes: "ParsedDocument.metadata type changed to `Record<string, unknown>` but boundary validation missing." This was flagged as a medium-priority follow-up. The type was right; the validation at the ingestion boundary was not added in the same session. It remained an open item in the roadmap.

**Parser types requiring manual regeneration.** Even after the OpenAPI generation workflow was established, the types still required `pnpm gen:parser-types` to be run manually when the Python schema changed. This was noted as a workflow gap but not automated within the documented sessions.

**The cpa-backend redundancy (June 14).** Observation 1689 records a strategic debt discovery: the `cpa-backend` sibling repository was "redundant with rag-system" — it used Vespa, OpenAI embeddings, and Textract in a parallel architecture. The decision (observation 1690) was to deprecate `cpa-backend` in favor of `rag-system`. This kind of architectural divergence is exactly the debt that accumulates when a project lacks a clear single owner.

**doc_class field (June 26–27).** Observations 2532–2545 show a document class enum being removed from the schema after it was decided not to proceed with that classification approach. The removal spanned multiple observations and required cleaning up migration journal entries, schema references, and call sites — the typical cost of a feature that was partially implemented before being reconsidered.

---

## 6. Challenges and Debugging Sagas

### The Railway Deployment Saga (June 16)

The production deployment to Railway was the most chaotic debugging session in the timeline. What should have been a linear infrastructure bring-up became a cascade of independent failures:

**PostgreSQL volume mount (observations 1883–1889).** The PostgreSQL service crashed on startup. Root cause: the volume was mounted at the PGDATA directory, preventing database initialization. Fix: add a PGDATA subdirectory (`/var/lib/postgresql/data/pgdata`). This is a known PostgreSQL Docker container issue but it burns time every time.

**Parser Dockerfile not in build context (observation 1916).** The parser deployment failed because the Dockerfile was not included in the code archive pushed to Railway. The root cause was a mismatch between where Railway expected to find the Dockerfile and where it actually lived in the monorepo structure. Observation 1918 records updating the runbook.

**API crash-looping on missing DB indexes (observation 1916).** The API service was crash-looping because it asserted startup guard conditions (HNSW index presence, GIN index presence) and the database hadn't been migrated yet. This exposed the deployment ordering constraint: `rag-worker` must run migrations before `api` and `mcp` can start. The runbook was updated (observation 1919).

**API_TOKENS chicken-and-egg (observations 1928–1930).** The worker startup failed because `api.tokens` was empty — the `API_TOKENS` environment variable hadn't been set on the worker service. But it only failed after the PostgreSQL fix and migrations. The ordering was: set env vars → redeploy → migrations → services up. The observation notes this was a "boot-order chicken-and-egg problem."

**TCP proxy deletion failure (observations 1941–1942).** Even cleanup wasn't clean — the PostgreSQL public TCP proxy failed to delete with the first command, requiring an explicit service flag. Three separate Railway CLI invocations for one cleanup task.

The session ultimately succeeded (observation 1940: "Phase 2 services deployed and health-verified on Railway") but the runbook was substantially thicker by the end.

### The Merge Conflict Resolution (June 11)

This was not a conventional debugging saga but it had the same quality of "one problem revealing the next." Fourteen files had merge conflicts between the scope-enforcement branch and the five-systems-unification branch. Each conflict had to be resolved semantically, not mechanically, because both sides were making valid changes to the same files.

The most nuanced was the auth hook (observations 1250–1252): the conflict was between a custom token verifier and the shared library verifier. The resolution was a hybrid — use the library verifier for token validation but extend it with scoped principal support. Neither side's implementation was dropped entirely.

After all conflicts were resolved, a typecheck failure surfaced (observation 1272) caused by stale `.d.ts` files in `dist/` directories — a build artifact problem, not a code problem. This required a full workspace rebuild before the typecheck could pass. The sequence from first conflict to committed resolution was 27 minutes across 47 observations.

### The Gemini API Breakage (June 20)

Observation 2240 is terse: "Gemini text-embedding-004 model no longer available in v1beta API." This was discovered at 11:22 PM when a re-embedding pipeline 404'd. The fix was a one-line model name change (observations 2241, 2244: `text-embedding-004` → `gemini-embedding-001`), but the discovery required understanding that Gemini had retired the v1beta endpoint for that model. The prior session (observation 2207) had just finished configuring billing on the Gemini API key, so this was the first live run against the actual API.

---

## 7. Memory and Continuity

The timeline contains 140 distinct sessions across 21 days. Without persistent memory, most of these sessions would have started from scratch — re-reading the codebase, re-understanding the architecture, re-identifying what work was next. The session handoff observations (`S*` entries) are the visible artifacts of this continuity:

S141 (June 6, 11:58 PM): "Create detailed recap document with instructions for resuming the five-systems refactoring project from a new session." This is the memory system being used explicitly — not just passively recording, but actively creating a handoff that the next session consumed.

S167 (June 10, 9:54 AM): "Session checkpoint and handoff summary for Five-Systems refactor completion." Filed immediately after PR #3 was pushed, this captured the state that made S176 and S178 (the follow-up sessions) effective.

S256 (June 13, 12:29 AM): "Determine next steps in RAG system refactoring work; user asked 'what's next according to claude-mem'." This is the memory system answering a navigation question — where are we in the roadmap? — rather than a code question.

The pattern across all 140 sessions: sessions that started with a memory query spent their first few minutes orienting rather than their first hour. Sessions that lacked clear handoff observations (like S384 and S385 on June 16, which were both trying to debug the same Railway deployment issues) show more redundant discovery — the same findings being re-established that had already been captured.

One important limit: the memory system recorded decisions but not always their outcomes. Observation 1689 (cpa-backend deprecation decision) appears in the timeline, but there is no corresponding observation recording that the deprecation was actually executed. The memory captured intent; verification required checking the repository state.

---

## 8. Token Economics and Memory ROI

All 501 observations (plus session markers) fall within a single calendar month: June 2026.

```
Total discovery tokens:    3,272,283
Total work tokens:         3,173,487  (from timeline header)
Timeline read cost:          175,706  (94% savings vs. re-reading work)
Sessions:                      140
Observations:                  501
Average tokens/observation:  ~6,209
```

**Monthly breakdown:**

| Month   | Observations | Discovery Tokens | Sessions |
| ------- | ------------ | ---------------- | -------- |
| 2026-06 | 527          | 3,272,283        | 140      |

The 527 figure from the database differs slightly from the 501 in the timeline header — the database likely includes session markers that the timeline view presents separately.

**Most expensive observations** (all at 50,929 tokens each, from June 14):

| ID   | Title                                                                          |
| ---- | ------------------------------------------------------------------------------ |
| 1584 | Multi-Connector Architecture: SharePoint, Drive, Gmail, Outlook                |
| 1585 | Connector Utilities: Cursor Codec, Pagination, Error Mapping, HTML Conversion  |
| 1586 | Graph HTTP Client: MSAL JWT + Defensive Absolute URL Validation                |
| 1587 | Ingestion Pipeline: Atomic Document Processing with Content-Hash Deduplication |
| 1588 | Job Queue with Deduplication and Retry Backoff                                 |

These five share the same discovery token count because they were generated in a single full-codebase learning pass (session S316, June 13–14). A session that read the entire connector package in one pass produced these as a batch, each costing the same because the discovery overhead was amortized across the session.

**The 94% savings figure** (from the timeline header: "175,706t read | 3,173,487t work | 94% savings") represents how much cheaper it is to read the timeline summary than to re-do the underlying work. For the 140 sessions in this project, the persistent memory system turned what would have been 3.1 million tokens of repeated context-loading into 175,706 tokens of structured recall — a meaningful efficiency gain realized gradually across sessions rather than all at once.

---

## 9. Timeline Statistics

| Metric                           | Value                                              |
| -------------------------------- | -------------------------------------------------- |
| Date range                       | June 6–27, 2026 (21 days)                          |
| Total observations               | 501 (timeline) / 527 (database including sessions) |
| Sessions                         | 140                                                |
| Work tokens                      | 3,173,487                                          |
| Discovery tokens stored          | 3,272,283                                          |
| Timeline read cost               | 175,706 (94% savings)                              |
| Avg discovery tokens/observation | ~6,209                                             |

**Observation type breakdown:**

| Type               | Count |
| ------------------ | ----- |
| discovery (○)      | 195   |
| change (✓)         | 155   |
| feature (◆)        | 76    |
| refactor (↻)       | 51    |
| bugfix (●)         | 21    |
| decision (⚖)       | 19    |
| security_note (⚷)  | 8     |
| security_alert (⚠) | 2     |

**Most active days:** June 8 (five-systems Phases 1–3), June 10 (Phases 4–6 completion), June 11 (merge conflict resolution), June 13 (parser auth, documentation pass), June 14 (full architecture deepdive, search-index hardening, deployment planning), June 16 (Railway deployment + UI scaffolding).

---

## 10. Lessons and Meta-Observations

**Planning sessions pay compound returns.** The June 6 Pathfinder analysis (observations 166–192) took roughly 25 minutes and produced observation 192: the five handoff prompts. Those prompts drove three sessions across four days (June 8–10) that completed six refactoring phases. The ratio of planning investment to execution efficiency was high.

**The service layer is the right abstraction boundary for RAG systems.** The most architecturally significant decision in the timeline was the creation of `@rag/services` with transport-agnostic functions. It resolved the HTTP vs. MCP behavioral drift, enabled scope threading to be added in one place (the June 11 merge resolution), and made the MCP tools thin enough that their implementation drift stopped mattering. Any RAG system with dual transport surfaces should make this extraction early.

**Startup guard assertions are worth the cost.** The API crash-looping on missing DB indexes during Railway deployment was initially a deployment headache, but the underlying behavior — refusing to start without the HNSW and GIN indexes in place — prevented silent degradation of search quality. The search-index guard hardening work (observation 1668, June 14) extended these guards to catch drizzle-kit drops. The startup failures were correct failures.

**Deployment ordering must be documented before you need it.** The Railway saga revealed that `rag-worker` must run migrations before `api` and `mcp` start. This constraint was not documented until it caused a production incident. The runbook update (observation 1919) happened in the same session. Document deployment ordering before the first deploy, not after the first incident.

**Gemini API stability requires monitoring.** The `text-embedding-004` deprecation (observation 2240) happened without ceremony — the model simply 404'd when called. An embedding provider that can silently stop working invalidates all retrieval until discovered. The fix was trivial; the detection was manual. A health check that verifies the embedding model is reachable would have caught this before it caused a user-facing failure.

**Memory works best for navigation, not verification.** The session markers show memory being used effectively for orientation ("what's next?", "how does auth work?") but less effectively for verification ("did the deprecation actually happen?"). The system is excellent at capturing decisions and discoveries; it captures execution outcomes only when the session explicitly records them. A habit of filing a `✓` observation after major milestones (not just `⚖` decisions) would improve recall accuracy.

**Security notes are underrepresented relative to their importance.** Only 8 security_note and 2 security_alert observations appear across 501 total — about 2% of the corpus. Yet the security surface of this system is substantial: constant-time bearer-token verification, PII metadata allowlist, per-principal source-ID access control, prompt injection defense in the generator. The security architecture was solid; the documentation of security reasoning in memory was sparse. A codebase whose security is well-implemented but whose reasoning is not recorded will be harder to audit when those properties need to be verified.

**Refactoring before features is correct for RAG infrastructure.** The decision to spend the first week on the five-systems unification rather than on new features meant that when features did arrive — streaming, SharePoint go-live, pluggable auth — they could be built on a stable foundation. The streaming endpoint (June 20) dropped cleanly into the `Generator` interface. The pluggable auth (June 15) extended the `AuthProvider` contract without touching service logic. These features would have been harder to add correctly had they been built before the service layer existed.

---

_Generated from 501 memory observations, 3,173,487 work tokens, 140 sessions — June 6–27, 2026._
