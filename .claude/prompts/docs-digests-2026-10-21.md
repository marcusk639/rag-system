# rag-system docs/ — reader digests (2026-10-21)

Nine parallel readers each read one group of docs/ in full and checked claims against code at HEAD 04761c5..00d13a7. Treat every claim here as a lead to re-verify, not as ground truth.

---

## Group 1-core-reference

I read all 13 files in my group end to end (2,961 lines) and spot-checked their claims against the code in three rounds of greps. Line references below are to each doc, and code paths are relative to `/Users/marcusklein/dev/rag-system`. Inbound references were searched across the whole repo excluding `node_modules`, `dist` and `.git`; refs from other `docs/` files are noted where they matter.

## Code facts that contradict several docs at once (verified)

- **Per-page self-re-enqueue is implemented.**
  - `apps/worker/src/handlers/sync-source.ts:86,184` and `packages/ingestion/src/pipeline.ts:70,170-172` both have continuation logic.
  - Sync job expiry is now `SYNC_EXPIRE_SECONDS = 1800` (30 min, per page) in `packages/ingestion/src/queue.ts:52`. The 6h expiry is gone.
  - Retry settings: `retryLimit 3`, `retryDelay 60`, `singletonKey sync:${sourceId}` (queue.ts:158-162,190-194). The "singleton" policy comment at queue.ts:106-109 says singletonKey alone gives no dedupe.
- **HTTP routes that exist:** `/health`, `/ready`, `GET/POST /sources`, `GET /sources/:id`, `DELETE /sources/:id` (purge, 6/min), `/sources/:id/sync` (6/min), `GET /sources/:id/documents`, `/documents/:id`, `/documents/:id/download`, `/search`, `/ask` (10/min), `/ask/stream` (10/min), `/feedback`.
  - Global rate limit: 60/min per credential, keyed on the JWT `sub` or the token (`apps/api/src/server.ts:45-60`).
  - No CORS.
- **Error mapping** (`apps/api/src/error-handler.ts`): `SYNC_ALREADY_RUNNING → 409`, `EGRESS_BLOCKED → 503`, `EMBEDDING_ERROR → 502`.
- **MCP tools: six, not five.** `search_documents`, `ask`, `get_document`, `list_sources`, `trigger_sync`, and **`purge_source`**. There is no feedback tool.
  - MCP HTTP authenticates a Bearer token per session and falls back to `DENY_ALL_SCOPE` (`apps/mcp/src/transports/http.ts:73-105`).
  - `MCP_MAX_SESSIONS` defaults to 1000.
  - MCP port is `MCP_HTTP_PORT ?? PORT ?? 3001`.
- **Service surface** (`packages/services/src/index.ts`): also exports `askQuestionStream`, `purgeSource`, `getDocumentDownload`, `submitAnswerFeedback`.
- **Schema has 14 tables, not 4:** answer_feedback, audit_log, audit_log_shipper_state, chunks, docs_gap_digest_runs, documents, ingest_log, ingestion_jobs, pending_uploads, source_client_assignments, sources, staff_client_assignments, staff_source_assignments (and one more name the grep caught only as `"id"`).
  - `sourceKindEnum` = sharepoint, gdrive, gmail, outlook, custom, git-markdown, ecfr-part4.
- **Defaults and limits:**
  - `DEFAULT_TOP_K=12` (env.example:333).
  - `/search` topK max 100, query max 1000.
  - `/ask` question max 2000, `MAX_ASK_TOP_K = 30`.
  - History caps: 12 turns / 4000 chars (`packages/core/src/validation.ts:33-34`).
  - `HYBRID_DENSE_WEIGHT` 0.7, RRF k=60, missing rank 1000000, pool multiplier 8, `SET LOCAL hnsw.ef_search` — all confirmed.
  - Sparse arm uses `to_tsquery` with OR semantics (hybrid search code now lives in `packages/db/src/hybrid-search.ts`, not `queries.ts`).
  - `WORKER_CONCURRENCY` 4, `WORKER_POLL_INTERVAL_MS` 2000, pg-boss `^10.1.6`.
  - `API_ENFORCE_SCOPING` defaults to false.
- **The four OAuth connectors use the shared helpers:** `packages/connectors/src/util/{paginate,cursor}.ts`. Factory `case` arms: sharepoint, outlook, gdrive, gmail, git-markdown, ecfr-part4, custom.
- **Eval:**
  - `tests/e2e/src/eval/` holds corpus-cpa.ts, faithfulness.ts, gold-eval.ts, gold-set.ts, run-gold-eval.ts, run-local-generation-eval.ts, run-real-eval.ts.
  - The gold set still has 0 entries.
  - `ScoringTier` has only `tier1-automatable | tier2-cpa-verified`.
  - `listDocuments` exists (`packages/db/src/queries.ts:263`).
  - The claim extractor, claim verifier and screen gate exist in `packages/rag/src/extraction/`.
  - `run-real-eval.ts` still calls `truncateAll`.
- **Only 2 package-level READMEs exist:** `apps/api/README.md` and `packages/connectors/README.md`.

---

## README.md (docs index)

- **Basics:** 124 lines · meta/index · audience: anyone entering docs/ · **partially stale**
- **Summary:** Header says "Updated 2026-08-03 · 80+ documents" (there are now 128). Opens with "the one rule": when a doc is wrong, edit that doc. "Start here" table points to PILOT-LAUNCH-STATUS (status), ARCHITECTURE (canonical), RAG-ARCHITECTURE-GUIDE, PROTOTYPE-READINESS-REVIEW, ISSUES-AND-OPTIMIZATIONS and DOCUMENTATION-REVIEW. Then sections: Current-reference, Current-status/ops, Current-eval (with a reading order), Current-reviews, Active design/plans (2026-08), Historical (grouped), and Known gaps.
- **Unique facts:**
  - The "never read PLAN-*.md checkboxes as status" rule.
  - The supersession map for superpowers specs/plans: the packs spec is live; generic-core-and-vertical-plugin is superseded (read only its §0); tenancy spec is partially superseded; the classification engine is absorbed.
  - Cited-but-missing docs list: RAG-VALIDATION-REPORT, CPA-CONSULTING-PLAN-REVIEW, EVAL-ANSWER-BASELINE, PLAN-P0-GATES-EXECUTION, compliance/BREACH-IR-RUNBOOK, compliance/VENDOR-REGISTER.
  - Cross-repo resolution: `docs/rag/…` and `docs/issue-synthesis/…` resolve in cpa-consulting; `CPA_Firm_Operations_Consultant_Briefing.md` is in `cpa-consulting/docs/marcus-onboarding/`.
  - `dev-prompts.md/` is a directory holding a raw prompt paste, not documentation.
  - Gemini DPA is PROVISIONAL; STAFF-BOT-ONE-PAGER is not for distribution.
  - The §7216 reconciliation in plans/2026-06-26 rests on a falsified premise.
- **Overlaps:** DOCUMENTATION-REVIEW-2026-08-03 (gap list); RAG-REVIEW-2026-09-16 §14 (gap tracking).
- **Contradictions/staleness:**
  - L121 lists `LOCAL-GENERATION.md` as "planned but unwritten", but it exists.
  - L3 "80+"; count is now 128.
  - L124 "Only 1 of 8 packages has a README"; now 2 READMEs (apps/api, packages/connectors).
  - RAG-REVIEW-2026-09-16 and later docs (LAUNCH-READINESS-REVIEW-2026-10-03, ISSUES…) are indexed only partially. LAUNCH-READINESS-REVIEW-2026-10-03 is not indexed.
  - "Active design and plans (2026-08)" is two months old; the in-flight state of reranking and conversation memory is unverified.
- **Inbound:** `README.md:79` (root).
- **LLM-readability:** good structure. Problems: the date header is stale; "Known gaps" mixes resolved and unresolved items; wide tables.
- **Recommendation:** **rewrite** as the post-consolidation index. Keep the "one rule", the checkbox warning, the cross-repo resolution note and the supersession map.

## ARCHITECTURE.md

- **Basics:** 215 lines · reference · audience: engineers and agents · self-declared canonical · **partially stale**
- **Summary:**
  - ASCII system diagram and package layering (core / runtime / services / connectors).
  - 9-step document data flow.
  - Retrieval SQL sketch and the 10-stage `/ask` pipeline.
  - "Why" sections: pgvector, pg-boss vs BullMQ, Python sidecar, embedding providers including local ONNX and compliance, RRF, markdown chunking.
  - Failure-mode table and "What this system is NOT" (chat, ACL, reranking, generation framework).
- **Unique facts:**
  - The 10-stage `/ask` pipeline order (L128-139): TRI screen before embedding → condensation via `contextualizeQuestion` → over-fetch → duplicate collapse ignoring heading lines → per-doc cap → optional `RETRIEVAL_MIN_DENSE_SIMILARITY` floor with a fixed refusal and no model call → neighbor expansion → per-chunk `Generator.screen()` → `[N]` prompt → one citation per document with `chunkIds`/`modifiedAt` and a truncation notice.
  - `hybridSearch` retries a filtered query at maximum pool size when it returns fewer than topK.
  - HF cache gotcha: with `HF_CACHE_DIR` unset, the cache lands inside the pnpm package dir and does not survive a multi-stage image copy.
  - The `rag-warm-base` digest-pinned image plus `docker/Dockerfile.warm-base` / `warm-model-verified.sh` build gate.
  - `allowRemoteModels=false` under client-data; EgressPolicy cannot police HF fetch.
  - History of the warm-model default drift (gemini-embedding-001 vs Xenova).
  - BGE query prefix string; mean-pool + L2 normalisation.
  - Gemini batch ≤100 inputs, OpenAI ≤2048.
  - Chunk heading prefix `# Title › path`; overlap applied before the heading line; tables split by whole rows under a repeated header.
  - The `data_class` column for auditing which provider touched which data class.
  - Failure-mode table.
  - Reranking prerequisites A2–A4: `return_documents:false`, `rerankScore`, hosted reranker refused under client-data; degrades to RRF order on error.
  - Decision B0 on bounded history.
- **Overlaps:**
  - RAG-ARCHITECTURE-GUIDE (mental model, ingestion, retrieval, ground rules — heavy duplication).
  - CLAUDE.md (pipeline, ground rules).
  - QUEUE-ARCHITECTURE-REVIEW (pg-boss rationale).
  - DEPLOYMENT.md (local embedding).
- **Contradictions/staleness:**
  - L84 "five operations": the code also has askQuestionStream, purgeSource, getDocumentDownload, submitAnswerFeedback (CLAUDE.md lists them).
  - Diagram L55-57 omits `/ask/stream`, `/feedback`, downloads and purge.
  - L56 tool list "..." hides purge_source.
  - L202-207 failure table: assumes whole-source jobs. Per-page re-enqueue plus 30-min expiry now applies. Also: singletonKey alone is not what dedupes — the singleton policy is.
  - L208 points to `0000_init.sql` for dimension-change instructions (unverified).
  - L141/L115: retrieval SQL now lives in `packages/db/src/hybrid-search.ts`.
  - "MCP: stdio + HTTP"; auth is not shown.
  - No link to QUEUE-ARCHITECTURE-REVIEW (its suggestion S4, never done).
  - QUEUE-REVIEW and PLAN-PER-PAGE-REENQUEUE cite "ARCHITECTURE.md:133" for the queue rationale; that line is now /ask stage 4. The rationale is at L153-155.
  - DOCUMENTATION-REVIEW flagged CPA-domain leakage in a generic doc ("CPA default", L161).
- **Inbound:** `README.md:53`; `CLAUDE.md:105`; `env.example:111`; `CODEBASE-REVIEW.md:44`; `.claude/skills/rag-add-provider/SKILL.md:16`.
- **LLM-readability:** decent. Problems: a large ASCII diagram costs tokens; the canonical-vs-guide preamble is duplicated in both files; the compliance text mixes domain into the generic architecture.
- **Recommendation:** **keep as the canonical doc and merge RAG-ARCHITECTURE-GUIDE into it**. Update the surfaces, the failure table and the queue facts.

## RAG-ARCHITECTURE-GUIDE.md

- **Basics:** 509 lines · reference/engineering companion · audience: engineers changing code · **partially stale**
- **Summary:** §1 mental model (copied from CLAUDE.md); §2 layout table; §3 ground rules (copied); §4 ingestion pipeline; §5 schema, migrations, RRF mechanics, fail-closed ACL; §6 parser sidecar; §7 API and MCP surfaces; §8 auth layers; §9 applying to any KB; §10 gotchas; §11 commands; §12 extension checklists; §13 worker lifecycle; §14 e2e/eval harness.
- **Unique facts:**
  - Pipeline details: empty page ≠ end-of-feed, termination via `page.done`; race-safe CTE snapshotting prior `content_hash` with `xmax=0` insert detection; chunk replace in batches of ~200.
  - Two-phase migrations: `0000_init.sql` is outside the journal, idempotent, owns HNSW opclass, GIN-on-tsvector and the plpgsql trigger. Index/trigger names `chunks_embedding_hnsw_idx`, `chunks_tsv_update`.
  - RRF formula details; filters in the final SELECT, not in CTEs (to keep HNSW usable); `ef_search=max(40, efSearch??100)`; NaN embedding guard.
  - ACL null / [] / [...] semantics.
  - Parser: multipart fields; 100 MB → 413; camelCase alias generator; spreadsheet fast path (two openpyxl loads; sheet classifier tabular / narrative / financial_model ≥0.20 formula density / freeform; one ParsedTable per sheet); PARSER_SECRET with hmac.compare_digest, read per request, comma-split duplicate headers.
  - API onRequest auth hook decorating `request.principal`; error-code map.
  - MCP: stdio gets ADMIN_SCOPE; HTTP is Express + StreamableHTTP, scope per session at `initialize`, MCP_MAX_SESSIONS 1000 → 503, Origin allow-list, `normalizeSessionId`.
  - Startup gates `assertEmbeddingDimensions` / `assertRequiredIndexes`; `migration-guard.test.ts`.
  - P1b confidentiality invariant: identical not-found in /documents/:id, get_document and documents://.
  - Worker lifecycle order; batchSize/pollingIntervalSeconds mapping (`teamSize` was renamed); serial batch handler on purpose; deleted-source handling; status transitions; `pageSize: 50`.
  - E2E infra: TRUNCATE…RESTART IDENTITY CASCADE per test; buildTestApi via inject(); pg-boss stub so the queue path is untested; CSV used as XLSX proxy.
  - Eval trip-wires: recall@5≥0.8, recall@3≥0.7, nDCG@5≥0.6, MRR≥0.6, plus a monotonicity check. FakeEmbedder masks the RRF weights.
- **Overlaps:** ARCHITECTURE (most of §1, §4, §5); CLAUDE.md (§1, §3, §8 add-provider, §10 gotchas, §11 commands near-verbatim); MCP.md and API.md (§7); CONNECTORS (§9/§12 connector steps); EVAL-BASELINE (§14).
- **Contradictions/staleness:**
  - §9 L318 and §12 L400 say "register it in the connectors `index.ts`". CLAUDE.md and the code use `factory.ts`; index re-export is optional.
  - L58 "~13.7k lines / ~137 files" (dated).
  - L144 "Four tables"; there are ~14.
  - L91-92 "five service functions".
  - L239 "No token streaming"; `/ask/stream` exists.
  - L244 "Five tools"; purge_source makes six.
  - L236-238 error map omits EGRESS_BLOCKED and EMBEDDING_ERROR.
  - L461 "6h expiry"; now 1800s per page. "A falsy sourceId throws SyncAlreadyRunningError → 409" is garbled.
  - §13 describes whole-source jobs; per-page continuation is now implemented.
  - §14 L501-502: the corpus now also includes `corpus-cpa.ts` and `retrieval-eval-cpa.spec.ts`.
  - L165 cites `queries.ts` for retrieval; it moved to `hybrid-search.ts`.
  - L315 "SharePoint/GDrive/Gmail/Outlook" omits git-markdown and eCFR.
  - RAG-REVIEW-2026-09-16 row 2 flagged §5 for plainto_tsquery; that is now fixed in the text.
- **Inbound:** none outside docs/. In-docs: ARCHITECTURE.md:7, README.md:20,38, and the reviews.
- **LLM-readability:** long; roughly 40% duplicates CLAUDE.md. Good section numbering.
- **Recommendation:** **merge into ARCHITECTURE.md** (or a single `ENGINEERING-REFERENCE`), dropping everything duplicated from CLAUDE.md. Preserve §4-§8, §10 extras, §13 and §14 infra.

## API.md

- **Basics:** 308 lines · reference · audience: API callers · **partially stale (materially)**
- **Summary:** Conventions (JSON, Bearer except health/ready, error envelope). Endpoints: health, ready, POST/GET sources, GET source, sync, GET document, search, ask (with history, citations, reviewStatus/disclaimer/answerId, zero-retrieval short-circuit, 503 when generation is not configured). Then rate limits and CORS.
- **Unique facts:**
  - Request/response JSON shapes.
  - `config` is never echoed.
  - `/ready` 503 shape.
  - Search `score` is normalised RRF with the top result = 1.0; dense/sparse raw scores.
  - Citation field table.
  - Exact refusal string; GENERATION_NOT_CONFIGURED message.
  - `reviewStatus: draft_requires_practitioner_review` plus disclaimer text (verified in `packages/services/src/ask.ts:100`).
- **Overlaps:** RAG-GUIDE §7; MCP.md (parallel tool fields); `apps/api/README.md`.
- **Contradictions/staleness:**
  - L66 `kind` enum lacks git-markdown and ecfr-part4.
  - L132-143 duplicate sync "Response 500 INTERNAL_ERROR". The code maps SYNC_ALREADY_RUNNING → **409**. The "likely duplicate" message string was not found in the code.
  - L302-304 "server itself does not enforce rate limits". It does: 60/min global, 10/min on /ask and /ask/stream, 6/min on sync and purge.
  - Missing endpoints: `DELETE /sources/:id`, `GET /sources/:id/documents`, `GET /documents/:id/download`, `POST /ask/stream`, `POST /feedback`.
  - L304 says embedding 429s surface as 502 EMBEDDING_ERROR (matches the map). EGRESS_BLOCKED 503 is undocumented.
  - The zero-retrieval response L281-289 likely also carries reviewStatus (unverified).
  - `topK` default "DEFAULT_TOP_K" (=12) is not stated.
- **Inbound:** `README.md:55`; `CODEBASE-REVIEW.md:36,238`.
- **LLM-readability:** good format. Problems: no endpoint summary table at top; stale.
- **Recommendation:** **rewrite** — regenerate from `apps/api/src/routes/` and add the missing endpoints, rate limits and 409.

## MCP.md

- **Basics:** 134 lines · reference/how-to · audience: agent integrators · **partially stale**
- **Summary:** Transports (stdio default; http on `/mcp`, MCP_HTTP_PORT 3001). Claude Desktop JSON config and the `claude mcp add` command. Tools (search_documents, get_document, list_sources, trigger_sync, ask). `documents://{id}` resource. MCP vs HTTP comparison, stderr logging, and tool design notes.
- **Unique facts:**
  - Claude Desktop config path and example env (including `API_TOKENS: "unused-for-mcp"`).
  - `claude mcp add` invocation; build first.
  - Returns: text plus `structuredContent`; ask returns `{answer, citations, retrievedCount}` (verified).
  - Resource returns text/markdown.
- **Overlaps:** RAG-GUIDE §7 MCP; ARCHITECTURE diagram.
- **Contradictions/staleness:**
  - L57-60 search_documents topK "(1–50) default 8". The code's describe() says the default is the server DEFAULT_TOP_K (12) with max MAX_TOP_K.
  - Tools list omits **`purge_source`**.
  - L122 "No auth at the protocol level (the transport is the security boundary…)". This contradicts the code and RAG-GUIDE: HTTP transport authenticates Bearer per session, with DENY_ALL fallback, an Origin allow-list and a session cap.
  - Doesn't document the scoped vs unscoped tool split, stdio ADMIN_SCOPE, MCP_MAX_SESSIONS, or the API_PRINCIPALS applicability.
  - Port fallback `PORT` is not mentioned.
  - Hard-coded `/Users/…`-style path placeholders are fine.
- **Inbound:** `README.md:56`.
- **LLM-readability:** fine. The security claim is dangerously wrong.
- **Recommendation:** **rewrite** — fix auth, add purge_source, scope semantics and topK defaults. Could merge with API.md into one "Interfaces" reference.

## CONNECTORS.md

- **Basics:** 269 lines · reference/how-to · audience: operators and connector authors · **current (mostly)**
- **Summary:** Connector interface; six connectors plus `custom`. Per connector: Entra/Google setup, env, config JSON, notes. Adding-a-connector steps, contract rules, testing advice.
- **Unique facts:**
  - SharePoint permissions: Sites.Read.All, Files.Read.All, and User.Read.All (used by apps/web `/admin/access` email→oid lookup and the group-overage check).
  - Least-privilege `Sites.Selected` _instead of both_ (Files.Read.All is tenant-wide and cancels the scoping) → FRESH-DEPLOY-GUIDE §1.2.
  - `excludePaths` semantics: case-insensitive substrings, applied before download, layered on `DEFAULT_EXCLUDED_PATH_FRAGMENTS` in `packages/core/src/content-safety.ts`; an excluded item is reported as a deletion, so previously indexed copies are removed.
  - siteId lookup URL; `.default` app-only scope.
  - Drive: export of Workspace docs to docx/xlsx/pptx; startPageToken/changes.list; `folderId` non-recursive with workarounds.
  - Gmail: metadata fields; attachments `${messageId}/${attachmentId}`; historyId; **Gmail bypasses the parser sidecar for bodies** (prefers text/plain).
  - Outlook: Mail.Read; deltaLink.
  - git-markdown: built for `veteran-disability-ai-resources`; frontmatter topic / last_verified / volatility → `metadata.extra`; shells out to git, no pull.
  - eCFR: govinfo bulk XML URL; DIV1→DIV3→DIV5(PART)→DIV6→DIV8(SECTION) structure; strips the `§ ` prefix from externalId; browser UA; `last-modified` header as cursor; no REST fallback (REST API gave 503s and 40s+ latency).
  - Contract: MUST/SHOULD rules, error classification, no info-level logging of bodies/tokens.
- **Overlaps:** CLAUDE.md "Adding a new connector" (6 steps vs 5 here); RAG-GUIDE §9/§12; ECFR-CONNECTOR-SPIKE; FRESH-DEPLOY-GUIDE (Entra perms); AZURE-DEPLOY-RUNBOOK; per-connector `packages/connectors/src/*/CLAUDE.md` files.
- **Contradictions/staleness:**
  - L255 "Adding" omits the `env.example` step that CLAUDE.md has.
  - L262 "Document content MUST be raw bytes… Don't pre-decode HTML" contradicts L143 (Gmail decodes HTML itself).
  - L196 hard-coded absolute path `/Users/marcusklein/dev/...`.
  - L66 "worker honors retryAfter via pg-boss backoff" — the pg-boss retryDelay is a fixed 60s, so retryAfter is likely not honored (unverified).
- **Inbound:** `README.md:54`; `CLAUDE.md:98`; `CODEBASE-REVIEW.md:37,239`; `.claude/skills/rag-add-provider/SKILL.md:15`.
- **LLM-readability:** good. Problem: JSON with `//` comments is invalid JSON.
- **Recommendation:** **keep** — fix the raw-bytes vs Gmail contradiction, align the add-steps with CLAUDE.md, and absorb ECFR-CONNECTOR-SPIKE's conclusion.

## CONFIGURE-PRINCIPALS.md

- **Basics:** 226 lines · how-to/runbook · audience: operator · **partially stale**
- **Summary:** Two-tier tokens (`API_TOKENS` admin, `API_PRINCIPALS` scoped). Steps:
  1. List sources via `scripts/gen-principals.sh`.
  2. Generate tokens plus JSON via `scripts/gen-tokens.sh` (`label:id1,id2`, `label::isAdmin`).
  3. Set on Railway for rag-api and rag-mcp, then redeploy.
  4. Verify with curl.
  5. Optionally set `API_ENFORCE_SCOPING=true`.

  Then: updating/revoking, access patterns, troubleshooting, references.

- **Unique facts:**
  - gen-tokens output: stderr token map (64-char hex, unrecoverable), stdout minified JSON; each run gives new tokens.
  - JSON rules: duplicates → startup error; `isAdmin:true` is the only admin path under enforce-scoping; `[]` = quarantine.
  - Live source UUIDs: `52bb403e-…` (operating tenant), `d3461cbe-…` (test site).
  - Live API URL `rag-api-production-07b4.up.railway.app`.
  - Lockout warning: set an isAdmin entry before enabling `API_ENFORCE_SCOPING`.
  - Troubleshooting error strings.
  - Code refs: `access-control.ts` (parsePrincipalsConfig / resolvePrincipal / effectiveSourceFilter).
- **Overlaps:** ARCHITECTURE L213; RAG-GUIDE §8; FRESH-DEPLOY-GUIDE:232,343; PILOT-MANUAL-RUNBOOK:116; env.example.
- **Contradictions/staleness:**
  - L153 verification uses `"limit":3` (the API takes `topK`) and `jq '.results[].sourceId'` (actual shape is `.results[].document.sourceId`).
  - L156 `/sources/<id>/documents` does exist (sources.ts:211), so that check is OK.
  - It doesn't mention the newer DB-backed assignment tables (`staff_source_assignments`, `source_client_assignments`, apps/web `/admin/access`). Whether web access now flows through those rather than `API_PRINCIPALS` is unverified but likely — worth checking.
  - L91 comment "alice sees CPA Firm only" vs the table label "the operating tenant".
  - Source UUIDs may be stale after the SharePoint tenant re-sync (the current branch is `docs/sharepoint-tenant-resync`; PILOT-MANUAL-RUNBOOK:116 talks about replacing old ids).
- **Inbound:** none outside docs (FRESH-DEPLOY-GUIDE and PILOT-MANUAL-RUNBOOK in-docs).
- **LLM-readability:** good runbook shape. Problem: live IDs and URLs embedded in a how-to.
- **Recommendation:** **keep and update** (fix the curl, reconcile with DB-backed assignments). Could fold into an "Access control" section of the deployment/ops doc.

## LOCAL-GENERATION.md

- **Basics:** 97 lines · how-to · audience: operator deploying air-gapped · **current**, but has no status/date header
- **Summary:** Self-hosted OpenAI-compatible generation for no-egress deployments (42 CFR Part 2, HIPAA, engagement terms). Server table (Ollama 11434, vLLM 8000, LM Studio 1234, llama.cpp 8080). Config env. API-key precedence. Egress allow-list must name the endpoint. Gemini plus base URL throws. TRI policy is not relaxed. Verification steps.
- **Unique facts:**
  - `GENERATION_PROVIDER=openai` + `GENERATION_BASE_URL` + `EGRESS_ALLOWED_HOSTS=127.0.0.1`.
  - Key precedence: GENERATION_API_KEY wins; a base URL gets a placeholder, never the embedding vendor's key (verified in `packages/core/src/generation-credentials.ts`).
  - EGRESS_BLOCKED 503 when the host is not allow-listed.
  - `GENERATION_PROVIDER=gemini` with a base URL throws at startup, and why.
  - `GENERATION_TRI_POLICY` is not auto-relaxed; `COMPLIANCE_MODE=client-data` forces `block` even over an explicit `off`.
  - Boot log line "generation using a self-hosted endpoint".
  - Negative test (remove the host → must fail); tcpdump evidence requirement.
- **Overlaps:** env.example; superpowers/plans/2026-08-03-local-generation.md (its deliverable); DEPLOYMENT.md (compliance mode); `run-local-generation-eval.ts` exists but is not mentioned.
- **Contradictions/staleness:** docs/README.md:121 calls it unwritten. Note `localhost:11434` port 8000 collides with the parser's default PARSER_URL port (vLLM 8000) — worth a warning.
- **Inbound:** `env.example:28,394,474`.
- **LLM-readability:** clear. Missing a status/date header.
- **Recommendation:** **keep** — add a header and fix the README index.

## EVAL-AND-FEEDBACK.md

- **Basics:** 181 lines · design/reference · audience: engineers and stakeholders · **partially stale** (has a 2026-09-16 correction inline)
- **Summary:** Four mechanisms: retrieval metrics, faithfulness, in-product 👍/👎, docs-gap-digest. Tier 1 is automatable; Tier 2 needs a CPA. Faithfulness design: fabricated citation = hard fail via `checkCitations()` with no model call; abstention scores null. Gold set is the bottleneck and deliberately empty. Feedback sort into "KB lacks it → authoring (ISS-05)" vs "KB has it, not found → retrieval". Commands. Claims table.
- **Unique facts:**
  - The Tier 1 / Tier 2 rationale (epistemic constraint C2; faithfulness ≠ correctness).
  - `validateGoldSet()` rejects an `expectedAnswer` lacking verifiedBy/verifiedOn.
  - Abstention-null rule; `aggregateFaithfulness()` reports abstentions separately.
  - Comment box only on thumbs-down, and why.
  - Mine `audit_log` for gold candidates.
  - Correction: CI runs only the scorer's unit tests; `pnpm eval` also gates on `retrieval-eval-cpa.spec.ts`.
  - The three eval:real gates (also in EVAL-BASELINE).
  - Egress override justified only because the corpus is synthetic; real KB eval needs the P0 #2 counsel determination.
- **Overlaps:** EVAL-BASELINE (flat sweep, gates, egress warning — duplicated nearly verbatim); EVAL-GOLD-SET-GUIDE (distractorNote, "ten beat fifty"); EVAL-CORPUS-GROUND-TRUTH (tiers).
- **Contradictions/staleness:**
  - L42-46 "flat sweep… decided by keyword overlap alone" and L179-181 "retrieval tuning is unfalsifiable and should not be attempted" are contradicted by EVAL-BASELINE's same-day CORRECTION (the sparse arm was broken; after the fix the sweep is not flat). The correction is not propagated here — a violation of README's "one rule".
  - L176 "Reranking unmeasurable at MRR 1.000" — same issue.
  - L18 says faithfulness runs in CI; partially corrected at L25.
  - "Doug" / ISS-05 / P0 #2 are undefined jargon.
- **Inbound:** `packages/rag/src/generation/generator.ts:41`.
- **LLM-readability:** good tables. Problems: an inline correction instead of fixing the text; undefined names and IDs.
- **Recommendation:** **merge** with EVAL-BASELINE and EVAL-GOLD-SET-GUIDE into one `EVALUATION.md` (design + current numbers + gold-set procedure). Fix the sweep claims.

## EVAL-BASELINE.md

- **Basics:** 152 lines · status-tracker/record · audience: engineers · **partially stale / self-contradictory**
- **Summary:** pnpm eval vs eval:real. Harness made embedder-swappable 2026-07-09. A stale "Why no real-embedder numbers yet" section remains even though the numbers follow. Gemini 2026-08-01 results table. "Flat sweep → corpus too easy" analysis, followed by a ⛔ CORRECTION: the sparse arm used AND `plainto_tsquery`; 5 of 15 real staff questions matched zero chunks; after OR-semantics the sweep is not flat. Claims table, reproduction commands, FakeEmbedder 2026-07-09 numbers, corpus growth.
- **Unique facts:**
  - The actual metric numbers: Gemini recall@1 91.2%, recall@3–10 100%, nDCG 99.1%, MRR 1.000. FakeEmbedder recall@3 97.1%, nDCG@10 98.4%.
  - Before/after sparse-fix sweep table (peak nDCG@5 99.5% at 0.5/0.5).
  - "5 of 15 realistic staff questions matched zero chunks".
  - Lesson: "a degenerate metric is a reason to suspect the instrument".
  - `real-eval-result.md` output path.
  - OpenAI 1536-d → set `EMBEDDING_DIMENSIONS=768` for text-embedding-3-*.
  - `EMBEDDING_PROVIDER=local pnpm eval:real` works without a key.
  - Corpus: 14 docs / 17 questions; target 30–50 real questions with distractors.
- **Overlaps:** EVAL-AND-FEEDBACK (gates, egress, claims table); RAG-GUIDE §14; PROTOTYPE-READINESS-REVIEW H-1/H-1b.
- **Contradictions/staleness:**
  - L14-24 "Why no real-embedder numbers are recorded yet… delete this paragraph" was never deleted, and contradicts L28.
  - L102-107 "retrieval tuning is unfalsifiable" is contradicted by its own correction at L84-86.
  - L121 "gates not documented elsewhere" — they are in EVAL-AND-FEEDBACK.
  - L148 corpus topics vs L45 list Docker (consistent). There is now a CPA corpus (`corpus-cpa.ts`) whose numbers are not recorded.
  - No numbers after 2026-08-01, despite the OR-semantics fix, reranking and the CPA corpus.
  - Ref L152 anchor into ISSUES-AND-OPTIMIZATIONS §4 (unverified).
- **Inbound:** `tests/e2e/src/eval/run-real-eval.ts:11,194` (tells users to paste results here); `tests/e2e/src/eval/gold-set.ts:6`.
- **LLM-readability:** the conclusion is buried and contradicted in the same file, with layered corrections. Hard for an LLM to know which statement is current.
- **Recommendation:** **rewrite** as the numbers section of a merged EVALUATION.md. Keep the file path (or update the code refs in run-real-eval.ts and gold-set.ts). State only the post-fix conclusions plus a short "lesson" note.

## EVAL-GOLD-SET-GUIDE.md

- **Basics:** 173 lines · how-to/runbook (session script) · audience: Marcus + Doug (the CPA) · **current** (gold set still empty)
- **Summary:** A 90-minute session to author `tests/e2e/src/eval/gold-set.ts`: pre-checks, then questions first without looking at answers, then label externalIds (an empty `relevant` = coverage test), then distractors, then attributed expected answers (tier2-cpa-verified). Recording format; never renumber ids. Afterwards and what good looks like. `pnpm eval:gold` reference.
- **Unique facts:**
  - Live web URL `rag-web-production-1c0a.up.railway.app`.
  - Grant Doug a source grant first; zero results look like a broken system.
  - The anti-contamination rule.
  - `relevant: []` as a coverage test.
  - GoldQuestion example shape; illustrative-only warning.
  - Never renumber ids.
  - "Near-perfect first scores → suspect the set".
  - `eval:gold` details: env GOLD_API_URL (https except localhost), GOLD_API_TOKEN, GOLD_OUT (contains real KB answers; `gold-*.json` gitignored; firm-confidential); calls `/ask` plus `GET /documents/:id` to map to externalIds; paced ~10/min; reports recall@1/3/5, MRR, correct/incorrect refusals, fabricated citations, truncation; exit codes 2/1/0.
- **Overlaps:** EVAL-AND-FEEDBACK (tiers, distractorNote); EVAL-BASELINE.
- **Contradictions/staleness:**
  - L17-24 restates the flat-sweep "unfalsifiable" claim without the correction.
  - L124 "pnpm eval:real scores against real embedder" — but eval:real uses the synthetic corpus. Gold-set scoring is `eval:gold`. Afterward-step inconsistency.
  - L157 the shell comment after `\` breaks the line continuation (the snippet is broken as written).
- **Inbound:** `CLAUDE.md:39`; `tests/e2e/src/eval/run-gold-eval.ts:16,46`; `tests/e2e/src/eval/gold-set.ts:28,36,88`.
- **LLM-readability:** good. Persona names are undefined (Doug/Marcus/Chris).
- **Recommendation:** **keep** as the procedure (code points here). Fix the `eval:real`→`eval:gold` step and the broken snippet. Optionally make it a section of EVALUATION.md, but keep the filename or update the 3 code refs.

## EVAL-CORPUS-GROUND-TRUTH.md

- **Basics:** 437 lines · design spec/research · audience: engineers building eval · **partially stale** ("Not built", but parts are built)
- **Summary:** Proposes a third tier, `tier1-corpus-grounded`: extract atomic claims with verbatim quotes from SOPs and score answer entailment (supported / contradicted / unaddressed). Contradictions are output. Claims generate gold questions with `relevant` labels for free. Extraction hazards: a self-corrected sequencing error (screen for client identifiers _before_ sending text to a model); locate-then-slice quote storage; normalization ladder as a diagnostic; adversarial independent verifier; atomicity; selection bias toward easy claims; determinism via `content_hash` caching. A fourth "usefulness" dimension with abstention matrix and a rubric mapped to prompt rules. Tune-loop discipline. Prerequisites/hazards and narrow scope.
- **Unique facts:**
  - The `CorpusClaim` interface.
  - Locate-then-slice rule; normalization ladder rungs.
  - Verifier constraints: no document, default-no, human sampling.
  - Abstention 2×2 matrix; rubric ↔ prompt rules 4/5/7/8.
  - Hazard: `run-real-eval.ts` `truncateAll` TRUNCATEs chunks/documents/ingestion_jobs/sources CASCADE — copying it against prod destroys the index (ISSUES C3).
  - Extracted claims must not be committed; they go in a gitignored cpa-consulting path.
  - ~858 indexed documents; start with 20–30 docs in the SOP families (bookkeeping, preparer/reviewer checklists, time coding, extensions, 1099s, sales tax).
  - Client files live in Onvio and on the Z Drive; SharePoint only is connected.
  - The extraction pass doubles as the client-identifier review ISS-05 needs.
- **Overlaps:** EVAL-AND-FEEDBACK (tiers); ISSUES-AND-OPTIMIZATIONS:125 (C3, ISS-05).
- **Contradictions/staleness:**
  - L3 "Not built": `packages/rag/src/extraction/{claim-extractor,claim-verification,screen-gate}.ts` and `scripts/extract-corpus.ts` exist and cite this doc. RAG-REVIEW says "Not built (extractor exists)".
  - L399-402 prerequisite 2 "no listDocuments helper exists" contradicts L145 "listDocuments… built" and the code (`queries.ts:263`).
  - `tier1-corpus-grounded` is still not in ScoringTier.
  - L149-167 the doc's own "sequencing error" section contradicts its earlier text and the ⭐ box at L411-422 ("build the screen into the first pass") — mixed guidance.
  - RAG-REVIEW-2026-09-16 row 12 flags prerequisite 4 (Class A/B by connection scope) as contested.
  - "~858 documents" is likely stale post tenant re-sync.
  - L139-141 has a duplicate `---`.
- **Inbound:** `packages/rag/src/extraction/claim-verification.ts:7`; `claim-extractor.ts:16`; `packages/rag/src/generation/generator.ts:53`; `packages/db/src/read-only.test.ts:6`.
- **LLM-readability:** long narrative; self-corrections in place; status unclear.
- **Recommendation:** **rewrite** (keep the file — code cites it). Update the status to what is built vs not, delete the obsolete prerequisite 2, resolve the screen-first vs combined-pass contradiction, and condense the narrative into rules.

## QUEUE-ARCHITECTURE-REVIEW.md

- **Basics:** 136 lines · review/decision-record · audience: humans + agents · dated 2026-06-19 · **decision current; concerns/suggestions largely completed/historical**
- **Summary:** Verdict: keep pg-boss. System facts table. Concerns: C1 coarse granularity (HIGH), C2 polling, C3 shared Postgres, C4 long jobs. Suggestions: S1 per-page self-re-enqueue, S2 revisit expiry, S3 dead-letter visibility, S4 link from ARCHITECTURE. Triggers for outgrowing pg-boss. Alternatives table (BullMQ, Graphile Worker, Temporal, cloud queues). "Do NOT" list.
- **Unique facts:**
  - The decision rationale, including transactional enqueue (no dual-write hazard).
  - Outgrow triggers: thousands of jobs/sec fan-out, sub-second pickup, Postgres contention.
  - Alternatives comparison.
  - Do-not rules: no migration without its own decision; keep singletonKey; keep triggerSync as sole `ingestion_jobs` writer.
  - S3 (no alerting on permanently failed syncs) — status unknown, possibly still open.
- **Overlaps:** ARCHITECTURE "pg-boss instead of BullMQ"; PLAN-PER-PAGE-REENQUEUE (execution of S1/S2/S4); RAG-GUIDE §13.
- **Contradictions/staleness:**
  - C1, C4, S1, S2 are implemented: per-page continuation exists; expiry is now 1800s; `expireInHours: 6` at L52 is gone.
  - The doc doesn't say so, even though PLAN-PER-PAGE-REENQUEUE:315 required "mark S1 implemented".
  - S4 (link from ARCHITECTURE) not done.
  - "ARCHITECTURE.md:133" citations at L26 and L44 are wrong now.
  - Line-number citations (`config.ts:78-80, 293-295`; pipeline ~L74) are stale. Config is now at L321-322.
  - "4 services" deployment is stale (there are also web, teams-bot, parser and backup).
  - queue.ts comments say singletonKey alone gives no dedupe and the singleton _policy_ does. The doc's "singletonKey dedupe" framing is imprecise.
- **Inbound:** none outside docs (docs/README.md:82, PLAN-PER-PAGE-REENQUEUE:3,225,314-315).
- **LLM-readability:** excellent format (TL;DR, audience, status, verify-before-acting). The only problem is the missing completion status.
- **Recommendation:** **merge** the decision (verdict, rationale, outgrow triggers, alternatives, do-nots) into ARCHITECTURE's pg-boss section as a short decision record. **Archive** the rest together with PLAN-PER-PAGE-REENQUEUE.

---

## GROUP SECTION

### Topic clusters

1. **System architecture:** ARCHITECTURE, RAG-ARCHITECTURE-GUIDE, QUEUE-ARCHITECTURE-REVIEW (plus root CLAUDE.md, which already duplicates RAG-GUIDE §1/§3/§10/§11/§12 nearly verbatim).
2. **Interfaces:** API, MCP (plus RAG-GUIDE §7).
3. **Integration/ops how-tos:** CONNECTORS, CONFIGURE-PRINCIPALS, LOCAL-GENERATION.
4. **Evaluation:** EVAL-AND-FEEDBACK, EVAL-BASELINE, EVAL-GOLD-SET-GUIDE, EVAL-CORPUS-GROUND-TRUTH.
5. **Meta:** README (index).

### Cross-doc contradictions

- **Sync conflict response:** API.md says 500 INTERNAL_ERROR; RAG-GUIDE says 409; code says 409.
- **MCP auth:** MCP.md says no protocol auth; RAG-GUIDE says per-session Bearer scope; code agrees with RAG-GUIDE.
- **Tool/service counts:** "five" in ARCHITECTURE, RAG-GUIDE and MCP; the code has 6 tools and 9 service functions (CLAUDE.md is correct).
- **Streaming:** RAG-GUIDE says none; `/ask/stream` exists. Rate limiting: API.md says none; code limits at 60/10/6 per minute.
- **Job expiry / granularity:** RAG-GUIDE and QUEUE-REVIEW say 6h, whole-source jobs; code uses 1800s per-page continuation jobs.
- **Connector registration:** RAG-GUIDE says connectors `index.ts`; CLAUDE.md, CONNECTORS and code say `factory.ts`.
- **Raw bytes:** the CONNECTORS contract says "raw bytes only"; the CONNECTORS Gmail section says the connector decodes HTML itself.
- **Flat sweep / "tuning unfalsifiable":** EVAL-AND-FEEDBACK, EVAL-GOLD-SET-GUIDE and the body of EVAL-BASELINE all assert it; the EVAL-BASELINE correction refutes it after the sparse OR fix.
- **listDocuments:** "built" vs "doesn't exist" inside EVAL-CORPUS-GROUND-TRUTH. "Not built" vs the extraction modules that exist.
- **LOCAL-GENERATION.md:** README says unwritten; it exists.
- **topK default:** MCP.md says 8; code uses DEFAULT_TOP_K (12).
- **Gold-set scoring step:** EVAL-GOLD-SET-GUIDE "Afterwards" uses `eval:real`; the actual command is `eval:gold`.

### Proposed consolidated docs

- **`ARCHITECTURE.md`** — single canonical, built from ARCHITECTURE + RAG-GUIDE + the QUEUE decision. Contents:
  - Package layering and surfaces (api / mcp / worker / web / teams-bot).
  - Ingestion pipeline with idempotency details (page.done, xmax CTE, 200-row replace, per-page continuation jobs, 30-min expiry, 3×60s retry).
  - Schema overview (all tables, briefly) and two-phase migrations.
  - Retrieval: RRF k=60, 0.7/0.3, pool×8, filters in the final SELECT, ef_search, OR-tsquery, retry at max pool.
  - The `/ask` 10-stage pipeline.
  - Parser sidecar details.
  - Auth layers: AuthProvider vs Principal→Scope, fail-closed ACL, P1b invariant, MCP stdio ADMIN vs HTTP per-session.
  - Startup gates.
  - Worker lifecycle.
  - Design rationale: pgvector, pg-boss with outgrow triggers and alternatives, sidecar, embeddings/HF cache/warm-base, RRF, chunking.
  - Failure-mode table, updated.
  - "What it is not".
  - **Do not re-copy CLAUDE.md's ground rules, commands or gotchas — link to them.**
- **`INTERFACES.md`** (or keep API.md + MCP.md) — generated-from-code endpoint and tool tables, including the missing routes, rate limits, error-code map, 409, purge_source, scope semantics, topK limits (search 100, ask 30, default 12), history 12×4000.
- **`EVALUATION.md`** — tiers and rationale; the four mechanisms; current numbers (post-fix only) plus the lesson; eval command matrix (`eval` / `eval:real` / `eval:gold` / faithfulness spec) with the three eval:real gates and the egress caveat; gold-set session procedure (or keep EVAL-GOLD-SET-GUIDE.md as the procedure since code links to it); corpus-grounded tier status and design rules.
  - **Keep the filenames EVAL-BASELINE.md, EVAL-GOLD-SET-GUIDE.md and EVAL-CORPUS-GROUND-TRUTH.md, or update their code references** in run-real-eval.ts, gold-set.ts, run-gold-eval.ts, claim-extractor.ts, claim-verification.ts, generator.ts:41,53 and read-only.test.ts.
- **Keep:** CONNECTORS, CONFIGURE-PRINCIPALS (fixed), LOCAL-GENERATION (add header).

### Facts that must survive any merge

- **Data flow:**
  - `triggerSync` is the sole creator of `ingestion_jobs`; the worker only transitions it.
  - Deleted-source handling marks the row failed.
  - Termination on `page.done`, not on an empty page.
- **Retrieval:**
  - Filters go in the final SELECT to preserve HNSW.
  - ACL null / [] / [...] semantics: [] returns before any DB query.
  - P1b identical not-found in 3 places.
  - The `/ask` stage order, including the TRI screen before embedding and `Generator.screen()`.
- **Embeddings:**
  - HF_CACHE_DIR default lands inside the pnpm package; warm-base image gate; `allowRemoteModels=false`; BGE query prefix.
  - Gemini batch ≤100 / OpenAI ≤2048.
  - OpenAI eval needs `EMBEDDING_DIMENSIONS=768`.
- **Parser:** 100 MB → 413; spreadsheet classifier thresholds (≥0.20 formula density); PARSER_SECRET constant-time, per request, comma-split headers.
- **MCP:** MCP_MAX_SESSIONS 1000 → 503; Origin allow-list; stdio ADMIN_SCOPE; logs to stderr; Claude Desktop/Code config snippets.
- **Connectors:**
  - Entra permission set including User.Read.All for apps/web; Sites.Selected instead of both Sites.Read.All and Files.Read.All.
  - `excludePaths` plus `DEFAULT_EXCLUDED_PATH_FRAGMENTS`, with exclusion = deletion.
  - Drive folderId is non-recursive; Gmail bypasses the parser for bodies.
  - eCFR XML structure and `last-modified` cursor; git-markdown frontmatter passthrough.
- **Principals:** gen-tokens semantics (unrecoverable tokens; duplicates are fatal); isAdmin before `API_ENFORCE_SCOPING`, or lockout; `[]` = quarantine.
- **Local generation:** key precedence; Gemini + base URL throws; client-data forces TRI `block` even over `off`; egress must name the endpoint host; negative test and tcpdump.
- **Eval:**
  - Fabricated citation = hard fail; abstention = null.
  - `validateGoldSet` attribution requirement; never renumber ids; questions before answers; `relevant: []` = coverage test.
  - eval:gold env, confidentiality and exit codes.
  - The sparse AND-bug lesson and the before/after table.
  - The `truncateAll` production-destruction hazard; extracted claims must never be committed.
  - Screen for client identifiers before any model extraction; locate-then-slice quotes.
- **Queue decision:** keep pg-boss; outgrow triggers; alternatives; never remove singleton dedupe.
- **README "one rule"** and the "PLAN checkboxes are not status" warning.

---

## Group 2-deploy-ops

# Digest: deployment, backup and ops-records group (12 files, 3,151 lines, all read in full)

Git last-touched dates are in brackets. "Inbound" means references from outside docs/; references from inside docs/ are listed separately so the merge can rewrite them.

---

## 1. DEPLOYMENT.md | 263 lines | reference + how-to [2026-10-17]

- **Audience:** operators. Generic self-hosters and the Railway operator are mixed together.
- **Status:** partially stale. The header says "Updated 2026-08-03", but the body already contains facts from 2026-09-02.
- **Summary:**
  - Production picture: a component scaling table, minimum env vars and Docker build commands (build context is the repo root, `pnpm deploy --prod` pruner).
  - DB provisioning for Neon, Supabase, RDS, self-hosted and Railway postgres-ssl.
  - A checklist for upgrading the Railway Postgres image, and the Railway migrations-on-deploy rules.
  - Connection-pool math, HNSW tuning, local-embedding (§7216) setup, secrets / API_TOKENS rotation, scaling and cost levers, monitoring queries.
- **Unique facts:**
  - Postgres image-upgrade checklist (L80-112): `railway service source connect --image ... --service rag-postgres`; pin the exact minor; check `pgdg12` vs `pgdg13` (glibc 2.36 vs 2.41).
    - Run `REINDEX DATABASE` and then `REFRESH COLLATION VERSION` on every DB, including `rag_premigration_*`.
    - Run `ALTER EXTENSION vector UPDATE`.
    - Verify: `datcollversion`; `pg_index where not indisvalid` = 0; an HNSW probe returns rows.
    - Rollback re-crosses the glibc boundary, so reindex either way.
  - Pool sizing: 10 connections per client (code confirms `client.ts:41`). About 100 max_connections supports 5 api + 3 worker + 2 mcp replicas. Beyond that, use PgBouncer in transaction mode.
  - HNSW is built with `m=16, ef_construction=64` (confirmed in `0000_init.sql:99`). `SET hnsw.ef_search=100` (default 40).
  - Local-model resources: about 430 MB on disk, +200-400 MB RSS, 50-100 chunks/s on 2 cores.
  - API_TOKENS rotation: 5 steps (add, roll, update callers, remove, roll).
  - Ingest bottlenecks: Gemini batch of 100 (confirmed `gemini.ts:108`); Graph about 10K req per 10 min; parser 5-20 docs/min/core. ANN latency: <10 ms under 1M chunks, <100 ms under 10M.
  - Monitoring SQL against `pgboss.job`; recommended metrics list.
  - Pre-deploy semantics: Railway aborts the deploy if the command exits non-zero, and it runs against the new image.
- **Overlaps:**
  - The migrations-on-deploy section is nearly verbatim in root CLAUDE.md L117.
  - The image-upgrade checklist duplicates the CLAUDE.md "Postgres image bump" gotcha.
  - postgres-ssl / pgBackRest facts appear in BACKUP-SCHEDULE-RUNBOOK and FRESH-DEPLOY-GUIDE §3.
  - Deploy order is also in FRESH §3.2.
  - Compliance env vars are also in env.example and CLAUDE.md.
- **Contradictions / staleness:**
  - L28 says MS credentials are needed only on the worker. `rag-web` also needs `MS_*` (`apps/web/src/lib/graph-client.ts:47-49`), as FRESH §3.1 documents.
  - L174-179: the Dockerfile `RUN ... warm-model.ts` snippet and the "first boot downloads ~430 MB" text (L168-170) are stale. The images now COPY from a digest-pinned `ghcr.io/marcusk639/rag-warm-base` (`apps/api/Dockerfile:50`, `apps/worker/Dockerfile:51`), as L205-208 of the same file says. Also, under client-data a runtime download is refused.
  - L172 says EMBEDDING_MODEL is not needed, but the snippet sets it.
  - The Components table and the Docker section omit rag-web, rag-teams-bot, rag-backup and ollama.
  - The Secrets section recommends GCP/AWS/K8s/Vault and never mentions Railway sealed variables.
  - L232 "Gemini free tier 1500 req/min" is generic. The production key is paid Tier 1 (PURGE-RECORD).
  - Inbound `docker/compose.prod.yml:37,358` points to "DEPLOYMENT.md §Encryption", which does not exist. That content is DEPLOYMENT-TARGET §D4.
- **Inbound:**
  - README.md:57
  - SETUP.md:66
  - env.example:78
  - CLAUDE.md:117
  - docker/compose.prod.yml:18,37,358
  - apps/worker/Dockerfile:85
  - Inside docs: 16 files.
- **LLM-readability:**
  - Generic multi-cloud advice is mixed with Railway-specific facts, so the reader cannot tell what applies to production.
  - The header date is wrong.
  - Stale and current warm-model instructions sit side by side.
- **Recommendation: rewrite.** Make it the canonical Railway production reference: services, env, migrations, the image-upgrade checklist, pooling and monitoring. Move the generic self-host and managed-PG material, plus D4 encryption, into one self-host appendix, and fix the compose.prod anchor.

## 2. DEPLOYMENT-TARGET.md | 70 lines | decision-record [2026-09-01]

- **Audience:** operators considering self-hosting.
- **Status:** superseded (banner L3-21) by Railway: DEPLOYMENT.md and PILOT-LAUNCH-STATUS.md.
- **Summary:**
  - Decision D1 (2026-06-14) was a single VM + docker-compose. Its rationale table covers sensitivity, ops burden, encrypted volume, pg16 image, residency and future-proofing.
  - It gives provisioning commands for `docker/compose.prod.yml` per tenant.
  - D4 is encryption at rest: LUKS, cloud KMS, and verify with lsblk.
  - It names the trigger for moving to K8s: namespace-per-tenant only when there are too many compose hosts.
- **Unique facts:**
  - D4 encryption-at-rest options.
  - The per-tenant `-p <tenant> --env-file .env.<tenant>` compose recipe.
  - The K8s trigger rationale.
  - D1 date 2026-06-14.
- **Overlaps:** DEPLOYMENT.md L45-49 points here. PLAN-LAUNCH-READINESS covers Phase T.
- **Contradictions:**
  - The L52 migration command `import('@rag/db').then(m => m.migrate())` is broken. The export is `applyMigrations` (`packages/db/src/index.ts:9`).
  - The recipe starts only api/mcp/worker, but compose.prod.yml now also defines web (L151) and teams-bot (L198).
- **Inbound:** none outside docs (compose.prod.yml mis-points to DEPLOYMENT.md instead). Inside docs: 9.
- **LLM-readability:** good banner. The leftover body invites misuse.
- **Recommendation: merge** D4, the compose recipe (with the migrate command fixed) and the K8s trigger into a "Self-host (compose.prod)" section of DEPLOYMENT.md, then **archive** this file.

## 3. FRESH-DEPLOY-GUIDE.md | 399 lines | how-to / checklist [2026-10-20]

- **Audience:** an operator standing up the whole system from zero.
- **Status:** current. This is the best doc in the group. The header still says "Updated 2026-10-17" but it contains a 2026-10-21 event (L325).
- **Summary:**
  - §0 decisions table: compliance mode, embedding, generation, Sites.Read.All vs Sites.Selected, Mail.Read, Teams bot (needs an Azure subscription), backup destination.
  - §1: four Entra app registrations with env vars, permissions, consent and redirect URIs; the Sites.Selected two-stage grant; what to send IT.
  - §2: secrets table.
  - §3: Railway service table and per-service variables; §3.2 deploy order.
  - §4: first sync, plus the tenant-SPO-licence gotcha and tenant-switch consequences.
  - §5: access. §6: Teams package. §7: verification checklist. Then a troubleshooting map.
- **Unique facts:**
  - The four-app split and its rationale: a client secret carries every permission on its app.
  - Why `User.Read.All` is on the ingestion app (`/users/{email}` and `checkMemberGroups` for group overage).
  - The known trade-off: public `rag-web` holds a secret that can read all of SharePoint. A fifth app is not built.
  - Sites.Selected:
    - Graph `POST /sites/{id}/permissions` JSON, the PnP `Grant-PnPAzureADAppSitePermission` command, and roles read/write/manage/fullcontrol.
    - Do NOT also grant Files.Read.All.
    - Each new site is an IT request; an ungranted site returns 403.
    - When switching, grant the sites before removing Sites.Read.All.
  - Secret generation:
    - `POSTGRES_PASSWORD` hex 24; `PARSER_SECRET` hex 32 on parser/api/worker/mcp.
    - `API_TOKENS` must be on the worker too.
    - `AUTH_SECRET` is base64 33 (matches env.example:541).
  - The full service table, including `ollama` (volume `/root/.ollama`, the Layer 1.5 scanner) and `rag-backup` cron `0 8 * * *`.
  - "Don't set PORT"; Railway injects 8080.
  - Shared env block with `DATABASE_URL ...?sslmode=no-verify`. pg-connection-string treats `require` as verify-full. The backup service is the exception: libpq needs `sslmode=require`.
  - Worker scanning vars: `CONTENT_SCAN_*`, plus add `ollama.railway.internal` to `EGRESS_ALLOWED_HOSTS` or documents quarantine.
  - `MCP_ALLOWED_ORIGINS` blank means all origins. `WEB_AUTH_MODE=static-fallback` disables auth.
  - `0000_init.sql` creates the vector, pg_trgm and uuid-ossp extensions.
  - SPO-licence error `400 Tenant does not have a SPO license.` (production, 2026-10-21). A tenant switch means new MS_* vars and a recreated source id.
  - Troubleshooting map with 11 rows.
- **Overlaps:**
  - §1.1 web/bot steps are summaries of AZURE-DEPLOY-RUNBOOK §1-4.
  - §1.1 ingestion app and §4 summarise PHASE-3-SHAREPOINT-RUNBOOK.
  - The §2 scope-secret note duplicates AZURE §5.
  - §3.1 rag-web vars duplicate AZURE §6a.
  - §3.2 duplicates DEPLOYMENT.md migrations and the PHASE-2 history.
  - The backup app duplicates BACKUP-SCHEDULE §2b-2d.
  - The postgres role requirement appears in 4 docs.
- **Contradictions:**
  - L185 implies the cron comes from `services/backup/railway.json`. That file has no cronSchedule (only `restartPolicyType: NEVER`), so the cron is dashboard-set.
  - L178 says `RAILWAY_DOCKERFILE_PATH=Dockerfile` for the parser, but `services/parser-py/railway.json` has `dockerfilePath: "services/parser-py/Dockerfile"`. With Root Directory `/services/parser-py` that path looks wrong. Verify which one wins.
  - Internal inconsistency: L236 says the worker is the only backend service that builds connectors, which the code confirms (only `apps/worker/src/deps.ts` imports `@rag/connectors`). But L329 and L395 say to change MS_* on worker, api AND web. The api does not need them.
  - L202 says rag-postgres carries a DATABASE_URL, which conflicts with BACKUP-SCHEDULE L369 (see below).
- **Inbound:** env.example:300. Inside docs: README, PHASE-2, CONNECTORS, DEPLOYMENT, PILOT-MANUAL-RUNBOOK, PHASE-3-SHAREPOINT.
- **LLM-readability:** good (status header, tables, links). The wide tables are dense but fine.
- **Recommendation: keep** as the canonical sequence and checklist. Absorb the unique bits of AZURE, PHASE-3-SHAREPOINT and PHASE-2, and fix the api MS_* claim and the header date.

## 4. AZURE-DEPLOY-RUNBOOK.md | 215 lines | runbook [2026-10-17]

- **Audience:** "Marcus (technical/ops lead)". It names firm people (Chris, Doug).
- **Status:** current, with history mixed in.
  - §6a is already done (rag-web live since 2026-08-01).
  - It has no status or date header.
- **Summary:**
  - Portal-click runbook for the web app and Teams bot: RAG-Admins security group; web app registration plus groups claim; Azure Bot resource plus bot app registration plus Expose an API (`api://botid-<id>`, `access_as_user`, pre-authorised Teams clients).
  - The Bot OAuth connection setting (AAD v2, token exchange URL); the shared HS256 scope secret.
  - Railway services rag-web and rag-teams-bot; packaging and uploading the Teams app; smoke tests; troubleshooting.
- **Unique facts:**
  - Teams first-party client IDs: `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (desktop/mobile) and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (web).
  - OAuth connection fields: Name becomes `BOT_OAUTH_CONNECTION_NAME`, provider AAD v2, Token Exchange URL `api://botid-<id>`, scopes. Test Connection must pass.
  - `BOT_ENTRA_SSO_SCOPE` format.
  - Scope-secret rule: at least 64 hex characters, enforced (code confirms `internal-scope-auth.ts:31`). Rotation note.
  - Live rag-web URL `https://rag-web-production-1c0a.up.railway.app` and app registration `c885331a-8e73-47c0-9dff-263756a81942`.
  - PORT=3978 incident on 2026-08-01: a pinned port caused a healthcheck mismatch. The bot defaults to 3978 but reads PORT (code confirms `teams-bot/src/config.ts:21,62`).
  - One-pass CLI recipe for rag-teams-bot that copies the secret and DATABASE_URL from rag-api.
  - `sslmode=no-verify` set 2026-09-07; pg-connection-string >= 2.10 aliases `require` to verify-full.
  - Manifest builder env vars: `DEVELOPER_NAME/WEBSITE_URL/PRIVACY_URL/TERMS_OF_USE_URL`, which must be reachable.
  - The builder rejects a `botid-` prefix on the app id and a mismatched scope.
  - Output path `apps/teams-bot/manifest/dist/teams-app-<version>.zip`; icon sizes 192/32.
  - Smoke test: audit_log `channel` api vs teams. A channel @mention answers from channel-safe sources only.
  - `DATABASE_SSL` env var on web and bot (exists in code).
- **Overlaps:** FRESH §1.1/§2/§3.1/§6 summarise it. The single-replica MemoryStorage note is in CLAUDE.md. The P0 gate text duplicates FRESH and PILOT-MANUAL-RUNBOOK.
- **Contradictions:**
  - §0 and §2 step 6 use `openssl rand -base64 32` for AUTH_SECRET; FRESH and env.example use `-base64 33`.
  - L138 says api/mcp "keep explicit `API_PORT`/`MCP_HTTP_PORT=8080`", while FRESH says don't set ports (`config.ts:303,312` falls back to PORT). They are compatible but give mixed guidance.
- **Inbound:** env.example:617. Inside docs: 7.
- **LLM-readability:** no date or status header; a person-specific audience; done and to-do steps interleaved.
- **Recommendation: merge into FRESH-DEPLOY-GUIDE** as a "Web + Teams Entra/Azure detail" appendix, or keep it as a slim linked runbook. Preserve the client IDs, OAuth connection fields, manifest builder rules and PORT incident. Drop the person names and the "already done" history.

## 5. BACKUP-RESTORE-DRILL.md | 382 lines | incident-or-event-record + runbook [2026-09-07]

- **Audience:** operators and compliance reviewers.
- **Status:** partially stale or historical. The drill result (2026-07-31) is complete.
  - The "no scheduled backup / nothing to restore from" findings are superseded by BACKUP-SCHEDULE-RUNBOOK: stopgap live since 08-01, scheduled-artifact restore proven 10-02.
  - L352-354 was updated for postgres-ssl.
- **Summary:**
  - P0 gate #3 drill in two legs.
    - Local: fresh pgvector container; 88/88 e2e against the restored DB; 39/39 indexes; 13 tables.
    - Production: 858 docs and 6,175 chunks streamed through `railway ssh` into `rag_restore_drill`; 4 seconds; 36 indexes; 12 tables; pgvector 0.8.2; distance spread 0 to 0.4573.
  - Findings: one migration behind; volume backups are available (dashboard only); pgvector version skew; SSH host key accepted on first use.
  - It also contains the "Applying a migration by hand" procedure, "Restoring for real", and notes for the next operator.
- **Unique facts:**
  - Exact local and production dump/restore commands. `--no-owner --no-acl` is required, otherwise the restore half-fails.
  - Four verification SQL queries: extension version, udt_name vector, non-null embeddings, pg_indexes count.
  - Railway volume backup semantics:
    - Daily kept 6 days, Weekly kept 1 month, Monthly kept 3 months; multiple schedules per volume allowed.
    - Restore only into the same project and environment; wiping the volume deletes the backups.
    - No CLI support.
  - `ssh.railway.com` host key fingerprint `SHA256:+S1xg92FrnHz6pY3bpkmh1OGtWQGNANXilPzlxA7B1g` (could not be verified).
  - **Manual migration procedure:**
    - The Drizzle hash is sha256 of the raw file.
    - Validate the method against 0017's stored hash first.
    - Apply the SQL plus the tracking row in one `-1` transaction, passing it base64-encoded through `railway ssh`.
    - The tracking row's created_at must be the journal `when` verbatim (`1795000000000` for 0018, which the code confirms in `_journal.json:127`), never `now()`.
    - Diff against local, including `NULLS NOT DISTINCT` on `afb_answer_subject_unique`.
  - Why it was needed: the deployed image predated the migration file.
  - Irreplaceable-tables table: audit_log, answer_feedback, staff_source_assignments, client_assignments, ingest_log, docs_gap_digest_runs. Also in BACKUP-SCHEDULE.
  - Bar for a real restore: 88/88 e2e.
- **Overlaps:**
  - The irreplaceable-tables table, the volume-backup caveats, the two-layer argument and the retention-vs-years mismatch are duplicated almost verbatim in BACKUP-SCHEDULE-RUNBOOK.
  - "Keep data inside Railway" also appears in BACKUP-SCHEDULE.
- **Contradictions / staleness:**
  - L15-19 and L211-215 ("nothing takes a scheduled backup") are false since 2026-08-01.
  - Finding 3 (prod 0.8.2 vs local 0.8.5) is stale: production is 0.8.6 since the 09-02 image change.
  - L21 is a historical aside.
  - The manual-migration rationale assumes rag-api ran migrations. The worker preDeploy now owns them, so the procedure is still valid but rarely needed.
- **Inbound:** none outside docs. Inside docs: 9, including compliance/scope-conformance-2026-09-30.md and PURGE-RECORD.
- **LLM-readability:**
  - The conclusion is split: the status line says complete, but the gaps sections read as current.
  - Many emoji status markers; long narrative "why" passages.
- **Recommendation: merge into a single Backup & Recovery doc** with BACKUP-SCHEDULE. Keep the restore procedure, verification queries, manual-migration procedure and drill evidence as a dated appendix. Drop the superseded "not yet proven" sections.

## 6. BACKUP-SCHEDULE-RUNBOOK.md | 576 lines | status-tracker + runbook [2026-10-02]

- **Audience:** operators, Chris (admin consent), counsel.
- **Status:** current-ish status tracker. Header: "Stopgap LIVE since 2026-08-01". The SharePoint destination is blocked on admin consent.
- **Summary:**
  - Two layers (volume backups plus nightly pg_dump shipped off Railway), plus pgBackRest WAL archiving.
  - Status table with 9 layers.
  - Scheduled-artifact restore proven 2026-10-02.
  - pgBackRest live 09-02. PITR proven via a manual root-run restore; the image's automated restore is broken (err 088 and a volume wedge).
  - Step 0: destination decision (SharePoint via Sites.Selected, because there is no Azure subscription).
  - Step 1: volume backups. Step 1.5: rag-backup deployed. Step 2: the ask to Chris. Step 3: verify. Step 4: dead-man's switch. Step 5: retention goes to counsel. Step 6: prove it.
- **Unique facts:**
  - **2026-10-02 restore evidence:**
    - Artifact `backups/kb-2026-10-01T080156Z.sql.gz`, 1.2 MiB; 31 artifacts from 09-01 to 10-01.
    - Restored into a throwaway on port 55433.
    - Results: 13 tables; 47 docs, 210 chunks, 132 audit rows; vector 0.8.6; `vector(768)`; 39 indexes (1 HNSW, 4 GIN); a single embedding model `gemini-embedding-001`.
  - **pgBackRest config:**
    - Bucket `rag-documents` (real name `rag-documents-yivrrpkniny`), prefix `/pgbackrest/cluster-7652162958315024418`.
    - Endpoint `https://t3.storageapi.dev` (Tigris), region auto, virtual-host style.
    - First full backup `20260902-191553F`: 114.9 MB, 52.8 MB stored with zstd-3, 1,873 files, 14 s.
    - Watcher polls every 60 s; full every 7 days, differential every 24 h; retention 4 full / 14 diff; RPO about 60 s.
    - The six `WAL_ARCHIVE_*` var names. `WAL_ARCHIVE_BUCKET` must be the S3 name, not a UUID (UUID-shaped names are refused; `WAL_ARCHIVE_BUCKET_ALLOW_UUID=1` overrides).
    - `pg1-user=${PGUSER:-postgres}` means dropping the postgres role silently disables backups.
  - **PITR proof:**
    - A marker table with exact timestamps; `pg_last_committed_xact` = 305156.
    - Err 088 root cause: the volume root is root:root, `postgresql.auto.conf` is created by pgBackRest, and `gosu postgres` cannot chown it.
    - The wedge: no PG_VERSION/pg_control, and initdb refuses a non-empty dir. Recover by pointing PGDATA at a fresh subdir.
  - **7-step manual PITR procedure:**
    - Set `WAL_RECOVER_FROM_*`, `_S3_URI_STYLE=host`, and `_PATH=/pgbackrest/cluster-<id>`.
    - Set NO `WAL_ARCHIVE_*`, and leave `POSTGRES_RECOVERY_TARGET_TIME` unset.
    - The config file must be `chown postgres` and 0600 (err 041).
    - Run the root `pgbackrest ... restore --type=time ...` command.
    - Start with `gosu postgres pg_ctl -p 5433`, then poll `pg_is_in_recovery()`.
    - File an upstream issue against postgres-ssl.
  - **Tenant check (2026-08-01):**
    - Tenant id `b49c5690-ccd1-4336-9f66-52780215c4ec`.
    - No Azure subscription; Marcus has no directory roles; `allowedToCreateApps=True`.
    - A tenant is not a subscription.
  - **Destination decision:** a SharePoint `Sites.Selected` write grant, not `Sites.ReadWrite.All`, and not a personal or firm-OneDrive account.
  - **rag-backup config:**
    - `BACKUP_DEST=s3` (stopgap).
    - `BACKUP_NAME_PREFIX` (file name, default kb) vs `BACKUP_PREFIX` (folder, default backups) is a trap (code confirms `backup.sh:47,52`).
    - Cron `0 8 * * *` UTC is 3 a.m. CDT.
    - `restartPolicyType NEVER`, because Railway skips scheduled runs while a deployment is Active.
    - The cron was enabled only after a manual run reached Completed.
    - Credentials via reference variables.
    - First run 2026-08-01 was 35,551,090 bytes.
  - **Unencrypted stopgap:** `AGE_RECIPIENT` is unset, with reasoning (no key home).
  - **az CLI commands** to create the backup app registration (`az ad app create`, `az ad sp create`, `credential reset --years 1`).
  - **Cutover:** `railway variables` with `GRAPH_*` and `GRAPH_FOLDER=kb-backups`.
  - **Verification:** expected log lines; the `railway run ... aws s3 ls` check; confirm Completed, not Active.
  - **Silent-failure safeguards:**
    - Silent-failure table.
    - `backup.sh` enforces a size floor `BACKUP_MIN_BYTES` (default 10 MB, confirmed `backup.sh:100`), a gzip integrity check and an upload timeout (azcopy was retrying indefinitely).
    - `HEARTBEAT_URL` pings healthchecks.io only on success (1 day period, 2 h grace).
  - **Counsel questions:** retention, WORM, and a maximum retention period.
  - **Decrypt:** `age -d`.
- **Overlaps:**
  - BACKUP-RESTORE-DRILL: the tables, volume-backup caveats, retention mismatch and restore-from-scheduled gate.
  - DEPLOYMENT.md L61-70 and FRESH §3.1: the postgres role and WAL vars.
  - CLAUDE.md L122.
  - FRESH §1.1: the backup app.
  - PURGE-RECORD: the bucket name.
- **Contradictions / staleness:**
  - **Size floor vs actual dumps.** The default 10 MB floor (L501, `backup.sh:100`) is incompatible with the 1.2 MiB 2026-10-01 artifact (L67). Either `BACKUP_MIN_BYTES` is overridden on Railway (undocumented) or something is off. Check Railway vars.
  - L42 "123 MB raw / 35.5 MB gz" and L460 "~35500000 bytes" are pre-purge sizes and stale.
  - L369 says "rag-postgres exposes no DATABASE_URL", which contradicts FRESH L202 and CLAUDE.md ("rag-postgres carries one").
  - L570: "index count 39 as of 2026-07-31". The 07-31 production count was 36 (39 was the local count; production reached 39/13 tables later).
  - Step 4 and Step 5 are still framed around Azure (the "SAS token expires" row, Azure lifecycle management) although the decision is SharePoint. Retention on SharePoint has no implementation note.
  - Step 1 still says "do today" though it was enabled 08-01.
  - Step 3's expected logs show sharepoint plus age, a future state.
- **Inbound:** CLAUDE.md:122; scripts/gate1-content-audit.mjs:26. Inside docs: 10.
- **LLM-readability:**
  - Status is current at the top, but the procedural steps still read as pending.
  - Huge length, many emoji status markers, and an evidence narrative interleaved with procedure.
- **Recommendation: rewrite / merge** into a single "Backup & Recovery" doc: a current-state table, a procedures section (volume, nightly dump, PITR manual restore, verification, dead-man's switch), open items (destination, heartbeat, encryption, retention), and an evidence appendix.

## 7. PHASE-2-RAILWAY-RUNBOOK.md | 299 lines | runbook, now historical [2026-10-17]

- **Audience:** whoever does the first Railway bring-up.
- **Status:** completed/historical, with a banner pointing to FRESH-DEPLOY-GUIDE.
- **Summary:**
  - Records the first Railway deploy (finished 2026-06-18): resource table with project and env ids, Gemini key, the API_TOKENS-on-worker crash, extensions via `railway ssh` psql.
  - The parser build-context fix (Root Directory), `railway up` of the three Node services, migrations from the worker container or a TCP proxy, domains, secret hygiene, verification and a config summary.
- **Unique facts:**
  - Project id `d5676b24-11fe-4665-a9bb-1e55b3670eb1`; env id `53a51a39-6b88-493a-92f1-ff3cad32b73a`.
  - API URL `rag-api-production-07b4`; MCP URL `rag-mcp-production-77f9`.
  - ZodError text for a missing API_TOKENS on the worker.
  - Railway CLI build-context tricks that fail: `railway up services/parser-py` gives "prefix not found". Do not change the parser COPY paths, because that breaks local compose.
  - Parser Dockerfile binds IPv6 `--host ::` and runs as non-root `appuser`.
  - TCP-proxy migrate fallback: `railway tcp-proxy --service rag-postgres create --port 5432`, then delete.
  - Parser `/parse` without a token returns 401, verified 2026-06-18.
- **Overlaps:** FRESH §3/§3.2/§7 supersede it; DEPLOYMENT.md migrations.
- **Contradictions:**
  - L94 claims the worker "does NOT assert indexes". False: `apps/worker/src/main.ts:48` asserts, as CLAUDE.md and DEPLOYMENT.md state.
  - L102 "railway connect does not work (raw Docker image)" is stale. Per CLAUDE.md, detection is by image name, and postgres-ssl contains "postgres".
  - L249 domain ports 3000/3001 are stale (8080 now).
  - The table's `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile` is superseded by the railway.json config files. The parser "remove RAILWAY_DOCKERFILE_PATH" contradicts FRESH's "=Dockerfile".
  - L30 "not yet committed" is stale.
  - Step 5's manual migration was replaced by the preDeploy command.
- **Inbound:** none outside docs. Inside docs: 8, including compliance/scope-conformance and timeline-weeks.
- **LLM-readability:** a "LIVE" table mixed into historical steps invites misuse; the banner helps.
- **Recommendation: archive.** First move the project and env ids, the IPv6/non-root parser note, the failing CLI tricks and the TCP-proxy fallback into the consolidated deploy doc's "Railway gotchas".

## 8. PHASE-3-FIRST-SYNC-RESUME.md | 139 lines | status-tracker / handoff [2026-06-21]

- **Audience:** the next session (June 2026).
- **Status:** completed/historical. Every open item has since been resolved or superseded: rag-web deployed, local embeddings and compliance mode exist.
- **Summary:**
  - First SharePoint sync result: job `a6ca467c`, source `d3461cbe-...`, 14 processed / 2 failed / 108 chunks.
  - Shipped fixes with commit SHAs:
    - parser 422 for markitdown's BaseException (`98b2833`)
    - embedding retry/backoff `EMBEDDING_MAX_RETRIES` default 5 (`a7aa669`)
    - zero-chunk re-embed (`ebc211d`)
    - streaming `/ask/stream` (`053d994`)
    - deploy reconciliation
  - The 2026-06-21 decision to host apps/web on Railway as rag-web, with the alternative (Vercel) and rationale.
  - Open items: lockfile, gitignore, branches, stream test, embedding-provider compliance. A redeploy recipe.
- **Unique facts:**
  - The rag-web hosting decision and its rationale: one platform, and the private network means rag-api need not be public. Vercel was rejected.
  - markitdown's `UnsupportedFormatException` subclasses BaseException.
  - railway CLI v5.19 does not surface remote stdout in non-interactive ssh.
  - The commit SHAs above.
- **Overlaps:** none significant. The retry knob is in env and code.
- **Staleness:**
  - markitdown is 0.1.8 now, not 0.0.1a4.
  - "rag-postgres pgvector pg16" is stale.
  - `scripts/reset_source_documents.py` is described as "untracked" but is tracked now.
  - L137-139 is an empty junk code fence.
- **Inbound:** none outside docs; README only inside.
- **LLM-readability:** a session handoff with relative "next session" framing.
- **Recommendation: archive.** Optionally preserve the rag-web hosting decision (one paragraph) in a decisions log.

## 9. PHASE-3-SHAREPOINT-RUNBOOK.md | 274 lines | runbook [2026-10-20]

- **Audience:** operators connecting a SharePoint source.
- **Status:** current, with minor drift. No date or status header.
- **Summary:**
  - How app-only Graph auth works (`/.default` scope, application permissions, admin consent).
  - Env-to-Entra mapping.
  - Steps 1-10: register the app, add permissions, grant consent, create the secret, set Railway vars, resolve siteId (from inside a container), POST /sources, sync, verify, schedule incremental syncs.
  - Troubleshooting table and code reference index.
- **Unique facts:**
  - **siteId resolution:**
    - The `curl` client-credentials token plus `GET /sites/<host>:/sites/<name>` recipe from inside rag-worker.
    - The composite siteId form `host,guid,guid`.
    - `GET /sites/{id}/drives` gives the driveId.
    - `folderPath` is honoured only on the initial cursor-less sync.
  - **Source creation and sync:**
    - POST /sources does not hit Graph (validation happens at sync).
    - Sync returns 202 `{jobId, ingestionId, mode}`; a concurrent second sync returns 409 (singletonKey).
    - Phase-3 done checklist, including an incremental sync advancing `lastSyncedAt` and a bad siteId failing loudly.
  - **Troubleshooting rows:** missing creds error text; 403 `Authorization_RequestDenied`; 401 `invalid_client` (Secret ID copied instead of Value); 404 site; 0 chunks (`maxFileBytes` 50 MB default); 429.
- **Overlaps:** FRESH §1.1/§1.2/§4 summarise it and link here.
- **Contradictions:**
  - L105-129 (Step 5) says set MS_* on rag-api and rag-worker because "rag-api may construct one (e.g. on validate)". The code disagrees: only the worker imports `@rag/connectors`. It also omits rag-web, which does need MS_*, although L75 mentions web reuse.
  - The code reference line numbers have drifted:
    - `factory.ts:47` is now line 52 (the error text is at 52).
    - `sources.ts:37` is now line 40 (CreateSourceBody).
    - `sources.ts:76` is now line 47 (SyncBody).
  - Step 2 recommends starting with Sites.Read.All plus Files.Read.All. FRESH presents Sites.Selected as least privilege. Not a contradiction, but the default posture differs.
- **Inbound:** none outside docs. Inside docs: 5, including FRESH and PILOT-MANUAL-RUNBOOK.
- **LLM-readability:** no header, otherwise a clean step structure. It hardcodes the production API URL.
- **Recommendation: keep** as the detailed SharePoint connector runbook, or merge it into CONNECTORS.md's SharePoint section. Fix the api MS_* claim and the line refs, and add a status header.

## 10. CI-PARSER-DISK-EXHAUSTION.md | 218 lines | incident-or-event-record [2026-09-02]

- **Audience:** developers and CI maintainers.
- **Status:** completed/historical. Resolved 2026-09-02 by PR #52 (CPU torch). The follow-up recommendations are partly undone.
- **Summary:**
  - The `parser` and `quality` jobs ran out of runner disk ("No space left", Errno 28) because `unstructured[local-inference]` pulled the GPU torch build and 19 nvidia/CUDA-13 packages.
  - Not caused by PR #50 (docs-only); latent on main; the transitive dependencies were unpinned.
  - A second problem: the `quality` job runs `pnpm test`, which includes @rag/e2e, despite the "infra-free" comment.
  - Five options with a recommendation: do 1 and 2, then 4; defer 5. Verification commands, and why PR #50 merged red.
- **Unique facts:**
  - Option 2 is still undone and still true. `ci.yml:64-65` runs `pnpm test`, which is `pnpm -r run test`; @rag/e2e has a `test` script; the `ci.yml:3` comment still claims "infra-free".
  - Option 5 rationale: the vision stack may be unnecessary, but removing it risks silent parse-quality regression and needs evals.
  - The `pip list | grep -icE 'nvidia|triton'` = 0 verification.
  - The breakage window: 2026-09-01 16:00 to 2026-09-02 15:56.
  - Rationale for merging PR #50 red.
- **Overlaps:** the `requirements.txt` L18-36 comment now preserves the core incident facts (torch 2.14.0, CUDA 13, 192 MB vs 527 MB, Errno 28). Also ISSUES-AND-OPTIMIZATIONS.
- **Staleness:**
  - L50 cites `requirements.txt:14 unstructured[local-inference]==0.16.11`; it is now L17 at `==0.24.1`.
  - Option 1 was implemented as explicit `torch==2.13.0+cpu` / `torchvision==0.28.0+cpu` pins, which partially fulfils option 4.
  - The option-5 analysis cites `app/main.py:307 partition(...)` with no strategy, and `main.py:249`. Parsing moved to `app/parsing.py`, and `_partition_with_ocr` now passes an explicit `strategy="hi_res"` (parsing.py:103). The "default strategy" premise is outdated.
- **Inbound:** none outside docs. Inside docs: claude-plugin-recommendations.md and ISSUES-AND-OPTIMIZATIONS.md.
- **LLM-readability:** good status header. Long argumentative narrative.
- **Recommendation: archive.** Move the two live follow-ups (filter e2e out of `quality`; option 5 deferred pending eval) into the backlog (ISSUES-AND-OPTIMIZATIONS).

## 11. PURGE-RECORD-2026-08-03.md | 211 lines | incident-or-event-record (compliance) [2026-09-01]

- **Audience:** compliance, counsel, operators.
- **Status:** completed/historical, but a binding compliance record. Some warnings are possibly still in force; check whether the content-boundary Phases 2 and 4 have landed.
- **Summary:**
  - On 2026-08-03 the whole corpus was purged because the 08-01 screen found taxpayer return information (TRI): 355 of 858 docs had hits; 17 had SSN/EIN/bank hits; one spreadsheet had 522 SSN-shaped and 518 EIN-shaped values.
  - Before/after counts: 858 docs and ~6,175 chunks to 0; the 3 sources were retained with cursors.
  - What survived; exposure assessment (internal: none; external: at ingest under the Gemini Cloud DPA, Tier 1 prepay); recordkeeping gap; re-sync warning; open items.
  - 2026-09-01 amendment: 1,747 objects (476 MB) of originals and five pre-purge dumps (177.8 MB) survived in the bucket for 29 days.
    - Root cause: `ObjectStore.delete()` was never called.
    - Fixes: purgeSource now clears storage; MCP threads objectStore; `scripts/sweep-orphaned-objects.sh` added (tracked; it refuses to run on an empty or unreadable source list).
    - Only one backup remained afterwards.
- **Unique facts:** all of it.
  - Counts and evidence: lifetime deletes of 2,546 docs and 18,659 chunks; ingest_log 844 ingested / 49 tri-flagged; last job 07-04, 811 processed / 89 failed.
  - Audit trail: audit_log has 3 rows, all by the operator. `embedding_provider` columns are NULL (the columns were added 07-09), which is an inference, not a record, under Circular 230 §10.22.
  - pg-boss schedules: only `rag.docs_gap_digest` (weekly) and `rag.ship_audit_log` (hourly).
  - All sources are `data_class=general`.
  - Bucket prefix table.
  - No DPA for the storage provider.
  - The "empty index looks like a broken system" warning.
  - Open items: CR-3 residency, counsel review of DPA adequacy (P0 #2), `screen-signoff.json` missing, log purges to ingest_log.
- **Overlaps:** PILOT-LAUNCH-STATUS, compliance/GATE-1-CONTENT-AUDIT and the sensitive-content-discovery spec reference it. The bucket name is in BACKUP-SCHEDULE.
- **Staleness:**
  - "Current state of the pilot" (empty index) is stale. BACKUP-SCHEDULE shows 47 docs re-ingested by 09-02.
  - "Do not re-sync until Phase 2/4 land" may or may not still hold; not verified here.
  - The "exactly one backup" consequence is superseded by 31+ nightly artifacts.
- **Inbound:** scripts/create-sharepoint-source.sh:21,170. Inside docs: 6.
- **LLM-readability:** good header with amendment dates. An H1 amendment inside the file confuses heading hierarchy; strikethrough items.
- **Recommendation: keep**, possibly moved under `docs/compliance/` or an incidents folder. Do not merge: it is an evidentiary record referenced by a script. Add a short "current status of each warning" note at the top.

## 12. EMAIL-IT-TEAMS-APP-UPLOAD.md | 105 lines | plan (draft correspondence) [2026-09-13]

- **Audience:** Marcus, to send to the firm's IT.
- **Status:** draft, not sent. The outcome table is empty, so it is open or possibly abandoned.
- **Summary:**
  - Draft email asking whether the tenant allows custom Teams app upload (requirement #6 in TEAMS-MVP-REQUIREMENTS). It offers the alternative of an admin-published catalogue app scoped to a group, and a three-option close.
  - Before-sending notes: the firm name is deliberately absent (CI fails on the tenant name), and the admin-centre wording is hedged.
  - Claims-to-manifest provenance table and an empty outcome table.
- **Unique facts:**
  - The two admin controls: the org-wide custom-apps setting and the per-user app setup policy.
  - Manifest facts, which the code confirms (`manifest.json:29,45,46`): permissions `identity` and `messageTeamMembers`; `validDomains: []`; scopes personal, team and groupChat.
  - The CI tenant-name guard.
  - The "send separately from the Azure subscription ask" guidance.
- **Overlaps:** FRESH §6 and AZURE §7 cover the upload mechanics.
- **Contradictions:** the email says the "indexed content is internal firm SOPs only — no client files". That needs re-checking given PURGE-RECORD (TRI was found in the "SOP" corpus) before it is sent.
- **Inbound:** none outside docs. Inside docs: TEAMS-MVP-REQUIREMENTS, FRESH, and `docs/.claude/sessions/snapshot.md`, a stray `.claude/sessions/` folder inside docs/ that should be removed in the cleanup.
- **LLM-readability:** clear. A personal-correspondence artifact in the reference docs folder.
- **Recommendation: move** to a correspondence/outbox folder, or merge the open question into TEAMS-MVP-REQUIREMENTS #6 and delete once it is sent or answered.

---

## Group section

### Topic clusters

**A. Deploying to Railway**

- Docs: DEPLOYMENT, FRESH-DEPLOY-GUIDE, AZURE-DEPLOY-RUNBOOK, PHASE-2 (historical), DEPLOYMENT-TARGET (superseded self-host).
- FRESH is the de facto hub; the others duplicate parts of it.

**B. Connecting the SharePoint source**

- Docs: PHASE-3-SHAREPOINT-RUNBOOK (current) and PHASE-3-FIRST-SYNC-RESUME (historical).

**C. Backup and recovery**

- Docs: BACKUP-RESTORE-DRILL and BACKUP-SCHEDULE-RUNBOOK. They overlap heavily, and the DRILL's "not proven" sections are superseded.

**D. Incident and compliance records**

- Docs: PURGE-RECORD (keep, evidentiary) and CI-PARSER-DISK-EXHAUSTION (archive).

**E. Correspondence**

- Doc: EMAIL-IT-TEAMS-APP-UPLOAD.

### Cross-doc contradictions to resolve

1. **Which services need `MS_*`.**
   - DEPLOYMENT L28 says worker only.
   - PHASE-3-SHAREPOINT L107 says api and worker.
   - FRESH L236 says the worker is the only backend builder, but L329 and L395 say worker, api and web.
   - Truth in code: worker (connectors, `apps/worker/src/deps.ts`) and web (`graph-client.ts`). The api does not need them.
2. **DATABASE_URL on rag-postgres.** FRESH L202 and CLAUDE.md say it is present; BACKUP-SCHEDULE L369 says it is absent.
3. **Worker index assert.** PHASE-2 L94 says the worker does not assert; CLAUDE.md, DEPLOYMENT and the code (`main.ts:48`) say it does.
4. **AUTH_SECRET.** AZURE uses `-base64 32`; FRESH and env.example use `-base64 33`.
5. **Parser Dockerfile selection.**
   - FRESH: `RAILWAY_DOCKERFILE_PATH=Dockerfile`.
   - PHASE-2: remove it.
   - `services/parser-py/railway.json`: `dockerfilePath: services/parser-py/Dockerfile`, which is inconsistent with Root Directory `/services/parser-py`.
   - Verify on Railway.
6. **rag-backup cron.** FRESH implies it comes from railway.json; it is dashboard-only, since the railway.json has no cronSchedule.
7. **Backup size floor (10 MB default) vs the 1.2 MiB artifacts.** Either an undocumented override or a problem. Check `BACKUP_MIN_BYTES` on Railway.
8. **Index and table counts on 2026-07-31.** BACKUP-SCHEDULE L570 says 39; the DRILL production leg says 36 (39 was local).
9. **Warm-model instructions.** DEPLOYMENT L168-186 describes a runtime download and a RUN snippet; DEPLOYMENT L205 and the Dockerfiles use the digest-pinned rag-warm-base COPY.
10. **Ports.** PHASE-2 uses 3000/3001; FRESH and AZURE use 8080 and say not to set PORT.
11. **Broken pointers.** compose.prod.yml points to "DEPLOYMENT.md §Encryption", which does not exist. The DEPLOYMENT-TARGET migrate command calls `m.migrate()`, which does not exist (the export is `applyMigrations`).
12. **Stale header dates.** DEPLOYMENT says 08-03 but has 09-02 content; FRESH says 10-17 but has 10-21 content.

### Proposed consolidated structure

**1. `DEPLOYMENT.md`: Railway production reference plus a self-host appendix**

- Service inventory (9 services, from FRESH §3), the env matrix per service, the secrets table.
- Ports, sslmode rules (no-verify for Node vs require for libpq/backup).
- Migrations: worker preDeploy, worker-first ordering, never on api/mcp.
- The Postgres image-upgrade and reindex checklist.
- Pooling, HNSW tuning, monitoring.
- Railway gotchas, collected from PHASE-2: TCP-proxy fallback, failing CLI build-context tricks, parser Root Directory, IPv6 bind, CLI v5.19 ssh stdout, PORT=3978 incident.
- Self-host appendix: compose.prod recipe with the migrate command fixed, D4 encryption, K8s trigger.

**2. `FRESH-DEPLOY-GUIDE.md`: the ordered checklist**

- Absorb AZURE's portal detail as an appendix: Teams client IDs, OAuth connection fields, `api://botid-` scope, manifest builder rules.
- Absorb PHASE-3-SHAREPOINT, or link to it from CONNECTORS.md.

**3. `BACKUP-AND-RECOVERY.md`: merge DRILL and SCHEDULE**

- A current-state table.
- Procedures: volume backups, the nightly pg_dump service config, the manual PITR restore, the restore-from-artifact procedure with verification queries, the manual migration application, the dead-man's switch.
- Open items: off-Railway destination blocked on admin consent, HEARTBEAT_URL, age encryption, counsel retention with P2 #8.
- An evidence appendix with dated drill results.

**4. Keep PURGE-RECORD as-is**, under compliance or an incidents folder, with a status note on each warning.

**5. Archive** PHASE-2, PHASE-3-FIRST-SYNC-RESUME, DEPLOYMENT-TARGET (after merging) and CI-PARSER (after moving its follow-ups to the backlog). Move the EMAIL draft out of the reference docs. Remove the stray `docs/.claude/`.

### Facts that must survive any merge

**Postgres image (rag-postgres)**

- postgres-ssl:16.14 requires the volume at exactly `/var/lib/postgresql/data` and `PGDATA=.../pgdata`.
- A `postgres` superuser role must exist (housekeeping and pgBackRest use `pg1-user=postgres`), or backups stop silently.
- The image runs a blind `REFRESH COLLATION`, so reindex first: per DB, including `template1` and `rag_premigration_*`. Check pgdg12 vs pgdg13 (glibc). Run `ALTER EXTENSION vector UPDATE`.

**sslmode**

- Node services use `sslmode=no-verify`, because pg-connection-string >= 2.10 treats `require` as verify-full, and the cert is self-signed.
- libpq (backup) needs `sslmode=require`.

**Migrations**

- Worker preDeploy only; deploy the worker first on schema changes.
- The manual Drizzle migration rule: the hash is sha256 of the raw file; created_at equals the journal `when` (never now()); apply SQL and tracking row in one transaction; validate against the previous migration's hash.

**Secrets and config**

- `INTERNAL_SCOPE_JWT_SECRETS` (plural) on the api; singular on web and bot; at least 64 hex characters.
- `API_TOKENS` is needed on the worker too.
- `PARSER_SECRET` must be identical on parser, api, worker and mcp.
- The ollama host must be in `EGRESS_ALLOWED_HOSTS`, or documents quarantine.

**Entra**

- The four separate app registrations and their rationale; `User.Read.All` on the ingestion app and the public-web trade-off.
- Sites.Selected two-stage grant (Graph/PnP), no Files.Read.All, grant before removing Sites.Read.All.
- SPO licence check: `400 Tenant does not have a SPO license` (2026-10-21); a tenant switch requires a new source id.

**Teams**

- Pre-authorised client IDs `1fec8e78-...` and `5e3ce6c0-...`.
- OAuth connection fields; `botid-` scope; manifest builder guardrails.
- Single replica (MemoryStorage).
- Don't set PORT.

**Backup service**

- `restartPolicy NEVER`, because Railway skips cron runs while a deployment is Active.
- `BACKUP_NAME_PREFIX` vs `BACKUP_PREFIX`; size floor, gzip check, upload timeout; `HEARTBEAT_URL` dead-man's switch.

**Recovery**

- pgBackRest settings: bucket and cluster path, Tigris endpoint, 60 s RPO, retention 4 full / 14 diff.
- Err 088 root cause, the volume-wedge recovery, and the 7-step manual PITR procedure. Do not set `POSTGRES_RECOVERY_TARGET_TIME` or `WAL_ARCHIVE_*` on the fork.
- Railway volume-backup semantics: same-project restore only; wiping the volume deletes the backups; dashboard only; 6 days / 1 month / 3 months.
- Restore verification: extension, vector type, index count, ANN distance spread, ON_ERROR_STOP, `--no-owner --no-acl`, e2e bar.
- Irreplaceable tables list. Retention is a counsel question: years vs a 3-month maximum.

**Infrastructure identifiers**

- Tenant id `b49c5690-...`; no Azure subscription; `allowedToCreateApps=True`.
- Project id `d5676b24-...` and env id `53a51a39-...`.

**Purge record**

- Keep it whole: object-store orphaning root cause, the sweep script, the pg-boss schedules, the re-sync warning.

**CI backlog**

- The `quality` job still runs e2e (`pnpm test` recurses into @rag/e2e).
- Removing `local-inference` is deferred pending eval.

---

## Group 3-launch-pilot

# Digest: launch/readiness group (10 files, 4,021 lines, every line read)

Ground truth I checked: PR #145 (docs/sharepoint-tenant-resync, commit 04761c5) **is MERGED to origin/main** as 00d13a7 on 2026-10-21. The local `main` is just behind. So the "3a" text is canonical on main.

---

## 1. docs/PILOT-LAUNCH-STATUS.md | 611 lines | status-tracker

- **Audience:** Marcus/operator, plus any agent. It names itself "the status source" (L475). README.md:77 also points readers here.
- **Status:** partially stale. It is the de facto current tracker, but it is a palimpsest: 6 dated banners stacked newest-first-ish (L3, L17, L52, L57, L68, L72), plus a superseded `<details>` block (L97-114) and inline AMENDED/CORRECTED blocks.
- **Summary:**
  - Top banner (2026-10-21): SharePoint re-sync is blocked by the tenant SPO licence. The index serves 48 docs / 211 chunks (47 SP + 1 manual).
  - Below that: the 2026-09-07 verified corpus table (47/210). Then the 2026-08-04 "index EMPTY" banner, which is explicitly superseded.
  - "Engineering DONE" table, then the P0 gates (0, 1, 2, 3, 3a), the LIVE web deployment record, the Railway port gotcha, the fastest-path options table and the 2026-08-03 correction of the "no client files" claim.
  - Then P1 (#0 migration 0018, #4 Teams bot/Azure, #5 digest privacy, #6 baseline diary) and P2 (#7 gold set, #8 audit-log destination/retention, #9 classifier, #10 local dev DB).
  - Then a doc-accuracy section and a large "Carried-forward backlog" (migrated from the deleted HANDOFF-2026-09-02.md): security/correctness items, deploy-gate hardening, open threads, the cpa-consulting pointer, and a "Where things live" table.
- **UNIQUE facts (only here):**
  - **Verified 2026-09-07 corpus table (L27-36):**
    - New source id `dbba75e2-…` replaced `badac563-…`. Two full syncs ran 2026-09-02 at 17:14 and 17:24 UTC.
    - 47/47 Class A, all `gemini-embedding-001`.
    - ingest_log: 94 ingested, 6 tri-flagged, 2 blocked. TRI hits: `1099+amount` ×4, `W2+amount` ×2.
    - `metadata.path` present on 47/47. 5 drives carry delta tokens. 6,362 WAL segments, 0 failures.
    - "Do not fix the 47 count" (L38-42).
  - **Gate 0 (GENERATION_TRI_POLICY=warn), the full measurement (L182-237):**
    - Answered 33/51 → 51/51. Self-retrieval 29/30 → 43/47 (91.5%). Refusal 4/4.
    - Only 3 trigger docs; 14 were collateral blocks. The blocking span was `Less than $600`.
    - `896170e`/`19a7542`: identifying patterns always throw. Revert path: `block`/unset. `client-data` forces `block`.
    - Operator decision dated 2026-09-07.
  - **Entra objects:** app reg `c885331a-8e73-47c0-9dff-263756a81942`; RAG-Admins group `33cdedd4-61cb-465e-afe2-f37045cf243c`; `groupMembershipClaims=SecurityGroup` (no Graph fallback needed). rag-web URL `https://rag-web-production-1c0a.up.railway.app`, verified 307-redirect behaviour (L306-322).
  - **Port gotcha (L346-364):** Railway `PORT=8080` vs `API_PORT`. You must change both the env and the domain target port.
  - **sslmode table (L496-508):** node-postgres needs `no-verify` (pg-connection-string ≥2.10 aliases `require` to verify-full); libpq needs `require`. Verified 7/7 backends TLSv1.3. "Verify the connections, not the variable."
  - **Backup status:**
    - Railway volume backups enabled 2026-08-01 (daily + weekly, ≤3-month retention).
    - Nightly pg_dump `0 8 * * *` UTC into Railway's own bucket (stopgap).
    - Off-Railway destination is blocked on Chris's admin consent. `HEARTBEAT_URL` is unset.
  - **Migration 0018 hand-apply record (L421-431):** prod went 17→18 migrations, 39 indexes.
  - **Teams-bot Azure blocker:** `az` returns "No subscriptions found". Raised as "Conflicts #11".
  - **Carried-forward backlog (L485-599):**
    - `disposition` modeled but never consumed (still true: no src consumer found).
    - Credential rotation deferred (admin token, Gemini key, `OBJECT_STORE_SECRET_ACCESS_KEY`).
    - PR #41 findings #3/#5/#6/#10; #42 SSA-validity SSN pattern dropped; #43 ~23 broken links and stray `b-renamed.md`/`c.md` (still present at repo root).
    - Deploy-gate hardening ladder: `/ready` healthcheck, git SHA on `/ready`, preDeploy preflight (hard-fail 401/403, warn on 5xx).
    - Pack-scanner slice 2 not started (plan doc boxes are unticked but slice 1 is merged).
    - TRI identifying-pattern exemptions are undecided and need a measurement against the standing corpus.
  - Principal `chris` is scoped to three non-existent source ids (L301).
- **Overlaps:**
  - Gates 1/2/3/3a duplicate PILOT-MANUAL-RUNBOOK items 1-3a (status here, procedure there).
  - The 3a text is repeated nearly verbatim at L3-15, L283-304, LAUNCH-READINESS-REVIEW L291-304, PLAN-SHAREPOINT-GOLIVE L18-25 and L100-106. That is 5 copies.
  - The options table (L372-377) duplicates PROTOTYPE-DELIVERY-OPTIONS.
  - The AMENDED block (L130-155) summarizes PROTOTYPE-READINESS-REVIEW C-1/H-1/H-7/M-7.
  - The P2 #7 gold-set text duplicates the runbook item 7.
  - Backup text duplicates BACKUP-SCHEDULE-RUNBOOK.md / BACKUP-RESTORE-DRILL.md.
- **Contradictions / staleness:**
  - **Doc count conflict:** L7 says 48 docs/211 chunks; L18/L29 say 47/210; runbook L84 says "47 SharePoint documents and 211 chunks".
  - **L167 "Eng go-live gate Amber, typecheck red"** is stale. Fixed in `64a7a38` (2026-08-31, .js extensions added). L144-146 has the same problem.
  - **L363 "Better long-term fix (not done)"** is stale. config.ts:303 now reads `API_PORT ?? PORT ?? 3000`.
  - **L510-522 "Spreadsheet content is chunked from an unredacted field"** looks fixed. pipeline.ts:449/549 shows CONTENT_PROCESSING_VERSION 2 with "tables and titles redacted" and `parsed.tables = redacted.tables`. PR #41 #10 (titles not redacted) is likely also fixed. Both need re-verification before deletion.
  - **L542 "#43: `pnpm eval:gold` names a script that does not exist"** is stale. It exists (package.json:31, tests/e2e run-gold-eval.ts).
  - **L337-344 "exposure is live… Task 1.1 still unchecked"** describes the 858-doc corpus that was purged 2026-08-03. It sits unmarked in the body.
  - **L128 "code is done; not engineering"** is superseded twice but still printed.
  - **L54 "S-5 decision pending"** (SharePoint per-doc permissions not enforced): status unknown.
  - **L264 / L430** cite 858/6,175 historical numbers without a historical label.
  - **Issue links #82/#83** (L246, L256): `gh issue view` on marcusk639/rag-system returns "Could not resolve". They are broken or point at another repo.
  - **L474:** DEPLOYMENT-TARGET.md is said to be stale (VM+compose vs Railway). That is still true and still uncorrected at the source.
  - LAUNCH-READINESS-REVIEW cites PILOT-LAUNCH-STATUS line numbers (:175, :17-19, :293-298, :168-197, :216-218) that have all drifted after the banner additions. documentation-review-artifacts/2026-09-07-sslmode-docs-review.md cites `:380-382` for the sslmode caveat, which is now ~L504-508.
- **Inbound refs outside docs/:** README.md:77; documentation-review-artifacts/2026-09-07-sslmode-docs-review.md:9,30,47. 23 docs inside docs/ reference it.
- **LLM-readability problems:**
  - Reverse-chronological banners interleaved with superseded banners. The reader has to apply "newest date wins" (stated at L118) across ~10 dated blocks.
  - The "One-line status" at L126-128 is itself marked superseded.
  - Mixed emoji severity markers.
  - Very long checklist items (gate 0 is 55 lines; gate 3 is one 25-line run-on line).
  - Historical record and current state are not separated.
- **Recommendation: rewrite** as the single consolidated launch tracker. Current state goes at top in one table; history moves to an appendix or archive.

## 2. docs/PILOT-MANUAL-RUNBOOK.md | 300 lines | runbook (human/legal/infra procedures)

- **Audience:** Marcus as de facto ops lead. It deliberately excludes AI-resolvable work.
- **Status:** partially stale. Item 3a is current. Items 1, 3 and 4 describe pre-July states and were never updated with outcomes. Items 2, 5, 6, 7, 8, 9 are still valid open procedures. Item 10 is local-only.
- **Summary:**
  - P0 hard gates: 1 audit what's indexed; 2 counsel + carrier; 3 backup/restore; 3a re-point MS_* to a SPO-licensed tenant and re-sync.
  - P1: 4 deploy apps/web; 5 digest privacy; 6 baseline diary.
  - P2: 7 gold set with Doug; 8 audit-log destination + retention; 9 classifier build-vs-buy; 10 reset the local dev Postgres.
  - Ends with a quick-reference table mapping the 20 items of the 2026-07-08 assessment to either this doc or PLAN-PILOT-READINESS-AUTOMATABLE tasks.
- **UNIQUE facts:**
  - **Item 3a procedure (L80-130):**
    - Same-tenant licence restore means no env change; just re-sync the existing source.
    - Graph perms: `Sites.Read.All`+`Files.Read.All` (or `Sites.Selected`) + `User.Read.All`.
    - `rag-web` needs MS_* for `/admin/access` Graph email→oid lookups and the group-overage check. `set-ms-credentials.sh --with-api` does not set rag-web (verified: the script only adds rag-api).
    - `resolve-siteid.sh` serves as the auth canary.
    - Sources cannot be edited, so a new id is required.
    - Access lives in two places: `API_PRINCIPALS` and `staff_source_assignments`. The `manage-access.js grant/check` commands are given.
    - The delete cascades access grants, so repoint before purging.
    - The manual-upload source `b8e010f3-…` must be re-uploaded by hand.
    - #142 parser and #116 heading-path changes are described in detail.
  - **Item 2:** exact questions for counsel, a carrier call script, and the instruction to flip vendor-dpa status only with the attorney's name.
  - **Item 5:** the hash-only audit-log privacy design and its middle-ground options.
  - **Item 6:** the diary must finish before Doug's first use. Timing exercise: "find the BOI SOP" with 3-5 staff. The $20-30K/yr estimate is `[NEW — UNVALIDATED]`.
  - **Item 7:** 30-50 questions with near-neighbor distractors; keep them free of client data.
  - **Item 8:** destination options and the reasoning that retention is a firm-policy call, not a legal minimum. Env vars `AUDIT_SINK_*`.
  - **Item 9:** pointer to cpa-consulting classifier-migration-design (DEFERRED) and the document-classification evaluation.
  - **Item 10:** root cause of Drizzle's MAX(created_at) watermark skip. 0015 enum add lacks `IF NOT EXISTS`. Mixed lineage from `feat/kb-governance-phase5-staleness-archive`.
  - Quick-reference mapping table (L278-300).
- **Overlaps:** status for items 1-3a, 4-10 is duplicated in PILOT-LAUNCH-STATUS. Item 4 duplicates PROTOTYPE-DELIVERY-OPTIONS and AZURE-DEPLOY-RUNBOOK. 3a overlaps PLAN-SHAREPOINT-GOLIVE phases 1-2 and FRESH-DEPLOY-GUIDE §1.
- **Contradictions / staleness:**
  - Item 1 (L15-39) still describes the July state ("classification gate isn't wired yet"). Status says verbal sign-off 2026-10-02 via compliance/GATE-1-CONTENT-AUDIT.md, but the runbook never points there.
  - Item 2 L45 quotes vendor-dpa as "PROVISIONAL — NOT COUNSEL-CONFIRMED". That file changed 2026-08-04 to billing-verified, CR-3 still open.
  - Item 3 L69 says "raw Docker image… not managed plugin" with `pg_dump` advice. Prod is now `postgres-ssl:16.14` with pgBackRest, the restore drill was done 2026-07-31, and the nightly schedule exists. None of that is reflected.
  - Item 4 lists "No Azure AD app registration yet, no RAG-Admins group" (L144). Both were created 2026-08-01 (status L319-320), and the web app is live.
  - Item 7 L203 "eval:real never run" conflicts with status L448-456 ("first real-embedder run proved… flat"). L206 "17 synthetic questions" is now 17 + corpus-cpa's 20.
  - **3a step 7 covers `API_PRINCIPALS` on rag-api only.** PLAN-SHAREPOINT-GOLIVE L206-209 sets it on rag-api **and rag-mcp**, and apps/mcp/src/main.ts uses buildAuthProvider. 3a likely omits rag-mcp.
  - 3a L84 says "47 SharePoint documents and 211 chunks" (see the count conflict above).
- **Inbound refs outside docs/:** env.example:644 ("item 5… item 8"); packages/core/src/config-schema.ts:221 ("item 5"). **Item numbering must be preserved, or these comments updated.** 15 docs reference it.
- **LLM-readability problems:** P1/P2 placement is contradicted in the text ("treat as P1", "P0-timing"). Long narrative "Why" paragraphs. Done-when lines are not reconciled with actual completion.
- **Recommendation: rewrite** (prune completed items 1/3/4 to outcome stubs plus links) and keep it as the procedure companion to the tracker. Alternatively merge the procedures into a consolidated launch doc's appendix, but keep item numbers stable for the code comments.

## 3. docs/LAUNCH-READINESS-REVIEW-2026-10-03.md | 349 lines | review-or-audit

- **Audience:** engineering. The bar is a 10–15 user internal pilot.
- **Status:** partially stale. Many findings were fixed 2026-10-06..08 but are not marked. It is an **orphan**: zero inbound references anywhere in the repo.
- **Summary:**
  - Four parallel reviews (chunking/embedding, retrieval, generation, eval). No CRITICAL.
  - HIGH-1: eval cannot gate the launch (gold set `[]` at gold-set.ts:93; corpora synthetic; FakeEmbedder only).
  - HIGH-2: no runtime faithfulness check.
  - HIGH-3: ACL post-filter was overstated, then fixed.
  - MEDIUM 4-13, LOW 14-16.
  - "Verified as sound" section. Ranked pre-go-live list. A 3a blocker banner was added 2026-10-21.
- **UNIQUE facts:**
  - **HIGH-3 fix detail:** ACL and withdrawal gate moved inside each candidate CTE via `EXISTS` before `LIMIT pool`. `enforcedSourceIds` dropped from the retry predicate.
  - **Residual:** filtered ORDER BY may seq-scan. pgvector `hnsw.iterative_scan` adoption is UNVERIFIED on Railway (local 0.8.6).
  - **Eval numbers:**
    - corpus.ts: 14 docs/17 q, recall@5 100%, nDCG 99.1%, MRR 1.000.
    - corpus-cpa.ts: 7 docs/20 q, recall 100%, nDCG 98.2%, MRR 0.975.
  - Worst-case context of 38 chunks (~30k tokens).
  - Sentence-splitter regex at markdown-chunker.ts:235, with no abbreviation handling.
  - Throttle is opt-in.
  - **"Verified sound" items:** citations are server-authoritative (`filterCitationsToAnswer` can only narrow); RRF k=60; sparse arm OR-semantic; scope fails closed; idempotency/straggler recovery; pool max 10, 5s connect / 30s statement timeouts; HNSW m=16/ef_construction=64.
  - Harness tooling mistaken for prompt injection (L345-349).
- **Overlaps:** RAG-QUALITY-REVIEW-2026-10-17.md (newer, same scope; not in my group); RAG-REVIEW-2026-09-16.md; PROTOTYPE-READINESS-REVIEW (TRI warn, gold set); EVAL-BASELINE / EVAL-GOLD-SET-GUIDE.
- **Contradictions / staleness (verified against git):**
  - Finding 4 (docClass not surfaced): **fixed** in `45c5dc2` (2026-10-07, "surface the data-class label on all three staff surfaces") and `bed4493` (citation URL gate by class). docClass now appears in prompt-context.ts, interfaces.ts and the web chat-interface.
  - Finding 5 (local egress): **addressed** in `6437534` and the factory.ts:60-75 `complianceMode` offline switch.
  - Finding 6 (neighbor expansion unbounded): **fixed** in `a7bb27c` ("bound neighbour expansion to MAX_ASK_TOP_K").
  - Finding 11: partially addressed by `04cc621` (re-embed when the active embedder changes).
  - Finding 12: HTTP echo was hardened in `aadc586`; MCP SDK path still unverified.
  - Finding 13 (reranker timeout): **still open** (no AbortSignal in reranker.ts).
  - Finding 14: **still open** (`ROW_NUMBER()` without tiebreaker at hybrid-search.ts:316/332).
  - Finding 15: **still open** (schema.ts:205 "768 dims for Gemini text-embedding-004").
  - Line cites into PILOT-LAUNCH-STATUS are all drifted (see #1).
  - "the real 47-document KB" is now 48/211.
- **Inbound refs:** none outside docs, and none inside docs.
- **LLM-readability:** good. Tables, path:line cites, explicit UNVERIFIED markers. The only problem is the missing resolution column.
- **Recommendation: merge into** the consolidated launch doc's "open engineering findings" list (open items 1, 2, 12-MCP, 13, 14, 15, 16), then **archive**. Alternatively fold it into RAG-QUALITY-REVIEW-2026-10-17 if that doc supersedes it.

## 4. docs/PLAN-LAUNCH-READINESS.md | 440 lines | plan

- **Audience:** implementing engineer/agent.
- **Status:** superseded, per its own L3-9, by plans/2026-06-26 (which itself is only "priority/sequencing"). Its premise ("Onvio not KB, §7216 not a gate") is falsified (L14-29).
- **Summary:** a 2026-06-14 phase plan:
  - Phase 0 done-table and decisions D1-D5 (VM+compose, standard API terms, delete path, encrypted volume, hybrid lazy tenancy).
  - Phase 1 CI; 2 Dockerfiles/deploy; 3 ops hardening.
  - G1 dataClass; G2 purge; G3 eval/rerank.
  - 4 correctness (H2, H6, M-N5, M-N3); T multi-tenancy (lazy); 5 go-live checklist.
- **UNIQUE facts:**
  - Decisions D1-D5 and their rationale. **D5 hybrid tenancy, isolated instance per sensitive tenant, never a commingled `tenant_id` DB** is a durable platform decision.
  - Phase T design: OPT-E4 per-source credentials as the multi-tenant prerequisite; k8s namespace + Postgres per tenant at scale.
  - **Provenance of Chris's 2026-06-14 iMessage** ("probably some actual client examples, but shouldn't be many") (L220-234).
  - Phase-0 commit hashes: P1 `91ce2dc`, P2 `7f0fdee`, C1 `3fdada5`, C2 `af5add2`.
  - Phase 4 open items H2 (metadata filter GIN not used), H6 (express@4 vs @types/express@5), M-N5, M-N3. Status not checked; M-N3 is done per other docs.
- **Overlaps:** plans/2026-06-26 (waves restate Phases 1-3, G1-G3), plans/2026-06-21 (same gap list), DEPLOYMENT-TARGET.md (D1).
- **Contradictions:**
  - D1 VM+compose conflicts with the actual Railway deploy.
  - D2 "standard API terms, no DPA" conflicts with 06-26 ("DPA signed") and vendor-dpa (Cloud DPA by billing tier).
  - L97 "pnpm lint is a no-op", "no Dockerfiles", "no deploy config": all done now.
  - Sentry does exist (packages/runtime/src/monitoring.ts). `/metrics` was not found in apps.
- **Inbound refs:** none outside docs; 10 inside (incl. DECISION-CPA-KB-RAG-CONVERGENCE, per L11).
- **Readability:** clear structure, but every checkbox is unchecked despite the work being done. That is a misleading status signal, as noted by README.md:77 and status L475.
- **Recommendation: archive.** Extract D5 plus Phase T into an ARCHITECTURE/tenancy decision record first, and keep the iMessage provenance in compliance history.

## 5. docs/PLAN-SHAREPOINT-GOLIVE.md | 473 lines | runbook/plan (operational)

- **Audience:** operator running Railway CLI.
- **Status:** completed/historical. The sync went live 2026-07/09, but the header still says "Phase 2 is next" (L6, L15-16). The 2026-10-21 banner (L18-25, L100-106) re-purposes it for 3a.
- **Summary:** four ops steps.
  - Phase 0 prereqs: tools, `gen-tokens.sh "service-admin::isAdmin"`, API_URL, resolve-siteid.
  - Phase 1 set MS_* via set-ms-credentials.sh, with the resolve-siteid auth canary.
  - Phase 2 POST /sources, update API_PRINCIPALS on rag-api + rag-mcp, full sync.
  - Phase 3 verification: pg-boss job-state query, `ingest.run.summary` marker, ask happy path, anti-pattern greps, singleton queue check.
  - Phase 4 optional S3 object store with migration-0002 check. Rollback table.
- **UNIQUE facts:**
  - Prod API URL `https://rag-api-production-07b4.up.railway.app`.
  - siteId format regex `^[^,]+,[a-f0-9-]+,[a-f0-9-]+$`.
  - Scope locked to the "Knowledge Base" subfolder of the Documents/Shared Documents drive (2026-06-29).
  - **"Why resolve-siteid is the auth canary"** (L124-129), cited by runbook 3a. Also new caveat: auth succeeds without an SPO licence and only the sync fails (L105-106).
  - Sync-time estimates (5–20 min; 1–3 h for large sites).
  - pg-boss `pgboss.job` / `pgboss.queue` inspection one-liners. Download 404-not-403 test. Rollback table.
- **Overlaps:** runbook 3a, FRESH-DEPLOY-GUIDE §1, PHASE-3-SHAREPOINT-RUNBOOK step 7, CONFIGURE-PRINCIPALS.md, PLAN-SHAREPOINT-READINESS Phase G.
- **Contradictions:**
  - Phase 1 says rag-worker only and "rag-api not strictly required". 3a now says all three services.
  - Hardcoded path `/Users/marcus/dev/rag-system` (L264, L318) is the wrong user dir (actual: /Users/marcusklein).
  - L170 source name "the tenant's SharePoint" vs actual "Knowledge Base".
  - `deploy_tokens.sh` is referenced. Its existence was not checked.
- **Inbound refs:** none outside docs; 2 inside (runbook 3a §0.2 reference).
- **Readability:** decent runbook shape, but the status header is stale and dual-purposed.
- **Recommendation: merge** the reusable bits (auth canary, siteId regex, job-state queries, rollback table) into a single SharePoint ops runbook (with runbook 3a / FRESH-DEPLOY-GUIDE). Then **archive**.

## 6. docs/PLAN-SHAREPOINT-READINESS.md | 538 lines | plan (code), with implementation results

- **Audience:** implementing engineer.
- **Status:** completed/historical. Phases A–D have results recorded. E/F/G have no results section, but downstream docs treat them as done: reranker exists (default off), topK=12, per-doc cap 3.
- **Summary:**
  - The 2026-06-21 plan: "ingest everything, answer substantively, download citations".
  - Locked decisions: S3 object store for originals plus an auth-scoped download route; tuning + diversity cap + max tokens + prompt + reranker; per-page re-enqueue.
  - Phase 0 discovery tables, then Phases A (drive pagination, deletions, observability, connector tests), B (re-enqueue), C (ObjectStore), D (download route), E (answer quality), F (reranker), G (final verification).
- **UNIQUE facts:**
  - Design decisions: **originals in object storage, never bytea**; download returns 404, not 403; BFF proxy, never browser bearer.
  - Migration 0002 was **hand-authored because `drizzle generate` would drop the HNSW/GIN indexes**.
  - Single-bucket assumption (`storage_bucket` recorded but serving uses the configured bucket).
  - "Attempt everything, let the parser 422" (no file-type allowlist).
  - **Known open follow-up:** a single Graph delta page with >50 file items drops its tail (pageSize 50). Not fixed by Phase B. No `$top` handling was found in sharepoint/index.ts, so it is likely still open (unverified).
  - Phase B: singleton policy, 5 pages/job, `MAX_SYNC_CONTINUATIONS`, expiry 1800s.
- **Overlaps:** PLAN-PER-PAGE-REENQUEUE.md; ARCHITECTURE.md (download capability); 06-26 "Done" table.
- **Contradictions:** most line refs are stale. The doc says `retriever.ts`/`queries.ts` hybridSearch; the code now lives in `hybrid-search.ts`. topK default 8 (now 12). The anti-pattern "keep filters post-fusion" was **reversed** for ACL/withdrawal on 2026-10-03 (LAUNCH-READINESS-REVIEW HIGH-3).
- **Inbound refs:** none outside docs; 3 inside.
- **Readability:** good per-phase structure, but plan text and results are interleaved, and E–G results are missing.
- **Recommendation: archive.** First lift the durable decisions (object store / not bytea, 404 semantics, hand-authored 0002 reason, attempt-everything ingest) and the >50-item delta overflow open item into ARCHITECTURE/backlog.

## 7. docs/PROTOTYPE-READINESS-REVIEW-2026-08-01.md | 700 lines | review-or-audit

- **Audience:** engineering plus project lead.
- **Status:** completed/historical. It has a 2026-09-16 resolution block (L318-334), but the block sits mid-document after H-1b instead of being reflected in the findings table.
- **Summary:**
  - The bar: 15–20 CPA staff in Teams. Measured against 112 real SOP docs / 321 chunks.
  - C-1: TRI pre-flight caused 500s. Fixed with triPolicy, 422 mapping and `runPreFlight` factoring.
  - H-1: `plainto_tsquery` AND made the sparse arm dead on 5/15 questions. Fixed with an OR tsquery that is `quote_literal`'d, wrapped in NULLIF/COALESCE.
  - H-1b: the flat-sweep conclusion was partly the H-1 bug.
  - H-2..H-7, M-1..M-10 and L-1..L-5, with a recommended sequence, a genericity section and corpus notes.
- **UNIQUE facts:**
  - **TRI measurement:** 9/112 docs (8%), 12/321 chunks (3.7%), ≈37% of random 12-chunk prompts tripped. All false positives. The scanner regexes are quoted.
  - **websearch_to_tsquery also ANDs**, so CPA-READINESS-ASSESSMENT's prescribed fix was wrong.
  - Before/after weight-sweep tables. Lesson: "a degenerate metric is a reason to suspect the instrument".
  - **H-2 design rationale:** query contextualization, not history-in-prompt.
  - **Resolution commit map:** `631c5c5`/`7591f9e`/`799cce8` (H-2), `5ba583e` (H-3), `ec50000` (H-4), `36ce4f7` (H-5 prerequisites; still off pending vendor/DPA), `d155bfa` (H-6), `c972d19` (M-1), `94884b1` (M-2), `6d42f1e`/`bd53ba9` (M-4), `1682e26` (M-8), `e05f8e4`/`c343ef9` (M-10).
  - Corpus pathologies: 2024/2025 HSA twins, DRAFT vs Finalized, ~13 procedures behind ScreenPal videos, ~40 calculator xlsx (M-9).
  - A real client name used as a worked example in an SOP.
  - M-3: no Anthropic generator. Probably since superseded: commit 47806c1 "stop Claude truncation" implies a Claude generator now exists (unverified).
  - **Genericity:** the system prompt is a hardcoded CPA constant; the TRI scanner is US-tax-specific.
- **Overlaps:** status L130-155; RAG-REVIEW-2026-09-16; EVAL-BASELINE; CPA-READINESS-ASSESSMENT-2026-07-08.
- **Contradictions:**
  - The C-1 fix text says the default is `warn` (L148-150). The resolution note (L323) says the code default is `block`, and status gate 0 confirms `block`.
  - The findings-table statuses (e.g. M-7 "Documented") are stale. M-7 was fixed 2026-08-31.
  - M-3 is likely stale.
- **Inbound refs:** none outside docs; 8 inside.
- **Readability:** strong per finding. The resolution block is mis-placed and the table is not updated.
- **Recommendation: archive**, as a historical review with high-value rationale. First carry the still-open items (H-5 reranker off pending DPA; H-6 recency prior; M-4 normalized scores; M-5 images dropped; M-6 `source_modified_at` unread; M-9 calculators; L-1..L-5) into the consolidated backlog.

## 8. docs/PROTOTYPE-DELIVERY-OPTIONS.md | 151 lines | decision-record

- **Audience:** Marcus/Chris.
- **Status:** completed/historical. Option 1 shipped 2026-08-01. Its compliance premise is falsified: status L411 claims it was "corrected 2026-08-03", **but this file contains no correction**. L27-36 still says "no client files… §7216 is not triggered".
- **Summary:** four ranked delivery options: web app (recommended), Teams personal tab, full Teams bot (Azure subscription), MCP only. Prototype guardrails (named users, Class A/B, written scope note, audit on, no judgments). Sequence: bundle the asks to Chris.
- **UNIQUE facts:**
  - Option 2 (Teams personal tab, no Azure Bot needed). The tenant custom-app-upload setting is unverified.
  - `allowedToCreateApps: True` verified for Marcus.
  - `apps/web/src/lib/graph-client.ts` uses app-only `User.Read.All` (admin consent) only for `/admin/access` and the group-overage fallback. It is not needed to ask a question.
  - Bundle ask: `User.Read.All` + the backup's `Sites.Selected` + the subscription.
  - **"What would make this NOT defensible"** (L147-151).
  - The five guardrails (L46-52).
- **Overlaps:** status options table (L366-377); runbook item 4; AZURE-DEPLOY-RUNBOOK.
- **Contradictions:**
  - L27-36 conflicts with status L384-413 and PURGE-RECORD. The "corrected" claim in status L411 is false for this file.
  - The table shows 844 docs; later 858.
- **Inbound refs:** none outside docs; 3 inside.
- **Readability:** concise and clear.
- **Recommendation: merge** Option 2 (the tab path), the graph-client consent nuance and the guardrails/"not defensible" list into the consolidated launch doc (Teams/Azure section). Then **archive**. Do not keep it live without fixing L27-36.

## 9. docs/plans/2026-06-26-launch-readiness-consolidated.md | 185 lines | plan

- **Audience:** engineer.
- **Status:** superseded/historical. It claims "Active for priority and sequencing only" (L3), but nothing downstream uses it for sequencing. PILOT-LAUNCH-STATUS plus the runbook are the real queue. Premise falsified (L13-20).
- **Summary:** reconciles the 06-14 and 06-21 plans by asserting a signed enterprise-LLM DPA, so self-host is not on the critical path. Done/Absent snapshot (2026-06-26). Wave 1 hardening (rate limit, PARSER_SECRET, DB TLS, remove admin-by-default, HITL disclaimer, Sentry + failed-job alert, real lint). Wave 2 (dataClass, purge, audit_log). Wave 3 (real eval). Process track (counsel / domain / WISP-QI). Deferred list. Go-live checklist.
- **UNIQUE facts:**
  - The claim "enterprise-LLM DPA (zero-retention + US-region) is signed". This **contradicts** vendor-dpa (Cloud DPA via billing tier only, verified 2026-08-04; US region/CR-3 UNCONFIRMED; counsel review open).
  - **Process-track items not tracked elsewhere in my group:** name the Qualified Individual; add the RAG system to the WISP; staff AI-limitations note; breach runbook reference; GLBA pen-test exemption by consumer-record count; a startup "DPA acknowledged" flag assertion.
- **Overlaps:** almost entirely restates 06-14 and 06-21.
- **Contradictions:** DPA signed vs unverified (above). Most "Absent" items are now present: rate-limit dep in apps/api, `draft_requires_practitioner_review` in services/ask.ts, purgeSource in services, Sentry in runtime/monitoring.ts, TLS, audit_log. `/metrics` was not found (still absent, but deferred).
- **Inbound refs:** none outside docs; 5 inside.
- **Readability:** compact, but asserts authority it no longer has.
- **Recommendation: archive.** First move the WISP/QI/AI-training/breach-runbook/GLBA process items into the consolidated launch doc's legal/process track if they are not tracked in compliance/ (I could not verify that from my group).

## 10. docs/plans/2026-06-21-prelaunch-hardening-plan.md | 274 lines | plan

- **Audience:** engineer.
- **Status:** superseded (by 06-26). Historical.
- **Summary:** CR-matrix-driven plan from `app-comparison-2026-06-21.md` at HEAD `7b70b59`. PRE-LAUNCH phases 1-7: self-host + egress TRI guard (CR-1, "TOP GATE"), retention/purge (CR-18), audit_log + Principal threading (CR-10), HITL (CR-13/14), RBAC + data class (CR-5), encryption (CR-6/7/8), rate limit. POST-LAUNCH 8-10 (observability, CI, backup). CAN-WAIT 11-14 (rerank, gold eval, per-doc ACL + mirroring, web UI completion).
- **UNIQUE facts:**
  - CR-1…CR-20 mapping to phases (priority table L266-274).
  - **Still-open forward items:**
    - Phase 6 parser TLS (HTTPS for non-localhost PARSER_URL).
    - App-level AES-256-GCM for Class C/D and transcripts.
    - Phase 13 per-document/per-client ACL, DB-backed principal store, SharePoint/Entra ACL mirroring. This relates to status L54 "S-5 permissions not enforced per document".
    - Phase 14 web upload route, server-side chat persistence, a11y (zero `aria-*` then).
    - Phase 10 decommission checklist with cryptographic erasure.
    - Phase 8 anomaly alerts with ≥3-year retention.
  - Phase-0 "allowed patterns" catalog. Its line numbers are stale.
- **Overlaps:** 06-26, 06-14, CPA-COMPLIANCE-REQUIREMENTS.md (CR matrix), PLAN-CPA-COMPLIANCE.md (likely).
- **Contradictions:**
  - The anti-pattern "Do not move the ACL filter into the ANN CTE" (L43) was explicitly **reversed** 2026-10-03 (ACL now via `EXISTS` inside the candidate CTE).
  - "`local` throws" is false now (LocalEmbeddingProvider exists, ONNX).
  - "audit stores query_text or hash — decide" was decided as hash.
- **Inbound refs:** none outside docs; 3 inside.
- **Readability:** dense, CR-tagged and useful as a control map. File/line pointers are stale.
- **Recommendation: archive**, after moving the CR-mapped still-open items (per-doc ACL/mirroring, parser TLS, AES for C/D, decommission/erasure, anomaly alerting) into the compliance backlog (PLAN-CPA-COMPLIANCE or the consolidated tracker).

---

# GROUP SECTION

## Which tracker is the real source of truth

- **PILOT-LAUNCH-STATUS.md** is the only live status tracker. It is self-declared (L116, L475), README.md:77 points to it, and every plan in the group defers to it.
- **PILOT-MANUAL-RUNBOOK.md** is the live _procedure_ source for human items. Code comments reference item numbers 5 and 8.
- plans/2026-06-26 still claims "active for priority/sequencing", but it is effectively dead.
- No doc in this group is a current _engineering_ findings tracker. LAUNCH-READINESS-REVIEW-2026-10-03 is orphaned and unresolved. RAG-QUALITY-REVIEW-2026-10-17 (not in my group) is the newest review and probably supersedes it; another reader should confirm.

## Genuinely OPEN launch items (deduplicated)

**Hard gates**

- **G-3a: SharePoint tenant has no SPO licence; re-point `MS_*` and re-sync** (status L3-15, L283-304; runbook L80-130; LRR L291-304; GOLIVE L18-25). Sub-steps:
  - Choose the tenant.
  - Register the app with admin consent (IT dependency).
  - Set MS_* on rag-worker + rag-api + **rag-web** (and verify whether rag-mcp needs the principals update).
  - Resolve siteId, create the new source, full sync.
  - Repoint `API_PRINCIPALS` (and fix `chris`'s 3 dead ids) and `staff_source_assignments`.
  - Verify, purge `dbba75e2-…`, re-upload manual doc `b8e010f3-…`.
  - This unblocks #142/#116 reaching prod and gives the gold-set run a fresh index.
- **G-2: counsel + carrier sign-off** (§7216/Circ 230/GLBA; DPA adequacy; CR-3 data residency) (status L248-256; runbook L43-59). Issue #83 link is broken.
- **G-1 residual: written per-row sign-off for the 47-doc audit**, archived outside the repo (status L239-247; "treated as satisfied"). Plus the "WITHDRAW verdict needs a schema home" code change (status L59-60). lifecycle_status now exists in schema/queries/hybrid-search, so this may be done; verify.
- **G-3 residual:**
  - Off-Railway backup destination (blocked on Chris's admin consent) (status L272-275, L533-535).
  - `HEARTBEAT_URL` dead-man's switch (L276-278; backup.sh:202 supports it, unset).
  - audit_log retention window (counsel; ties to P2 #8) (L279-281).
  - Restore from a scheduled artifact: closed 2026-10-02 per L61-63, but L278-279 still lists it as open. That is an internal contradiction.

**P1**

- **P1-4: Teams bot needs an Azure subscription** (Chris / purchasing; distinguish "no subscription" from "no role") (status L433-442). The Option-2 Teams personal tab is an untried path (PDO L88-106; tenant custom-app-upload unverified). Admin consent for `User.Read.All` (the /admin/access page) is pending.
- **P1-5: docs-gap-digest privacy decision** (status L443; runbook L162-174). Referenced by env.example:644 and config-schema.ts:221.
- **P1-6: baseline diary** before any staff use (status L444; runbook L178-192).

**P2 / quality**

- **P2-7: gold set with Doug.** GOLD_QUESTIONS is still `[]`, verified. `pnpm eval:gold` exists but has never produced a number (status L448-456; runbook L198-219; LRR HIGH-1; PRR H-1b).
- **P2-8: audit-log off-host destination + retention** (status L457; runbook L223-235).
- **P2-9: classifier build-vs-buy** (deferred).
- **P2-10: reset the local dev Postgres** (local only).
- **Engineering open:**
  - No runtime faithfulness check (LRR HIGH-2).
  - MCP SDK error-path sanitization unverified (LRR #12).
  - Reranker fetch has no timeout (LRR #13, verified).
  - RRF ROW_NUMBER has no tiebreak (LRR #14, verified).
  - schema.ts:205 stale text-embedding-004 comment (LRR #15, verified).
  - Prod GENERATION_MODEL unverified (LRR #16).
  - Sentence-splitter and pathological-input tests (LRR #8-9).
  - Embed throttle opt-in (#10).
  - TRI warn is log-only for users (#7).
  - Reranker off pending vendor/DPA (PRR H-5).
  - No recency prior (H-6).
  - Relative scores (M-4).
  - Images/screenshots dropped (M-5).
  - `source_modified_at` unread (M-6).
  - Calculator xlsx noise (M-9).
  - L-1..L-5.
  - SharePoint delta-page >50-item tail loss (PSR L190-194, L225-229; likely still open).
  - Per-document SharePoint permissions not enforced (status L54, "S-5 decision pending"; plan 06-21 Phase 13).
- **Backlog (status L485-599):**
  - `disposition` not consumed (verified).
  - Credential rotation (admin token, Gemini key, object-store secret).
  - PR #41 #3 (Class-C escalation dead code), #5 (no eval evidence), #6 (object store writes raw unredacted bytes, `pipeline.ts:424`). #10 titles is likely fixed by CONTENT_PROCESSING_VERSION 2; verify.
  - #42 SSA-validity SSN pattern.
  - #43 ~23 broken links and stray `b-renamed.md`/`c.md` (verified present).
  - Deploy-gate hardening: healthcheckPath is still `/health` on api/mcp/teams-bot (verified); git SHA on /ready; preDeploy preflight; per-document ingest-failure metric.
  - Pack-scanner slice 2.
  - TRI identifying-pattern exemption decision plus measurement (`ssn-unformatted` FP rate unmeasured).
  - `hnsw.iterative_scan` on Railway pgvector unverified (LRR L128-133).
- **Process/legal (06-26 L139-146; 06-21 L220-223), status unknown from my group:** Qualified Individual, WISP entry, staff AI-limitations training, breach runbook (FTC 30-day + IRS liaison), GLBA pen-test exemption count, vendor register (CR-9).

## Done items still shown as open or stale

- typecheck red (fixed 64a7a38, 2026-08-31).
- PORT fallback (config.ts:303).
- Spreadsheet/tables redaction (pipeline v2).
- eval:gold script missing (it exists).
- Runbook items 1, 3, 4 (outcomes not recorded).
- PROTOTYPE-DELIVERY-OPTIONS' "no client files" claim (status says it was corrected; it was not).
- LRR findings 4, 5, 6 (fixed 2026-10-06..07).
- PRR findings table (statuses stale vs its own resolution block).
- GOLIVE "Phase 2 next".
- 06-26 "Absent" list (mostly built).

## Topic clusters

1. **Launch status/gates:** STATUS, RUNBOOK, 06-26 go-live checklist, 06-14 Phase 5, 06-21 Final Phase. That is **four separate go-live checklists**, all overlapping (build/test/eval green, rate limit, PARSER_SECRET, Sentry, dataClass, purge, audit_log, disclaimer, sign-off).
2. **SharePoint ingestion ops / 3a:** GOLIVE, RUNBOOK 3a, STATUS 3a, LRR banner. The 3a text exists in 5 places.
3. **Compliance premise history (Onvio vs KB, §7216):** 06-14 D2a, 06-26 reconciliation, PDO guardrails, STATUS corrections, PRR corpus note.
4. **Retrieval/generation quality reviews:** PRR (08-01), LRR (10-03), plus RAG-REVIEW-09-16 and RAG-QUALITY-REVIEW-10-17 outside my group.
5. **Delivery surfaces:** PDO, STATUS LIVE section, RUNBOOK item 4, Teams/Azure blocker.
6. **Historical plans** (06-14, 06-21, 06-26, SharePoint-readiness): implementation guides with unticked boxes.

## Cross-doc contradictions

- **Index size:** 48/211 (STATUS L7) vs 47/210 (STATUS L18, L29) vs 47 SP / 211 (RUNBOOK L84) vs "47-document KB" (LRR).
- **TRI policy default:** `warn` (PRR L148-150) vs `block` (PRR L323, STATUS gate 0, config.ts). `block` is correct.
- **DPA:** "signed enterprise DPA, US-region" (06-26 L37-39) vs "standard API terms, no DPA" (06-14 D2) vs "Cloud DPA by billing tier, CR-3 unconfirmed, counsel pending" (STATUS L251-255, vendor-dpa). The last is correct.
- **Deploy target:** VM+compose (06-14 D1, DEPLOYMENT-TARGET.md) vs Railway (actual).
- **`MS_*` services:** rag-worker only (GOLIVE Phase 1, set-ms-credentials.sh header) vs worker + api + web (3a).
- **API_PRINCIPALS:** rag-api + rag-mcp (GOLIVE L206-209) vs rag-api only (RUNBOOK 3a step 7).
- **ACL filter placement:** "never inside the ANN CTE, keep post-fusion" (06-21 L43, PSR L101, L491) vs moved inside the CTE via EXISTS (LRR HIGH-3, 2026-10-03).
- **"Restore from a scheduled artifact":** closed (STATUS L61-63) vs still open (STATUS L278-279).
- **PDO L27-36 "no client files":** contradicts STATUS L384-413 and PURGE-RECORD, while STATUS claims PDO was corrected.
- **Runbook item 7 "eval:real never run"** vs STATUS P2 #7 "first real-embedder run proved flat".

## What a single consolidated launch doc should contain

1. **Header:** date, corpus state as one verified table (docs/chunks/sources/class/model/source ids), deployed surfaces with URLs, and the "do not fix the 47/48 count" warning.
2. **Gate table** (one row per gate: 0, 1, 2, 3, 3a, P1-4/5/6, P2-7/8), with status, owner (Marcus / Chris / Doug / counsel / IT), blocker, evidence link and date verified. Keep runbook item numbers stable (code comments cite items 5 and 8).
3. **Procedures** (or links) for the human gates: today's runbook content, pruned of completed history. The single 3a procedure lives here; remove the other 4 copies.
4. **Open engineering findings list**, deduplicated across PRR / LRR / RAG-REVIEW-09-16 / RAG-QUALITY-10-17 / backlog, with a status column and commit hashes for fixes.
5. **Operational gotchas** (current, not historical): port, sslmode table, set-ms-credentials not covering rag-web, sources not editable, delete cascades grants, resolve-siteid as auth canary, "verify connections not variables".
6. **Legal/process track** (QI, WISP, training, breach runbook, GLBA, CR-3), linking to compliance/.
7. **History appendix or archive pointer:** the purge, the "no client data" premise and why it was wrong, and the 2026-08-01 defects.

## Facts that must survive any merge

- **Source ids and corpus:** `dbba75e2-cecb-41be-8998-4f923158f741` (current SP source), `badac563-…` (purged), `b8e010f3-…` (manual uploads). 47-doc TRI-screened rebuild after the 858-doc purge (2026-08-03).
- **Tenant licence:** the SPO licence was lost after 2026-09-02. The error string is `Tenant does not have a SPO license`.
- **Gate 0:** the `GENERATION_TRI_POLICY=warn` decision (2026-09-07), with its measurement (33→51/51; 3 trigger docs; collateral mechanism), the revert path and the `client-data` override.
- **Gate 1/2/3 status:** Gate 1 verbal sign-off 2026-10-02 by Chris; written sign-off outstanding; GATE-1-CONTENT-AUDIT.md. Gate 2 not satisfied by Chris (it needs an attorney plus the carrier). Gate 3: volume backups, nightly pg_dump stopgap, off-Railway destination blocked, HEARTBEAT_URL unset.
- **Entra/web:** app reg id, RAG-Admins group id, group claims inline, user-consentable scopes, `static-fallback` must never be used, rag-web URL.
- **Teams/Azure:** the Teams bot needs an Azure subscription (F0 is free; the subscription is the obstacle), `BOT_OAUTH_CONNECTION_NAME`, single-instance MemoryStorage. Teams personal tab is an alternative.
- **Gotchas:** the sslmode node-postgres vs libpq table; the Railway PORT/domain-port gotcha.
- **Access/sync model:** access is keyed by source id in `API_PRINCIPALS` and `staff_source_assignments`; sources are immutable; repoint before purge.
- **Design decisions:** originals go in an object store (never bytea); download returns 404, not 403; migration 0002 was hand-authored to keep the HNSW/GIN indexes; D5 isolated-instance tenancy; H-2 contextualization rationale; H-1 OR-tsquery design (and why websearch_to_tsquery is not a fix).
- **Corpus pathologies:** twins, drafts, video-only procedures, calculators, a real client name in an SOP.
- **Measurement baselines:** self-retrieval 91.5% is a lexical floor; eval corpora are synthetic; GOLD_QUESTIONS is empty.
- **Process items:** the Chris iMessage provenance (2026-06-14); the process/legal items (QI, WISP, GLBA, breach runbook).
- **Inbound references to preserve or update:** env.example:644 and packages/core/src/config-schema.ts:221 (RUNBOOK items 5 and 8); README.md:77 (STATUS as status source; PLAN-* checkboxes are not status); documentation-review-artifacts sslmode review (stale line cites).

---

## Group 4-plan-docs

# Digest: group of 8 PLAN docs (3,949 lines, every line read)

**Inbound references from outside docs/: none for any of the 8 files.** A grep that excluded node_modules, dist, .next, .git, `.token-optimizer/` and `.worktrees/` returned zero hits. The only hits outside docs/ were tool caches (`.token-optimizer/wiki/*`) and stale worktree copies, so all inbound links come from other docs/ files (listed per file below).

---

## 1. PLAN-PILOT-READINESS-AUTOMATABLE.md | 1353 lines | TDD execution plan, 17 tasks

- **Audience:** agentic workers (superpowers:subagent-driven-development).
- **Status:** mostly done, with **real open items**. `PILOT-LAUNCH-STATUS.md:163` says "Complete". That is wrong for Task 16 and parts of Tasks 8, 11 and 17. Every checkbox is unchecked except 17.4.
- **What landed:**
  - T1 `classify-source.ts`, commit 67781c6. The pipeline fallback is now `?? "D"` (fail-closed), not the `?? "A"` the plan cites at `pipeline.ts:235`.
  - T3 f60b70d (the 64-char check is in `internal-scope-auth.ts`).
  - T4: MCP `channel:"mcp"` audit in `apps/mcp/src/tools/ask.ts:106` and `search-documents.ts:89`.
  - T5: monotonic guard at `migration-guard.test.ts:91`.
  - T6 8cec184. T7 6c10dd1 (`LOCAL_PROVIDER_MAX_CHUNK_SIZE=512`). T9 c481929 (0012). T10 1d9dbca. T12 ec50000 (`splitTableByRows`). T13 99bc917 (0013). T14 8192c45 (0014, `ship-audit-log.ts`). T15 50d8ec3 (`next.config.ts` plus `src/next.config.test.ts`, not an e2e test). T17.4 e285d89.
- **Done differently:**
  - T8: there is no `EVAL_EMBEDDER=local` flag. It became `pnpm eval:real` with `EMBEDDING_PROVIDER` (Gemini), commit c873211. `EVAL-BASELINE.md` exists.
  - T11: implemented as a `modified=` attribute in `prompt-context.ts`. The prompt says to treat dates as "evidence, not a verdict" (`generator.ts:76-78`), which **contradicts the plan's** "prefer the more recent document" rule at line 931.
- **OPEN:**
  - **T16 is not done.** These files do not exist: `packages/connectors/src/{gdrive,gmail,outlook}/index.test.ts` and `apps/api/src/routes/documents.test.ts`. The plan's `packages/runtime/src/index.test.ts` is also missing. `auth-chain.test.ts` partly covers `buildAuthProvider`, but the TLS-warning test is unverified.
  - T17.1: the rollback/forward-only text is not in `DEPLOYMENT.md`. Only a Railway image rollback at line 111 is there.
  - T17.3: alerting beyond Sentry is absent from `DEPLOYMENT.md`.
  - T2 (correcting the `ISSUES-AND-OPTIMIZATIONS.md` claims) and the final-phase cross-referencing into `CPA-READINESS-ASSESSMENT` were not verified.
  - T17.2 is done: `DEPLOYMENT-TARGET.md` is marked SUPERSEDED.
- **Unique facts worth keeping:**
  - Pre-assigned migration serialization: concurrent tasks each confirming "current highest" will collide (L15). The journal has no 0000 entry, so `idx = tag − 1` (L13).
  - Use `uuid_generate_v4()`, not `gen_random_uuid()`. pgcrypto is not installed, and the mismatch causes a spurious drizzle diff (L21).
  - The e2e `runOneIngestion` helper bypasses the worker handler. That is why the data-class gap went unnoticed (L22, L182).
  - The `client_confidential→C` (not D) mapping is provisional and not ratified (L85-92).
  - Secret minimum is 64, not 32: `openssl rand -hex 16` passes a 32-char check with only 128 bits (L268). The web BFF reads `INTERNAL_SCOPE_JWT_SECRET` straight from env, so the signing side must enforce the length itself (L270).
  - MCP audit: thread the full Principal (option a), not a scope-derived subject (option b) (L349). Stdio is admin with no subject, by design. The HTTP path authenticates twice (guard plus `scopeForRequest`); merging the two is a noted follow-up (L370).
  - Use a `staff_source_assignments` table, not a nullable-clientId sentinel, which would cross-grant (L664). Also add a standalone `source_id` index for the cascade, plus a negative isolation test for the UNION (L703).
  - The audit sink ships on a schedule with a cursor, not at write time. It must go through EgressPolicy. `HttpCrossEncoderReranker` (`reranker.ts:35`) **lacks an egress check, a pre-existing gap** (L114). The watermark is a single-row boolean-PK table.
  - The CSP gives no script-src/XSS protection; that would need per-request nonces (L1215). `middleware.test.ts` cannot test `next.config` headers (L1194).
  - `.dockerignore` must exclude `**/*.tsbuildinfo`. A stale buildinfo silently made tsc emit no JS (L1323).
  - The docs-gap digest stores aggregate counts only. Keeping question text is a policy decision, not a bug (L1021).
- **Overlaps:** `PILOT-MANUAL-RUNBOOK.md` (companion), `CPA-READINESS-ASSESSMENT-2026-07-08.md` (source), `PILOT-LAUNCH-STATUS.md` (status).
- **Staleness:** line numbers throughout (`pipeline.ts:148`, `queries.ts:840-852`, etc.) are stale. Migrations now run to 0021. L1228 `pnpm dev:web` is not a root script (root `CLAUDE.md` says to use `--filter @rag/web dev`). L1348 "chain through 0014" is outdated.
- **Inbound (docs only):** README.md:107, PILOT-LAUNCH-STATUS.md:475, PILOT-MANUAL-RUNBOOK.md:5,19,65,152,164,206,225, DOCUMENTATION-REVIEW-2026-08-03.md:122.
- **LLM-readability:** very long. Paste-ready code blocks now diverge from the real code. Status is only knowable from another doc.
- **Recommendation:** **archive.** First move the Task 16 / 17.1 / 17.3 open items to the live tracker, and move the design rationale listed above into a decisions doc.

## 2. PLAN-POST-MERGE-FOLLOWUPS.md | 672 lines | TDD plan, 5 tasks

- **Status:** completed/historical. The header says "COMPLETE re-verified 2026-07-13" and all boxes are checked.
- **Evidence:** commit 2f38bae (journal fix), migrations `0010_client_assignments_unique.sql` and `0011_audit_log_principal_subject.sql`, `parseMultiValueSecret` (`config.ts:77`), `Principal.subject` (`access-control.ts:49`), `ON CONFLICT (user_id, client_id)` (`queries.ts:1047`), `apps/web/src/middleware.test.ts`.
- **Unique facts:**
  - Drizzle runs entries by array/idx order, but **runs an entry only if `MAX(created_at) < entry.when`**. A non-monotonic `when` therefore makes migrations get silently skipped forever (L28, verified against drizzle-orm 0.45.2). `drizzle-kit generate` always stamps `Date.now()`, so the bug only comes from manual merge resolution (L29, commit c360db5).
  - Store the raw AAD oid in `audit_log`, not a hash, per CR-10. Identity is a different category from question content (L17, L43, L406).
  - Use JSON-array-or-CSV parsing for multi-value secrets. Do not change the delimiter, which would break deployed values (L42).
  - The TOCTOU test belongs in e2e against real Postgres. `queries.access-control.test.ts` is DB-free on purpose (L16).
  - The middleware is testable by calling it directly with a `NextRequest` and minting a cookie with `@auth/core/jwt encode()`. There is no Playwright infrastructure (L37).
  - `/api/auth` exemption uses an exact or child path match, not `startsWith` (L617).
- **Staleness:** cites `.superpowers/sdd/progress.md` (L3, L672), **which does not exist**. All line refs are stale.
- **Inbound:** README.md:106, CPA-READINESS-ASSESSMENT-2026-07-08.md:20.
- **Recommendation:** **archive.** Move the drizzle `when`-gating explanation into `rag-postgres-contracts` / `ARCHITECTURE.md` if it is not already there.

## 3. PLAN-PER-PAGE-REENQUEUE.md | 427 lines | phased plan with results sections

- **Status:** mostly done, but the header is stale. L5 still says "Ready to execute".
  - Phases 1–3 are complete in code: `updateQueue(... policy:"singleton")` (`queue.ts:113`), `SYNC_EXPIRE_SECONDS=1800`, `PAGES_PER_RUN=5`, `enqueueContinuation`, `MAX_SYNC_CONTINUATIONS`, marker `ingest.sync.failed` (`sync-source.ts`). Commits 0234159 and f57366c.
  - Phase 4 is partial: expiry and log marker done. There is no dead-letter queue and no health/admin surface for failed syncs.
  - **Phase 5 is not done:** `ARCHITECTURE.md` does not link the plan or the queue review, and `QUEUE-ARCHITECTURE-REVIEW.md:7,63` still says per-page re-enqueue is "unimplemented".
- **Unique facts (high value):**
  - Under pg-boss **10.4.2** with the default `standard` policy, `singletonKey` without `singletonSeconds` does **no dedup and no serialization**. The uniqueness indexes job_i1/i2/i3 are gated by policy (L357-369). Consequence: `SyncAlreadyRunningError` never fired before the policy change.
  - Under `singleton`, a duplicate external trigger is **queued, not rejected**. Whether to keep the "reject duplicate" contract (option B2, an app-level `running`-row guard) is an **undecided design question**. `services/sources.ts` still relies only on `SyncAlreadyRunningError` (L406-418).
  - `createQueue` is `ON CONFLICT DO NOTHING`, so policy cannot change through it. `updateQueue` is idempotent and reversible, with no drop/recreate (L390-404).
  - Counters are approximate under retries; do not claim crash-safety. Exact counts should come from COUNT over documents/chunks (L194-195).
  - `lastSyncedAt` is split from the cursor write, because MCP `trigger_sync` tells users to poll `lastSyncedAt` (L126).
  - Continuations skip `validate()` to avoid multiplying Graph auth calls N times.
  - Mixed-fleet rolling deploys are safe (L298-301).
- **Contradictions:**
  - Phase 3 step 6 (L198) and Rollback (L306) still say "irreversible drop/recreate". L390-404 refutes that.
  - L189-190 is a duplicated bullet.
  - L41 says `expireInHours: 6`, which is stale.
  - `PLAN-SHAREPOINT-READINESS.md:58` ("worker does NOT yet re-enqueue") and `:507,:535` are stale against the code.
- **Inbound:** PLAN-SHAREPOINT-READINESS.md:58,200,218,507,535; README.md:107.
- **Recommendation:** **merge into `QUEUE-ARCHITECTURE-REVIEW.md` / `ARCHITECTURE.md`** as a "queue semantics" section (the pg-boss policy findings, the singleton decision, counters, lastSyncedAt). Then archive. Carry forward the open B2 decision, the dead-letter/health surface and the doc linking.

## 4. PLAN-KB-SYNC.md | 292 lines | ops runbook for one SharePoint source

- **Status:** completed/historical ("COMPLETE — executed 2026-07-02"). Boxes are unchecked. Scripts `gen-tokens.sh`, `deploy_tokens.sh`, `resolve-siteid.sh` and `set-ms-credentials.sh` exist.
- **Unique facts:**
  - `folderPath` is relative to the drive root: use `"Knowledge Base"`, not `"Documents/Knowledge Base"` (L104).
  - Leaving out `driveId` enumerates every library on the site (L106).
  - Principals must be granted before the sync (L114).
  - The composite siteId format is checked with a regex (L70).
  - Rollback: DELETE source cascades documents and chunks (L279).
- **Staleness/contradictions:**
  - L221 and L244 send an `allowedSourceIds` body field. The API accepts `sourceIds` (`routes/ask.ts:29`), so these calls are wrong.
  - It uses the static `API_PRINCIPALS` token model. The web path now uses per-user Entra plus scope JWT plus `staff_*_assignments`.
  - Source UUID `b54dbd7b…` is probably stale given the later purge-and-re-sync (current branch is `docs/sharepoint-tenant-resync`). Not verified.
  - It embeds a production API URL (L28), a real `DRIVE_ID` (L36) and source UUIDs (L42-43). These are operational identifiers in the repo.
- **Inbound:** README.md:106, PLAN-CPA-COMPLIANCE.md:32,144 (which still calls this a "currently-live production issue", now stale).
- **Recommendation:** **archive.** Fold the folderPath/driveId gotchas into the `CONNECTORS.md` SharePoint section. A generic "add a SharePoint source" runbook belongs in `CONNECTORS.md` or `DEPLOYMENT.md`.

## 5. PLAN-FIVE-SYSTEMS.md | 302 lines | refactor plan, 6 phases

- **Status:** completed/historical. All phases committed: 78aa9d0, c9279ce, 98d6166, f1ee05e, 4e49f1e, plus 3950c37 per the resume doc. Present: `packages/services`, `packages/runtime`, `core/validation.ts`, `core/auth.ts` (single `timingSafeEqual`), `toPublicSource` (`queries.ts:509`), `util/cursor.ts`, `util/paginate.ts`, `parser-types.generated.ts`, root `gen:parser-types`. `ARCHITECTURE.md:83-91` already documents services/runtime and the single-writer rule. `createIngestionJob` is only in `packages/services` / `db`.
- **Unique rationale:**
  - "Prefer deletion over abstraction" (L5).
  - `buildCoreDeps` lives in `@rag/runtime`, not core, to avoid a core→db cycle (L135-138).
  - No BaseConnector, no DI container, no `withGeneration` flag. No runtime Zod check of parser output (deliberately deferred, L75).
  - MCP keeps its Origin allowlist and zero-token refusal as browser-threat defenses (L181).
  - `done` semantics follow Outlook's feed-exhaustion approach, decoupled from zero-document pages (L245).
- **Contradiction:** L69 says `enqueueSync` "throws when pg-boss returns falsy (duplicate)". That never fired under the standard policy (see #3).
- **Inbound:** README.md:106, PLAN-LAUNCH-READINESS.md:437, PLAN-FIVE-SYSTEMS-RESUME.md:4.
- **Recommendation:** **archive.** Move the rationale above (runtime placement, no-abstraction rules, MCP security extras, `done` semantics) into an ARCHITECTURE "design principles/decisions" section.

## 6. PLAN-FIVE-SYSTEMS-RESUME.md | 157 lines | session resume notes

- **Status:** junk/historical. It says "ALL PHASES COMPLETE 2026-06-10". The rest is branch-checkout instructions for a local-only branch, Colima setup and a historical TL;DR.
- **Unique:** almost nothing. Gotchas: `pnpm test` failed on packages with no tests (L153, likely obsolete), and `package-lock.json` was a spurious npm lockfile (L157).
- **Contradictions:** L46-48 (historical TL;DR) contradicts L30-40 inside the same doc.
- **Inbound:** PLAN-LAUNCH-READINESS.md:437.
- **Recommendation:** **delete**, or archive alongside #5.

## 7. PLAN-CHAT-FRONTEND.md | 351 lines | phased UI plan derived from #8

- **Status:** implemented, then superseded in places.
  - `POST /ask/stream` (`routes/ask.ts:223`), `answerStream` for both providers (`generator.ts:347,491`), `apps/web` with BFF routes `api/{chat,documents/[id],sources,upload,feedback,health,auth}`, PropelAuth removed, ephemeral sessions hook (`use-chat-sessions.tsx:15-16`).
  - Upload was done as option (a): `POST /sources/:id/documents` (`sources.ts:211`).
  - **No `GET /documents` list endpoint** (source list only).
  - **No CORS / `API_ALLOWED_ORIGINS`.**
- **Superseded by:**
  - Per-user Entra SSO (next-auth 5 `MicrosoftEntraID`) plus `INTERNAL_SCOPE_JWT_SECRET` per-user scope tokens. This replaces the static `RAG_API_TOKEN` (L184) and "no per-user login".
  - Conversation history sent to `/ask`, per `superpowers/plans/2026-08-01-reranking-and-conversation-memory.md`. That plan explicitly cites this doc's L10/L237 ephemeral decision.
- **Unique facts:** sessions are deliberately ephemeral, with no DB or localStorage (L10, L237). Upload has to be validated at both the BFF and the API, and the client's MIME type is not trusted (L304-310). An unfinished upload means the modal is hidden, never a dead button (L287).
- **Staleness:** paths `/Users/marcus/dev/...` (L77) are wrong; the real path is `/Users/marcusklein/dev`. Line refs into #8 (L161, L192, L285) are stale.
- **Inbound:** README.md:107, superpowers/plans/2026-08-01-reranking-and-conversation-memory.md:98,209.
- **Recommendation:** **archive.** Move the ephemeral-session decision (and the fact that it was later revised) and the upload-validation rules into `apps/web/CLAUDE.md` or a decisions doc.

## 8. PLAN-LIVE-DEPLOY-AND-CHAT-UI.md | 395 lines | phased deploy plus UI plan, with "locked decisions"

- **Status:** largely implemented, partly superseded.
  - Done: Dockerfiles `apps/{api,worker,mcp}/Dockerfile` and `.dockerignore`, Railway deploy, SharePoint live, streaming, `apps/web`.
- **Open:**
  - **Phase 3.5 scheduled incremental sync does not exist.** The only pg-boss schedules are the docs-gap digest and audit shipping, and there is no Railway cron.
  - CORS (Phase 4.1) was never added.
- **Superseded:**
  - "No per-user login / static BFF token" (L14-15, L85, L302) was replaced by Entra SSO.
  - "Managed Postgres + pgvector" was replaced by `postgres-ssl:16.14` with pgBackRest (root `CLAUDE.md`).
  - Migrations run as a `rag-worker` preDeploy step, not a one-off job (L163).
  - "Upload out of scope" (L341) was reversed by #7.
  - "MS creds on rag-api + rag-worker" (L195): PLAN-KB-SYNC says worker only.
- **Unique facts:**
  - `cpa-backend` (Express/Mongo/Vespa) is superseded and must not be ported. Its session-CRUD and S3-presign route shapes are a reference only (L87-93).
  - SharePoint creds are global env, not per-source. Config is validated at sync time, not create time (L223-226).
  - `PARSER_SECRET` is mandatory once the parser is reachable over the network (L180).
  - Sync is an ops action and never triggered from the UI with an admin token.
- **Staleness:**
  - L6 and L78 use `/Users/marcus/dev` paths.
  - L37-43 ("no Dockerfiles") was true before the work and is false now.
  - L207 assumes `singletonKey` gives a 409 on overlap. False (see #3).
- **Inbound:** README.md:107, PLAN-CHAT-FRONTEND.md:4,161,192,285, PLAN-PILOT-READINESS-AUTOMATABLE.md:1315, DECISION-CPA-KB-RAG-CONVERGENCE.md:19.
- **Recommendation:** **archive.** Move the locked-decision table (with a superseded annotation on each row) and the cpa-backend "do not port" note into a decisions doc. Track scheduled incremental sync as open.

---

## GROUP SECTION

### Still-open items (deduplicated)

1. **Test-coverage gaps (PILOT T16, L1256-1301):** no unit tests for the gdrive/gmail/outlook connectors (pagination, cursor, errors); no tests for `GET /documents/:id` and `/download` (including 404-not-403 behaviour and the byte stream); no `buildCoreDeps` production-TLS-warning test. `PILOT-LAUNCH-STATUS:163` wrongly says "Complete".
2. **Rollback / forward-only migration procedure** is missing from `DEPLOYMENT.md` (PILOT T17.1, L1313).
3. **Alerting beyond Sentry** is unaddressed (PILOT T17.3, L1317; PER-PAGE Phase 4 S3: no dead-letter queue and no failed-sync health/admin surface, L269-271).
4. **Duplicate-trigger contract:** under the singleton policy a second trigger is queued, not rejected. Either accept that or add a `running`-row guard in `triggerSync` (PER-PAGE L413-418). Undecided.
5. **Doc linking:** `QUEUE-ARCHITECTURE-REVIEW.md` still says S1 is unimplemented, and `ARCHITECTURE.md` does not link the queue decision (PER-PAGE Phase 5, L314-316).
6. **Scheduled incremental SharePoint sync** does not exist (LIVE-DEPLOY Phase 3.5, L204-207).
7. **CORS / `API_ALLOWED_ORIGINS`** was never added (LIVE-DEPLOY L238, CHAT-FRONTEND L118). It is optional under the BFF model, so close it as won't-do or keep it.
8. **`GET /documents` list endpoint** does not exist; the UI shows sources only (CHAT-FRONTEND L252-254).
9. **Double authentication on the MCP HTTP path** (guard plus `scopeForRequest`); consolidation is a noted follow-up (PILOT L370). Not verified as resolved.
10. **The reranker egress gap:** `HttpCrossEncoderReranker` makes no EgressPolicy check (PILOT L1114). Worth checking against current code.
11. **`client_confidential→C` vs D mapping** still needs ratification (PILOT L85-92, runbook item 9).
12. **CSP covers no script-src/style-src** (nonce-based CSP is out of scope) (PILOT L1215).

### Design rationale to keep in a permanent ARCHITECTURE/DECISIONS doc

- **Drizzle journal:** an entry runs only if `MAX(created_at) < when`, so a non-monotonic `when` means a silent permanent skip. `generate` always stamps `Date.now()`. The journal has no 0000 entry, so `idx = tag−1`. Migrations that run in parallel must be numbered up front. Use `uuid_generate_v4()`, not `gen_random_uuid()`.
- **pg-boss 10.4.2:** `singletonKey` does nothing under the `standard` policy. Use `policy:"singleton"` through `updateQueue`, which is reversible with no drop/recreate. Per-page continuation is bounded by `PAGES_PER_RUN=5` and `MAX_SYNC_CONTINUATIONS`, and stops if the cursor does not advance. Counters are approximate. `lastSyncedAt` is stamped only on the final page. Continuations skip `validate()` to protect the Graph quota.
- **Layering:** `@rag/runtime` is separate from core to avoid a cycle. Prefer deletion over abstraction (no BaseConnector, DI container or flags). MCP keeps its Origin allowlist and zero-token refusal. `done` means feed exhaustion.
- **Audit/privacy:** never store question text (hash only). Store the raw AAD oid as `principalSubject` (CR-10). MCP audit carries the full Principal. Stdio is admin with no subject. Audit shipping is scheduled with a cursor and gated by EgressPolicy. Docs-gap digest stores aggregate counts only.
- **Access model:** `staff_source_assignments` sits alongside the client-routed grants (no sentinel rows). Use UNION, plus a negative isolation test.
- **Secrets:** at least 64 hex characters, enforced on both the verify side and the signing side. Multi-value secrets parse as JSON array or CSV.
- **Security headers:** clickjacking and transport protection only. `.dockerignore` must exclude `*.tsbuildinfo`.
- **Chat:** BFF only, with no token in the browser. Sessions were ephemeral by decision; conversation history was added later. Upload is validated at both the BFF and the API. `cpa-backend` is not to be ported.

### Contradictions across docs

- `PILOT-LAUNCH-STATUS.md:163` ("17-task plan Complete") vs the missing Task 16 test files.
- PILOT T11 plan ("prefer the newer document", L931) vs the code ("dates are evidence, not a verdict", `generator.ts:76-78`).
- `PLAN-SHAREPOINT-READINESS.md:58` ("worker does NOT yet re-enqueue") and `QUEUE-ARCHITECTURE-REVIEW.md:7,63` vs the implemented continuation in `sync-source.ts`.
- FIVE-SYSTEMS L69 and LIVE-DEPLOY L207 (`singletonKey` dedup gives a 409) vs PER-PAGE L365 (it is inert under `standard`).
- PER-PAGE L198 and L306 ("irreversible drop/recreate") vs the same doc's L390-404 (`updateQueue` is reversible).
- LIVE-DEPLOY and CHAT-FRONTEND "no per-user login, static scoped `RAG_API_TOKEN`" vs the shipped Entra SSO plus `INTERNAL_SCOPE_JWT_SECRET` per-user tokens.
- CHAT-FRONTEND L10 (ephemeral sessions) vs the later conversation-history support (`ask.ts` `history`).
- LIVE-DEPLOY L341 (upload out of scope) vs CHAT-FRONTEND Phase 6 and the shipped `POST /sources/:id/documents`.
- PLAN-KB-SYNC L221 and L244 (`allowedSourceIds` body field) vs the API's `sourceIds`.
- `PLAN-CPA-COMPLIANCE.md:32,144` still calls the KB-SYNC issue "currently-live".
- POST-MERGE (L3, L672) and PILOT cite `.superpowers/sdd/progress.md`, which does not exist.
- Hard-coded `/Users/marcus/dev` paths: LIVE-DEPLOY L6, L78, L87; CHAT-FRONTEND L77. The real path is `/Users/marcusklein/dev`.

### Recommendation summary

- Archive: PILOT-READINESS-AUTOMATABLE (after moving the open items out), POST-MERGE-FOLLOWUPS, KB-SYNC, FIVE-SYSTEMS, CHAT-FRONTEND, LIVE-DEPLOY-AND-CHAT-UI.
- Delete: FIVE-SYSTEMS-RESUME.
- Merge then archive: PER-PAGE-REENQUEUE, into `QUEUE-ARCHITECTURE-REVIEW` / `ARCHITECTURE`.
- None of the 8 should stay live as-is. The rationale above is the only content worth carrying forward.

---

## Group 5-cpa-compliance

# Digest: CPA compliance and governance doc group (15 files, 3,616 lines, every line read)

**Verification method.** I grepped code under packages/ and apps/, checked env.example, git log and gh, and checked that cross-referenced docs exist. The outside-docs/ inbound-reference grep excluded node_modules, .git, dist, .next and worktrees.

**Cross-cutting findings to act on first:**

1. **Dangling tracking issue.** `GATE-1-CONTENT-AUDIT.md:230` says the gate's open items are "tracked in issue #82, not waived". `gh issue view 82` and `gh pr view 82` both fail: no such issue or PR exists. The only issue on the repo is #62. So the "not waived" claim has no tracker behind it.
2. **Missing docs that are still cited.** These are referenced but do not exist in the repo:
   - `docs/RAG-VALIDATION-REPORT.md`, cited by the readiness assessment.
   - `docs/PLAN-P0-GATES-EXECUTION.md`, cited by the readiness assessment.
   - `docs/compliance/VENDOR-REGISTER.md`, required by CR-9.
   - `docs/compliance/BREACH-IR-RUNBOOK.md`, required by CR-16/17.
   - `~/dev/cpa-consulting/docs/_meta/plans/2026-07-04-rag-system-reconciliation-and-priorities.md`.

   `~/dev/cpa-consulting/docs/rag/compliance-scope.md` does exist.

3. **Leftover from the client-name redaction (commit 82acfe0).** Placeholder text such as "the operating tenant" was left in prose. Examples: `CPA-READINESS-ASSESSMENT-2026-07-08.md:1` (the title) and `PLAN-CPA-COMPLIANCE.md:31`. Partner first names (Chris, Doug) are still present throughout.

---

## Per-file

### 1. CPA-COMPLIANCE-REQUIREMENTS.md

- **Lines / type:** 84 · reference (regulatory requirements catalog). It is the root of the CR-1..CR-20 control matrix.
- **Audience:** engineers, counsel, the Qualified Individual (QI).
- **Status:** current as a requirements catalog, dated 2026-06-08. It holds no implementation status.
- **Summary:**
  - Under §7216, sending taxpayer return information (TRI) to any external embedding/LLM/vector DB is a disclosure. There is no AI carve-out and, as of 2026-06, no IRS guidance.
  - The auxiliary-services exception (26 CFR §301.7216-2(e)) likely does not cover a general-purpose LLM. The consent path (Rev. Proc. 2013-14) is heavy.
  - Chosen path: self-host embeddings, and use a US-region enterprise LLM under a DPA with no-train and zero-retention terms.
  - The CR-1..20 table maps each requirement to a control and a verification step.
  - Requirements are tiered: mandatory before client data, within 90 days, and nice-to-have.
  - There is a list of counsel gaps and a source list.
- **Unique facts:**
  - Penalties: §7216 criminal $1,000 or 1 year per violation ($100k with an identity-theft predicate); §6713 civil $250 per disclosure, capped at $10k per year.
  - Embedding vectors derived from TRI are treated as TRI.
  - CR-10 requires ≥3-year log retention.
  - FTC breach notice is due within 30 days when 500+ consumers are affected (effective 2024-05-13).
  - Pen-testing exemption applies under 5,000 consumer records.
  - The mandatory-before-client-data set is CR-1, 4, 5, 6, 7, 8, 12, 13, 16, 18.
  - Four counsel gaps: DPA sufficiency, an aux-exception legal opinion, state laws (CCPA, NY SHIELD), and the final text of the proposed Circular 230 tech-competence rule.
- **Overlaps:** The §7216 framing is restated in IMPLEMENTATION-SPEC §1 and PLAN-CPA-COMPLIANCE.
- **Contradictions / staleness:**
  - L43 names PropelAuth for MFA. The shipped web app uses Entra ID.
  - L40 says "Marcus has no prod TRI access without explicit grant". That is unimplemented (the operator holds an `isAdmin` principal).
  - PLAN-CPA-COMPLIANCE §0.3 updates L67's pen-test note: "consumer" counts cumulatively, including former clients.
- **Inbound refs outside docs/:** none.
- **LLM-readability:** good, but the very wide table cells are hard to parse.
- **Recommendation:** **keep**, as the canonical requirements source. Fold in PLAN-CPA-COMPLIANCE §0.3's 2026 regulatory updates (OPR Alert 2026-19, cumulative consumer count, the state 30-day rule) and remove PropelAuth.

### 2. CPA-KB-ADOPTION-PLAN.md

- **Lines / type:** 380 · plan, in 9 phases.
- **Audience:** the implementing engineer or agent.
- **Status:** superseded / historical. Most phases have shipped or diverged.
- **Summary:**
  - Decision of 2026-06-07: adopt rag-system, salvage the cpa-knowledge-base UI, retire cpa-backend, and add Teams and SMS adapters.
  - Phases: (0) discovery; (1) merge access control (ACL) and PII handling from a worktree and add identity→scope mapping; (2) index-drift, dimension guard, parser auth; (3) eval harness; (4) reranking; (5) chat-session tables and stateful `/sessions` endpoints; (6) BFF web client; (7) Teams and SMS; (8) compliance gate; (9) decommission.
- **Unique facts:**
  - cpa-backend findings: embeddings never persisted, no search endpoint, zero tests.
  - SMS design: restricted to non-confidential sources, a phone allowlist, Twilio Verify, and an audit of every query.
  - Teams must be single-tenant (multi-tenant bot registration was deprecated 2025-07-31).
  - Session schema: `chat_sessions(channel, external_user_id)`, `chat_messages`, `message_citations`, `chat_audit_log`.
  - Proposed endpoints: `POST /sessions`, `/sessions/:id/messages`, purge.
  - Proposed AES-256-GCM on `chat_messages.content`, plus RLS.
- **Overlaps:** IMPLEMENTATION-SPEC phases B–J defer to this plan's phases 1–9 for detail. It is heavily interlocked with `AUTH-AND-SESSIONS-RESEARCH.md`.
- **Contradictions / staleness:**
  - L33–35 use paths under `/Users/marcus/dev/...`. The user's home is `marcusklein`.
  - L60–66: access control is "ON A BRANCH, NOT main". It has been merged; the governance plan L122 calls this stale.
  - L41–56: the API/MCP surface and line numbers are stale. There are now `/ask/stream`, `purge_source`, documents download, and more.
  - L252: PropelAuth. The shipped web app uses Entra.
  - Phase 5 is not built: `apps/web/src/hooks/use-chat-sessions.tsx:15` reads "Ephemeral, in-memory… No persistence", and there are no `chat_sessions` in the code.
  - Phase 7: a Teams bot exists (`apps/teams-bot`). SMS/Twilio does not.
  - Phases 1–4 are effectively done. Phase 2's three items shipped: index-assert, `PARSER_SECRET`, dimension guard.
  - L218 refers to a "decision B0", which is not defined anywhere in this doc.
- **Inbound refs outside docs/:** only `documentation-review-artifacts/2026-09-07-sslmode-docs-review.md`.
- **LLM-readability:** stale file:line citations presented as "verified" are a trap.
- **Recommendation:** **archive.** Before archiving, extract the still-unbuilt designs (SMS restrictions, session-store schema, transcript encryption/RLS) into a single backlog/design doc.

### 3. CPA-KB-IMPLEMENTATION-SPEC.md

- **Lines / type:** 284 · plan/spec. Self-marked HISTORICAL since 2026-08-03.
- **Audience:** engineers.
- **Status:** superseded by `PILOT-LAUNCH-STATUS.md`, `plans/2026-06-26-launch-readiness-consolidated.md` and `superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md` (all three exist). Its banner says the FR/NFR catalog and the "§7216 shapes the architecture" framing are still valid.
- **Summary:**
  - Defines a TRI-egress-zero architecture: self-hosted embedder, DPA-covered US LLM, and allow-listed egress with TRI scanning.
  - Catalogs FR-1..8 and NFR-1..4.
  - Includes an ASCII target architecture.
  - Phases A–J interleave compliance controls with the adoption plan.
  - Final verification checklist and a critical-path diagram.
- **Unique facts:**
  - FR-1..8 and NFR-1..4. FR-8: every channel goes through governed `/ask` and MCP. NFR-1: a single Postgres.
  - Phase G human-in-the-loop design: non-dismissible disclaimer, a review queue, "Draft — requires practitioner review" labels, no client→AI path.
  - Phase H: config refuses client-data mode without DPA plus §7216 acknowledgment.
  - Estimate: "multi-month build for one or two engineers".
- **Overlaps:** It duplicates ADOPTION-PLAN phases and the COMPLIANCE-REQUIREMENTS matrix.
- **Contradictions / staleness:**
  - The banner corrects L43 ("local currently throws").
  - L139: the "DPA stored; refuses boot without it" check is file-existence only (`config.ts:156-167`).
  - L182: the off-host SIEM is built as an `AUDIT_SINK_PROVIDER` webhook, but it is unset in production.
  - L99 and L168: PropelAuth.
- **Inbound refs outside docs/:** only the sslmode review artifact.
- **LLM-readability:** the banner works. The body still uses imperative "must" language that an agent could act on.
- **Recommendation:** **merge** FR/NFR and the human-in-the-loop design into the consolidated requirements doc, then **archive** the rest.

### 4. CPA-READINESS-ASSESSMENT-2026-07-08.md

- **Lines / type:** 177 · review/audit, with an in-place priority tracker rewritten 2026-07-11 and later annotations (2026-08-01).
- **Audience:** Marcus, and for go/no-go on the pilot.
- **Status:** completed/historical, with partially stale tracker sections.
- **Summary:**
  - Reconciles the 2026-07-04 reconciliation against `main@b5271e3`.
  - Found then that the sourceDocClass gate was unwired and MCP audit logging was missing.
  - Lists new findings across RAG quality, security, deploy, tests and functional completeness against partner promises.
  - §5 is a P0–P3 list, later marked mostly DONE.
- **Unique facts:**
  - The 512-token truncation bug (fixed; now in CLAUDE.md).
  - Citation filter missed `[1, 2]`/`[1-3]` (fixed 2026-08-01).
  - Correction that `websearch_to_tsquery` ANDs too; the fix was an OR tsquery. 5 of 15 SOP questions had zero sparse matches.
  - The flat RRF sweep under FakeEmbedder.
  - Scope JWT secret raised to ≥64 hex characters (verified at `config-schema.ts:131`).
  - `WEB_AUTH_MODE=static-fallback` bypass is a P0 config check.
  - Gaps against partner promises: citation fields from `kb-design.md` §6 missing; no dynamic `scope_caption`.
  - `staff_source_assignments` was added (verified at `schema.ts:585`).
  - `.dockerignore` tsbuildinfo bug.
  - Drizzle migrator watermark-skip behaviour on the local dev DB.
  - Tests: three connectors had no tests; `purge_source` authorization test added.
- **Overlaps:** PROTOTYPE-READINESS-REVIEW-2026-08-01, PILOT-MANUAL-RUNBOOK, ISSUES-AND-OPTIMIZATIONS.
- **Contradictions / staleness:**
  - L1 title carries the redaction leftover.
  - L3 and L135 cite missing docs (see cross-cutting finding 2).
  - L25 and L60: "PROVISIONAL" DPA status. Since 2026-08-04 it reads "BILLING VERIFIED".
  - L26 cites `env.example:259`. It is now `:428`.
  - L97: "raw Docker Postgres image". Production now runs postgres-ssl with pgBackRest (per CLAUDE.md).
  - Items 1, 3, 5 and 13 are still open human actions.
- **Inbound refs outside docs/:** none.
- **LLM-readability:** very long cells, and layered correction callouts mixed with original text make current state hard to extract.
- **Recommendation:** **keep-immutable** as a dated audit record, but **freeze** it. Strip or relocate the living §5 tracker to the status doc. A historical banner pointing to `PILOT-LAUNCH-STATUS` is needed.

### 5. DECISION-CPA-KB-RAG-CONVERGENCE.md

- **Lines / type:** 116 · decision record, dated 2026-06-23, Accepted.
- **Audience:** new contributors.
- **Status:** current as a decision. Its §5 premise was falsified (annotated 2026-08-03).
- **Summary:**
  - cpa-knowledge-base is deprecated; `rag-system/apps/web` is the combined product; cpa-backend is to be retired.
  - Platform comparison score 6.9 vs 2.0.
  - Lists the remaining hardening work.
  - Records the falsified "client data lives in Onvio, so §7216 is not a launch gate" premise, with a correction: 858 documents, including one spreadsheet with 522 SSN-shaped values.
- **Unique facts:**
  - Tax-season build freeze runs Jan 15–Apr 15. The implementation window is May–Sep. This is not found in the other group docs.
  - Weighted comparison score.
  - Both `app-comparison` copies were byte-identical.
- **Overlaps:** It ratifies the ADOPTION-PLAN decision.
- **Contradictions / staleness:**
  - L68–70: chat sessions are still ephemeral (still true).
  - L73: "single-VM per-tenant target" is superseded by Railway.
  - L75: PropelAuth stripped (consistent).
- **Inbound refs outside docs/:** none.
- **LLM-readability:** good.
- **Recommendation:** **keep-immutable** as a record of decision, with the existing correction kept. Optionally move it to a `decisions/` folder.

### 6. PLAN-CPA-COMPLIANCE.md

- **Lines / type:** 528 · plan, plus a control-status tracker. Authored 2026-07-03, with status callouts through 2026-09-07.
- **Audience:** engineers and counsel.
- **Status:** partially stale. It is still the de facto canonical compliance plan; the sslmode review named its Phase 3 the single source of truth for the TLS explanation.
- **Summary:**
  - §0.1 audits CR-1..20 status as of 2026-07-03.
  - §0.2 explains how the TRI scanner and egress policy work.
  - §0.3 covers 2026 legal research.
  - Phase 1: DPA and embedding path. It holds the 2026-07-04 exception record: `EGRESS_ALLOWED_HOSTS` was enabled before DPA verification, for an internal demo; `client-data` mode was attempted and reverted.
  - Phase 2: web auth. Phase 3: encryption (CR-7 closed 2026-09-07). Phase 4: retention and audit hardening. Phase 5: vendor register and breach runbook. Phase 6: org items. Phase 7: growth triggers. Final: counsel gate.
- **Unique facts (legal research and incident record, found nowhere else in this group):**
  - IRS OPR Alert 2026-19 (June 24–26, 2026), including a new billing-transparency duty.
  - Circular 230 REG-116610-20 is still proposed.
  - 16 CFR §314.2(b)(1): "consumer" includes those who "has obtained" a service, so the count is cumulative.
  - CA SB 446 30-day rule effective 2026-01-01; CO, FL and WA are also 30-day states.
  - Pub 5708 contents list.
  - nomic-embed-text-v1.5 is 768-d, so it needs no migration.
  - libpq rejects `no-verify`; `pg_dump`, `psql` and restore need `require`.
  - The 2026-07-04 user-authorized exception.
  - The `.dockerignore` excluded `docs/compliance` (fixed).
  - Anti-pattern: do not invent a region-pinning network check.
- **Overlaps:** the scope-conformance matrix, IMPLEMENTATION-SPEC, and the readiness assessment.
- **Contradictions / staleness:**
  - §0.1 table L45–64 is the 2026-07-03 snapshot and is largely outdated.
    - CR-5 "web UI has no per-user auth; `resolveSourceIdsForUser` dead code" — fixed in PR #31 and production-enforced 2026-10-02.
    - L49 has the typo "resolveSourceIsForUser".
    - CR-2 "no such file currently exists" — the DPA file now exists.
    - CR-10 "logs live in same Postgres" — a shipper exists but is unset in production.
    - CR-20 "no backup/restore" — BACKUP-RESTORE-DRILL proves restore works.
  - Phase 1 header L144–145: "/ask 500ing right now" (resolved).
  - L162 says TRI protection rests solely on the allow-list. Since then the corpus was purged, plus ingest gates and `GENERATION_TRI_POLICY=warn` in production.
  - Phase 1.3 `defaultCheckDpa` content validation is **not done**: `config.ts:161-167` still checks file existence only.
  - Phase 4 is not built: no `RETENTION_YEARS`, no retention job, no purge logging, no anomaly alerting. Only the off-host shipper mechanism exists, unset in production.
  - Phase 5 artifacts do not exist.
  - Phase 3 item 4 (reject `http://` in production) was not found in code.
  - L365 and L519 still contain "Phase 7" deferrals and the 2026-07-03 CR-14 reasoning.
- **Inbound refs outside docs/:** the sslmode review artifact only.
- **LLM-readability:** the snapshot table gives no "as of" warning on each row.
- **Recommendation:** **rewrite** into (a) a living control-status register (CR × status × evidence × date) and (b) a remaining-work plan. Preserve §0.3 legal research and the 2026-07-04 exception record verbatim, either in an evidence or decisions log.

### 7. PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md

- **Lines / type:** 586 · plan in 5 phases, dated 2026-07-05.
- **Audience:** implementing agent.
- **Status:** completed/historical for Phases 1–4. Phase 5 is partial.
- **Summary (four briefing-derived gaps):**
  - Phase 1: `/sources` authorization (API and MCP).
  - Phase 2: content-type taxonomy (`content_type`, `owner_id`, `lifecycle_status`).
  - Phase 3: `/search` audit parity (`endpoint`, `topScore`).
  - Phase 4: weekly docs-gap digest via pg-boss schedule.
  - Phase 5: archive filter in `hybridSearch` plus a staleness sweep.
- **Verified in code:**
  - P1: `POST /sources` admin-only with 403 (`apps/api/src/routes/sources.ts:68-80`, which cites this doc); `registerListSources(server, deps, scope)` at `apps/mcp/src/server.ts:98`.
  - P2: `contentTypeEnum` (`schema.ts:65`), migration `0008_document_governance.sql`.
  - P3: `topScore` (`schema.ts:404`), migration `0009_search_audit_parity.sql`.
  - P4: `docs-gap-digest` handler, `rag.docs_gap_digest`.
  - P5: the archive filter exists (`hybrid-search.ts:169,397`, `lifecycle_status='active'`, shipped 2026-10-02 per GATE-1). **No `lastReviewedAt` and no staleness sweep job** (grep finds none; jobs are `sync_source`, `docs_gap_digest`, `ship_audit_log`).
- **Unique facts:**
  - The `upsertDocument` explicit SET-list invariant, so governance columns survive re-sync (now commented at `queries.ts:179-182`).
  - `DataClass` (legal) and `ContentType` (librarian) must never be conflated.
  - `questionHash`-only privacy design for the digest.
  - Out-of-scope list from the briefing: Karbon/Carbon time tracking, an AI QA layer, pod structure.
  - Revision-note banner corrects the claim about the briefing's location: it is `~/dev/cpa-consulting/docs/marcus-onboarding/CPA_Firm_Operations_Consultant_Briefing.md`. `CPA-CONSULTING-PLAN-REVIEW.md` is not found.
- **Overlaps:** READINESS §5 items 9 and 17; the GATE-1 §3 lifecycle filter.
- **Contradictions / staleness:**
  - L226–228 anti-pattern "no admin UI, log line only" was later reversed: `docs_gap_digest_runs` table and `/admin/docs-gap-digest` page (per READINESS L118).
  - L519 targets `queries.ts:296-359`; retrieval now lives in `hybrid-search.ts`.
  - L16 says `docs/CPA_Firm…`, which is wrong; the banner corrects it.
- **Inbound refs outside docs/ (code depends on this doc as rationale):**
  - `env.example:575`
  - `packages/core/src/config-schema.ts:428`
  - `packages/db/src/schema.ts:61`
  - `packages/db/drizzle/0008_document_governance.sql:2`
  - `packages/db/drizzle/0009_search_audit_parity.sql:2`
  - `apps/api/src/routes/sources.ts:72`
  - `apps/api/src/routes/audit-log.test.ts:16`
  - `tests/e2e/src/specs/{governance-taxonomy,audit-log-parity,docs-gap-digest}.spec.ts`
- **LLM-readability:** good structure, but long.
- **Recommendation:** **archive in place, or move with redirects** — the path must survive or the 10 code comments must be updated. Add a status banner: P1–4 done, P5 archive filter done, staleness sweep unbuilt. Move the unbuilt sweep to the backlog.

### 8. compliance/README.md

- **Lines / type:** 77 · reference/how-to for the compliance artifact directory and the DPA template.
- **Audience:** operators and engineers.
- **Status:** current, with a stale line reference.
- **Summary:**
  - Conformance-record convention: `scope-conformance-<date>.md`; supersede by adding a new file, never edit an old one.
  - The DPA boot check matches `vendor-dpa-<vendor>.md` only.
  - Lists 8 required DPA fields, a template, and activation env.
- **Unique facts:**
  - The naming and immutability convention.
  - Conformance records do NOT satisfy the boot check.
- **Contradictions / staleness:**
  - L17 cites `config.ts:778-782`. The actual code is `config.ts:161-167` (`defaultCheckDpa`) and `:428-440` (throw).
  - L19–22 implies the 8 fields are validated. Only file existence is checked.
  - The activation block omits client-data's other hard requirements: `CONTENT_SCAN_PROVIDER≠none`, pre-warmed weights, durable `HF_CACHE_DIR` (CLAUDE.md L119).
- **Inbound refs:**
  - `env.example:423-436`
  - `CLAUDE.md:119`
  - `.dockerignore:38-45`: `docs/compliance/*.md` is copied into images, so this directory is runtime-load-bearing.
  - `packages/core/src/config-schema.ts:143,419`
  - `packages/core/src/config.ts:436` (error message points to this README)
  - `tests/e2e/src/env.ts:15`
- **Recommendation:** **keep**, but fix the line reference, state "existence-only check", and list all four client-data boot requirements. The **directory must not be moved or renamed**: the boot check, the Dockerfile copy and `.dockerignore` depend on it.

### 9. compliance/GATE-1-CONTENT-AUDIT.md

- **Lines / type:** 253 · runbook/procedure plus compliance evidence (sign-off record), dated 2026-10-02.
- **Audience:** reviewers (Chris, Doug), the operator, and counsel.
- **Status:** current. Gate 1 is treated as satisfied on Chris's verbal sign-off of 2026-10-02. Four definition-of-done boxes are open.
- **Summary:**
  - Gate 1 asks whether all 47 documents may be exposed to all staff.
  - Machine-measured facts come from a restored copy of the `2026-10-01T080156Z` backup.
  - Procedure: generate the worksheet with `scripts/gate1-content-audit.mjs`; verdicts are OK, WITHDRAW or ASK.
  - Enforcement shipped: `lifecycle_status` filter post-RRF, plus re-sync immutability.
  - Residual risk: a re-sync re-imports purged material because cursors are intact and ingest content gates are "unbuilt". Standing instruction: do not re-sync.
- **Unique facts:**
  - Corpus measurements: 47 documents, 210 chunks, 1 source, 0 SSN/EIN in bodies or titles, 9 documents naming an IRS form, `content_type` NULL on all 47.
  - Production DB is unreachable outside Railway, by design.
  - The worksheet must never be committed; it is gitignored as `gate1-audit-*.md`.
  - PR #43 / `check-file-sizes.mjs` "300 checked, inspected nothing" cautionary tale.
  - Five e2e specs in `lifecycle-withdrawn.spec.ts`, mutation-verified.
  - Tradeoff: the filter is not counted in the `filtered` retry flag.
  - Eval after the change: recall@5 100%, nDCG@5 99.1%.
- **Contradictions (internal, from in-place edits):**
  - §0.2 L26 says a verdict IS now enforced, but L27–32 still say there is no approval column, nothing acts on WITHDRAW, and §3 is a blocker.
  - §0.3 L33–36 is half-updated.
  - §6 L243–244 still says "`lifecycle_status` has no reader".
  - L251 "Nobody has looked yet" conflicts with the verbal sign-off.
  - L230: issue #82 does not exist (see cross-cutting finding 1).
  - "ingest-time content-boundary gates are unbuilt" (L33, L197) conflicts with code: `packages/ingestion/src/ingest-gates.ts`, the `CONTENT_SCAN_PROVIDER` layer and `classify-document.ts` exist. These need re-verifying; possibly they are built but not enabled in production.
- **Inbound refs:** `scripts/gate1-content-audit.mjs:52,139`.
- **LLM-readability:** stale paragraphs contradict their own updated headers. That is dangerous for an agent.
- **Recommendation:** **keep-immutable** for the sign-off and measurement content. The contradictory paragraphs need a dated amendment block, not silent edits. Create the real tracking issue or remove the #82 claim.

### 10. compliance/scope-conformance-2026-09-30.md

- **Lines / type:** 244 · compliance evidence (conformance record for P0 gate #2, counsel plus carrier sign-off). Amended in place 2026-10-02 because it had not yet been issued to counsel.
- **Audience:** counsel.
- **Status:** current. **This is the best current statement of the compliance posture.**
- **Summary:**
  - Checks every rule of `cpa-consulting/docs/rag/compliance-scope.md` against production at `6dc0d70`.
  - §0 holds items that should not wait for the matrix:
    - The July disclosure event.
    - Unencrypted backup as a reasoned deferral.
    - Hosting principal unconfirmed.
    - Access control was not enforced at the API until remediated 2026-10-02 (`API_ENFORCE_SCOPING=true`; secret-name mismatch `INTERNAL_SCOPE_JWT_SECRET` vs `_SECRETS` fixed).
    - Floating `gemini-flash-latest` model.
    - No name or address PII detection.
  - §1: three questions for counsel. §2: matrix. §3: `TRI_POLICY=warn` rationale. §4: what settles each UNVERIFIED row. §5: delta since the Aug 31 counsel packet. §6: verified production configuration.
- **Unique facts:**
  - Live log line: `verifiers=["static-token","internal-scope"] enforceScoping=true`.
  - rag-mcp is static-token only.
  - OIDC is unset at the API; web and Teams use signed scope assertions.
  - Finding S-5: SharePoint per-document ACLs are not enforced.
  - Scanner set: ssn, ssn-unformatted, ein, routing (ABA), card (Luhn), 1099/W2+amount.
  - Audit log stores the hash only; no `answer_text`; no retention policy; pgBackRest keeps 4 fulls and 14 diffs.
  - `TRI_POLICY` warn vs block metrics: 36.8% false-positive rate; answered 33→51; blocked 18→0; 3 documents caused ~36% of failures.
  - `COMPLIANCE_MODE=none` in production.
  - Conversation history is now sent to the model (PR #71), a new data flow.
  - `check-kb-grounding` and `eval:gold` need the admin token.
- **Contradictions / staleness:**
  - Row 3.2.3 (L162) says "see §0.4". It should say §0.6 (stale after renumbering).
  - Row 6.1b/c (L169) says `gemini-2.5-flash`. §0.5 and §6 say production is `gemini-flash-latest`.
  - L181 cites `env.example:464` for the TRI default. It is now `:520`.
  - L219 notes other docs still quote the retired DPA status line.
- **Inbound refs:** none.
- **LLM-readability:** dense but well labeled. Strikethroughs plus amendments are acceptable.
- **Recommendation:** **keep-immutable** (evidence). Any future change goes in a new dated `scope-conformance-*.md`, per the README. Fix the two citation errors only via a marked erratum.

### 11. compliance/vendor-dpa-google-gemini.md

- **Lines / type:** 81 · compliance evidence (vendor DPA record). **Also runtime-load-bearing**: its presence satisfies the `client-data` boot check, and `.dockerignore` copies it into images.
- **Audience:** counsel, QI, and the boot gate.
- **Status:** current. "BILLING VERIFIED 2026-08-04 — COUNSEL REVIEW STILL OUTSTANDING."
- **Summary:**
  - Standard Google Cloud DPA, auto-incorporated by Cloud Billing (Tier 1 prepay), so no-train and zero-retention are in force.
  - CR-3 residency is unconfirmed. Counsel adequacy has not been reviewed.
  - Records the 2026-07-04 disclosure: 844 documents ingested (49 TRI-flagged) and 3 `/ask` calls on `gemini-2.5-flash`, all by the operator.
  - Embedding at ingest is the disclosure event.
  - `audit_log.embedding_provider/model` is NULL for July rows (columns added 2026-07-09), so there is no §10.22 record of which embedder was used.
  - Purge around 2026-08-03 does not reach the July event.
- **Contradictions / staleness:**
  - The record carries `gemini-2.5-flash`, but production runs `gemini-flash-latest` (scope-conformance §0.5). The record should note the alias.
  - "844" here vs "858" elsewhere: the ingest_log count vs the indexed count. Not reconciled in-text.
- **Inbound refs:** indirectly via the README, `env.example` and `config.ts` boot gate (glob, not name).
- **Recommendation:** **keep-immutable** — evidence, and the boot gate depends on the file. Never merge, rename or move it.

### 12. plans/2026-06-26-phase-a-7216-architecture.md

- **Lines / type:** 184 · plan plus completion record.
- **Audience:** engineers.
- **Status:** completed/historical. All of A-1..A-5 are COMPLETE (commits 0ca7fbd, 8214f9d; 156 tests on 2026-06-27).
- **Summary:**
  - Local embedder: `Xenova/bge-base-en-v1.5`, 768-d, BGE query prefix.
  - Egress allow-list (`EgressPolicy`, `EGRESS_ALLOWED_HOSTS`, empty means deny-all).
  - TRI scanner with initial 4 patterns.
  - `COMPLIANCE_MODE=client-data` DPA gate.
  - Docs updates.
- **Unique facts:**
  - Completion table with test counts (15, 13, 13, 4).
  - The model is about 430 MB and needs pre-warming.
  - The gate condition: firm documents may not enter until a signed DPA exists, client-data mode is on, and counsel signs.
- **Contradictions / staleness:**
  - L180–184 gate was violated in practice: firm documents were ingested 2026-07-04 with `COMPLIANCE_MODE=none`. The doc does not note this.
  - L19: "local currently throws" (fine as history).
  - Scanner patterns have since expanded.
- **Inbound refs:** none.
- **Recommendation:** **archive**, with a one-line note pointing to the 2026-07-04 exception (PLAN-CPA-COMPLIANCE Phase 1) and the DPA record.

### 13. HOOK-INJECTION-FINDINGS.md

- **Lines / type:** 125 · research/incident investigation, dated 2026-07-08.
- **Audience:** operator. It is about the `~/.claude` tooling, **not the rag-system product**.
- **Status:** completed/historical. Partially corrected by its own header: the culprit is Semgrep Guardian v2.0.3, not ecc, and 16 plugins register hooks, not 30.
- **Summary:**
  - Claude Code's `hook_additional_context` wraps any hook stdout in `<system-reminder>`, with no sanitization or attribution beyond the event name.
  - Reproduced a `package-lock.json` ENOENT leak (Go-style error).
  - A claude-mem recall hook shows the same symptom.
  - A native `date_change` reminder is benign but looks like injection.
  - Recommends `disableAllHooks`, plugin pruning, output labels, and briefing subagents.
- **Contradictions / staleness:**
  - §4 L85–87 and §2 L68 are wrong (corrected by the header).
  - L125 says no `.mcp.json` exists.
  - The CLI binary path is version-specific (2.1.203).
- **Inbound refs:** none.
- **Recommendation:** **move out of the rag-system repo**, to `~/dev/claude-config` or archive. It is irrelevant to an LLM consumer of product docs and is noise for a docs-reading agent.

### 14. PLAN-HOOK-INJECTION-REMEDIATION.md

- **Lines / type:** 297 · plan, DONE 2026-07-13 except 3 deferred items.
- **Audience:** operator. Again `~/.claude` tooling.
- **Status:** completed/historical.
- **Summary:**
  - Disabled the semgrep plugin; enabledPlugins went from 90 to 87.
  - `agent_type` exemption pattern in the user's own hook.
  - Headless `claude -p --settings '{"disableAllHooks":true}'` wrapper at `~/.claude/scripts/review-no-hooks.sh`.
  - Verification steps.
  - Deferred: filing upstream bugs; choosing one memory system (claude-mem, remember or pensyve).
- **Unique facts:**
  - An "Instruction Poisoning" hard-block refused documenting the bypass in an agent-loaded README.
  - In-process subagents inherit the parent's hooks; there is no per-hook disable; `allowManagedHooksOnly` works in managed settings only.
- **Staleness:**
  - Paths reference a `.claude/worktrees/web-app-per-user-auth` worktree.
  - L11 "REQUIRED SUB-SKILL" agent directive is stale and executable-looking.
- **Inbound refs:** none.
- **Recommendation:** **move out of the repo** with item 13, or delete; the remaining record lives in `~/.claude`.

### 15. prompts/kb-incident-remediation-plan.md

- **Lines / type:** 200 · a prompt template (meta-artifact) for producing an incident remediation plan for the 2026-08-01/03 client-data incident.
- **Audience:** a fresh agent session.
- **Status:** unclear whether it was ever run. No output doc was found in this group; `PURGE-RECORD-2026-08-03.md` exists, so check it. Probably historical.
- **Summary:**
  - Tells the agent to treat the context as claims to verify, not delete anything, separate "our copy is gone" from "the disclosure is undone", route legal questions to counsel, and keep client names out of tracked files.
  - Phases: inventory, recoverability, owners, prevention replay against the manifest.
  - Defines the output sections.
  - Includes a table of prompt techniques used.
- **Unique facts (incident details):**
  - 858 documents; 355 flagged; 316 merely name a form; 17 serious.
  - Copies persist in: object storage under multiple prefixes (including one whose source id was deleted), pre-purge DB dumps in the bucket, provider daily/weekly volume backups, and the vendor.
  - A pre-purge manifest sits in a gitignored path.
  - Three ingest guards: path exclusion, redaction before embedding, per-document classification fail-closed.
- **Overlaps:** PURGE-RECORD, the DPA record, scope-conformance §0.1.
- **Inbound refs:** none.
- **LLM-readability:** the embedded prompt is itself instructions. A docs-reading agent could mistake it for a task.
- **Recommendation:** **keep (archive) as incident evidence** if the prompt's output exists; otherwise flag to the user whether the remediation plan was ever produced. Its copy inventory (object-storage orphan prefix, pre-purge dumps) may be the only record of remaining copies. Move it to `incidents/2026-08/` next to `PURGE-RECORD`.

---

## Group section

### Current compliance posture (as of 2026-10-02 records, checked against code 2026-10-21)

**Enforced in code:**

- `COMPLIANCE_MODE=client-data` boot gates:
  - Local embedder forced: `packages/rag/src/embeddings/factory.ts:25` throws `ComplianceError`.
  - DPA file existence only (`config.ts:161-167, 428-440`).
  - `TRI_POLICY` forced to block.
  - `CONTENT_SCAN_PROVIDER≠none`, pre-warmed weights and `HF_CACHE_DIR` (per CLAUDE.md).
- Egress allow-list. Each provider calls it explicitly; it is not a global intercept.
- TRI generation pre-flight. Identifying patterns always throw; context chunks carrying TRI are dropped.
- Ingest TRI flagging, plus the source `data_class` gate wired in the worker (fail-closed; C and D collapse to D), plus per-document classification and ingest gates.
- Mandatory `enforcedSourceIds` in `hybridSearch`; empty array returns zero rows.
- `lifecycle_status='active'` filter, which cannot be overridden.
- `/sources` authorization: POST is admin-only; list is scoped (API and MCP).
- Audit log on `/ask` and `/search` (API and MCP), hash-only.
- Scope JWT secret ≥64 hex characters.
- Non-dismissible disclaimer (CR-13).
- Postgres TLS `no-verify`: encrypted, server not authenticated.
- `PARSER_SECRET` enforced.
- Migration journal monotonicity test.

**Production configuration (not code):**

- `COMPLIANCE_MODE=none`.
- Gemini for embeddings and generation; `gemini-flash-latest`.
- `GENERATION_TRI_POLICY=warn`.
- `API_ENFORCE_SCOPING=true` (since 2026-10-02).
- `AUDIT_SINK_PROVIDER` unset, so audit rows never leave firm infrastructure.
- OIDC unset.

The code-enforced §7216 belt (local embeddings) is **not active in production**. Protection rests on the DPA, the egress allow-list, the corpus purge and rebuild (47 documents, all Class A), and the TRI guards.

**Aspirational / not built:**

- DPA field validation.
- Retention policy and scheduled purge (CR-18), purge logging, anomaly alerting (CR-10).
- Vendor register (CR-9) and breach IR runbook (CR-16/17). The files do not exist.
- WISP/QI/training (CR-11/12/15). These are org items with no evidence anywhere.
- Encryption at rest (CR-6). Unverified with Railway.
- Backup encryption (deliberately deferred) and multi-year backup retention.
- Hosting principal confirmation.
- Name/address PII detection.
- Role-based indexes (`firm-sop`/`firm-research`/`karbon-templates`).
- SharePoint per-document ACLs (S-5).
- Recency caption and class label in citations.
- CR-14 review queue (acceptable while no client-send path exists).
- Server-side chat sessions and transcript encryption/RLS. Note the new data flow: history is sent to the model (PR #71).
- SMS channel.
- Staleness sweep.
- Rejecting `http://` URLs in production.

**Open human/legal items:**

- Counsel review: DPA adequacy, the three §1 questions, state breach matrix, OPR 2026-19.
- Carrier notification.
- CR-3 residency.
- Gate 1 written row-by-row sign-off. The tracking issue does not exist.
- Whether the 2026-07-04 disclosure (844/858 documents, 522 SSN-shaped values, sent to Gemini under DPA terms, with no audit record of the embedder) is reportable. This is a counsel question flagged across three docs; no doc records an answer.
- Railway account principal.

### Contradictions across the group

- **DPA status.** Readiness L25/L60 and (per scope-conformance L219) PILOT-LAUNCH-STATUS:215 and PILOT-MANUAL-RUNBOOK:45,55 say "PROVISIONAL". The current status is "BILLING VERIFIED".
- **Generation model.** `gemini-2.5-flash` appears in the DPA record and conformance row 6.1b/c. Production is `gemini-flash-latest`.
- **Document counts.** 844 (ingest_log) vs 858 (indexed) vs 47 (current), with no reconciliation note.
- **Web auth.** PropelAuth (REQUIREMENTS, ADOPTION, SPEC) vs Entra (shipped).
- **Ingest content-boundary gates.** "Unbuilt" (GATE-1) vs code that exists (`ingest-gates.ts`, the content-scan layer). Production `CONTENT_SCAN_PROVIDER` status needs checking.
- **Phase A gate.** Phase A said no firm docs before client-data mode; they were ingested anyway. Only PLAN-CPA-COMPLIANCE records the exception.
- **PLAN-CPA-COMPLIANCE §0.1.** Its CR-5/CR-2/CR-10/CR-20 rows are 2026-07-03 state with no warning.
- **Digest design.** The governance plan says log-line only; the shipped version has a table and admin page.
- **Stale line references.** README `config.ts:778-782`; conformance `env.example:464`; readiness `env.example:259`; governance `queries.ts:296-359`.

### Recommended consolidated compliance doc set

1. **`compliance/README.md`** (keep, fixed): an index of the directory, naming conventions, the immutability rule, and the boot-gate facts.
2. **`compliance/REQUIREMENTS.md`**: CPA-COMPLIANCE-REQUIREMENTS plus §0.3 legal research from PLAN-CPA-COMPLIANCE plus FR/NFR and the human-in-the-loop design from IMPLEMENTATION-SPEC. One authoritative catalog, marked "not legal advice / [COUNSEL]".
3. **`compliance/CONTROL-STATUS.md`** (new, living): one row per CR-1..20 and contract § with code-enforced / config / org / unbuilt status, evidence file:line, production config value and last-verified date. It replaces the PLAN-CPA-COMPLIANCE §0.1 table and the READINESS §5 tracker, and points to the latest `scope-conformance-*.md`.
4. **`compliance/REMAINING-WORK.md`**: the unbuilt items above, rewritten from PLAN-CPA-COMPLIANCE phases 1.3, 3.4, 4, 5 and 6, plus the governance staleness sweep and session-store/SMS designs from ADOPTION-PLAN.
5. **Immutable evidence, never merged or edited** (only dated amendments or new files):
   - `vendor-dpa-google-gemini.md` (also boot-load-bearing).
   - `scope-conformance-2026-09-30.md`.
   - `GATE-1-CONTENT-AUDIT.md`, with a fixed amendment for its internal contradictions and the issue #82 problem.
   - `CPA-READINESS-ASSESSMENT-2026-07-08.md`, frozen.
   - `DECISION-CPA-KB-RAG-CONVERGENCE.md`.
   - `PURGE-RECORD-2026-08-03.md` (outside this group).
   - A new `compliance/EXCEPTIONS-LOG.md` holding the 2026-07-04 egress/`COMPLIANCE_MODE` exception, the 2026-09-07 `TRI_POLICY=warn` decision and the 2026-10-02 scoping remediation (extracted verbatim from PLAN-CPA-COMPLIANCE and scope-conformance).
6. **Group the incident records:** `prompts/kb-incident-remediation-plan.md` alongside the purge record, and find out whether its output plan was ever produced.
7. **Archive:** CPA-KB-ADOPTION-PLAN, CPA-KB-IMPLEMENTATION-SPEC (after extraction), phase-a-7216, PLAN-KB-GOVERNANCE. For the governance plan, keep the path or add a redirect, because 10 code, test and migration comments cite it by path.
8. **Move out of the repo:** HOOK-INJECTION-FINDINGS and PLAN-HOOK-INJECTION-REMEDIATION. They are `~/.claude` tooling, not product docs.
9. **Missing artifacts the set must eventually contain:** VENDOR-REGISTER, BREACH-IR-RUNBOOK, a retention policy, and a WISP reference.
10. **Constraint:** `docs/compliance/` must keep its path and `vendor-dpa-*.md` naming, because `config.ts` `defaultCheckDpa`, `.dockerignore:38-45` and the Dockerfile copies depend on them.

---

## Group 6-reviews-backlog

# Digest, group 9: review, backlog, research and plan docs (10 files, 3,452 lines, all read in full)

I checked findings against code at HEAD 04761c5 (2026-10-20), using git grep and git log.

**Read this first: some earlier docs-cleanup fixes were silently undone.** Commit `2e6987e` (2026-09-01, "fix: stop leaking bearer tokens, restore de-tenanting…") rolled five files back to their pre-#43 text, which removed most of the 2026-08-03 docs-review corrections:

- `STAFF-BOT-ONE-PAGER.md`: −42 lines. The "CORRECTED 2026-08-03" block is gone. Line 28 again says the bot "does **not** have your client files". The page is still Teams-only and undated.
- `PROTOTYPE-DELIVERY-OPTIONS.md`: −51 lines. Line 28 again says "There are no client files"; lines 40–50 are the "nobody has confirmed" text and guardrail 3 that the review said it had rewritten.
- `PILOT-MANUAL-RUNBOOK.md`: −15 lines. The "completion status lives in LAUNCH-STATUS" banner (F-9 fix) is gone.
- `CPA-READINESS-ASSESSMENT-2026-07-08.md`: −23 lines. The citation warning about `RAG-VALIDATION-REPORT.md` is gone.
- `ISSUES-AND-OPTIMIZATIONS.md`: −3/+1 lines. Its broken-citation correction is gone; line 344 cites the nonexistent `RAG-VALIDATION-REPORT.md` again.

`DOCUMENTATION-REVIEW-2026-08-03.md` still says "All 8 HIGH and all 8 MEDIUM findings … have been fixed". That is now false.

---

## 1. RAG-REVIEW-2026-09-16.md

- **Basics:** 1,172 lines. A severity-graded end-to-end review plus its implementation-status record (§11). Audience: the owner (Marcus), reviewers, agents.
- **Status:** completed/historical. §11 is the "status of record" for 09-16. The open parts are only §9 decisions, §11.2 deferrals and some §11.3 items. Its "Status: Current" header (L3) is stale.
- **Summary.**
  - 42 findings, each with evidence, severity (Critical/High/Medium/Low), verification level and effort:
    - S-1..S-10: data safety
    - Q-1..Q-10: answer quality
    - R-1..R-5: retrieval
    - I-1..I-6: ingestion
    - E-1..E-7: evaluation
    - F-1..F-4: API/operations
  - §3 holds an unusually good system description: purpose, surfaces, CR-1/CR-3/CR-13/14 compliance mapping, production state as of 09-07, end-to-end flow diagram.
  - Other sections: §4 "what's good, don't break it"; §7 planned capabilities vs built; §8 a 14-item docs-drift table; §9 eight owner decisions; §10 a five-phase roadmap; §11 fixed / deferred / new findings / deploy notes.
- **Unique facts.**
  - Purpose: a staff knowledge bot for a CPA firm of about 20, with Circular 230 §10.37 "Draft — requires practitioner review" labelling.
  - Production on 09-07: 47 docs, 210 chunks; the 858-doc corpus was purged on 08-03; topK 12, cap 3, weights 0.7/0.3, rerank off.
  - Commit hashes per fix (§11.1).
  - `CONTENT_PROCESSING_VERSION=2` forces a full re-sync. New env vars: NEIGHBOR_EXPANSION_DOCUMENTS/CHUNKS (default 2/4), RETRIEVAL_MIN_DENSE_SIMILARITY (off), GENERATION_THINKING_BUDGET, PARSER_MAX_CONCURRENT_OCR, PARSER_OCR_WAIT_SECONDS, and SharePoint `excludePaths`.
  - N-1 (a search-only deployment has no TRI screening). N-4 (running eval/e2e from a worktree without `E2E_SKIP_DOCKER_UP=1` recreated rag-postgres on an empty data directory).
  - The glossary (Appendix B).
- **Findings.**
  - **Fixed (with commits in §11.1):** S-1, S-2, S-3, S-4, S-6, S-7, Q-1..Q-8, Q-10, R-1, R-2, R-3 (prerequisites only), R-5, I-1..I-5, E-1 (tooling only), E-2, E-4, E-6, E-7, F-1..F-4, and §8 drift items 1–14. I spot-checked several: `plainto_tsquery` is gone from the architecture guide; the stale "Defaults to 'A'" and "why warn is the default" comments are gone; the PII-redaction plan's status banner is updated; `keywordCoverage` and `prompt-context.ts` escaping exist.
  - **Fixed since the doc was written:**
    - N-6: teams-bot now has `apps/teams-bot/src/logger.ts` (pino).
    - N-7: `config.ts` was split; now 459 lines plus `config-schema.ts` at 475.
    - E-3 partially: `audit_log.question_text`/`answer_text` exist behind `AUDIT_LOG_CONTENT=full` (schema.ts:407-421). The doc still lists E-3 as deferred pending decision #3.
  - **Open:**
    - S-5: no per-document SharePoint permission enforcement; no Graph `/permissions` call in connectors.
    - S-8: `sources.data_class` has no C value.
    - S-9: pack scanner `disposition` is carried through (load.ts:88, scan.ts:92) but nothing branches on it.
    - S-10: Gemini redirects are not refused (gemini.ts:54).
    - R-3: enabling a reranker needs a vendor/DPA decision.
    - R-4: no `ts_rank_cd` normalization (hybrid-search.ts:331).
    - Q-9: images and screenshots are dropped.
    - I-6: calculator spreadsheets add noise.
    - E-1: the gold set is still empty (`GOLD_QUESTIONS = []`, gold-set.ts:93).
    - E-5: docs-only item.
    - N-4: `global-setup.ts` is still not worktree-aware.
    - All eight §9 decisions (production TRI policy, SharePoint permissions, retention, reranker vendor, KB_SANDBOX/Drafts, counsel sign-off, pgvector version in postgres-ssl, gold-set session).
- **Overlaps.**
  - `RAG-CRITICAL-REVIEW` (same day, subset).
  - `ISSUES-AND-OPTIMIZATIONS`. Its H0 is Q-8; C3 is E-6; C4 is E-1; M-N1/M-N2 are I-5; OPT-C4 is Q-1; OPT-D4 is I-1.
  - `RAG-QUALITY-REVIEW` (R-4 vs R6; Q-6 vs F4 and E3).
  - §3 duplicates material in `ARCHITECTURE.md` and `PILOT-LAUNCH-STATUS.md`.
- **Contradictions and staleness.**
  - L66: line numbers are pinned to commit `7486747`; `hybridSearch` has since moved to `packages/db/src/hybrid-search.ts`.
  - L139: says generation is `gemini-2.5-flash`. The 10-17 review (L23) says production runs `gemini-flash-latest`; env.example:445 says `gemini-2.5-flash`.
  - L1103 (S-8): says "DocumentClass already distinguishes C and D". The root CLAUDE.md says "the enum collapses Class C and D". One of them is wrong.
  - L1122-1123: N-6 and N-7 marked "Open" are fixed.
  - L116: says the Teams bot is "not deployed" (unchanged).
- **Inbound references outside docs/:** none. Inside docs: README.md:77, RAG-CRITICAL-REVIEW, PROTOTYPE-READINESS-REVIEW, PILOT-LAUNCH-STATUS, the multi-vertical spec.
- **LLM-readability problems.**
  - About 1,000 lines of resolved findings sit before the status table that says they are resolved; a reader must cross-reference §5/§6 with §11.1 by ID.
  - Severity is stated per finding but never updated when the finding is fixed.
  - The line-number citations have decayed.
- **Recommendation:** archive the body. Move §11.2 deferrals, the §11.3 open items and the §9 decisions into a new KNOWN-ISSUES doc. Keep §3 (system description) and §4 (strengths to protect) only if they are not already in ARCHITECTURE.md.

## 2. RAG-CRITICAL-REVIEW-2026-09-16.md

- **Basics:** 136 lines. A review written on the predecessor branch `fix/rag-retrieval-review`. Audience: the owner.
- **Status:** superseded by `RAG-REVIEW-2026-09-16.md` §11. It carries a correct "Superseded" banner with a per-item status table (L10-33).
- **Summary.** Strengths; three defects fixed on that branch (`6d42f1e` top_score, `f08849a` ef_search, `95709c4` 3× over-fetch); eight recommendations, of which the banner marks six done; a list of plugin advice deliberately not adopted.
- **Unique facts.**
  - A measured probe on pgvector 0.8.6: `LIMIT 480` at `ef_search=100` returned 100 rows.
  - `resolveEfSearch` = max(40, override ?? 100, pool), clamped to 1000.
  - Cost note: with a reranker enabled, 36 × 5 = 180 candidates go to the reranker.
  - `DOCS_GAP_DIGEST_MIN_SCORE=0.3` has never been calibrated.
  - Judge requirements: ≥100 labelled items, TPR and TNR ≥ 0.85, judge from a different model family (Claude).
  - **Rejected with reasons:** LangChain, HyDE/multi-query, MMR, HNSW retuning, semantic caching (a cross-principal confidentiality risk). This is the only place in my group that records these rejections.
- **Findings.** Items 1, 2, 3, 5, 7 and 8 are fixed (banner). Still open:
  - #4: calibrated faithfulness judge (faithfulness.ts exists but is uncalibrated).
  - #6: reranking is off (prerequisites only).
  - DOCS_GAP_DIGEST_MIN_SCORE calibration.
  - The pgvector version in Railway's postgres-ssl image is unconfirmed (also R-1, and QUALITY-REVIEW "Low").
- **Overlaps:** almost entirely a subset of RAG-REVIEW.
- **Contradictions:** none. The banner is accurate.
- **Inbound references:** none outside docs/. Inside: docs/README.md.
- **Recommendation:** archive. Before that, move the "advice deliberately not adopted" list into a decisions/ADR doc, and the judge-calibration thresholds into the eval docs.

## 3. RAG-QUALITY-REVIEW-2026-10-17.md

- **Basics:** 116 lines. The newest RAG review. Audience: the owner and agents.
- **Status:** current. It is the newest and most accurate, but **nothing links to it**: zero inbound references from anywhere, and it is not in docs/README.md.
- **Summary.**
  - Verdict on what is strong.
  - F1–F7 were fixed in the same change. All verified present: level-stack heading paths; `invalidateDocumentContentHash` (db/ingest-failures.ts:49, called from failed-documents.ts:33); `isTransientServerError` (retry.ts:72); `keywordCoverage` (types.ts:247, hybrid-search.ts:441); search duplicate collapse; Claude 16k token default; MCP tool annotations (`destructiveHint` in purge-source.ts).
  - Ranked open findings R1–R13 plus 10 low items; enhancements E1–E10; a "checked and sound" list.
- **Unique facts.**
  - Live production config: `GENERATION_MODEL=gemini-flash-latest`, RERANK unset, relevance floor unset.
  - Eval baseline numbers: recall@1 91.2% / 92.5%; MRR 1.000 / 0.975.
  - Measured `keywordCoverage`: identifier queries score 0.6–1.0; off-topic scores 0.33. Suggested Gemini floor: 0.55–0.65.
  - A 596-token chunk was reproduced against the 512-token local model cap.
  - `chunks.page` is NULL for every chunk.
  - `chunks_hash_idx` exists but nothing uses it.
- **Findings (all re-verified open at HEAD):**
  - R1: chunk budget ignores overlap, header and title.
  - R2: no `invalidCitations` anywhere.
  - R3: model alias unpinned; can't verify production from the repo.
  - R4: hash is still only `v${CONTENT_PROCESSING_VERSION}\n${markdown}` (pipeline.ts:626); no CHUNKER_VERSION.
  - R5: `chunks.length===0` returns before `replaceChunks` (pipeline.ts:748-751).
  - R6: no setweight, no normalization.
  - R7: parsing.py:157 still maps Header to `##`.
  - R8: no "Interpreted as".
  - R9: no REFUSAL_NOTICE.
  - R10: poolMultiplier 5 stacked on 3× over-fetch.
  - R11: no `max_completion_tokens`.
  - R12: openai.ts:79 still batches 2048 inputs by count.
  - R13: local embedder has no sub-batching.
  - E5: chunkers never set `page`.
  - Low items: no date in the prompt; `</conversation>` unescaped in contextualize.ts:62-64.
  - Nothing has changed in the code since 10-17; later commits are deps, CI and parser only.
- **Overlaps:** R6 is RAG-REVIEW R-4 and ISSUES OPT-C2. E1 is ISSUES OPT-C2. E9 is ISSUES H1 and RAG-REVIEW R-3. E10 is RAG-REVIEW Q-8. The HNSW iterative_scan note repeats R-1.
- **Contradictions:** L23 `gemini-flash-latest` vs RAG-REVIEW L139 and env.example `gemini-2.5-flash`.
- **Inbound references:** none anywhere.
- **LLM-readability:** good. One problem: very wide table cells (F1–F7 rows are single 400–600-character lines).
- **Recommendation:** merge its open R/E/Low items into the new KNOWN-ISSUES doc as the primary source. Keep F1–F7 as a short changelog entry or archive. At minimum, add it to docs/README.md now.

## 4. ISSUES-AND-OPTIMIZATIONS.md

- **Basics:** 557 lines. The "standing backlog with resolution history". It is the most-referenced doc in my group.
- **Status:** partially stale. Many entries are resolved inline (✅), but the §11 roadmap tables and several bodies are out of date.
- **Summary.**
  - Dated 2026-06-07 but appended through 09-16.
  - Sections: Critical (C1–C4), High (H0–H6, CI1), Medium (audit M3/M6/M17/M19 plus M-N1..N5), Low, OPT-A (connector extensibility), OPT-B (SharePoint), OPT-C (chunking), OPT-D (pipeline), §9 PII/§7216 blockers P1–P4, OPT-E (operator UX), §11 roadmap, the five-systems-unification log, the PR #3 review backlog (items 1–11), §12 measurement note.
- **Unique facts.**
  - The metadata `@>` containment fix with its numeric-string edge case (H2).
  - The P4 audit_log retention design question: split clocks for `principal_subject`; counsel to supply the window number.
  - Single-client deletion is blocked on having no per-document `clientId`.
  - The MCP `principal_subject: null` limitation.
  - The connector-registry / BaseConnector design (OPT-A1..A4).
  - SharePoint throughput ideas (B1–B4), D1–D5, operator UX endpoints (E1–E4).
  - PR #3 items 9–10: the paginate mid-page truncation bug (~75% likely real); gmail/gdrive silently re-scan on a null token; gmail 404 "startHistoryId too old" is not self-healed.
  - The "filters stay out of CTEs" rule and its deliberate embedding-model exception (2026-07-04).
- **Findings.**
  - **Fixed:**
    - C1, C2, H2, H3, H4, H5, H6, M-N1.
    - C3: `truncateAll` guard plus a read-only DB handle (packages/db/src/client.ts:80-90, read-only.test.ts). The doc still says "Partially resolved".
    - C4: `eval:gold`.
    - H0: dates on citations (Q-8).
    - H1b: `listDocuments` now exists (queries.ts:263). The doc still shows it 🟠 open.
    - H1: reranker shipped, off by default. The doc says "likely stale" and the §11 row still says "OPEN".
    - M-N2: I-5.
    - M-N3: per-document cap plus duplicate collapse. §11 still says "OPEN".
    - M-N5: prompt-context.ts:60 escapes `<document`.
    - OPT-C4: neighbour expansion.
    - OPT-D3: per-page continuation in sync-source.ts (`enqueueContinuation`, `PAGES_PER_RUN`).
    - OPT-D4: I-1.
    - OPT-A2: partly.
    - PR #3 items 1–8 and 11.
    - P1, P2, P3.
  - **Open:**
    - CI1: transitive Python dependencies still unpinned (no lock file); quality job still builds e2e.
    - OPT-A1 registry: factory.ts:48 is still a `switch`.
    - OPT-A3; OPT-A4 (sources.ts:43: "connectors validate at use time").
    - OPT-B1: SharePoint `getBytes` inline (index.ts:335).
    - OPT-B2/B3/B4; OPT-C1; OPT-C2 (worse now: Q-3 put title and heading into `text`/tsv); OPT-C3.
    - OPT-D1, D2, D5.
    - OPT-E1..E4: no ingestion-status endpoints; no test/dry-run endpoint.
    - P3 remainder: MCP `principal_subject` null (search-documents.ts:71-73).
    - P4: audit_log retention; single-client deletion; column encryption, deferred.
    - Audit M3: xmax=0 detection is still in use (queries.ts:160-193).
    - M6: `inArray` with an unbounded list (queries.ts:330+).
    - M17: `tsv` is still nullable (schema.ts:217).
    - M19: gmail baseline `historyId`.
    - L7 (unverifiable by grep); the `custom` connector registration; the `documents://` resource UUID check (unverified).
    - PR #3 items 9 and 10: gdrive/gmail still `warn` and reseed (gdrive:215-216, gmail:212).
    - The mixed-provider recall test (appendix).
- **Overlaps:** heavy with RAG-REVIEW (see §1 above) and RAG-QUALITY (OPT-C2 = E1/E2; H1 = E9). C3/C4 duplicate `EVAL-GOLD-SET-GUIDE`. §9 duplicates `CPA-COMPLIANCE-REQUIREMENTS` and `PILOT-LAUNCH-STATUS`.
- **Contradictions and staleness.**
  - L3: header dated 2026-06-07.
  - L5 and L203: cite `CODEBASE-REVIEW.md` as if in docs; it lives at the repo root.
  - L24: heading "Critical (open decisions)" contains finished items.
  - L87, L134: "~858 documents" (now 47).
  - L159: H1 "likely stale".
  - L161, L221, L555: line numbers in `queries.ts` that now live in hybrid-search.ts.
  - L344: cites the nonexistent `RAG-VALIDATION-REPORT.md` (correction reverted by 2e6987e).
  - L399: "there is no web UI" (`apps/web` is live).
  - §11 L451 (H1 OPEN), L454 (M-N3 OPEN), L455 ("no real run recorded"; `eval:real` and `real-eval-result.md` exist), L483.
  - §12 L549: the harness gaps are closed.
- **Inbound references outside docs/** (code depends on the filename and section IDs):
  - packages/db/drizzle/0001_documents_metadata_gin.sql:6 (H2)
  - packages/db/src/client.ts:85 (C3)
  - packages/db/src/queries.ts:259
  - packages/db/src/read-only.test.ts:7
  - scripts/extract-corpus.ts:25
  - tests/e2e/src/specs/audit-log-parity.spec.ts:99 (P3)
  - Plus 18 docs (README:22 and :80, EVAL-BASELINE, PLAN-*, …).
- **LLM-readability.**
  - Emoji severity tags with ✅ overlaid on 🔴 headings; resolved items interleaved with open ones.
  - Status recorded in three places (heading tag, body note, §11 table) that disagree.
  - Very long paragraphs.
- **Recommendation:** rewrite as the backbone of the KNOWN-ISSUES doc: open items only, one status field each. Archive the resolved history. Keep the C3, H2 and P3 IDs as stable anchors, or update the six code comments.

## 5. DOCUMENTATION-REVIEW-2026-08-03.md

- **Basics:** 287 lines. A prior review of the whole docs corpus (81 files then; ~47 read in full or in substantial part, all 81 sampled). Audience: the docs owner.
- **Status:** historical, but its "applied" banner (L19-43) is **now false** for F-1, F-2, F-9 and F-6.
- **Summary.**
  - Scores 15 docs.
  - Findings: 8 HIGH, 8 MEDIUM, 5 LOW.
  - Cross-document findings, 5 open questions, a 10-step action plan.
  - Core diagnosis: "corrections are written into the discovering document and never propagated to the asserting one", confirmed six times.
- **Unique facts.**
  - 355 of 858 documents had identifier hits; one spreadsheet had 522 SSN-shaped and 518 EIN-shaped values.
  - The cross-repo citation lesson: "absent from git log ≠ does not exist" (the briefing exists in cpa-consulting).
  - Two defects were introduced by its own fixes and caught by a re-review pass.

**What it recommended, and what actually happened:**

| #       | Recommendation                                                     | State at HEAD                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1     | Correct the "no client files" claim in three docs, one-pager first | **Regressed.** Correct only in PILOT-LAUNCH-STATUS (L386-390). STAFF-BOT-ONE-PAGER:28 and PROTOTYPE-DELIVERY-OPTIONS:28 assert it again (reverted by 2e6987e).                                                                                                                                   |
| F-2     | Retarget the one-pager at the web app or mark pending; add a date  | **Regressed** in the file: Teams-only, no date. Partial mitigation: docs/README.md lists it as "⛔ Not for distribution — describes an undeployed surface".                                                                                                                                      |
| F-3     | Banner in DEPLOYMENT-TARGET                                        | **Done** (SUPERSEDED banner). DEPLOYMENT.md:47 still links there, now annotated.                                                                                                                                                                                                                 |
| F-4     | Mark the plugin plan superseded                                    | **Done** (superpowers/plans/2026-08-03-generic-core-and-vertical-plugin.md L3).                                                                                                                                                                                                                  |
| F-5     | Fix connector, app and reranker counts; package-README claim       | **Done.** README lists six connectors; CLAUDE.md has five apps including teams-bot; ARCHITECTURE:214 says reranking ships but is off; CONNECTORS no longer says "four". Only `packages/connectors/README.md` exists (I did not check whether README still promises per-package READMEs).         |
| F-6     | Re-ground the missing citations                                    | **Regressed** in two places (ISSUES L344, CPA-READINESS Method line, warnings removed). docs/README.md L117-119 keeps a "cited but not found" list. New missing citation in my group: `PATHFINDER-2026-06-23/03-unified-proposal.md` (cited by the test-fixtures plan L3; not tracked anywhere). |
| F-7     | Retired `text-embedding-004` shown as default                      | **Done.** It survives only in "retired" warnings.                                                                                                                                                                                                                                                |
| F-8     | README "greenfield scaffold"                                       | **Done** (no match).                                                                                                                                                                                                                                                                             |
| F-9     | Reconcile the runbook                                              | **Regressed** (banner removed by 2e6987e). PILOT-MANUAL-RUNBOOK now has no status line at all.                                                                                                                                                                                                   |
| F-10    | Update LAUNCH-STATUS P0 #3                                         | **Done** (L266-267 correction).                                                                                                                                                                                                                                                                  |
| F-11    | One authority per scope; markers in the superseded files           | **Done** (consolidated plan L9; CPA-KB-IMPLEMENTATION-SPEC "HISTORICAL"; PLAN-LAUNCH-READINESS "SUPERSEDED").                                                                                                                                                                                    |
| F-12    | Merge ARCHITECTURE and RAG-ARCHITECTURE-GUIDE, or cross-link       | **Half done.** Cross-linked (1 and 2 references); still two 18 KB and 32 KB architecture docs.                                                                                                                                                                                                   |
| F-13    | Status/Updated line on every doc                                   | **Mostly done.** By my heuristic only STAFF-BOT-ONE-PAGER, LOCAL-GENERATION, PILOT-MANUAL-RUNBOOK and the dev-prompts file lack one.                                                                                                                                                             |
| F-14    | PLAN-LAUNCH-READINESS and DECISION-CONVERGENCE                     | **Done** (correction blocks quote the old text).                                                                                                                                                                                                                                                 |
| F-15    | Drop the model-tier policy from CLAUDE.md                          | **Done.**                                                                                                                                                                                                                                                                                        |
| F-16    | docs/README.md index with Current/Historical split                 | **Done** (14.3 KB). It does **not** include RAG-QUALITY-REVIEW-2026-10-17.                                                                                                                                                                                                                       |
| F-17    | `docs/dev-prompts.md/` directory                                   | **Ignored**: still present with system-reviewer-aug-1.md.                                                                                                                                                                                                                                        |
| F-18    | timeline-weeks index and the W25 collision                         | **Index fixed** (and extended 09-12). **Collision left**: both W25 files remain, annotated.                                                                                                                                                                                                      |
| F-19    | Stale `/Users/marcus/` absolute paths                              | **Ignored** (LOW): still in PLAN-LIVE-DEPLOY-AND-CHAT-UI, CPA-KB-ADOPTION-PLAN, PLAN-CHAT-FRONTEND, app-comparison-2026-06-21, PLAN-SHAREPOINT-GOLIVE, plans/2026-06-21-prelaunch-hardening-plan (and the review itself).                                                                        |
| F-20    | Link CR-* in ARCHITECTURE                                          | **Done** (1 link to CPA-COMPLIANCE-REQUIREMENTS).                                                                                                                                                                                                                                                |
| F-21    | Domain leakage in generic docs                                     | **Not checked in depth.** ARCHITECTURE:166 still says local is "required for any deployment handling regulated data".                                                                                                                                                                            |
| Open Q5 | Merge `docs/plans/` with `docs/superpowers/plans/`?                | **Unresolved**: both directories still exist.                                                                                                                                                                                                                                                    |
| Open Q4 | Should firm-specific docs leave the repo?                          | **Unresolved.**                                                                                                                                                                                                                                                                                  |

- **Inbound references:** none outside docs/. Inside: README.md:23 and :81, claude-plugin-recommendations.md, and README L117 (as the tracker for known gaps).
- **LLM-readability:** good structure. But the "✅ applied" banner gives false assurance, and the finding text is preserved verbatim, so a reader can't tell current from fixed without re-checking.
- **Recommendation:** archive. First carry its process rule and the regression lesson into the cleanup brief, and re-apply F-1, F-2, F-6 and F-9. Do not keep it as the "where docs are wrong" tracker; README:23 points there.

## 6. HARDEN-SEARCH-INDEX-GUARDS.md

- **Basics:** 456 lines. A self-contained execution brief for a fresh session, with the full code to paste. Audience: an agent.
- **Status:** completed/historical. Implemented in `3511fee` (2026-06-14): `REQUIRED_CHUNK_TRIGGERS` is in required-indexes.ts:38, and `packages/db/src/migration-guard.test.ts` exists.
- **Summary:** extend `assertRequiredIndexes` to cover the `chunks_tsv_update` trigger, add unit tests, and add a CI file scan that fails if any non-0000 migration drops a protected object.
- **Unique facts:**
  - The protected-object table (two indexes, the trigger, the trigger function).
  - `0000_init.sql` legitimately contains `DROP TRIGGER IF EXISTS`.
  - Remaining follow-up: a broken-but-present trigger is undetected; it needs an e2e check that `tsv IS NOT NULL`.
- **Findings:** fixed (3511fee). Open, minor: the e2e `tsv IS NOT NULL` probe.
- **Overlaps:** ISSUES C1; the `rag-postgres-contracts` skill (boot-time index assertions); root CLAUDE.md.
- **Staleness:** L412 says only 0001 exists (now 0001–0006+). The 3-call-site boot description is consistent with CLAUDE.md. L454-456: an empty stray code fence.
- **Inbound references:** none outside docs/. Inside: README, timeline-weeks.
- **Recommendation:** delete or archive; the code and its comments are now the source of truth. If anything is kept, it is the single "tsv IS NOT NULL" e2e follow-up, which goes to KNOWN-ISSUES.

## 7. AUTH-AND-SESSIONS-RESEARCH.md

- **Basics:** 280 lines. 2026-06-07 research supporting CPA-KB-ADOPTION-PLAN. Audience: the owner.
- **Status:** largely superseded.
  - PropelAuth was replaced by Entra SSO; apps/web/CLAUDE.md:37-38 says PropelAuth was stripped. One leftover comment: schema.ts:531 "PropelAuth/IdP userId".
  - The SMS/Twilio channel was never built (no matches in apps).
  - Server-side `chat_sessions` / `chat_messages` were never built.
  - The B0 client-held-history interim note (L222) was added 09-16.
  - The likely successor for auth is `superpowers/specs/2026-07-06-web-app-auth-design.md`.
- **Summary:** the BFF-proxy decision (still the live pattern), identity-to-scope mapping tables, channel auth (Teams, SMS), and a three-table Drizzle session schema with purge, encryption and RLS guidance.
- **Unique facts:**
  - New multi-tenant bot registrations deprecated as of 2025-07-31.
  - NIST SP 800-63-4: SMS is not AAL2.
  - `sslmode=no-verify` rationale (pg-connection-string ≥2.10 aliases `require` to verify-full); flagged as an overclaim by `documentation-review-artifacts/2026-09-07-sslmode-docs-review.md`.
  - The `staff_client_assignments` / `source_client_assignments` design, which did ship (schema.ts:517-518).
  - The session schema design with `(channel, external_user_id)` key, purge tombstones and citation snapshots: the only design for persistent history, gated on the question-retention decision.
- **Findings:** BFF and assignment tables are implemented. Server-side sessions, SMS and RLS are open/unbuilt. The PropelAuth-specific guidance is obsolete.
- **Overlaps:** web-app-auth-design spec; superpowers/plans/2026-08-01-reranking-and-conversation-memory; CPA-KB-IMPLEMENTATION-SPEC; PLAN-LAUNCH-READINESS.
- **Inbound references outside docs/:** documentation-review-artifacts/2026-09-07-sslmode-docs-review.md:3, :16, :26, :58. Inside: seven docs.
- **Recommendation:** archive. If server-side sessions are still planned, extract the Part 2 session schema and compliance rules into a "future: persistent conversation history" design note (or the conversation-memory plan).

## 8. ECFR-CONNECTOR-SPIKE.md

- **Basics:** 63 lines. A spike result from 2026-07-07. Audience: connector authors.
- **Status:** completed/historical, and the decision is implemented. The `ecfr-part4` connector uses only the govinfo bulk XML ("no REST fallback", index.ts:15, :113) and sends a browser User-Agent (tested in index.test.ts:87-100). `scripts/spike-ecfr-rate-limits.ts` still exists.
- **Unique facts:**
  - Every eCFR REST full-title request returned 503, up to 40,164 ms, with no retry-after header.
  - The cause (overload vs WAF) was never distinguished.
  - The REST `part` parameter does not filter server-side.
- **Overlaps:** CONNECTORS.md references it.
- **Inbound references outside docs/:** `packages/connectors/src/ecfr-part4/index.ts:13` ("See docs/ECFR-CONNECTOR-SPIKE.md").
- **Recommendation:** merge into CONNECTORS.md's ecfr-part4 section as a short "why bulk XML" note, and update the index.ts:13 comment. Otherwise keep as-is.

## 9. plans/2026-06-22-phase-g3-retrieval-quality.md

- **Basics:** 264 lines. A phased plan for the G3 retrieval-quality gate. Audience: an agent.
- **Status:** partially completed and partially superseded.
  - Phase 1 is done (`8753199`). The pre-deploy command has since changed to `node node_modules/@rag/db/dist/migrate.js` (apps/worker/railway.json:8; the plan says `pnpm --filter @rag/db migrate`).
  - Phase 2 is done (EVAL-BASELINE.md exists).
  - Phase 3 is partly done, in a different shape: `corpus-cpa.ts` (not `corpus.cpa.ts`), `eval:real`, `run-real-eval.ts`, `faithfulness.ts` and a gold-eval runner exist. Missing: hit-rate@k and MAP (metrics.ts has only recall, precision, nDCG, RR, mean), a temperature-0 JSON-schema `judge.ts`, and §3E judge-to-human agreement. The gold set is empty.
  - Its header L3 says "Phase 2 ready"; this is stale.
- **Unique facts.**
  - The judge design rules: temperature 0, `responseSchema`, ordinal 0/1/2, N≥3 runs reporting mean ± stddev, loose floors only.
  - Parse `[N]` markers from the answer prose rather than `GenerationResult.citations` (which follow context order).
  - Self-preference bias; a Jaccard leakage tripwire; ≥30% multi-document questions; an embedding cache.
  - The migration boot-order trap.
- **Findings open:** the §3C judge, the §3D metrics and the §3E validation. These overlap CRITICAL-REVIEW #4 and RAG-REVIEW E-1.
- **Overlaps:** EVAL-BASELINE, EVAL-GOLD-SET-GUIDE, EVAL-AND-FEEDBACK, PLAN-LAUNCH-READINESS G3, DEPLOYMENT.md (migration ownership).
- **Inbound references:** none outside docs/. Inside: README, the test-fixtures plan.
- **Recommendation:** archive. Move the judge-design rules (§3C, §3E) into the eval docs (EVAL-GOLD-SET-GUIDE or EVAL-AND-FEEDBACK) as the spec for the still-open calibrated judge.

## 10. plans/2026-06-23-test-fixtures-package.md

- **Basics:** 121 lines. A mechanical refactor plan. Audience: an agent.
- **Status:** completed/historical.
  - `packages/test-fixtures/src` holds all five fakes plus the barrel.
  - `tests/e2e/src/fakes/` is gone.
  - Option D-1a was taken: `Generator` lives in packages/core/src/interfaces.ts:47.
- **Unique facts:**
  - The D-1 dependency-cycle rationale (why `Generator` lives in core).
  - Use `vi.spyOn` on the shared fakes rather than `vi.fn` fields.
- **Findings / contradiction:** packages/test-fixtures/package.json:18 uses `vitest run --passWithNoTests`, as the plan said. The repo rule `.claude/rules/tdd.md` says not to add new `--passWithNoTests` packages ("packages/runtime is the existing gap"). Runtime no longer uses it; test-fixtures is now the only one. Either the rule's text is stale or the package violates it.
- **Missing citation:** `PATHFINDER-2026-06-23/03-unified-proposal.md` (L3); not tracked.
- **Inbound references:** none outside docs/. Inside: README.
- **Recommendation:** delete or archive. Move the D-1 rationale into a code comment or ARCHITECTURE if it isn't already there.

---

## Group section

### A. Still-open issues across these reviews, deduplicated (verified at HEAD unless marked)

**Data safety and compliance**

1. Per-document SharePoint permissions not enforced. [RAG-REVIEW S-5; decision §9#2]
2. `sources.data_class` has no C value. RAG-REVIEW §11.2 and CLAUDE.md disagree on whether C and D collapse; reconcile. [S-8]
3. Pack scanner `disposition` is modelled but ignored. [S-9]
4. Gemini SDK redirects are not refused. [S-10]
5. Search-only deployments have no TRI screening. [N-1]
6. MCP audit rows have `principal_subject: null`. [ISSUES P3]
7. audit_log retention window and split clocks; single-client deletion needs `clientId`; column encryption deferred. [ISSUES P4]
8. Counsel sign-off (P0 #2). Production TRI policy unknown (warn vs block). [RAG-REVIEW §9#1, #6]

**Answer quality and generation** 9. Invalid `[N]` citation numbers stay in the answer text; uncited answers are not flagged. [QUALITY R2] 10. Production model is an unpinned alias (`gemini-flash-latest`). [R3] 11. The generator never sees the follow-up's interpreted question. [R8] 12. Refusal and SAFETY stops yield an empty answer. [R9] 13. OpenAI reasoning models are rejected (unverified). [R11] 14. No current date in the prompt; `</conversation>` not escaped. [QUALITY Low] 15. Calibrated faithfulness judge: ≥100 labels, TPR/TNR ≥ 0.85, temperature 0 with JSON schema, human-agreement check. [CRITICAL #4, G3 plan §3C–3E] 16. Gold set empty (`GOLD_QUESTIONS = []`); needs the firm-staff session. [RAG-REVIEW E-1, §9#8] 17. Relevance floor off; DOCS_GAP_DIGEST_MIN_SCORE uncalibrated. [QUALITY E3, CRITICAL] 18. Images and screenshots dropped. [Q-9] No page numbers in citations: `chunks.page` is never set. [QUALITY E5] 19. Native citations, step verification, conflict badge. [QUALITY E6–E8; enhancements]

**Retrieval** 20. Keyword ranking has no IDF, length normalization or weighted tsvector; the title/breadcrumb now bloats the tsv. [QUALITY R6 and E2 = RAG-REVIEW R-4 = ISSUES OPT-C2] 21. Reranker off. Needs a vendor/DPA decision or a local cross-encoder (bge-reranker-base); the pool stacks 3× over-fetch with 5× rerank (180 chunks). [R-3, QUALITY R10 and E9, ISSUES H1] 22. HNSW `iterative_scan`; pgvector version in the postgres-ssl image unconfirmed. [R-1 follow-up, QUALITY Low, CRITICAL #3] 23. Duplicate collapse is exact-match only. [QUALITY Low] No recency signal. [QUALITY E10] 24. Mixed-provider recall during migration is untested. [ISSUES appendix]

**Ingestion and chunking** 25. Local embedder: chunks overflow 512 tokens because the budget ignores overlap, header and title. [QUALITY R1, E1] 26. Content hash ignores title and chunker config. [R4] 27. A changed document that now yields zero chunks keeps its stale chunks (pipeline.ts:748-751). [R5] 28. Unstructured fallback: headers and footers become `##` sections; page numbers are lost. [R7] 29. OpenAI embedding batches sized by count. [R12] Local embedder runs one pass per document with no sub-batches. [R13] 30. Code blocks split at sentence punctuation; table overlap can exceed the budget; overlap starts mid-word. [QUALITY Low] 31. Calculator spreadsheets add noise. [I-6] 32. Unchanged-chunk embedding reuse (`chunks_hash_idx` unused). [QUALITY E4] 33. Contextual retrieval and semantic chunking. [ISSUES OPT-C1, C3] 34. Paginate mid-page truncation (likely data loss). Gmail/gdrive null-token silent re-scan. Gmail 404 history not self-healed. [ISSUES PR#3 items 9, 10] 35. Audit M3 (xmax), M6 (unbounded `inArray`), M17 (nullable tsv), M19 (gmail baseline historyId). [ISSUES §3] 36. Present-but-broken tsv trigger is undetected; needs an e2e probe. [HARDEN step 5]

**Connectors, operator UX, operations** 37. Connector registry (A1), open SourceKind (A3), validate config at creation (A4, E1). [ISSUES OPT-A] 38. SharePoint: decouple download from listing, `$select`, `$batch`, managed metadata. Skip on modified-time, cross-document embedding batches, coalesced DB writes. [OPT-B1–B4, D1, D2, D5] 39. No `GET /sources/:id/ingestions` or `/ingestions/:id`; no test/dry-run endpoint; no per-source credentials. [OPT-E2–E4] 40. Parser build not reproducible (transitive ML dependencies); CI quality job builds e2e. [ISSUES CI1] 41. e2e `global-setup` not worktree-aware. [N-4] 42. Teams bot not deployed (Azure subscription). Server-side chat sessions, SMS and RLS unbuilt. [RAG-REVIEW §3.2, AUTH research]

**Already fixed but still shown open in docs (fix the docs):** ISSUES C3, H1, H1b, M-N3, §11 eval row, §12; RAG-REVIEW N-6, N-7, and E-3 (partial: `AUDIT_LOG_CONTENT=full`).

### B. Shape for a consolidated KNOWN-ISSUES.md (merge target)

- **One table row per issue** with these columns: stable ID (keep `ISSUES-C3`, `H2` and `P3` anchors because code comments cite them, or update the six code references), area, severity, status (`open` / `decision-needed` / `deferred-with-unblocker`), the code location (path plus symbol, not line numbers, which have decayed in every review here), source doc, the "unblocked by" condition, and last-verified date plus commit.
- **Separate sections** for "Decisions needed (owner)" (RAG-REVIEW §9 plus P4) and "Deliberately not doing" (CRITICAL-REVIEW's rejected advice; BaseConnector skipped; column encryption).
- **Resolved items** go to a CHANGELOG or archive with one line plus commit hash each. Don't mix them into the open list; the ✅-over-🔴 interleaving in ISSUES is the main readability failure.
- **No emoji severity.** One status field per issue, not a status in the heading, the body and a roadmap table that drift apart.
- **Sources to fold in:** RAG-QUALITY-REVIEW (primary, newest), RAG-REVIEW §11.2, §11.3 and §9, ISSUES (open items), CRITICAL #4 and #6, the G3 judge spec (to the eval docs), the HARDEN follow-up.
- **Afterwards:** archive RAG-REVIEW, CRITICAL-REVIEW, ISSUES, HARDEN, the G3 plan, the test-fixtures plan, AUTH research and DOCUMENTATION-REVIEW. Update docs/README.md L22-23 and L77-81, and the six code comments referencing ISSUES.

### C. Lessons from the 2026-08-03 docs review for the next cleanup

1. **Fixes were lost to a merge, silently.** `2e6987e` (a de-tenanting "restore to #43's version") reverted the F-1/F-2/F-6/F-9 corrections in five files a month later, and the review's "✅ applied" banner kept claiming success. For the next cleanup:
   - Add a mechanical CI guard, like the tenant-name `git grep` guard in ci.yml that same commit added. For example: fail if "no client files" or `RAG-VALIDATION-REPORT.md` appears outside correction blocks; fail if the docs/README.md index omits a file in docs/.
   - Re-verify "applied" claims against HEAD; don't trust banners.
2. **Correct the asserting document, not just the discovering one.** The rule was right, but it was implemented as appended "⛔ CORRECTED" blocks that quote the false text. That keeps the falsehood greppable, readable by LLMs and easy to resurrect on revert. Prefer rewriting the sentence and keeping history in git or a changelog.
3. **Mechanical fixes stuck; judgement fixes in long docs did not.** Banners on superseded files (F-3, F-4, F-11, F-14), the index (F-16), and model and connector corrections (F-5, F-7, F-8) all held. LOW housekeeping was ignored outright: the `dev-prompts.md/` directory, the duplicate W25 files, the `/Users/marcus/` paths, the plans/ vs superpowers/plans/ split. Bundle housekeeping as deletions and moves, which are easy to verify, instead of leaving it as advice.
4. **The index is a single point of failure for discovery.** The newest review (RAG-QUALITY-REVIEW-2026-10-17) has zero inbound links. Require every new doc to be added to the index, enforced by CI.
5. **Superseded docs were bannered but not removed.** That kept about 80 files plus banner noise. The next pass should archive or delete rather than banner. Every completed plan in my group (HARDEN, the test-fixtures plan, the G3 plan) is fully replaced by code.
6. **Watch for cross-repo citations and code-to-doc links before moving files.** Code comments cite ISSUES (6 places) and ECFR-SPIKE (1). `CODEBASE-REVIEW.md` lives at the repo root, not in docs/. PATHFINDER-2026-06-23 is missing entirely. "Not in git log" ≠ "doesn't exist": check cpa-consulting.
7. **Line-number citations decay within weeks** (`queries.ts` → `hybrid-search.ts`). Docs meant to stay current should cite path plus symbol.

Files read, all under /Users/marcusklein/dev/rag-system/docs/: RAG-REVIEW-2026-09-16.md, RAG-CRITICAL-REVIEW-2026-09-16.md, RAG-QUALITY-REVIEW-2026-10-17.md, ISSUES-AND-OPTIMIZATIONS.md, DOCUMENTATION-REVIEW-2026-08-03.md, HARDEN-SEARCH-INDEX-GUARDS.md, AUTH-AND-SESSIONS-RESEARCH.md, ECFR-CONNECTOR-SPIKE.md, plans/2026-06-22-phase-g3-retrieval-quality.md, plans/2026-06-23-test-fixtures-package.md. No files were edited.

---

## Group 7-misc-specs

I read in full every .md file in my group: Group A misc, the timeline weeks and digests, the SDVOSB plan and report, and all 8 files in `superpowers/specs/`. For the bibliography I read the head and tail. The JSONL ledgers were sampled for structure and counted. No files were edited.

**Cross-cutting facts:**

- **No inbound references from outside docs/.** None of these files is referenced from anywhere outside `docs/`, tracked or untracked. The only references from code into `superpowers/` point at _plans_, not specs: `packages/core/src/content-safety.ts:5` and `packages/core/src/tri-scanner.ts:74`.
- **Inbound references from inside docs/** are listed per file below.
- **Tool cruft is gitignored and untracked.** Covering rules: `.gitignore:39` `.DS_Store`, `:80` `**/.claude/sessions/`, `:92` `.token-optimizer/`.

---

## GROUP A — Misc

### SESSION-2026-05-26.md

- **Basics:** 113 lines · tracked · type: event-record (session checkpoint) · audience: a future Claude session.
- **Status:** completed/historical. Already listed under Historical in `docs/README.md:109`.
- **Summary:**
  - This is the end-of-session checkpoint from the greenfield build: monorepo, 3-cycle review, MEDIUM cleanup, and the parser v1 XLSX/CSV sheet classifier.
  - It records the v0 table-aware chunker as shipped and v2 Text-to-SQL as deferred.
  - It lists deferred MEDIUM/LOW review findings and a "non-obvious decisions" table.
- **Unique facts worth preserving:**
  - Table chunker design:
    - `TableChunker` returns `null` for narrative/freeform sheets so the caller falls back to `MarkdownChunker`.
    - Header row is repeated on every chunk, with a 2-row overlap by default.
    - Oversized rows fall back to one row per chunk.
    - `financial_model` sheets try whole-sheet first.
    - `CompositeChunker` detects spreadsheets via `tables.some(t => t.sheetType)`.
    - Spreadsheet docs skip `MarkdownChunker` entirely, to avoid duplicate chunks.
    - Ordinals are global across the document.
  - v2 Text-to-SQL sketch: `tabular_sheets` table, SELECT-only role, AST-validated SQL, `query_table` MCP tool, regex intent router. Not captured anywhere else (no doc mentions text-to-sql or `query_table`).
  - Deferred findings not captured anywhere else:
    - UUIDv4→v7 for the chunks PK
    - hard-coded `'english'` tsvector config
    - triple `<=>` evaluation in the `dense_hits` CTE
    - an exfil-URL output filter
    - `@fastify/helmet`
    - validation of the GDrive `query` field
  - Decision table:
    - RRF k=60
    - `SET LOCAL hnsw.ef_search` = 100 per query
    - filters applied at the outer SELECT, not inside the CTEs
    - SHA-256 + `timingSafeEqual` bearer comparison
    - `# headingPath` prepended to each chunk
    - content-hash short-circuit
    - empty `_journal.json` plus a hand-authored `0000_init.sql`
    - camelCase pydantic aliases
  - Coverage check: k=60 and ef_search appear in RAG-ARCHITECTURE-GUIDE. `timingSafeEqual`, UUIDv7 and helmet are not captured anywhere.
- **Overlaps:** RAG-ARCHITECTURE-GUIDE, ISSUES-AND-OPTIMIZATIONS, ARCHITECTURE (row overlap).
- **Contradictions / staleness:**
  - L10: "read this first" — obsolete.
  - L19/L21: the "NOT built yet" heading contains v0 marked DONE.
  - L40: cites the missing `docs/SESSION-2026-05-26-research.md`; DOCUMENTATION-REVIEW flagged this as a missing citation.
  - L101: cites `apps/*/README.md`; per the review these don't exist.
  - L106: stale path `/Users/marcuspersonal/...`.
  - L4/L65: "8 packages" — now there are more.
  - L110: migration list.
  - L113: "obvious next move is v0" — contradicts L21.
- **Inbound references:** `docs/README.md:109`, `docs/DOCUMENTATION-REVIEW-2026-08-03.md:187`.
- **LLM-readability:** dated "current state" framing; a self-contradicting heading.
- **Recommendation:** archive. Before archiving, merge the decision table, the deferred-findings list and the Text-to-SQL sketch into an ARCHITECTURE "decisions/deferred" section.

### STAFF-BOT-ONE-PAGER.md

- **Basics:** 42 lines · tracked · type: how-to (end-user guide) · audience: firm staff.
- **Status:** junk-ish / premature. It describes a Teams bot that is not deployed: the Azure subscription is still a blocker (`PILOT-LAUNCH-STATUS.md:376,434`).
- **Summary:** how to DM or @mention the KB bot in Teams; answers are drafts with citations; in channels only firm-wide docs are used; it answers as you; first-run SSO sign-in.
- **Unique facts:**
  - Staff-facing copy for DM vs channel semantics.
  - Disclaimer wording.
  - Example questions (1040 intake, BOI SOP, time code).
  - "Contact Marcus" as the support path.
- **Overlaps:** the teams-bot spec §3/§4 (same semantics) and TEAMS-MVP.
- **Contradictions:**
  - L28: "does not have your client files" — falsified by the corpus screen (DOCUMENTATION-REVIEW F-1: 355/858 docs had hits). Still uncorrected in the file.
  - Undated.
  - `docs/README.md:59` marks it "⛔ Not for distribution", but the file itself carries no banner.
- **Inbound references:** `docs/README.md:59`, `PILOT-LAUNCH-STATUS.md:411,609`, `RAG-REVIEW-2026-09-16.md:109,954,1140`, `DOCUMENTATION-REVIEW-2026-08-03.md:82,96,108,227,264`.
- **Recommendation:** keep as a draft, but add a "DRAFT — not deployed" banner and a date, and fix L28. Alternatively move it to `apps/teams-bot/` as release copy.

### TEAMS-MVP-REQUIREMENTS.md

- **Basics:** 183 lines · tracked · type: status / checklist · audience: operator and the firm's admins (Chris, Doug).
- **Status:** partially stale. Verified 2026-09-12; blockers still open as of PILOT-LAUNCH-STATUS.
- **Summary:**
  - Definition of done: a named pilot user gets a cited, scoped answer in Teams, with an `audit_log` row where `channel='teams'`.
  - Lists what's done:
    - 60 bot tests
    - 488 MB image
    - 51/51 grounding probes
    - 47 Class A docs
    - TLS 1.3
    - verified backups
  - Lists the blockers:
    - §1 Azure subscription (hard)
    - §2 Azure Bot plus Entra registration (5 env vars)
    - §3 content audit (P0)
    - §4 icons
    - §5 Railway `rag-teams-bot` service plus 3 reachable URLs
    - §6 tenant custom-app-upload policy (unverified)
    - §7 backup dead-man's switch
  - Lists what is deliberately NOT required, the go-live sequence, and day-one traps.
- **Unique facts:**
  - Run "Test Connection" on the OAuth setting first; a failure shows up as a sign-in card on every message.
  - `BOT_OAUTH_CONNECTION_NAME` is not the SSO scope URI.
  - Teams validates the website, privacy and terms URLs at upload time.
  - Do not set `PORT`.
  - `?sslmode=no-verify` for node-pg, but `pg_dump` rejects it.
  - The packager rejects a `botid-`-prefixed app id.
  - `/health` is green even when the DB is unreachable, by design.
  - `AGE_RECIPIENT` is unset.
  - The corpus re-syncs from SharePoint in about 90s; the real loss on a provider failure is the audit log.
- **Overlaps:** AZURE-DEPLOY-RUNBOOK (the steps), PILOT-LAUNCH-STATUS (gates), EMAIL-IT-TEAMS-APP-UPLOAD.
- **Contradictions:**
  - L33: "47 documents" and L135-137 "47 internal Class A SOPs, none [taxpayer data]" rest on the per-source `data_class` default. Same premise risk as F-1, although post-purge plus TRI screening make it more defensible.
- **Inbound references:** `EMAIL-IT-TEAMS-APP-UPLOAD.md:5,97`, `RAG-REVIEW-2026-09-16.md:953,1140`.
- **LLM-readability:** good. Clear headings, owners named.
- **Recommendation:** merge into PILOT-LAUNCH-STATUS as the Teams gate section, with the traps moved into AZURE-DEPLOY-RUNBOOK. Or keep it as the single Teams checklist and dedupe the rest.

### app-comparison-2026-06-21.md

- **Basics:** 178 lines · tracked · type: decision-record / review · audience: founder and the firm.
- **Status:** superseded / historical. The decision is captured in DECISION-CPA-KB-RAG-CONVERGENCE; README lists this file as "superseded planning".
- **Summary:**
  - Code-level comparison of cpa-backend + cpa-knowledge-base against rag-system. Verdict: adopt rag-system, retire cpa-backend, reuse only the Next.js UI.
  - Weighted scorecard: 2.0 vs 6.9.
  - A 10-item gap list for go-live (audit log, retention, class enforcement, §7216 local path, rate limiting, observability, CI, ACL granularity, reranker, UI).
- **Unique facts:**
  - cpa-backend defects: dead RAG code, `DataEntity.find({})` with no tenant scoping, a committed `.env`, a hardcoded JWT secret at `scripts/jwt.ts:11`, an infinite-recursion getter at `sqs/index.ts:90-92`.
  - The Vespa 1536-dim schema.
  - The firm's tax-season build freeze (Jan 15–Apr 15); the build window is May–Sep.
  - "Postgres RLS is not reliably enforced under pgvector ANN — pre-filter inside the CTE."
- **Overlaps:** DECISION-CPA-KB-RAG-CONVERGENCE; the timeline W24 decision (obs 1689-1690).
- **Staleness:**
  - L3: `/Users/marcus/dev` paths.
  - Many "absent in B" items have since been built: audit log, purge, rate limiting, local embeddings, Teams, CI gates. See L98, L122-125, L172-173.
- **Inbound references:** `DECISION-CPA-KB-RAG-CONVERGENCE.md:18,51`, `docs/README.md:105`, `plans/2026-06-21-prelaunch-hardening-plan.md:3`, DOCUMENTATION-REVIEW.
- **Recommendation:** archive. It is about cpa-backend as much as rag-system, so it could arguably move to `cpa-consulting`.

### claude-plugin-recommendations.md

- **Basics:** 308 lines · tracked · type: research / decision-record about Claude Code tooling · audience: the developer.
- **Status:** current as of 2026-09-15 but not acted on: `~/.claude-acct2/settings.json:361` still has `llm-application-dev: true`. Off-topic for rag-system docs.
- **Summary:**
  - Analysis of the wshobson/agents marketplace (94 plugins). Install `security-scanning`; use `documentation-standards`, which is already enabled.
  - Skills-only picks: `vector-index-tuning`, `slo-implementation`, `sql-optimization-patterns`.
  - Disable `llm-application-dev`, because it contradicts repo decisions.
  - 18 candidates rejected; the install plan and risks are included.
- **Unique facts:**
  - A repo profile snapshot: 73 test files, a CI step list, and no SAST or dependency audit anywhere.
  - Open codebase-review findings H2 and H3:
    - H2: drizzle-kit generate would DROP the HNSW and GIN indexes.
    - H3: `documents_metadata_gin_idx` uses `jsonb_ops` and does not accelerate `->>`.
  - halfvec would halve the 3 KB/vector cost.
  - No marketplace offering covers botbuilder.
  - The two-config-dir drift on this machine.
- **Overlaps:** CODEBASE-REVIEW.md; the user-level config docs.
- **Staleness:** it cites "docs/ (70+ files)" (L27, L145); there are now 128.
- **Inbound references:** none.
- **LLM-readability:** a dense ~1,000-word opening verdict paragraph (L3); very long table cells (L298-308).
- **Recommendation:** move out of the repo, to `claude-config` or `~/.claude-acct2`. Before moving, carry H2 and H3 into an issue tracker or ISSUES-AND-OPTIMIZATIONS if they are still open.

### dev-prompts.md/system-reviewer-aug-1.md

- **Basics:** 1 line (2,125 chars) · tracked · type: tool-cruft (raw prompt paste). The directory is misnamed `*.md`.
- **Status:** junk.
- **Content:** a raw user prompt invoking `/llm-application-dev:rag-implementation` to review rag-system for the CPA pilot, with typos ("sored in postgress", "frindings").
- **Inbound references:** DOCUMENTATION-REVIEW L84 (scored 1/10), L237 and LOW-17 ("move out of docs/").
- **Recommendation:** delete. Optionally keep the prompt in the claude-config repo.

### timeline-weeks/ (8 files plus digests/)

- **Basics:** tracked · type: event-record (claude-mem observation dumps plus narrative digests) · audience: historian / the owner.
- **Status:** historical. README L3 calls it "not maintained documentation".

| File                         | Lines                  | Content                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                  | 35                     | Index                                                                                                                                                                                                                     |
| `2026-W23-Jun06-to-Jun06.md` | 28                     | Pathfinder audit; five-systems proposal                                                                                                                                                                                   |
| `2026-W24-Jun08-to-Jun14.md` | 358                    | 305 observations: @rag/services and @rag/runtime extraction, C2a single-writer, paginate/cursor codec, OpenAPI parser types, eval harness, parser secret, merge-conflict reconciliation, cpa-backend deprecation decision |
| `2026-W25-Jun15-to-Jun17.md` | 144                    | AuthProvider, Dockerfiles, Railway Phase 2, Next.js UI, SharePoint runbook                                                                                                                                                |
| `2026-W25-Jun15-to-Jun21.md` | 204                    | Superset of the Jun15-17 file, plus Jun18-21: parser public-domain removal, `text-embedding-004` 404 → `gemini-embedding-001`, Graph RAG rejected (obs 2287), per-page re-enqueue plan                                    |
| `2026-W26-Jun23-to-Jun27.md` | 50                     | test-fixtures package, ESLint, purgeSource MCP, `doc_class` removal, `ingest_log`→`audit_log` rename, egress policy                                                                                                       |
| `2026-W36-Sep02-to-Sep06.md` | 153                    | postgres-ssl swap, collation/REINDEX, pgBackRest live, PITR drill                                                                                                                                                         |
| `2026-W37-Sep07-to-Sep11.md` | 240                    | PORT fallback, manifest validator, PR #56, TLS detection, CRITICAL JSON injection fixes, TRI 82% false blocking → `warn`, Prettier non-convergence #62, PRs #61/#63/#64                                                   |
| `digests/00`–`04`            | 46 / 68 / 52 / 76 / 56 | Narrative "chapters" with carry-forward blocks                                                                                                                                                                            |

- **Unique facts** (mostly recorded elsewhere in runbooks; these may be unique):
  - Graph RAG rejected for Phase 1 with a named re-evaluation trigger (obs 2287; W25-Jun21 L~196).
  - TRI guard blocked 17 of 47 docs, 82% of them with no detectable pattern; `warn` raised answerability from 65% to 100%.
  - `isPostgresTlsActive` must use `getAll('sslmode').at(-1)`, because the driver reads the last parameter; this is case-sensitive.
  - Manifest JSON injection via `SSO_SCOPE` / `DEVELOPER_NAME`.
  - The Prettier oscillation trigger: a table nested in a list item with bold across continuation lines.
  - PITR failure modes: root-owned manifest, restore gate on a non-empty volume.
  - Railway was 16 commits behind main on Sep 7.
  - Open debts left unresolved:
    - `ingestion_jobs` / `ingest_log` column mismatches (obs 216)
    - parser metadata unvalidated at the boundary (obs 774)
    - delta-cursor silent full re-scan (obs 772)
- **Contradictions:**
  - README L7-11 says the two W25 files are "not duplicates". In fact Jun15-17 is a strict subset: 124 of its 125 lines appear in Jun15-21, the only difference being one S402 timestamp.
  - README L4 says "5 files", then lists 7.
  - README L8 says Jun15-17 is "same shape as W23/W24". It isn't: W23, W24, W26 and W25-Jun21 all carry the "recent context, 2026-06-27" header and legend, which Jun15-17 lacks.
  - W23 and W26 headers say "recent context 2026-06-27"; that is the generation date, not the week.
  - DOCUMENTATION-REVIEW L239/LOW-18 still cites the old "430 observations" index.
- **Inbound references:** `docs/README.md:111`, `PLAN-HOOK-INJECTION-REMEDIATION.md:256`, DOCUMENTATION-REVIEW L239 and L280.
- **LLM-readability:** very poor. They are observation-ID dumps with emoji legends, truncated lines and IDs that only resolve against claude-mem. Digests are prose with "TONE NOTES" meant for a narrative generator.
- **Recommendation:**
  - Delete the raw week files, or move them out of the repo; they are regenerable from claude-mem and add no value in git.
  - Optionally keep digests 00–04 in an archive folder.
  - Rescue the three unresolved debts and the Graph-RAG rejection into ISSUES/decisions first.

### plans/SDVOSB-GOV-GTM-PLAN.md

- **Basics:** 212 lines · tracked · type: plan (business go-to-market) · audience: the founder.
- **Status:** current (2026-10-09) but off-topic.
- **Summary:**
  - Federal go-to-market plan for a solo SDVOSB. Thesis: sell cited, in-tenant, model-agnostic, evaluated RAG, not chat (OneGov makes chat ~$1).
  - A repo-capability gap table: FedRAMP scope, ATO kit, Bedrock/Azure-Gov, 508/ACR, FIPS 140-3, 7332 record class, M-26-04.
  - Six ranked offerings: VA regulatory answer engine; FAR/RFO SaaS; state VSO rating assistant; eval/assurance; prime subcontracting; Tradewinds appliance.
  - Phased plan, revenue assumptions, kill criteria, next 10 actions.
- **Unique facts (product-relevant):**
  - Gap list for a gov build: only 3 files in `apps/web/src` use ARIA; no ACR; no SBOM; no SIEM sink; eCFR connector is single-part.
  - IP hygiene: a Schedule A background-IP confirmation is needed; firm files should move to `clients/pilot/`; MIT-vs-proprietary decision.
- **Overlaps:** RESEARCH-REPORT.
- **Inbound references:** only from its own research folder.
- **Recommendation:** move out of the repo, to a business/strategy repo. If kept, extract only the "repo gaps for government deployment" table into a product backlog doc. It also contains sensitive personal/business info: VetCert status, IP agreement, revenue targets.

### plans/sdvosb-research/

- **RESEARCH-REPORT.md** (311 lines, tracked, research, current 2026-10-09):
  - Deep-research output: 6 angles, 104 sources, 257 evidence quotes, 103 claims (72 confirmed / 31 unverified / 0 refuted).
  - Findings: SDVOSB thresholds (SAT $350K, VA sole-source $5M), VA AI demand (367 use cases), OneGov pricing, compliance (in-tenant is outside FedRAMP; VA ATO 60-day pilot path), open vehicles, the VSO adjacent market and its legal limits.
  - Off-topic for rag-system.
- **bibliography.md:** 104 lines, one citation per line, S100–S624.
- **JSONL ledgers:**

| File             | Rows | Keys / breakdown                                                                                                                 |
| ---------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| `claims.jsonl`   | 103  | `id, text, text_final, support, independent_sources, verdict, confidence, notes, redteam`; verdicts 72 confirmed / 31 unverified |
| `evidence.jsonl` | 257  | `id, source, quote, locator`                                                                                                     |
| `redteam.jsonl`  | 103  | `id, reviewer, skeptic, auditor, verdict, corrected_text`                                                                        |
| `sources.jsonl`  | 131  | 72 primary / 31 secondary / 27 unreachable / 1 blog                                                                              |

- **run_manifest.json** (28 lines):
  - Contradiction: it says `"tools": "built-in WebSearch + WebFetch only"`, but the report (L61, L310) says built-in fetch was blocked and Firecrawl/Exa were used.
  - The report's "104 fetched sources" vs the 131 rows in `sources.jsonl` is consistent once the 27 unreachable are excluded.
- **Inbound references:** none outside the SDVOSB pair.
- **Recommendation:** move the whole folder out of the repo, together with the GTM plan.

### Tool cruft — all untracked and already gitignored

| Path                                                                | Size     | Content                                                                                                               |
| ------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `docs/.claude/sessions/snapshot.md`                                 | 19 lines | 2026-09-15 session snapshot                                                                                           |
| `docs/.claude/sessions/token-log.md`                                | 52 lines | ~195 `~?` rows, 2026-09-15 → 2026-10-21 (still being written)                                                         |
| `docs/.claude/sessions/.token-guard-checked`                        | 0 B      | Run marker                                                                                                            |
| `docs/timeline-weeks/digests/.claude/sessions/token-log.md`         | 6 lines  | Token log                                                                                                             |
| `docs/timeline-weeks/digests/.claude/sessions/.token-guard-checked` | 0 B      | Run marker                                                                                                            |
| `docs/.token-optimizer/wiki/artifacts/*.txt`                        | 5 files  | JSON tool captures, two referencing other projects (cowork-tools, csv-data-summarizer) and `/tmp/wshobson-catalog.md` |
| `docs/.token-optimizer/wiki/metrics.jsonl`                          | 5 lines  | Tool metrics                                                                                                          |
| `docs/superpowers/.DS_Store`                                        | 8 KB     | macOS cruft                                                                                                           |

- **Recommendation:** delete from disk. No new `.gitignore` lines are needed; existing rules (`:39`, `:80`, `:92`) cover them all.
- Root cause: tooling is writing session state into `docs/` because sessions start with cwd=`docs/`. Consider configuring the hooks to use the repo root.

---

## GROUP B — superpowers/specs/ (8 files)

### 2026-07-06-web-app-auth-design.md

- **Basics:** 295 lines · tracked · spec · audience: implementers.
- **Status:** implemented. Evidence:
  - `packages/core/src/internal-scope-auth.ts`
  - `WEB_AUTH_MODE` in `apps/web/src/lib/rag-api.ts` and `middleware.ts`
  - `apps/web/src/app/admin/access/`
  - `packages/db/src/manage-access.ts`
  - `RAG_API_TOKEN` removed from web; it remains only in `scripts/check-kb-grounding.mjs`
  - groups-overage detection at `apps/web/src/lib/auth.ts:43-46`
- **Summary:**
  - Entra sign-in via Auth.js v5 in the BFF.
  - BFF calls `resolveSourceIdsForUser(oid)` and mints an HS256 60s scope-assertion JWT.
  - New `InternalScopeAuthProvider` added to the composite.
  - Admin role from an AAD group, `RAG-Admins`.
  - Admin UI with soft-delete grants; all five BFF route groups migrated.
  - `WEB_AUTH_MODE` static-fallback break-glass; a Teams extension path.
- **Unique design rationale:**
  - Rejected forwarding Entra tokens with `OIDC_SCOPE_MAP` (that would need one AAD group per client) and rejected HMAC headers (bespoke protocol).
  - `algorithms:["HS256"]` is mandatory.
  - `INTERNAL_SCOPE_JWT_SECRET` has a larger blast radius than `PARSER_SECRET`: it needs rotation via a multi-secret list and alerting on verification failures.
  - A short expiry avoids needing a revocation list.
  - Fail closed when resolve fails; `[]` maps to `DENY_ALL`.
  - A separate delegated-permission app registration from the connectors' app.
  - `oid`, not upn, is the identity key.
  - Groups overage requires a Graph `memberOf` fallback.
  - Multi-tenant bot registrations deprecated as of 2025-07-31.
- **Where captured permanently:** `apps/web/CLAUDE.md:15-16` covers the scope-token mechanism. The rejected alternatives and the secret blast-radius and rotation requirements are not in ARCHITECTURE.md or CLAUDE.md.
- **Staleness:**
  - L5: cites the non-existent `docs/RAG-VALIDATION-REPORT.md`.
  - L21: `queries.ts:774` — line drift is likely.
  - The env var became the plural `INTERNAL_SCOPE_JWT_SECRETS` on the API side, per web-e2e spec L100. This spec only says "comma-separated" (L139).
  - No status update after implementation.
- **Recommendation:** archive. Promote "Auth/scope-assertion decisions" (rationale, rejected alternatives, secret handling, fail-closed rules) into ARCHITECTURE or a decisions doc.

### 2026-07-11-generic-document-classification-engine-design.md

- **Basics:** 103 lines · tracked · spec.
- **Status:** not implemented; superseded/absorbed by the 08-03 multi-vertical spec, which says so in its header (L5). No `DocumentClassifier`, `createRuleBasedClassifier` or `CLASSIFICATION_RULESET_PATH` exists in code.
- **Summary:**
  - A `DocumentClassifier` interface with `handlingRules`, including `permittedForIngestion`.
  - A `createRuleBasedClassifier(ruleSet)` factory.
  - Generalize the TRI scanner.
  - Rule sets loaded from external config.
  - The ingestion gate becomes per-classifier.
- **Unique content:** "zero product-specific rules in this repo" as a global constraint, and the `handlingRules` shape. Both are largely carried into the pack design.
- **Staleness:**
  - L2: "superpowers:writing-plans" boilerplate.
  - References `classify-source.ts`; the code now has `classify-document.ts`.
  - Mentions "companion specs in cpa-consulting/veteran-claims-app".
  - No supersession banner in the file.
- **Recommendation:** archive, adding a banner that points to the multi-vertical spec.

### 2026-07-16-teams-bot-design.md

- **Basics:** 180 lines · tracked · spec.
- **Status:** implemented. Evidence:
  - `apps/teams-bot/`
  - `resolveSharedSourceIdsForUsers` in `packages/db/src/queries.ts` and `apps/teams-bot/src/scope.ts`
  - e2e `shared-source-scope.spec.ts`
  - `X-RAG-Channel` in `apps/api/src/routes/ask.ts`
  - audit channel `"web"|"teams"` at `schema.ts:454`
  - Not deployed, because of the Azure blocker.
- **Summary:**
  - Bot-as-BFF: Teams SSO yields `oid`, the bot mints the same scope token, calls `/ask` with `X-RAG-Channel: teams`, and renders an adaptive card.
  - DM scope is the user's full grants.
  - Channel scope is the intersection of all members' grants, minus `client_confidential`, computed in one SQL query (`GROUP BY` / `HAVING count = N`).
  - Fail closed; single card, no streaming; no admin actions in v1.
- **Unique design rationale:**
  - On-behalf-of (OBO) flow rejected, because it would duplicate the confidentiality boundary.
  - The channel-intersection leak-freedom argument.
  - `client_confidential` excluded as belt-and-suspenders.
  - Audit `sub` = asker, even with the intersection scope.
  - The shared grant SQL fragment must be reused so DM and channel scope can't diverge.
  - The isolation test is mandatory.
- **Where captured permanently:** partially, in code comments and `apps/teams-bot/manifest/README.md:59`. Not in ARCHITECTURE.md; CLAUDE.md has only "single-instance/MemoryStorage".
- **Staleness:**
  - L157: lists `BOT_ENTRA_SSO_*`; the actual var is `BOT_ENTRA_SSO_SCOPE`, plus `BOT_OAUTH_CONNECTION_NAME` (TEAMS-MVP L62-65).
  - L118: "`api"|"mcp"` channel"; the current schema comment says `"web"|"teams"`.
  - L158: gated on counsel sign-off; TEAMS-MVP L135 explicitly drops that requirement.
- **Recommendation:** archive, after promoting the bot-as-BFF and channel-intersection decisions to ARCHITECTURE "Surfaces & scoping".

### 2026-07-17-platform-tenancy-and-plugin-boundary.md

- **Basics:** 169 lines · tracked · spec.
- **Status:** not implemented and superseded in part by 08-03. No `PluginRegistry`, `RagPlugin`, `provision-tenant.sh`, `tenants/` or `PLUGINS` env exists.
- **Summary:**
  - Three layers: core, vertical plugin, tenant config + data.
  - Per-tenant isolated DB (decision D5: no commingled `tenant_id`).
  - A provisioning script, one Railway project per tenant.
  - Convert closed factory switches into a plugin registry; a `@rag/plugin-cpa` package; hard edges on what a plugin may touch.
- **Unique / still-valid:**
  - D5 per-tenant isolation as the compliance story.
  - The anti-fork rationale (N-way merges of security fixes).
  - The boot/migration ordering inside provisioning.
  - Interface line map (stale lines).
  - The "closed factory switches" observation.
- **Staleness:**
  - L77: says `DEPLOYMENT-TARGET.md` is stale (that's correct).
  - L54: `RAG_ADMINS_GROUP_ID` vs `RAG_ADMINS_GROUP_CLAIM` in the 07-06 spec; an inconsistency.
  - Line references (`factory.ts:40` etc.) are likely drifted.
- **Recommendation:** archive, adding a banner. Promote D5 isolation, "no fork per customer" and "plugins/packs supply policy, never enforcement" to a decisions doc.

### 2026-08-03-multi-vertical-rag-platform-design.md

- **Basics:** 688 lines · tracked · spec. Last edited 2026-09-16 with notes.
- **Status:** partially implemented:
  - **Slice 2 (local generation):** done. `GENERATION_BASE_URL`; `runPreFlight` uses `effectiveBaseURL` (`generator.ts:406`); Gemini refuses a `baseURL` (`GEMINI_BASE_URL_REFUSAL`); `docs/LOCAL-GENERATION.md` exists.
  - **Pack scanner slice:** done. `packs/cpa/pack.yaml`; `packages/core/src/pack/{load,schema,registry,scan}.ts`; `PACK_CONTRACT_VERSION="1.0.0"` with a caret check; `kind`/`disposition` enums.
  - **Redaction before persist:** done (`pipeline.ts:524` "Layer 1 — redact before anything downstream").
  - **Slice 1a:** not done. `ANSWER_DISCLAIMER` (Circular 230) is still hardcoded at `packages/services/src/ask.ts:95-101`; there is no `prompt.md` in `packs/cpa`.
  - **Slice 1b (open tiers):** not done. `dataClassEnum` is still a pgEnum at `schema.ts:52`; there is no `processingVersion`.
  - **Slice 3 (settings catalog, `scrubBeforeIndex`, admin surface):** not done.
  - **Slice 4:** only pack validation exists; no conformance suite, acceptance run or drift check.
  - None of the promised docs exist: PACK-AUTHORING, DEPLOYING, UPGRADING, SETTINGS.
- **Summary:**
  - Core / vertical pack (data) / client deployment layers; each client self-hosts.
  - Pack format: open tiers, scanner `kind` and `disposition`, classification shape (in the pack) vs patterns (in the DB), named extension escape hatch, pack as the compliance artifact, a pack-contract semver check that fails closed.
  - Disposition at ingest (exclude default / redact / flag); the scrub toggle and its four downsides.
  - Pack vs DB config split with two safety axes.
  - Local generation.
  - Verification framework; slices and their order.
- **Unique design rationale (high value):**
  - Why core must not accumulate domains.
  - The identifying vs contextual severity split, with evidence: 316 contextual hits were all false positives; 24 identifying hits included a 522-SSN roster.
  - "Redaction protects the model, not the user": the citation URL still opens the original. Redaction is an egress control, not a confidentiality control.
  - Re-scan after redacting.
  - Record redaction counts, never values.
  - Exclusion as the default, citing Amazon arXiv 2411.05978 (>25% Q&A degradation) and NIST SP 800-188.
  - Unknown pack fields are an error.
  - `PACK_CONTRACT_VERSION` vs product version.
  - Two axes: the sensitivity boundary (pack-only, never DB-changeable) vs retrieval scope (DB, freely widened, audited). This corrects an earlier "narrow-only" claim.
  - Protected settings and `adminEditable` validated at boot.
  - Per-request DB config behind a short-TTL cache.
  - `contentHash` (pre-scrub) plus a separate `processingVersion`.
  - Suppress downloads for scrubbed docs.
  - Do not auto-relax the TRI gate for "local" endpoints (localhost can be a tunnel).
  - A structural prompt lint in CI vs a nightly behavioral check; a FakeGenerator never sees the prompt.
  - ReDoS time-boxing.
  - Drift check reports counts and hashes only; ~30 doc titles carry client names.
  - Rejected: query rewriting / HyDE / multi-query / parent-document (single-turn) — conversational condensation (B0) was adopted.
  - No npm publish; no dynamic loading.
  - Tier migration risk: the C/D enum collapse.
  - Exclusion is silent; scanner false negatives are unmeasurable.
- **Where captured permanently:** essentially none. Only `processingVersion` is mentioned, in RAG-REVIEW-2026-09-16. CLAUDE.md mentions the C/D collapse only in "Effort calibration". ARCHITECTURE.md has no pack, sensitivity-axis or redaction rationale.
- **Staleness:**
  - §3.6 example "^3.0.0" vs actual 1.0.0; illustrative.
  - L454: "`createGenerator` supports gemini|openai only" — now claude too, plus `baseURL`.
  - §5.1: the hardcoded-host bug is described as live, but it is fixed.
  - L111-115 and L245 line refs.
  - No implementation-status table, although the 2026-09-16 commit message claims one; only the Notes box L45-52 was added.
- **LLM-readability:** long, but well structured. It needs a status header per slice.
- **Recommendation:** rewrite.
  1. Split out a permanent `ARCHITECTURE-DOMAIN-BOUNDARY` (or decisions) doc holding §2, §3.2, §3.6, §3.7 principles, §4.1 axes, §5.2 and §7.
  2. Keep the remaining slices 1a/1b/3/4 as a short open plan with current status.
  3. Archive the original.

### 2026-08-31-sensitive-content-discovery-design.md

- **Basics:** 417 lines · tracked · spec.
- **Status:**
  - The pack-scanner part (§3) is implemented: `pack.yaml` scanners with `validator`/`context`, `registry.ts`, `scan.ts` with high/low `Confidence`, `maskValue`.
  - The discovery service (§5) is NOT implemented: no `scan_run` / `scan_document` / `scan_finding` tables, no `/admin/scans`, no `@rag/content-scan`.
  - The §4 matrix's dependency on PR #41 / Layer 2-3: `classify-document.ts` exists, so that layer is partly landed.
- **Summary:**
  - Collapse three disagreeing pattern sets (`tri-scanner`, `extract-corpus` `screenDocument`, `content-safety`) into one pack-declared set.
  - One pass emits every match as high or low, so ingest acts on high only and discovery on everything.
  - Disposition is a function of (scanner kind × document class).
  - A read-only discovery job with value-free findings tables, admin-only API, migration and rollback, testing.
- **Unique rationale:**
  - Decisions D1–D5. D2 = never store raw values, including in context windows.
  - The "total rule": gates decide the label, never whether a finding exists; a Luhn-invalid card must appear as low.
  - The superset property holds only within a run.
  - `Unclassified` + contextual → flag is explicitly _not_ fail-closed; it is a calibration to re-validate per corpus.
  - The `data_class` → matrix-row mapping is undefined: a roster stamped `general` could be redacted and indexed instead of excluded. Nothing may be enforced until that mapping exists.
  - Excluding on any hit costs 41% of the corpus; identifying hits are ~2–3%.
  - The locator problem: a markdown offset doesn't map back to `tables[]`.
  - `scan_document` row for every enumerated doc ("no findings" ≠ "never read").
  - 4 concurrent parses; scan tables have no FKs into the corpus.
- **Captured permanently:** no.
- **Contradictions:**
  - L4-6: "supersedes `extract-corpus.ts`", but that script still exists.
  - L413 vs pack.yaml: the pack yaml header says adding a scanner id requires editing `content-safety.ts` `kindFor` and `CLASS_D_IDENTIFIERS`. That contradicts D3's "patterns are pack data"; tracked as a type-safety gap.
  - L44 example `ssn` pattern differs from actual `pack.yaml` (`\b\d{3}[-\s]\d{2}[-\s]\d{4}\b`).
- **Recommendation:**
  - Keep the §5 discovery service as an open plan or spec with a status banner ("§3 shipped via plans/2026-09-01-pack-scanner-slice; §5 not built").
  - Promote D2, the total rule and the "kind × class" disposition matrix (with its unresolved-mapping warning) into the decisions doc.

### 2026-09-13-web-e2e-kb-verification-design.md

- **Basics:** 403 lines · tracked · spec.
- **Status:** implemented. Evidence:
  - `tests/web-e2e/` (Playwright)
  - `.github/workflows/web-e2e.yml`, run without secrets; generation specs tagged `@needs-8b-model` and excluded in CI per the REVIEW
  - `data-testid="refusal"` in `chat-interface.tsx:111`
  - measured 11/11 passing warm
- **Summary:**
  - A browser e2e of KB properties through the real web UI.
  - Four processes (docker, a listening API, `next start`, Playwright).
  - Minted Auth.js JWE session cookie.
  - Seeded access grant; embedder coherence check.
  - Local Ollama `llama3.1:8b` with ONNX bge embeddings.
  - Invariant-only assertions 0–4.
  - A `fetch`-tee stream reader.
  - Production code changes (testids, stream-error element, refusal classification).
  - Excluded from pre-push via `test:browser`.
- **Unique facts (valuable gotchas):**
  - Auth.js v5 cookie is JWE (`dir` / `A256CBC-HS512`) with an HKDF salt = cookie name, named `authjs.session-token`.
  - `EMBEDDING_PROVIDER=local` without `EMBEDDING_MODEL` crashes; `config.ts` defaults to the Gemini id.
  - `CHUNK_SIZE` doesn't reach the seeder; pass `chunkSize` explicitly.
  - Web uses the singular `INTERNAL_SCOPE_JWT_SECRET`, the API the plural `_SECRETS`, each min 64 chars.
  - `API_TOKENS` must be non-empty or the API exits.
  - `API_PORT` and `PORT` both default to 3000.
  - `AUTH_TRUST_HOST` is needed under `next start`.
  - `EGRESS_ALLOWED_HOSTS` replaces rather than merges.
  - `GENERATION_PROVIDER=openai` for Ollama; a placeholder API key is sent, and the embedding key is never inherited.
  - Two fail-open traps: an empty grant, and zero chips with vacuous `.every`.
  - A refusal carries a "Closest related material [N]" citation, 6/6 measured.
  - `page.route()` buffers the stream.
  - Use the `start` script, not `dev` (dev loads the real `.env`).
  - HF and Ollama downloads bypass `EgressPolicy`.
- **Contradictions:**
  - L30: the embedding-model crash. Partly addressed since? The REVIEW (S3-14/16) says the provider-aware default is still missing as of 10-02.
  - The REVIEW finding 7 shows the refusal detector uses `.includes()`, contradicting the "opening line only" fix in `gold-eval`. This spec's assertion 3 inherits that.
  - L100 config line numbers.
  - L369-389: the bulleted cold-time estimate is mangled by Prettier (list items breaking mid-sentence).
- **Recommendation:**
  - Archive the spec.
  - Move the env-matrix gotchas into `tests/web-e2e/README` or the CLAUDE.md "trip you up" list (the singular/plural secret, `EMBEDDING_MODEL`, `EGRESS_ALLOWED_HOSTS` replaces, `PORT` collision).

### 2026-10-02-local-llm-verification-REVIEW.md

- **Basics:** 392 lines · tracked · review.
- **Status:** orphaned on main. The spec it reviews (`2026-10-02-local-llm-verification-design.md`) is not on main. It exists only on the unmerged branch `docs/local-llm-verification-spec`, which was restored and rewritten after this review (commits 1f6f47a, 8b4028e, ded0709, 7245a3d, all NOT in HEAD).
- **Summary:**
  - S0 blockers: the spec was deleted; Amendment 1 misread a CI comment (generation specs are not run in CI); the answer-quality harness already exists (`pnpm eval:gold`, `scoreGoldRun`; the gold set is empty).
  - S1 critical findings:
    - The local ONNX providers can silently download from HF (`allowRemoteModels`).
    - `config.ts` was at 791/800 lines.
    - A mocked reranker test can't detect logit inversion.
    - Web-e2e refusal is a verbatim `.includes()` check.
  - S2 major findings:
    - The 512 cap is keyed to the embedder, not the reranker.
    - The pool multiplier means 60 cross-encoder passes per query.
    - Silent reranker degradation (pino warn only).
    - The client-data DPA file gate is satisfied by the Gemini DPA and is cwd-relative.
    - Web-e2e can't produce a Gemini baseline.
    - A model matrix would run 20–40 minutes, with an ~8% stall rate (5/65).
  - S3 minor items, plus spec claims verified correct, plus a resequencing.
- **Current status of the findings:**
  - Finding 4 (allowRemoteModels) has since been fixed (`local.ts:15,136,185`).
  - Finding 5 has been resolved: `config.ts` is now 459 lines, split into `config-schema.ts`.
  - No local reranker has been added.
  - Finding 7 is presumably still open.
  - Finding 11 (DPA gate) is unknown.
- **Unique facts still useful:**
  - The DPA gate is vendor-agnostic and satisfied by the Gemini DPA; it is cwd-relative, so a container shipping `dist/` without `docs/` fails in client-data mode.
  - The ~8% local llama3.1 stall rate.
  - The `kb.spec.ts:40` ordering assertion is fragile.
  - Setting `RETRIEVAL_MIN_DENSE_SIMILARITY` silently makes the refusal test model-independent.
  - `warm-model.ts` bypasses `loadConfig` and hardcodes 768 dimensions.
  - Pool multiplier × in-process cross-encoder cost.
- **Captured permanently:** no.
- **Recommendation:** archive with the spec once the branch merges or is abandoned. Promote the still-open items (DPA gate trap, refusal-detector divergence, reranker health signal) to ISSUES-AND-OPTIMIZATIONS, and the DPA cwd trap to the CLAUDE.md `COMPLIANCE_MODE` gotcha.

---

## GROUP SECTION

### A. Design decisions to promote into a permanent ARCHITECTURE / DECISIONS doc

None of these currently live in ARCHITECTURE.md or CLAUDE.md, except where noted.

1. **Scope assertion (07-06):**
   - BFF resolves scope from the DB and mints an HS256 60s JWT. `InternalScopeAuthProvider` trusts the embedded scope with no DB round-trip.
   - `algorithms` pinned.
   - Rejected: forwarding Entra tokens with a group map, and HMAC headers.
   - `INTERNAL_SCOPE_JWT_SECRET(S)` has corpus-wide blast radius: secret manager, multi-secret rotation, alert on verification failures.
   - Fail closed everywhere; `[]` = deny-all; revocation takes effect within one request.
   - `oid` is the identity key; admin = AAD group with Graph overage fallback; separate delegated app registration.
   - `WEB_AUTH_MODE` static-fallback is a temporary break-glass.
   - Only partially in `apps/web/CLAUDE.md`.
2. **Surfaces are BFFs (07-16):**
   - Teams bot = another BFF; OBO rejected.
   - Channel scope = intersection of every member's grants minus `client_confidential`, via the shared grant SQL fragment.
   - Audit `sub` = asker; `X-RAG-Channel` sets the audit channel.
3. **Tenancy (07-17 / 08-03):**
   - Each client gets its own deployment and DB (D5); no commingled `tenant_id`, no control plane, no fork per customer.
   - Updates are pull-based, so pack/core compatibility and version reporting are product features.
4. **Domain boundary (08-03):**
   - Core owns enforcement; packs supply policy, never enforcement.
   - Core must not accumulate domain scanners or taxonomies.
   - Static, in-image extensions only (no dynamic loading); no npm publish.
5. **Sensitivity model (08-03 / 08-31):**
   - Scanner `kind` identifying vs contextual, with the evidence (316 contextual false positives; 24 identifying hits incl. the 522-SSN roster).
   - Disposition exclude (default) / redact / flag; disposition = f(kind × document class).
   - "Redaction protects the model, not the user": it is an egress control, not a confidentiality control.
   - Re-scan after redacting; record counts, never values (D2, including context windows).
   - The total rule (gates label, never drop).
   - The `data_class` → disposition-row mapping is undefined; do not enforce the matrix until it is defined.
   - The C/D enum collapse risk.
   - Exclusion is silent: needs an operator view.
   - Scanner false negatives are unmeasured, so human review stays load-bearing.
6. **Config axes (08-03 §4.1):**
   - Sensitivity boundary (pack-only, immutable from DB) vs retrieval scope (DB, freely widened, audited).
   - Protected settings and `adminEditable` validated at boot.
   - DB config read per request behind a short-TTL cache.
7. **Change detection (08-03 §3.8):** `contentHash` = pre-scrub source; a separate `processingVersion` = (scrub, ruleset version). Planned, not built.
8. **Pack contract (08-03 §3.6):**
   - `PACK_CONTRACT_VERSION` is separate from the product version; mismatch refuses boot, with a directional error message.
   - Unknown pack fields are errors.
   - Built (1.0.0).
9. **Local generation (08-03 §5):**
   - The egress check must use the effective `baseURL` (built).
   - Never auto-relax the TRI gate for "local" endpoints.
10. **Retrieval exclusions:**
    - No single-turn query rewriting, HyDE, multi-query or parent-document retrieval (measured neutral-to-negative). Conversational condensation (B0) adopted.
    - Graph RAG rejected for Phase 1 (timeline obs 2287).
11. **Verification philosophy (08-03 §6, 09-13):**
    - A structural prompt lint is not a behavioral proof; FakeGenerator never sees the prompt.
    - Assert non-empty before `.every`; test fixtures are their own oracle.
    - The diagnostic drift report carries counts and hashes only, never titles.
12. **From SESSION-2026-05-26:**
    - RRF k=60
    - `ef_search` = 100 via `SET LOCAL`
    - filters at the outer SELECT (HNSW is only usable for `ORDER BY <=> LIMIT`)
    - SHA-256 + `timingSafeEqual` token comparison
    - heading-path prefix on each chunk
    - spreadsheet routing and 2-row table overlap
    - the deferred-findings list (UUIDv7, `'english'` tsvector config, helmet, exfil-URL filter)
    - the Text-to-SQL v2 sketch

### B. Cruft to delete

- **Untracked, already gitignored — delete from disk:**
  - `docs/.claude/` (sessions/snapshot.md, token-log.md, .token-guard-checked)
  - `docs/timeline-weeks/digests/.claude/`
  - `docs/.token-optimizer/` (5 artifacts plus metrics.jsonl; these reference other projects)
  - `docs/superpowers/.DS_Store`
- **Tracked — delete via git:**
  - `docs/dev-prompts.md/` (the directory and `system-reviewer-aug-1.md`)
  - `docs/timeline-weeks/2026-W*.md`, the raw observation dumps. At minimum delete `2026-W25-Jun15-to-Jun17.md`, a strict subset of `-Jun21`.
- **.gitignore:** no new lines needed. The rules at `.gitignore:39` (`.DS_Store`), `:80` (`**/.claude/sessions/`) and `:92` (`.token-optimizer/`) already cover all of it. Optionally add `docs/.claude/` wholesale.
- **Root cause:** sessions launched with cwd=`docs/` write tool state there, and `docs/.claude/sessions/token-log.md` is still being appended (last row 2026-10-21).

### C. Off-topic content (consider moving out of rag-system)

- `plans/SDVOSB-GOV-GTM-PLAN.md` plus all of `plans/sdvosb-research/` (business/federal GTM research with personal certification and IP details). Move to a business/strategy repo. Keep only, if desired, the "repo gaps for government deployment" table as a product-backlog item: ACR/508, SBOM, FIPS 140-3, SIEM sink, Bedrock/Azure-Gov, multi-part eCFR, a 7332 record class.
- `claude-plugin-recommendations.md` (Claude Code tooling for the user's machine). Move to `claude-config`. Its step 4 (disable `llm-application-dev`) has not been executed.
- `dev-prompts.md/` (prompt scratch). Delete, or move to `claude-config`.
- `timeline-weeks/` (claude-mem narrative history). Optionally move out of the repo.
- `app-comparison-2026-06-21.md` is about the cpa-backend vs rag-system choice. It belongs with `cpa-consulting` or in the archive.
- `STAFF-BOT-ONE-PAGER.md` is firm-specific end-user copy for an undeployed surface. Belongs in a client folder (the SDVOSB plan itself suggests `clients/pilot/`) or `apps/teams-bot/`.

### D. Other cross-file issues

- **Orphaned review:** `superpowers/specs/2026-10-02-local-llm-verification-REVIEW.md` is on main, but its spec is only on the unmerged branch `docs/local-llm-verification-spec`. Resolve by merging or dropping that branch.
- **No status banners on the specs:** 07-11 and 07-17 lack supersession banners although 08-03 declares it supersedes them. 07-06, 07-16 and 09-13 are fully implemented but still say "Approved design / ready for implementation".
- **Unresolved debts found only in the timelines/digests:** `ingestion_jobs` / `ingest_log` schema column mismatch (obs 216); parser `metadata` with no boundary validation (obs 774); delta-cursor silent full re-scan (obs 772). Verify, then carry them to ISSUES before deleting the timeline files.
- **Env-var naming drift across specs:** `RAG_ADMINS_GROUP_CLAIM` (07-06) vs `RAG_ADMINS_GROUP_ID` (07-17); `BOT_ENTRA_SSO_*` vs the actual `BOT_ENTRA_SSO_SCOPE` + `BOT_OAUTH_CONNECTION_NAME`; `INTERNAL_SCOPE_JWT_SECRET` (web) vs `_SECRETS` (API).

---

## Group 8-superpowers-plans-a

DIGEST — group: superpowers/plans {2026-07-06-web-app-per-user-auth, 2026-07-15-harness-readiness-remediation, 2026-07-16-answer-feedback-backend, 2026-07-16-e2e-autopilot-and-feedback, 2026-07-16-teams-bot}. I read every line of all 5 files and checked each against the code and git log. None of the 5 filenames is referenced from anywhere outside docs/; I grepped the whole repo excluding node_modules, .git, dist and docs/. No checkboxes are ticked in any plan (all `- [ ]`), so the checkboxes say nothing about status; status below comes from the code.

====================================================================

1. docs/superpowers/plans/2026-07-06-web-app-per-user-auth.md | 2406 lines | superpowers TDD implementation plan (16 tasks, about 85% verbatim code)
   STATUS: IMPLEMENTED (all 16 tasks), later hardened past the plan.
   Evidence:

- All planned files exist: packages/core/src/internal-scope-auth.ts(+test); apps/web/src/lib/{db,auth,scope-token,graph-client,admin-check,rag-api.test}.ts; apps/web/src/types/next-auth.d.ts; apps/web/src/app/api/auth/[...nextauth]/route.ts; apps/web/src/middleware.ts; apps/web/src/app/admin/access/{actions.ts,page.tsx}; tests/e2e/src/specs/internal-scope-auth.spec.ts.
- grantClientAccess, revokeClientAccess and listAssignmentHistoryForStaff are in packages/db/src/queries.ts.
- The env vars are in env.example (INTERNAL_SCOPE_JWT_SECRETS :251, INTERNAL_SCOPE_JWT_SECRET :261, AUTH_ENTRA_* :532, WEB_AUTH_MODE / RAG_API_STATIC_FALLBACK_TOKEN :562, RAG_ADMINS_GROUP_ID :572).
- Commits: 81642e7, 35544de, e8aba14, 08d7161, 9d9d89e, 74ddaf9, 7f39961, then fixes 664105d, bad24fb, db3e7eb, 7b2c895, e204e77, 5efdd4d, c170497, b287399, f60b70d, c481929, e285d89.
- The only planned file that no longer exists is apps/web/src/lib/env.test.ts (the smoke test). Plan #2 Task 10 deleted it on purpose.
  SUMMARY: Replaces the web app's shared static bearer token with Auth.js v5 + Entra ID sign-in. Per request, the BFF:
- resolves the signed-in user's `oid` to their allowed source ids via resolveSourceIdsForUser;
- signs a 60s HS256 scope-assertion JWT;
- presents that JWT to Fastify, where the new InternalScopeAuthProvider (added to the composite provider) maps it to a scoped Principal.
  It also adds:
- grant/revoke/history queries (soft-delete; a re-grant reactivates the existing row);
- a WEB_AUTH_MODE=static-fallback emergency rollback;
- a Graph client (email→oid lookup, plus a group check for the groups-overage case);
- an isAdmin gate based on the RAG-Admins AAD group;
- an /admin/access UI whose server actions re-check admin;
- an e2e spec for grant → token → revoke.
  UNIQUE DURABLE KNOWLEDGE (mostly also in code comments or the spec now):
- Fail-closed rule (L19): every new auth failure gives zero access, never the old shared-admin behaviour. Scope resolution throwing must not be caught into a default scope (also in a scope-token.ts comment).
- Identity key is AAD `oid`, never upn/email (L22). No is_admin column or roles table: admin = AAD group membership read from the `groups` claim, with a Graph fallback for overage (L23).
- The sign-in Entra app registration is deliberately separate from the connectors' MS_* client-credentials app. It needs delegated permissions, auth-code + PKCE, `groupMembershipClaims: "SecurityGroup"`, and redirect `<app>/api/auth/callback/microsoft-entra-id` (L991). Also in env.example, AZURE-DEPLOY-RUNBOOK and FRESH-DEPLOY-GUIDE.
- Secret rotation procedure: add the new secret, deploy, wait out ~60s, drop the old one (in an internal-scope-auth.ts comment).
- Server actions are public endpoints, so each must re-check admin itself (in an actions.ts comment).
- Post-implementation ops list (L2398-2406), including "remove RAG_API_TOKEN once stable" (already gone from apps/web) and "bootstrap the first admin by direct staff_client_assignments insert". The runbooks cover most of this.
- e2e makeTestConfig switched to `composite` so static-token and internal-scope tests can coexist.
  Nothing here is missing from the spec, code comments or env.example except possibly the first-admin bootstrap note.
  DEVIATIONS (code differs from plan):
- (a) Graph group check uses `POST /users/{id}/checkMemberGroups`, not the plan's `GET .../members/{id}/$ref`. The plan's version is not a documented Graph operation, and graph-client.ts records why.
- (b) The Graph token is cached in memory with a 60s safety margin.
- (c) A 64-hex-char (256-bit) minimum on scope secrets is enforced in signInternalScopeToken (f60b70d), not just "≥32 bytes".
- (d) Secrets can be given as a JSON array so a value may contain a comma.
- (e) Env naming: the plan is ambiguous ("SECRET(S)"). Shipped: plural INTERNAL_SCOPE_JWT_SECRETS (api/mcp verify) and singular INTERNAL_SCOPE_JWT_SECRET (web/teams-bot sign). The singular must be one of the plural list's values; env.example documents this.
- (f) The middleware /api/auth exemption is bounded to an exact or child path (664105d). The plan used startsWith, which also matched e.g. /api/authx.
- (g) static-fallback bypass was fixed to actually bypass the session gate and log its use (bad24fb).
- (h) Direct per-source grants (`staff_source_assignments`) were added later (c481929), so the scope is now a UNION of client-routed and direct grants.
- (i) The JWT `sub` is threaded into audit_log principal_subject (b287399).
- (j) Imports use no `.js` extensions (bundler moduleResolution).
- (k) The admin history view was wired up, and Next.js was bumped past CVE-2025-29927, a middleware-bypass CVE (c170497).
  STILL-OPEN TASKS: None in code. The ops items at L2400-2406 (Entra registration, RAG-Admins group, secrets, first-admin bootstrap) are tenant actions tracked in the runbooks. The static-fallback flag is meant to be removed "once stable" (L1531, L1606); it is still present.
  OVERLAPS: docs/superpowers/specs/2026-07-06-web-app-auth-design.md (295 lines) holds all the rationale:
- why the prior research recommendation was not followed;
- request flow, fail-closed semantics, admin role, migration/rollback;
- the Teams extension path.
  The plan duplicates the spec's constraints and adds only code. apps/web/CLAUDE.md already states the server-only credential and scope-token rule. Also mentioned in PLAN-POST-MERGE-FOLLOWUPS.md, AZURE-DEPLOY-RUNBOOK.md, ISSUES-AND-OPTIMIZATIONS.md.
  INBOUND REFS (outside docs/): none.
  RECOMMENDATION: archive. The code, the spec and env.example cover everything. Optionally move the Graph checkMemberGroups gotcha and the SECRET vs SECRETS relationship into apps/web/CLAUDE.md first.

==================================================================== 2) docs/superpowers/plans/2026-07-15-harness-readiness-remediation.md | 884 lines | superpowers implementation plan (10 tasks, config and tooling, no app code)
STATUS: IMPLEMENTED, with improvements.
Evidence:

- .prettierrc.json and .prettierignore exist.
- .husky/pre-commit and .husky/pre-push exist.
- scripts/check-secrets.mjs and scripts/check-file-sizes.mjs exist.
- Root scripts format, format:check, test:fresh, test:coverage, prepare=husky, plus a lint-staged block.
- vitest.config.ts thresholds: lines 56 / funcs 52 / branches 52 / stmts 55.
- ci.yml has a "Format check" step and a `parser` pytest job.
- .claude/rules/{tdd,quality-gates}.md exist; .claude/settings.json allows git status, diff and commit.
- README tree includes runtime and test-fixtures; CLAUDE.md has test:fresh, eval:real and "Conventions enforced mechanically".
- Commits 5d3823e, 0db2e6c, 9082b95, ba5a22f, 6b245f5, dd083ef, 5485415, 91c382a, 28d366e, 68f6033, bfc60f4, 5113a34, 38be5b1.
- readiness-report.md is at the repo root (b1a9407).
  SUMMARY: Takes harness readiness from Level 1 to Level 3. Moves enforcement from personal ~/.claude into the repo:
- default-settings prettier + CI format check;
- zero-dependency staged-file secret scan and 800-line file guard;
- husky + lint-staged pre-commit;
- pre-push that builds and runs unit tests, skipped when `.test-passed` already holds HEAD's SHA;
- agent permission allowlist;
- `test:fresh` for the fresh-clone dist/ trap;
- parser pytest in CI;
- path-scoped .claude/rules;
- v8 coverage with thresholds set at measured baseline minus 5;
- CLAUDE.md and README accuracy fixes.
  UNIQUE DURABLE KNOWLEDGE:
- Prettier `{}` defaults were chosen to keep the one-time reformat diff small.
- Thresholds = measured baseline minus 5, rounded down, then ratcheted up. They guard against regression and do not claim the 80% target (L737-745, L770). Worth stating in quality-gates.md, which currently does not mention coverage.
- `@vitest/coverage-v8` must match the vitest minor version (L711).
- `eslint --no-warn-ignored` exists because the root flat config ignores apps/web, which `next lint` covers instead (L355).
- `git checkout` and `git restore` are deliberately NOT allow-listed because they can discard work (L475).
- Out-of-scope backlog (L871-877): queries.ts refactor; runtime and gmail/gdrive/outlook connector tests; Level-4 AUTO-doc and drift validation; import/no-default-export; narrowing `Bash(pnpm --filter:*)`.
  Everything else now lives in CLAUDE.md, .claude/rules and script comments.
  DEVIATIONS:
- (a) vitest.workspace.ts was created, then removed. It was replaced by `projects` in the root vitest.config.ts, whose comment says so.
- (b) pre-push uses `pnpm -r --filter '!@rag/*e2e' run test` (this also excludes web-e2e) and test:fresh uses `--filter '!@rag/e2e'`. The plan's open question at L410 was resolved by excluding e2e.
- (c) The guard scripts read staged blobs, not the working tree (9082b95). They fail when nothing is staged or a file can't be read. More secret patterns were added (DB URL), plus guards against `git commit --no-verify` and `git add -f`.
- (d) pre-commit starts with `set -e`.
- (e) The allow rule is narrowed to `git commit -m:*`.
- (f) The queries.ts "do not extend" rule is breached in spirit. The grandfather list was not extended, but the file grew from 1240 to 1305 lines (the plan's L17 baseline vs now). Worth noting for consolidation.
  STILL-OPEN TASKS: Only the out-of-scope list at L871-877. Final verification step 4 (re-run readiness, expect Level 3) is claimed done in PILOT-LAUNCH-STATUS.md:164.
  OVERLAPS: readiness-report.md (repo root); PILOT-LAUNCH-STATUS.md:164; claude-plugin-recommendations.md; the 2026-09-13 web-e2e plan/spec (mentions .test-passed/husky). CLAUDE.md and .claude/rules/quality-gates.md now state the enforced conventions verbatim.
  INBOUND REFS (outside docs/): none. scripts/check-secrets.mjs:43 allow-lists `readiness-report.md`, not this plan.
  RECOMMENDATION: extract-rationale-into .claude/rules/quality-gates.md (coverage-threshold policy, coverage-v8 version pin, why apps/web is eslint-ignored), then archive. The backlog at L871-877 could go to ISSUES-AND-OPTIMIZATIONS.md.

==================================================================== 3) docs/superpowers/plans/2026-07-16-answer-feedback-backend.md | 622 lines | superpowers implementation plan (6 tasks; this is Phase 1 of plan #4)
STATUS: IMPLEMENTED except optional Task 6. The MCP `submit_feedback` tool was never built; apps/mcp/src/tools has no feedback file.
Evidence:

- answerId is minted with randomUUID in packages/services/src/ask.ts (:114 type, :425 mint).
- packages/db/drizzle/0018_answer_feedback.sql exists, with NULLS NOT DISTINCT at :14.
- schema.ts:437-470 defines answerFeedback.
- queries.ts has submitAnswerFeedback and getFeedbackStats (:703).
- packages/services/src/feedback.ts(+test) and apps/api/src/routes/feedback.ts(+test) exist.
- answerId flows through apps/mcp/src/tools/ask.ts structuredContent and apps/web/src/lib/stream-chat.ts.
- Commits 056d438, 29890ea, a23734d.
  SUMMARY:
- Mints a uuid answerId per answer, including the empty-retrieval short-circuit.
- Surfaces it on /ask JSON, the SSE done event and the MCP structuredContent; records it in audit_log.answer_id.
- Adds answer_feedback with a unique index on (answer_id, principal_subject) NULLS NOT DISTINCT. Votes are last-write-wins upserts.
- Adds `POST /feedback`, which returns 204. principal_subject comes from the server-side principal, never the request body.
  UNIQUE DURABLE KNOWLEDGE:
- answer_feedback.answer_id is deliberately NOT a foreign key to audit_log, because audit writes are fire-and-forget and the row may not exist. Also recorded in a schema.ts comment.
- NULLS NOT DISTINCT makes admin/anonymous re-votes (subject null) dedupe too. Drizzle's uniqueIndex cannot express this, so the hand-written SQL is the source of truth and the schema.ts declaration exists only for typing and `assertRequiredIndexes` parity (L212). This parity point is NOT in code comments; worth keeping (target: rag-postgres-contracts skill or a schema.ts comment).
- Comment confidentiality decision: cap 1000 characters, never sent to any external model, firm-internal ops signal only (L20). Only half captured: there is a schema.ts:452 comment, but env.example was never updated, contrary to plan #4 L101.
- answerId changes are additive-only, so consumers ignore unknown fields.
- The hand-authored migration rule, the `uuid_generate_v4` (not `gen_random_uuid`) rule and the monotonic journal rule are already in CLAUDE.md and the rag-postgres-contracts skill.
  DEVIATIONS:
- (a) Zod `answerId: z.string().uuid()` instead of `.min(1)` (a23734d).
- (b) channel is no longer hard-coded "web". It comes from the `X-RAG-Channel` header ("teams", else "web"). This feedback vocabulary (web|teams) intentionally differs from audit_log's (api|mcp|teams); feedback.ts explains why. That gotcha is not in CLAUDE.md.
- (c) The plan's service signature changed; principalSubject is passed in.
- (d) getFeedbackStats is defined but has no caller outside queries.ts: dead code. The plan's "admin view later" (L615) never happened.
  STILL-OPEN TASKS:
- Task 6 MCP submit_feedback (L592-607): not built.
- getFeedbackStats admin surfacing (L615): not built.
  OVERLAPS: Parent plan #4 Phase 1 repeats the same content in condensed form. docs/EVAL-AND-FEEDBACK.md (181 lines) covers the shipped feedback loop: 👍/👎, comment only on 👎, "new 2026-08-01". Also BACKUP-* runbooks and PILOT-LAUNCH-STATUS mention the table.
  INBOUND REFS (outside docs/): none. Its only references are plan #4 and docs/README.md.
  RECOMMENDATION: extract-rationale-into docs/EVAL-AND-FEEDBACK.md (no-FK reason, NULLS NOT DISTINCT / Drizzle limitation, channel vocabulary split, comment confidentiality rule, getFeedbackStats unused, MCP tool not built), then archive.

==================================================================== 4) docs/superpowers/plans/2026-07-16-e2e-autopilot-and-feedback.md | 277 lines | phased master plan (non-TDD, phases 0-7; references plan #3)
STATUS: PARTIAL, part superseded, part abandoned.

- P1 (feedback backend): done via plan #3.
- P2 (feedback UI): done, with deviations.
  - Web: apps/web/src/components/answer-feedback/, apps/web/src/app/api/feedback/route.ts, wired in chat-interface.tsx.
  - Teams, listed as a "follow-up": also done. apps/teams-bot/src/cards.ts has FEEDBACK_SUBMIT_KIND and 👍/👎 Action.Submit, handled in bot.ts and rag-client.ts.
  - The planned data-testids (question-input, send-button, answer, citation-{n}, disclaimer, citation-modal, download-original, feedback-helpful / feedback-not-helpful) were NOT added. The only ones that exist are assistant-message, citation-chip, citation-class, refusal and stream-error.
- P0.5 / P3 (Playwright): superseded. tests/web-e2e/ exists, created by a different plan (2026-09-13-web-e2e-kb-verification), with specs auth, compliance, grant, kb, seed and stack.
  - No `e2e:ui` script and no tests/e2e-ui directory.
  - No spec covers feedback (grep: zero).
- P4 (the `.claude/agents/e2e-autopilot.md` agent): ABANDONED. .claude/agents contains only rag-reviewer.md and retrieval-eval-runner.md, and the name appears nowhere in code.
- P5 (answer-quality judge): partly done in a different shape: tests/e2e/src/eval/{faithfulness.ts, gold-set.ts, gold-eval.ts, run-gold-eval.ts, corpus-cpa.ts, run-local-generation-eval.ts} and docs/EVAL-GOLD-SET-GUIDE.md. The planned docs/EVAL-ANSWER-BASELINE.md was never created; docs/README.md:119 already flags it as "cited but not found".
- P6 (real SharePoint corpus): gated, and taken over by later SharePoint and content-boundary work.
- P7: not done as specified.
  SUMMARY: Master plan to make the KB a trustworthy self-serve tool. Phases:
- answerId + feedback (backend, then UI);
- data-testids;
- a Playwright suite that logs in through static-fallback;
- an autonomous "e2e-autopilot" agent that builds, runs and fixes tests and delegates to other agents;
- an LLM-judge answer-quality gate with judge calibration;
- real SharePoint ingestion, gated on the P0 content audit and Azure credentials.
  Citation deep-linking is explicitly deferred.
  UNIQUE DURABLE KNOWLEDGE (worth extracting):
- C1 gotcha (L23, L81): with scoping enforced, a plain API_TOKENS token resolves to deny-all. A static-fallback test harness therefore needs an admin API_PRINCIPALS token, or a scoped principal that includes the seeded source. Otherwise every answer is the "not enough information" short-circuit; fix the token, not the app. Good CLAUDE.md "trip you up" / web-e2e README candidate. Verify first that web-e2e's fixtures/auth.ts handles it.
- Port collision (L20): Next dev and the API both default to 3000, so run web on another port and point RAG_API_URL at the API.
- Scope-testing honesty (L157, L257): the UI suite authenticates as one principal, so multi-user isolation stays the backend tests/e2e suite's job.
- Autopilot guardrails (L172-175):
  - never weaken compliance/security assertions;
  - never edit migrations, the schema.ts index block, or auth/scope code without human sign-off;
  - at most 3 iterations;
  - no --no-verify.
    Reusable if any autonomous fix-agent is revived.
- Judge calibration before any gate: hand-label about 10 answers and measure agreement (L201). Keep the seeded (fictional) and real (Doug) gold sets in separate, labelled files (L202).
- Comment free text is a new confidentiality vector (L101).
- Deferred feature: citation deep-linking needs char-offset tracking through parser → chunker → viewer (L263).
  STALE / WRONG:
- C2 (L194-196) rests on decision D2, "firm-SOP is Class A/B and OK for Gemini". docs/PLAN-LAUNCH-READINESS.md:18-29 now says D2 "inherits that error": a screen of the 858 indexed documents found client-identifying material, including 522 SSN-shaped values, inside the KB itself. The C2 reasoning must not be carried forward as-is.
- Line refs (ask.ts:60, chat-interface.tsx:129 etc.) and "ZERO data-testid" are outdated.
- It cites the non-existent EVAL-ANSWER-BASELINE.md (L200, L209).
  STILL-OPEN TASKS:
- P0.5 checklist L76-77 (moot);
- P2 test-ids L125/L131;
- P3 feedback flows and induced-failure artifacts L148, L155;
- P4 entirely, L171-182;
- P5 calibration, thresholds and baseline doc L201-211;
- P6 L223-237;
- P7 L249-259;
- citation deep-linking L263.
  OVERLAPS: Plan #3 duplicates Phase 1 in full. The 2026-09-13 web-e2e plan and spec replace P0.5/P3. EVAL-AND-FEEDBACK.md and EVAL-GOLD-SET-GUIDE.md cover P2 and P5 as built. PLAN-LAUNCH-READINESS.md covers D2. PILOT-MANUAL-RUNBOOK and AZURE-DEPLOY-RUNBOOK cover P6.
  INBOUND REFS (outside docs/): none. Inside docs: docs/README.md:119 and plan #3 L7.
  RECOMMENDATION: extract-rationale-into CLAUDE.md "Things that will trip you up" (C1 token-scope and port-3000 gotchas) and docs/EVAL-AND-FEEDBACK.md (judge-calibration rule, separate seeded/real gold sets, deep-link deferral, open backlog: autopilot, test-ids, feedback e2e). Then archive, with a header saying C2/D2 is invalidated, and fix docs/README.md:119.

==================================================================== 5) docs/superpowers/plans/2026-07-16-teams-bot.md | 778 lines | superpowers TDD implementation plan (9 tasks)
STATUS: IMPLEMENTED; the app has since grown beyond the plan.
Evidence:

- apps/teams-bot/src/ has auth, bot, cards, config, db, index, logger, manifest(+tests), rag-client and scope; plus manifest/{manifest.json, README.md, color.png, outline.png}, Dockerfile, railway.json, scripts/.
- The teams-bot service is in docker/compose.prod.yml:197.
- resolveSharedSourceIdsForUsers is at queries.ts:992; tests/e2e/src/specs/shared-source-scope.spec.ts exists.
- KNOWN_CHANNELS and channelFromRequest are at apps/api/src/routes/ask.ts:44-48.
- 29 commits on apps/teams-bot, from 8361296 / 985c1f5 / 38c0826 onward.
  SUMMARY: The Teams bot is another BFF:
- Teams SSO token exchange gives a verified `oid`; fail closed otherwise.
- DM scope = the asker's own grants. Channel/group scope = the intersection of all members' grants (HAVING count(DISTINCT user_id) = number of members), minus client_confidential sources.
- It mints the same 60s internal scope token and calls POST /ask with `X-RAG-Channel: teams`, which the API allowlists into audit_log.channel.
- Replies are single adaptive cards (answer + citations + server-sourced disclaimer; empty-scope; error).
- Deploys via Express /api/messages and /health, Railway or compose.
  UNIQUE DURABLE KNOWLEDGE:
- The channel scope must reuse the exact same grant UNION as resolveSourceIdsForUser so DM and channel can never disagree on what "a grant" is (L20). A channel never uses the asker's private grants (L434). An empty scope short-circuits before calling the API (L647). All of this is in the spec §3 and the code (bot.ts:91/302).
- X-RAG-Channel is allowlisted so an arbitrary header cannot pollute the audit vocabulary (L187-195); in the code.
- The disclaimer is always server-sourced, never hard-coded (L21).
- KbUnavailableError never echoes the upstream body (L485).
- "Do not guess the botbuilder SSO/CloudAdapter surface; confirm it against the installed SDK" (L331).
  Nothing that isn't already in the spec (docs/superpowers/specs/2026-07-16-teams-bot-design.md, 180 lines, which includes a "Rejected alternative" section) or in code comments.
  DEVIATIONS:
- (a) Plan said console.error; the code logs via pino (3915db1, logger.ts).
- (b) Added since the plan: MemoryStorage-based SSO exchange storage (single instance only, already in root CLAUDE.md); ephemeral conversation history for follow-ups ("decision B0", bot.ts:175); 👍/👎 feedback Action.Submit; a data-class label on cards (45c5dc2); user-facing failure reasons (1682e26); manifest.ts generator + test.
- (c) channelFromRequest returns the typed union "api" | "teams".
  STILL-OPEN TASKS: Only the out-of-scope items (L766-771): streaming, proactive/meeting surfaces, admin via bot, real branding and the Azure Bot resource (runbook). Multi-turn memory, listed out of scope at L769, has since been partly built.
  OVERLAPS:
- The spec (source of truth, cited at L13).
- PILOT-LAUNCH-STATUS.md:610 points at `docs/superpowers/{specs,plans}/2026-07-16-teams-bot*`. Update that row if the plan is archived.
- 2026-08-01-reranking-and-conversation-memory plan cites the spec :167.
- AZURE-DEPLOY-RUNBOOK covers the human steps.
  INBOUND REFS (outside docs/): none.
  RECOMMENDATION: archive. The code, the spec and root CLAUDE.md (teams-bot row, MemoryStorage note) cover it. Keep the spec. Fix the PILOT-LAUNCH-STATUS.md:610 pointer.

====================================================================
GROUP SECTION

Durable facts to extract (with suggested targets):

1. CLAUDE.md "Things that will trip you up":
   - (a) Static-fallback / test-harness token-scope trap (C1): with scoping enforced, a plain API_TOKENS token is deny-all, so every answer is "not enough information". Use an admin API_PRINCIPALS token or a scoped principal that includes the seeded source.
   - (b) Next dev and the API both default to port 3000.
   - (c) INTERNAL_SCOPE_JWT_SECRET (singular; web and teams-bot sign) must be one of INTERNAL_SCOPE_JWT_SECRETS (plural; api/mcp verify), and each must be at least 64 hex chars. Today this lives only in env.example.
2. apps/web/CLAUDE.md:
   - Admin = RAG-Admins AAD group (RAG_ADMINS_GROUP_ID) with a Graph fallback for groups overage via `POST /users/{id}/checkMemberGroups`; the `$ref` GET is not a real Graph operation.
   - The sign-in Entra app is separate from the connectors' MS_* app.
   - Server actions re-check isAdmin.
   - Update its BFF route list to include /api/feedback, /api/auth and /admin/access, which are currently missing from its table.
3. docs/EVAL-AND-FEEDBACK.md:
   - answer_feedback has no FK to audit_log (best-effort audit).
   - The NULLS NOT DISTINCT unique index is hand-SQL only because Drizzle can't emit it.
   - Last-write-wins vote semantics.
   - Feedback channel vocabulary (web|teams, from X-RAG-Channel) differs from audit_log's (api|mcp|teams).
   - Comment confidentiality rule: 1000 chars, never sent to external models. Also add it to env.example, which the plan required and which never happened.
   - getFeedbackStats exists but is unused; the MCP submit_feedback tool was never built.
   - Judge calibration before any threshold gate; seeded and real gold sets kept in separate files.
   - Citation deep-linking deferred (needs char offsets through parser and chunker).
4. .claude/rules/quality-gates.md:
   - Coverage thresholds = measured baseline minus 5, ratchet only.
   - @vitest/coverage-v8 must match the vitest minor version.
   - queries.ts has grown 1240 → 1305 lines despite "shrink, never extend".
5. rag-postgres-contracts skill: the schema.ts declaration of afb_answer_subject_unique exists for typing and assertRequiredIndexes parity; the migration SQL is authoritative.
6. ISSUES-AND-OPTIMIZATIONS.md or a backlog doc. Open items from these plans:
   - e2e-autopilot agent (abandoned);
   - planned data-testids (question-input, send-button, feedback-*);
   - a web-e2e feedback spec;
   - EVAL-ANSWER-BASELINE.md / judge thresholds;
   - MCP submit_feedback;
   - a getFeedbackStats admin view;
   - removing WEB_AUTH_MODE=static-fallback "once stable";
   - harness backlog: runtime and connector unit tests, AUTO-docs and drift checks, the no-default-export rule.

Warning for consolidation: plan #4's C2 reasoning ("firm-SOP is Class A/B, so sending it to Gemini or a Claude judge is within D2") is invalidated by PLAN-LAUNCH-READINESS.md:18-29, since client PII was found in the KB. Do not merge it into any permanent doc as current policy.

Overall recommendation for superpowers/plans/:

- These are execution scripts. About 80% of their bulk is verbatim code that has since drifted from the shipped code (Graph endpoint, secret length, imports, channel attribution, uuid validation), so they actively mislead an LLM reader about what the code does.
- Move every fully-implemented plan to an archive folder (e.g. docs/archive/superpowers/plans/), or delete them, since git history keeps them. Keep the specs/ design docs as the rationale record; they are shorter and hold the decisions.
- Before archiving: pull the gotchas listed above into CLAUDE.md, apps/web/CLAUDE.md, EVAL-AND-FEEDBACK.md and quality-gates.md, and put the open-task backlog in one living backlog doc.
- Add a one-line status header to each archived plan: implemented / partial / abandoned plus the main commit.
- For partial plans (#4), state which phases were superseded and by what (the 2026-09-13 web-e2e plan; the gold-set and faithfulness eval).
- Fix the two stale pointers: docs/README.md:119 (EVAL-ANSWER-BASELINE citation) and PILOT-LAUNCH-STATUS.md:610 (teams-bot plan glob).
- Nothing outside docs/ links to any of these 5 files, so moving them breaks no code references.

---

## Group 9-superpowers-plans-b

# Digest: docs/superpowers/plans group (8 files, 4,431 lines)

I read every line of all 8 files and checked each one against the code, `git log` and repo-wide greps.

Four cross-cutting problems first:

- **`docs/README.md:91-94` has stale statuses.** It lists local-generation as "Committed, ready", kb-content-boundary as "**Do first**" and reranking as "In flight". All three are wrong: the first two are done or overtaken, and reranking is done except A6.
- **`docs/PILOT-LAUNCH-STATUS.md:336-343` is stale and alarming.** It still says kb-content-boundary Task 1.1 (remove the roster) is "still an unchecked box… assume the roster is retrievable". The whole 858-doc index was purged on 2026-08-03 (`PURGE-RECORD-2026-08-03.md`), the rebuilt corpus is 47 docs, and Gate 1 got verbal sign-off on 2026-10-02 (`compliance/GATE-1-CONTENT-AUDIT.md`).
- **Firm data is committed in plan files.** This breaks the plans' own rules:
  - `kb-content-boundary.md:240-242` lists the firm's full staff roster by name, while the same file says the roster is "firm data → injected config, never committed".
  - `kb-content-boundary.md:307` contains the firm's legal name in a document title.
  - `generic-core…md:132` greps for a firm-name token.
  - Commit `82acfe0` ("remove the client name from the repository") shows this kind of scrub has been done before. These spots need the same treatment.
- **Three plan files are cited from code or `env.example`.** They can't be moved without updating these references:
  - `packages/core/src/content-safety.ts:5` → pii-redaction-before-index.md
  - `env.example:388` → pii-redaction-before-index.md
  - `packages/core/src/tri-scanner.ts:74` → tri-identifying-pattern-exemptions.md
  - None of the other five files has any inbound reference from outside docs/.

---

## 1. 2026-08-01-reranking-and-conversation-memory.md | 323 lines | TDD implementation plan (two tracks)

**Status: mostly implemented.** Track B (conversation memory) is complete. Track A (reranking) is done except A6, the enable-and-measure step.

- **A1 egress gate:** `efe4bcb`. Bonus fix `6fc48ab` refuses redirects, because `assertAllowed` only checks the first hop. See `reranker.ts:77-80`.
- **A2–A4:** `36ce4f7`.
  - A2: Jina `extraBody: { return_documents: false }` (`reranker.ts:176`).
  - A3: option (b), an additive `rerankScore` in `core/types.ts`.
  - A4: `complianceMode === "client-data"` refuses a hosted reranker (`reranker.ts:141-148`).
- **A5 (HNSW pool):** solved differently. `RAG-CRITICAL-REVIEW-2026-09-16.md:64` measured that `LIMIT 480` at `ef_search=100` returns only 100 rows. The fix is `resolveEfSearch` in `packages/db/src/hybrid-search.ts:227`, = max(40, override ?? 100, pool) clamped to 1000 (`f08849a`). It was not plumbed through `Retriever` as the plan proposed.
- **A6 open:** `RERANK_PROVIDER=none` (`env.example:369`). The readiness review marks H-5 🟡 Partial, "pending a vendor/DPA decision". Also tracked as `RAG-REVIEW-2026-09-16.md` R-3.
- **Track B:**
  - Condenser: `631c5c5` (`contextualize.ts`).
  - Follow-on fixes: `aa7afa8` (question TRI-screened before it is embedded) and `47806c1` (silent condensation fallback).
  - `history` is threaded through api/mcp/web/teams-bot.
  - Generator has no `history` references; there are no `sessionId` hits.
  - B0 pointers landed in `ARCHITECTURE.md:212`, `AUTH-AND-SESSIONS-RESEARCH.md:222` and `CPA-KB-ADOPTION-PLAN.md:218`.
  - Readiness review marks H-2 ✅ (`631c5c5`, `7591f9e`, `799cce8`).

**Summary:** Track A gates the hosted cross-encoder reranker on `EgressPolicy`, fixes its wire contract and score semantics, sets a TRI/client-data posture, then enables and measures it. Track B adds condensation: a small model call rewrites a follow-up into a standalone query, used for retrieval only, from bounded client-held history. Decision B0: ephemeral client-held history now, a server-side session store later. The plan reconciles two docs that contradicted each other on this.

**Unique durable knowledge:**

- **Phase 0b vendor contract (verified 2026-08):**
  - Cohere: v2 `/v2/rerank` takes string documents only; `return_documents` defaults to false; trial keys are limited to **10 req/min** (production 1,000).
  - Jina: `return_documents` **defaults to true** and echoes every chunk back; free tier 100 RPM, paid 500 RPM.
  - Default models `rerank-v3.5` and `jina-reranker-v2-base-multilingual` are live and not deprecated.
  - Explicitly unverified: Cohere per-search pricing (sources conflict by 2×), Jina token pricing, and whether Cohere's 500-token billing split makes ~800-token chunks bill as about 2 documents each.
- **The r1 rule-out doesn't apply here.** `cpa-consulting r1-retrieval-open-items.md:26` rules out query rewriting, but that is about single-turn vocabulary rewriting, not conversational condensation. The plan says "no document in either repo draws this distinction". `r2-domain-answer-quality.md:470-477` is the source of the reranker-before-rewriting order.
- **B0 rationale:** a server-side store would create a conversation-transcript retention surface the system has never had. `audit_log` stores only `questionHash`, and whether to retain question text is an open, unowned decision (P1 #5).
- **Seam rules for v2:**
  - `@rag/services` receives already-resolved history.
  - The turn-window policy lives only in the condenser (`maxTurns` default 6).
  - Client caps are DoS bounds, not policy.
  - Don't add `sessionId` until something honours it.
  - The rewritten query is used for retrieval only; the generator gets the original question.
- **Ordering decision:** the empty-candidates short-circuit runs before the egress check, and a test pins it.
- **Expected eval result:** `pnpm eval` will be flat at MRR 1.000 because the starter corpus can't tell reranked from unreranked. That flat result is not an argument for reverting.

Code comments and the B0 pointers capture part of this. The vendor facts, the r1 distinction and the retention argument are only here.

**Deviations:**

- B3: no separate `CompleteFn` was built in runtime. `ask.ts:340` uses the optional `deps.generator.complete?`, so condensation inherits the generator's egress and TRI policy.
- Rewrite output is TRI-screened, and a blocked rewrite falls back to the original question.
- Teams bot: `HISTORY_STORED_TURNS=20`, and it forwards `history.slice(-12)` (`bot.ts:188,324`). It is documented as the API request bound (`MAX_HISTORY_TURNS`), not policy. Even so, the plan's final grep `slice(-` would flag it.
- The AUTH doc dates B0 as 2026-09-16; the plan says 2026-08-01.
- MCP `search_documents` still prints the RRF `score` (`search-documents.ts:57`).

**Still open:** A6 (L172-183). A2 Step 3 (deliberate model-default choice) was presumably settled in `36ce4f7`; I didn't verify it. The plan's own checkboxes were never ticked after A1.

**Overlaps:** `PROTOTYPE-READINESS-REVIEW-2026-08-01.md` (H-2/H-5), `RAG-REVIEW-2026-09-16.md` and `RAG-CRITICAL-REVIEW-2026-09-16.md`, `AUTH-AND-SESSIONS-RESEARCH.md`, `CPA-KB-ADOPTION-PLAN.md`. No matching spec.

**Inbound from outside docs/:** none.

**Recommendation:** extract the rationale, then archive.

- B0 rationale, the seam rules and the r1-vs-condensation distinction → an ARCHITECTURE.md "Conversation memory" section or an ADR.
- Phase 0b vendor facts, the A6 trial-key warning and the "flat eval is expected" note → a reranking section (where `ISSUES-AND-OPTIMIZATIONS.md#4` lives, or env.example).
- Keep A6 tracked in RAG-REVIEW R-3.

## 2. 2026-08-03-generic-core-and-vertical-plugin.md | 353 lines | plan, self-marked ⛔ SUPERSEDED (L3-29)

**Status: abandoned/superseded.** The data-first packs spec replaced it.

- No `PluginRegistry`, `RagPlugin` or `APP_NAME` in code.
- No `packages/plugin-cpa`.
- `SYSTEM_PROMPT` in core is still the CPA prompt (`generator.ts:55`: "…CPA firm of roughly 20 staff… not a tax advisor", Karbon/BK-CATCHUP example at :91-96). No `systemPrompt` option and no `SYSTEM_PROMPT_PATH`.
- `@rag/core` and `@rag/rag` are still `"private": true` with no `files`.
- `packs/cpa/pack.yaml` exists, built by plan 7.

**Summary:** This was the build order for the 2026-07-17 tenancy/plugin spec: externalize the prompt, publish to npm, add a registry refactor, a `plugin-cpa` workspace package and a deployment repo, move compliance out of core last, and add per-tenant branding. Its banner sends readers to `specs/2026-08-03-multi-vertical-rag-platform-design.md` and keeps only §0/§1a as worth reading.

**Unique durable knowledge:**

- §0a: three-tier inventory of CPA-specific code in core, with file:line references:
  - Tier 1: the prompt; `REVIEW_STATUS`/`ANSWER_DISCLAIMER` in `services/ask.ts`; the TRI scanner; class A–D plus `ClassBlockedError` citing §314.4(f) and §7216.
  - Tier 2: `dataClassEnum`, `complianceMode`, the DPA check.
  - Tier 3: comments only.
- §0b: `apps/web` has no firm branding; the only hardcoded name is "RAG Knowledge Hub" (`layout.tsx:8`, `knowledge-base.tsx:35`).
- §0c packaging trap: `dist/` is gitignored and there's no `files`/`prepack`, so `npm pack` would ship source with no `dist/`.
- §0d: `cpa-consulting` has no package.json.
- **§1a prompt decomposition**, which slice 1a of the spec needs and doesn't contain:
  - Domain-neutral: untrusted-`<document>` handling, the `[N]` citation contract, A/B/C coverage (prefer B over C), conflicting sources, numbered near-verbatim steps, exact identifiers.
  - CPA-specific: the identity line, the "not a tax advisor" scope, the client-name rule, "SharePoint", the worked example.
- Decision: the consumer supplies a full replacement prompt, not a preamble concatenated with core's. `SYSTEM_PROMPT_PATH` must fail loud if unreadable. Ship the firm prompt in the same deploy that makes the default neutral (Task 1.5).
- Phase 2 rejected-options table for publishing:
  - GitHub Packages: classic PAT only, and the scope must equal the org login.
  - npm Teams: $7 per user per month.
  - git `path:` deps: pnpm#12304 silently resolved the repo root.
  - `file:`/`link:` and `catalog:`.
- Unconfirmed: whether the npm `@rag` scope is free.
- Task 4.4: enforce an import-boundary lint for any plugin package.

**Deviations:** not applicable (not built).

**Still open:** everything. Phase 6 `APP_NAME` (L338) and Phase 1 neutral prompt (L190-237) remain useful whatever mechanism wins.

**Overlaps:** `specs/2026-07-17-platform-tenancy-and-plugin-boundary.md` (still "Status: Design"), `specs/2026-08-03-multi-vertical-rag-platform-design.md` (§7 puts npm out of scope; slice 1a is the neutral prompt), `DECISION-CPA-KB-RAG-CONVERGENCE.md`.

**Inbound from outside docs/:** none. Inside docs: README.md, DOCUMENTATION-REVIEW-2026-08-03.md.

**Recommendation:** extract §0a, §0c and §1a, plus the Phase 2 rejection table and Task 4.4, into the multi-vertical spec (slice 1a / "prior discovery" appendix), then archive. Update the 07-17 spec status to Superseded. Drop the firm-name token from L132.

## 3. 2026-08-03-kb-content-boundary.md | 355 lines | remediation plan (compliance)

**Status: partial; largely overtaken by events.**

- **Phase 1:** superseded. The whole index was purged on 2026-08-03 instead of the targeted deletion in Task 1.1. The 858-doc corpus no longer exists; it was rebuilt as 47 screened docs. Gate 1 has verbal sign-off from Chris (2026-10-02) via `compliance/GATE-1-CONTENT-AUDIT.md`, and the written form is issue #82. `PILOT-LAUNCH-STATUS.md` was corrected.
- **Phase 2:** done.
  - `excludePaths` in `SharePointConfigSchema` (`70c936f`, `sharepoint/config.ts:37`): substring match, case-insensitive. A matching item that was indexed before is reported as a deletion, which also covers Task 6.2.
- **Phase 3:**
  - `path` was removed from `EXPOSABLE_METADATA_FIELDS`, and `webUrl` is handled too because it embeds the path (`metadata-policy.ts:52,99-101`).
  - `title` is still exposed (the deliberate non-fix in 3.3). I didn't confirm the reasoning is recorded in code.
- **Phase 4:** done differently.
  - Ingest-time redaction (`content-safety.ts`) plus a Layer 3 per-document classifier (`f13f707`, `classify-document.ts`). `CLASS_D_IDENTIFIERS` (ssn/ein/routing/card) quarantines C/D.
  - An undeclared source class fails closed to D.
  - There is also Layer 1.5, a semantic scanner (`ContentScanner`).
- **Phase 5:** no `screen-signoff.json`; superseded by the GATE-1 audit worksheet (`corpus-analysis/CONTENT-AUDIT-WORKSHEET.md`).
- **Phase 6.1 (re-screen worker job) and 6.3 (stale sign-off surfacing):** not built. Worker handlers are only docs-gap-digest, ship-audit-log and sync-source.

**Summary:** Written after the 2026-08-01 screen found a 522-SSN client roster and 339+ client-file documents in a `general` source. That broke the firm's core compliance claim (POL-01 §3, "connected to SharePoint and nothing else"). The plan sets a four-level filtering hierarchy, finds a citation leak, and lays out containment, structural exclusion, ingest gate, human review and ongoing re-screening.

**Unique durable knowledge:**

- **Filtering hierarchy, most to least reliable:** (1) source scope, (2) ingest gate, (3) citation/metadata boundary, (4) prompt instruction.
- **Root cause:** class was stamped per source, not per document (`docClass = sourceDocClass ?? "A"`).
- **Citation leak:** `buildCitations` passes `title`/`path` straight through, so a prompt rule against client names can never protect citations.
- **Sizing argument:** folder-inclusion rules beat content-pattern denylists. 73% of flagged docs sat in excludable folders.
- **POL-01 Class A test, verbatim:** "Would this be equally true if we had no clients at all?" Tie-breaker: "when you cannot tell, it is the higher class".
- **Unbuilt Class B obligation:** human de-identification before indexing, and "summarized, not quoted". That conflicts with the near-verbatim prompt, so the simplest resolution is to index Class A only.
- **§0f research:**
  - NER can't tell client names from staff names; no tool encodes entity role.
  - Presidio moved to community governance in June 2026 (2.2.363), so pin the version. Its PERSON F1 is 0.78 on news but 0.18–0.37 on business-style data, and it has no US_EIN recognizer.
  - Redaction costs >25% on comprehension Q&A (arXiv 2411.05978).
  - An LLM classifier got recall 0.80 / precision 0.54, and adding a critic made it worse (arXiv 2605.10211).
  - NIST SP 800-188; AWS pairs redaction with a second detector and quarantine.
  - Possible approach: roster cross-matching.
- **Title non-fix rationale:** the firm's own name matches person-name regexes, so never add a title name-scrubber.
- **Decisions the plan reserves for partners:** whether to exclude sandbox/draft folders (64% of the old corpus), and whether to index Class A only.
- **Anti-pattern guards:** exclude containers, not identities. Exclusion must happen before fetch, not after retrieval. Never put regexes in JSONB config (ReDoS).

**Deviations:**

- A built-in `DEFAULT_EXCLUDED_PATH_FRAGMENTS` list of firm-derived folder names lives in core (`content-safety.ts:238-249`: "client service package files", "billing & production analysis", "/va disability"…). That contradicts this plan's Global Constraint (L89) that firm folder names never go in committed `.ts`. The SharePoint schema comment says per-source `excludePaths` apply "on top of the built-in client-content denylist".
- Redaction plus quarantine replaced "refuse on SSN".
- A full purge replaced the targeted deletion.

**Still open:** 6.1 (L339), 6.3 (L341). Possibly the Class-A-only decision (L195, L328b). The final-phase checks (L345-355) are moot after the purge.

**Overlaps:** `PILOT-LAUNCH-STATUS.md`, `compliance/GATE-1-CONTENT-AUDIT.md`, `PURGE-RECORD-2026-08-03.md`, the pii-redaction plan (#5), the multi-vertical spec, `PLAN-LAUNCH-READINESS.md`, `RAG-REVIEW-2026-09-16.md`. Plan #2 (Task 4b.2) said to move this file to the deployment repo.

**Inbound from outside docs/:** none. Inside docs: README, DOCUMENTATION-REVIEW-2026-08-03, PLAN-LAUNCH-READINESS, RAG-REVIEW-2026-09-16, PILOT-LAUNCH-STATUS (stale at :336-343), generic-core plan, multi-vertical spec.

**Recommendation:** extract the rationale into a permanent compliance or content-boundary design doc (merged with #5 below), then archive.

- Strip the staff roster and firm name (L240-242, L307) first.
- Move firm-specific material (POL-01 quotes, folder names) to cpa-consulting.
- Fix PILOT-LAUNCH-STATUS:336-343.
- Decide whether `DEFAULT_EXCLUDED_PATH_FRAGMENTS` belongs in the pack rather than core.

## 4. 2026-08-03-local-generation.md | 944 lines | TDD implementation plan (slice 2 of the multi-vertical spec)

**Status: implemented.**

- Commits: `95df153` (credentials resolver), `8e5349a` (docs), `0a73474` (never forward a vendor key to a self-hosted endpoint), `6cd3069` (doc corrections).
- Files: `packages/core/src/generation-credentials.ts` and its test, `docs/LOCAL-GENERATION.md` (97 lines).
- Config `GENERATION_BASE_URL`/`GENERATION_API_KEY` (`config.ts:388-389`, `env.example:475-483`).
- Runtime uses the resolver (`runtime/index.ts:243`) and logs "generation using a self-hosted endpoint" (:324).
- Later extended by a Claude provider (`7c5549f`; generator.ts:545 `ANTHROPIC_DEFAULT_BASE_URL`).
- Checkboxes were never ticked.

**Summary:** Adds an OpenAI-compatible `baseURL` (Ollama/vLLM/LM Studio/llama.cpp) so a deployment can be air-gapped together with `EMBEDDING_PROVIDER=local`. Three fixes come with it:

- The egress pre-flight used to validate the hardcoded `api.openai.com` literal. It now checks the effective host.
- The generation key used to come from the embedding config, which disabled generation in the air-gapped case. The new resolver fixes that.
- The SDK requires a non-empty key, so a placeholder is sent to self-hosted endpoints.

`baseURL` under Gemini throws, and `triPolicy` is never inferred from the endpoint.

**Unique durable knowledge:** the **"Corrections" section (L15-51)**, which records four defects found after implementation:

1. A conditional spread `...(baseURL ? {baseURL} : {})` reopened the bypass. The OpenAI SDK defaults an absent key from `OPENAI_BASE_URL`. Lesson: pass security-relevant values unconditionally.
2. The plan claimed Google's SDK has no base-URL knob. It does (`httpOptions.baseUrl`, plus env `GOOGLE_GEMINI_BASE_URL`), so `GeminiGenerator` now pins `baseUrl` explicitly. Lesson: verify SDK capability claims against the SDK's types before writing a security rationale.
3. `EMBEDDING_API_KEY` doesn't exist; the real variables are `GEMINI_API_KEY`/`OPENAI_API_KEY`.
4. Credential precedence had to change to explicit → placeholder-if-baseURL → inherited, so a hosted vendor's key is never sent to a "local" URL (which could be an SSH tunnel).

A fifth defect: an empty-string test that passed vacuously, so it couldn't tell `||` from `??`.

The specific facts are now in code comments (`generator.ts:254,410`) and LOCAL-GENERATION.md. The two generalized lessons (1 and 2) are not recorded anywhere else.

Out-of-scope items still open: local reranking, a local audit-log sink, and evaluating self-hosted model quality. Auto-relaxing `triPolicy` was decided against, not deferred.

**Deviations:**

- The shipped code differs from tasks 1, 2 and 4 exactly as the Corrections section describes.
- The OpenAI client uses `effectiveBaseURL = opts.baseURL ?? OPENAI_DEFAULT_BASE_URL`, passed unconditionally.
- `GeminiGenerator` refuses `baseURL` even when constructed directly.

**Still open:** Task 4 Step 6 (a real run against Ollama). I couldn't verify it was done. The web-e2e plan later measured an 8b model at ~5s per call, which suggests the path works.

**Overlaps:** multi-vertical spec §5, §5.1, §5.2 and §8 (the design). `docs/LOCAL-GENERATION.md` is this plan's Task 5 output, almost word for word.

**Inbound from outside docs/:** none. Inside docs: README (stale "ready"), DOCUMENTATION-REVIEW-2026-08-03, generic-core plan.

**Recommendation:** extract the Corrections lessons, generalized, into an egress-policy and security section of ARCHITECTURE.md or a "security review lessons" doc. Add the out-of-scope list to the spec's backlog. Then archive.

## 5. 2026-08-03-pii-redaction-before-index.md | 120 lines | design note (not a TDD plan); status header "✅ Built (confirmed 2026-09-16)"

**Status: implemented.**

- `packages/core/src/content-safety.ts` (`36774de`, rewired onto the pack engine in `54ec25b`, overlap coalescing in `e8d1681`).
- Tables and titles also redacted (`f09bb3c`).
- Layer 3 classifier: `f13f707`.
- Layer 2 path exclusion: `isExcludedPath`, `DEFAULT_EXCLUDED_PATH_FRAGMENTS`, plus SharePoint `excludePaths`.
- Fail-closed quarantine: `ContentSafetyError`, `ContentScanFailure`, and a missing or empty pack is treated as a configuration gap (`pipeline.ts:190-209`).

**Summary:** Sets the constraint that redaction must happen **before the embedding call**, since embeddings go to Gemini. Redacting only before storage protects the database but still discloses the document, which is exactly what happened on 2026-08-03. Three layers:

1. Deterministic pattern redaction: SSN, EIN, ABA checksum, account numbers, Luhn.
2. Structural path exclusion, the highest-value layer.
3. A per-document classification gate.

Redaction must fail closed. Verification replays `corpus-analysis/PRE-PURGE-MANIFEST-2026-08-03.jsonl` (17 high / 338 review / 503 clean) and uses golden over- and under-redaction tests. Re-ingest goes through a staging source first.

**Unique durable knowledge:**

- Redaction sits between parse and embed, and the redactor itself must make no network calls.
- Names can't be caught by patterns; client billing files were found by folder, not content.
- Redaction can't un-disclose what was already sent. The 2026-08-03 disclosure to Google is a question for counsel.
- Over-redaction risk: 316 of the 355 hits merely name a form, so precision matters as much as recall.

**Deviations:**

- The doc's Layer 1 table suggests matching bare 9-digit SSN runs. The shipped `ssn` pattern is delimiter-anchored, and bare runs go to a context-gated `ssn-unformatted`.
- Layer 1.5, a semantic LLM content scan (`scanForClientContextOrThrow`, `CONTENT_SCAN_PROVIDER`), was added and isn't in this doc.
- I couldn't verify whether the manifest replay (step 1) was run.

**Still open:** Layer 3 before the corpus widens (L117) is now built. Manifest replay evidence is unconfirmed.

**Overlaps:** kb-content-boundary (#3: same layers, more evidence), `specs/2026-08-31-sensitive-content-discovery-design.md`, `RAG-REVIEW-2026-09-16.md`, `PURGE-RECORD-2026-08-03.md`.

**Inbound from outside docs/:** `packages/core/src/content-safety.ts:5` ("Design: docs/superpowers/plans/2026-08-03-pii-redaction-before-index.md") and `env.example:388`.

**Recommendation:** keep the content, but move it. It is the code-cited design rationale, not a plan. Merge it with #3's rationale into a permanent doc such as `docs/compliance/CONTENT-SAFETY-DESIGN.md`, add Layer 1.5, and update both inbound references.

## 6. 2026-08-31-tri-identifying-pattern-exemptions.md | 104 lines | open design-decision note (not a plan)

**Status: open; nothing implemented, by design.**

- No `TRI_ALLOWED_PATTERNS` or exemption mechanism.
- The EIN pattern is still unanchored (`tri-scanner.ts:64`).
- `TRI_IDENTIFYING_LABELS` = SSN, SSN-unformatted, EIN (:163-166).
- The code points back to this doc (`tri-scanner.ts:72-74`).
- Commit `ad93706` recorded it. It was raised by PR #35 review finding 6.

**Summary:** Identifying TRI labels hard-block whatever `GENERATION_TRI_POLICY` says, so a single false-positive EIN-shaped string (`/\b\d{2}[-\s]\d{7}\b/`) permanently 422s every question whose top-k retrieval pulls in that chunk. The only escape is `off`, which also disables SSN detection everywhere. Options:

- A: per-label, per-source or per-document exemptions, with an audit entry on every exempted match.
- B: a proximity requirement on EIN.
- C: wait.

**Unique durable knowledge:**

- The policy table (block/warn/off × contextual/identifying) and the hole in it.
- `SSN-unformatted` (PR #36) collides with a 9-digit routing number next to "TIN", the classic W-9 note. Its false-positive rate is unmeasured; it post-dates the 858-doc screen.
- Option B would silently lose recall, because the existing fixture "Employer ID 12-3456789" already has context. New fixtures are needed first.
- §7216 argues for preferring a false block over a false pass, so B plus a recall check.
- The 422 should name the label that fired and the remedy.

None of this is in code beyond the pointer.

**Deviations:** none.

**Still open:** all of it — measure (L80), decide (L85), improve the error message (L89).

**Overlaps:** the pack-scanner plan (#7) explicitly defers `tri-scanner.ts` here. Also `PILOT-LAUNCH-STATUS.md`. Note the ingest-side pack (`packs/cpa/pack.yaml`) and the generation-side `tri-scanner.ts` now duplicate the SSN/EIN pattern definitions.

**Inbound from outside docs/:** `packages/core/src/tri-scanner.ts:74`.

**Recommendation:** keep it as a live open decision, but move it out of plans/ to `docs/decisions/` or an open-questions register, or convert it to a GitHub issue. Update the tri-scanner.ts:74 pointer.

## 7. 2026-09-01-pack-scanner-slice.md | 1103 lines | TDD implementation plan (plan 1 of 2)

**Status: implemented.**

- 10 commits: `88d8296` schema, `b9b646c` registry, `a11b44c` loader, `53d1bdc` (rejects 0.x caret ranges and guards a malformed core version), `482a639` engine, `ecc35ba` (fixes a context-regex `lastIndex` leak and a sticky-flag drop path), `54ec25b` redactText rewire, `5137d42` cpa pack and exports, `e8d1681`, `8ac3e51` (review fix wave).
- Files: `packages/core/src/pack/{schema,registry,load,scan}.ts` plus tests and `cpa-pack.test.ts`. `PACK_CONTRACT_VERSION = "1.0.0"`.
- **Plan 2 (discovery service, `scan_*` tables, admin API): not built.** There are no `scan_` tables in schema.ts.

**Summary:** Moves identifier patterns out of TypeScript into `packs/cpa/pack.yaml`, behind a generic `scanText()` engine. Finding and replacing are split:

- `scanText` emits every match with stable input offsets and `high`/`low` confidence.
- `applyRedaction` masks high-confidence matches right to left.
- `redactText(input, pack)` keeps its existing behaviour.

Validators and context matchers (`luhn`, `aba`, `account-vocab`) are referenced from the pack by name and resolved to compiled-in code; nothing is loaded dynamically. Pack/core compatibility uses a caret range against the pack contract version and fails closed.

**Unique durable knowledge:** most of it is already in code comments:

- the total-confidence rule (a gate failure changes the label, never drops the finding);
- why replacement runs right to left;
- the PACK_CONTRACT version is not the npm version.

Only here:

- the explicit non-scope list (tri-scanner, `classification.yaml`/`prompt.md`/conformance suite, disposition wiring — `classify-document.ts` keeps its own `CLASS_D_IDENTIFIERS`);
- the known follow-on: mapping a `ScanMatch` offset back to `ParsedTable.sheetName` is undesigned.

**Deviations:**

- The pack also declares an `ssn-unformatted` scanner.
- Hardening the plan didn't have: rejecting 0.x caret ranges, the `lastIndex` fix, and coalescing overlapping spans.
- The pipeline requires a pack (`PipelineDeps.pack`; worker `config.worker.scannerPackDir`, default `packs/cpa`), and an empty pack is treated as missing.
- `redactParsedDocument` covers tables and titles.

**Still open:** plan 2 (discovery), migrating tri-scanner to the pack, and wiring disposition to the pack (L1088-1093, L1103).

**Overlaps:** `specs/2026-08-31-sensitive-content-discovery-design.md` §3 is the design; multi-vertical spec §3.2, §3.4, §3.6. The spec covers the same ground plus plan 2.

**Inbound from outside docs/:** none. Inside docs: PILOT-LAUNCH-STATUS.

**Recommendation:** archive. The code and the spec are the source of truth. Copy the non-scope list and the sheetName follow-on into the discovery spec's open items first.

## 8. 2026-09-13-web-e2e-kb-verification.md | 1129 lines | TDD implementation plan

**Status: implemented,** with deviations.

- 16 commits, `0ab73a2` to `3f01313`.
- Files: `tests/web-e2e/{package.json, playwright.config.ts, src/env.ts, fixtures/{auth,corpus,sse}.ts, setup/{global-setup,ingestion,seed,seed-main,stack}.ts, specs/{auth,compliance,grant,kb,seed,stack}.spec.ts}`.
- `data-testid`s `assistant-message`, `citation-chip`, `refusal`, `stream-error` and `data-doc-id` are in `chat-interface.tsx`.
- `EMPTY_ANSWER` is exported from `services/ask.ts:117`.
- `.husky/pre-push` uses `'!@rag/*e2e'`.
- `.github/workflows/web-e2e.yml` exists.

**Summary:** A Playwright suite runs four processes: docker (Postgres + parser), the compiled `apps/api`, `next start`, and Playwright. It seeds a two-document nonce fixture corpus with the local ONNX embedder, grants fixture-user access, and mints an Auth.js JWE session cookie. It tees the SSE stream without buffering it, and asserts four invariants:

- citations resolve to real documents;
- the nonce document is self-retrieved;
- an out-of-corpus question is refused, not confabulated;
- rendered chips equal the citations the BFF sent.

Mutation checks prove each assertion can fail. CI needs no secrets.

**Unique durable knowledge:** the Global Constraints (L15-25) are a list of harness gotchas:

- No `test` script, or pre-push would boot docker.
- Don't import from `@rag/e2e` (no exports/main).
- Embedder env must match between seeding and querying, or retrieval silently degrades to the sparse channel.
- `runOneIngestion` ignores the `CHUNK_SIZE` env var and defaults to 800, so pass 512 explicitly.
- Gemini plus a base URL throws.
- `API_TOKENS` must be non-empty.
- API and web both default to port 3000 and collide.
- `INTERNAL_SCOPE_JWT_SECRET` (web, singular) and `INTERNAL_SCOPE_JWT_SECRETS` (API, plural) must hold the same ≥64-char value.
- `AUTH_URL` is required under `next start` (trustHost).
- Use `start`, never `dev`, which loads the developer's `.env`.
- Fixtures must avoid `1099`/`W2` near an amount.
- Assert a non-empty chip set first, or `[].every()` passes vacuously.
- Copying `EGRESS_ALLOWED_HOSTS` to a deployed service would drop the Gemini host, because the setting replaces rather than merges.

Also here:

- Auth.js `encode` needs `salt` equal to the cookie name (no default); the cookie has no `__Secure-` prefix on http.
- Classify a refusal with `.includes(EMPTY_ANSWER)` because branch C appends "Closest related material".
- Measured refusals do carry a citation.

**Deviations:**

- **`EMPTY_ANSWER` is duplicated as a literal in the web app**, which the plan forbade (L806). Importing `@rag/services` pulls `onnxruntime-node` into the Next client bundle and breaks `next build`. The comment is at `chat-interface.tsx:11-18`; this gotcha is worth keeping.
- ONNX seeding is isolated in a child process (`seed-main.ts`, `3f01313`).
- The smoke spec was dropped.
- CI runs `test:browser:ci`, which uses `--grep-invert @needs-8b-model` (4 `kb.spec` tests are tagged). Ollama/8b is not installed in CI; the plan's Task 9 had CI pull llama3.1:8b.
- The workflow is path-filtered plus `workflow_dispatch`.
- Playwright ^1.64.1.

**Still open:** Task 9 Step 4 (measure the wall clock) appears done: spec L358-372 has measured warm and cold numbers. The 8b-dependent assertions don't run in CI.

**Overlaps:** `specs/2026-09-13-web-e2e-kb-verification-design.md` (31.5K) overlaps heavily, holds the rationale and the measurements, and still says "ready for an implementation plan".

**Inbound from outside docs/:** none, and no docs/ references either. There is no `tests/web-e2e/README`.

**Recommendation:** extract the Global Constraints gotchas plus the `EMPTY_ANSWER` bundling gotcha and the CI `@needs-8b-model` split into a new `tests/web-e2e/README.md` (or the spec's "Operating notes"). Then archive the plan and update the spec's status.

---

## GROUP SECTION

**Durable facts to extract (suggested targets):**

1. **ARCHITECTURE.md, conversation-memory section or ADR:**
   - B0 is a sequencing answer, not a winner. The reason is the transcript-retention surface.
   - Seam rules: services receive resolved history; the window policy lives only in the condenser; client caps are DoS bounds; no `sessionId` until something honours it.
   - The rewrite is used for retrieval only.
   - Conversational condensation is not the r1 "query rewriting" rule-out. (From #1.)
2. **Reranking doc, `ISSUES-AND-OPTIMIZATIONS.md#4` or env.example:**
   - Cohere/Jina contract facts: Jina `return_documents` defaults to true; Cohere trial keys are 10 req/min and the reranker fails silently back to RRF order.
   - Unverified pricing claims.
   - A flat eval at MRR 1.0 is expected.
   - The `resolveEfSearch` interaction, so ef_search covers the pool. (From #1.)
3. **New `docs/compliance/CONTENT-SAFETY-DESIGN.md`**, merging #5 with #3's rationale. Update `content-safety.ts:5` and `env.example:388` to point at it. Contents:
   - redact before embed;
   - the four-level filtering hierarchy;
   - the citation-leak finding;
   - folder-inclusion beats pattern denylists;
   - why there's no NER/Presidio gate, with the research numbers and arXiv IDs;
   - the never-add-a-title-scrubber reasoning;
   - fail closed;
   - the over-redaction precision warning;
   - the unbuilt Class B obligation;
   - the open re-screen job (6.1) and stale-sign-off surfacing (6.3).
4. **Egress/security lessons in ARCHITECTURE.md (egress section):**
   - SDKs default absent options from env (`OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`), so pass security-relevant values unconditionally.
   - Verify SDK capability claims against types.
   - Never forward an inherited vendor key to a self-hosted URL.
   - "Looks local" is not a security property.
   - Redirects are refused because `assertAllowed` only sees the first hop.
     (From #4 and #1.)
5. **Multi-vertical spec, slice 1a appendix:** #2's §1a prompt decomposition, §0a tiered CPA-in-core inventory, §0c npm packaging trap and the publishing rejection table. The CPA prompt is still in core (`generator.ts:55`).
6. **Open-decisions register:** #6 in full. Also the duplication of SSN/EIN patterns between `tri-scanner.ts` and `packs/cpa/pack.yaml`. Also the question of whether `DEFAULT_EXCLUDED_PATH_FRAGMENTS` (firm-derived folder names in core) should move into the pack.
7. **`tests/web-e2e/README.md`:** #8's harness gotchas and the `@rag/services` bundling trap.

**Hygiene fixes the consolidation should make regardless:**

- Scrub the staff roster and firm name from `kb-content-boundary.md:240-242,307` and `generic-core…md:132`.
- Fix the stale `PILOT-LAUNCH-STATUS.md:336-343`.
- Fix the stale statuses at `docs/README.md:91-94`.
- Update spec statuses: 07-17 tenancy → Superseded; 09-13 web-e2e → Implemented; 08-31 discovery → plan 1 done, plan 2 not started.

**Overall recommendation for `superpowers/plans/`:**

- Treat completed TDD plans as historical. The code and the specs are the source of truth, and their embedded code blocks are now stale copies.
- After extraction, move #1, #2, #3, #4, #7 and #8 to `docs/archive/superpowers-plans/`, or delete them, since git history keeps them.
- #5 and #6 aren't plans at all; one is a design and one is an open decision. Move them to permanent homes (`docs/compliance/`, `docs/decisions/`) and update the three code/env pointers.
- Leave only in-flight plans in `plans/`. In this group that's none. A6 reranking enablement and discovery plan 2 should be tracked as issues or spec open-items, not left in these files.
- Going forward, require each plan to carry a status header (Implemented / Partial / Superseded, with commit range), as #2 and #5 already do, so a reader doesn't need git archaeology.
