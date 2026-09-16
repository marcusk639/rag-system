# RAG System Review — 2026-09-16

**Status:** Current · **Date:** 2026-09-16 · **Scope:** the whole RAG pipeline, from SharePoint ingestion to cited answers in web chat, Teams, and MCP
**Prepared by:** Claude Code (Opus 5) for Marcus Klein

**Summary.** The design is careful. Access checks fail closed, prompt-injection defences are in place, re-ingestion is safe to repeat, and the generation prompt is unusually well built. The weaknesses are in four places: **redaction has gaps** (spreadsheet rows, stored originals, citation paths); **context assembly works against procedure questions** (the per-document cap, score ordering, missing titles); **deletions can be lost**; and **no real answer is measured for quality**. This document lists every finding with its evidence, why it matters, and a concrete fix, followed by a phased plan.

> **Implementation update (2026-09-16).** Most findings are now fixed on branch
> `fix/rag-review-findings` (built on `fix/rag-retrieval-review`). See
> [§11 Implementation status](#11-implementation-status) for what changed, the
> commit for each finding, what was deferred and why, and the new issues the
> work uncovered. **Deploying it requires a full re-sync:** the content
> processing version changed, so every document re-chunks and re-embeds once.

---

## Contents

1. [How to read this document](#1-how-to-read-this-document)
2. [Executive summary](#2-executive-summary)
3. [How the system works today](#3-how-the-system-works-today)
4. [What the system does well](#4-what-the-system-does-well)
5. [Findings index](#5-findings-index)
6. [Detailed findings](#6-detailed-findings)
   - [A. Data safety and compliance](#a-data-safety-and-compliance)
   - [B. Answer quality](#b-answer-quality)
   - [C. Retrieval and ranking](#c-retrieval-and-ranking)
   - [D. Ingestion robustness](#d-ingestion-robustness)
   - [E. Evaluation, feedback, and observability](#e-evaluation-feedback-and-observability)
   - [F. API surface and operations](#f-api-surface-and-operations)
7. [Planned capabilities vs. what is built](#7-planned-capabilities-vs-what-is-built)
8. [Documentation drift](#8-documentation-drift)
9. [Open questions and decisions](#9-open-questions-and-decisions)
10. [Recommended roadmap](#10-recommended-roadmap)
11. [Implementation status](#11-implementation-status)
12. [Appendix A — Method and sources](#appendix-a--method-and-sources)
13. [Appendix B — Glossary](#appendix-b--glossary)

---

## 1. How to read this document

Each finding has an **ID**, a **severity**, a **verification level**, and an **effort estimate**.

### Severity

| Level        | Meaning                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Client data can reach the index, a vendor, or a user in a way the compliance design forbids, and nothing notices.       |
| **High**     | Answers are materially wrong or incomplete for common questions, or a compliance control is weaker than the docs claim. |
| **Medium**   | Real defect, but narrow in scope, latent at today's corpus size, or covered by another control.                         |
| **Low**      | Hygiene, consistency, or a future hazard.                                                                               |

### Verification level

| Label         | Meaning                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verified**  | Confirmed by reading the cited code during this review.                                                                                                         |
| **Reported**  | Found by a code trace or an existing review doc (for example `PROTOTYPE-READINESS-REVIEW-2026-08-01.md`), not re-read line by line here. Confirm before acting. |
| **Plausible** | Inferred from code plus provider behavior; needs a test or a production log to confirm.                                                                         |

### Effort

**S** = under half a day · **M** = one to three days · **L** = more than three days, or needs a decision first.

Line numbers refer to `main` at commit `7486747`.

---

## 2. Executive summary

### Verdict

The architecture fits the job. One Postgres database holds documents, vectors, the keyword index, and the job queue, which is right at this scale, and the layering (`@rag/core` → `@rag/services` → thin app adapters) keeps each invariant in one place. What's missing is at the edges: the places where redaction doesn't reach, and the step that assembles chunks into model context.

### The five things to fix first

| #   | Finding                                                                                                                          | Why now                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | [S-1](#s-1-spreadsheet-rows-are-indexed-without-redaction) Spreadsheet rows skip redaction                                       | Identifiers in `.xlsx` files can reach Postgres and the Gemini embedding API. |
| 2   | [S-2](#s-2-a-failed-deletion-is-lost-permanently) A failed deletion is lost permanently                                          | A file removed from SharePoint for compliance can stay searchable forever.    |
| 3   | [S-3](#s-3-stored-originals-are-unredacted-and-downloadable) Downloads serve unredacted originals                                | Downloading a cited document bypasses redaction completely.                   |
| 4   | [Q-1](#q-1-the-per-document-cap-truncates-procedures) + [Q-2](#q-2-context-is-ordered-by-score-not-by-document) Context assembly | The cap and the ordering cut and scramble SOP steps, the main use case.       |
| 5   | [E-1](#e-1-no-real-answer-is-ever-quality-scored) No real answer is quality-scored                                               | Every other tuning decision is guesswork until this exists.                   |

### Suggested sequence

1. **Close the data-safety gaps** (S-1 to S-4). The changes are small and confined to ingestion, and they carry compliance exposure.
2. **Rebuild context assembly** (Q-1 to Q-4), then re-embed. At 210 chunks, re-embedding is cheap.
3. **Build the gold set and its runner** (E-1 to E-3). They unlock evidence-based work on follow-ups, no-answer thresholds, and reranking.
4. **Prepare retrieval for scale** (R-1, R-2) before the corpus grows past a few thousand chunks.

Section 10 has the full plan with acceptance criteria.

---

## 3. How the system works today

### 3.1 Purpose and users

The system is a **staff knowledge bot for a CPA firm of about 20 people**. Staff ask how the firm does things: "how do I set up a new bookkeeping client", "what is the time code for catch-up work", "where does the engagement letter template live". Answers must:

- come **only from the firm's own documents**, with numbered `[N]` citations;
- reproduce procedure steps and identifiers **near-verbatim** (paraphrasing a procedure is how errors creep in);
- give the covered part plus an explicit "Not covered by the documents:" line when coverage is partial, and refuse only when nothing relevant was retrieved;
- **surface conflicts** between documents rather than silently picking one;
- carry a **"Draft — requires practitioner review"** label on every answer (Circular 230 §10.37).

The request came from Doug, the firm's heaviest requester, who wanted an "AI bot in Teams for the knowledge base" (`STAFF-BOT-ONE-PAGER.md`).

### 3.2 Surfaces and how they are consumed

| Surface          | State                                | Auth                                      | Notes                                                                                                                          |
| ---------------- | ------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`       | **Live** on Railway since 2026-08-01 | Entra SSO → per-request scope token (BFF) | Streams answers over SSE; 👍/👎 feedback.                                                                                      |
| `apps/teams-bot` | Built, **not deployed**              | Entra SSO                                 | Blocked on the Azure subscription and tenant app-upload policy. Single instance only (`MemoryStorage`). 20-second ask timeout. |
| `apps/mcp`       | Live                                 | Static token                              | For agent clients.                                                                                                             |
| `apps/api`       | Live                                 | Static tokens, OIDC, or composite         | The shared backend; web and Teams call it.                                                                                     |

**Multi-turn.** Decision B0 (2026-08-01) says follow-up questions will be rewritten into standalone questions from in-memory history, used for **retrieval only**; the original question still drives generation. It is designed but not built (see [Q-5](#q-5-follow-up-questions-are-not-supported)).

### 3.3 Compliance constraints

| Control            | Requirement                                                             | How the code meets it                                                                            |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **CR-1** (§7216)   | No taxpayer return information (TRI) to an outside API without consent. | TRI scanner at ingest, identifier redaction, TRI pre-flight before generation, egress allowlist. |
| **CR-3**           | Vendors must be US-located.                                             | Gemini paid tier under the Cloud DPA; `COMPLIANCE_MODE=client-data` forces local embeddings.     |
| **CR-13 / CR-14**  | Circular 230 review label; no client-facing AI path.                    | `reviewStatus` and `disclaimer` stamped server-side (`packages/services/src/ask.ts:51-57`).      |
| **Content policy** | Class A only: "would this be equally true if we had no clients at all?" | Per-document class gate at ingest; Class C/D quarantined with an audit row.                      |

Counsel sign-off (P0 gate #2) is still open.

### 3.4 Current production state

As queried on 2026-09-07 (`PILOT-LAUNCH-STATUS.md`):

- **47 documents / 210 chunks**, one source, all Class A, all `gemini-embedding-001` at 768 dimensions.
- The earlier 858-document corpus was **deliberately purged on 2026-08-03** because it held client data. 47 is the TRI-screened rebuild, not a bug.
- The scanner flagged 6 documents and blocked 2 on the last two syncs.
- Generation: `gemini-2.5-flash`, `maxOutputTokens=2048`, temperature 0.2.
- Retrieval: `DEFAULT_TOP_K=12`, `MAX_CHUNKS_PER_DOCUMENT=3`, weights 0.7 vector / 0.3 keyword, reranking **off**.
- WAL archiving is live, with zero failures.

### 3.5 End-to-end flow

```
 SharePoint ──► Connector (delta) ──► Parser sidecar ──► Safety gates ──► Chunker ──► Embedder ──► Postgres
                 list pages,           MarkItDown →        path exclude,     markdown /    Gemini       documents,
                 tombstones            Unstructured        TRI scan,         table         768-d        chunks (HNSW
                                                            redaction,                                   + tsvector)
                                                            class gate
                                                                                                          │
 User ──► web / Teams / MCP ──► API ──► scope check ──► embed query ──► hybrid SQL (vector + keyword, RRF)
                                                                                  │
                                              per-document cap ◄─────────────────┘
                                                     │
                                          prompt (numbered <document> blocks)
                                                     │
                                          TRI pre-flight ──► Gemini ──► answer + [N]
                                                                             │
                                          citations filtered to the cited [N] ──► draft label ──► audit log
```

**Ingestion** (`apps/worker`, `packages/ingestion/src/pipeline.ts`)

1. `triggerSync()` writes one `ingestion_jobs` row and enqueues a pg-boss job with a per-source singleton key.
2. The worker pages through the connector. Each page holds new or changed documents plus deletion tombstones.
3. Each document is parsed to markdown (and `tables` for spreadsheets), then checked against the path denylist, scanned for TRI, redacted, and classified. Class C/D documents are quarantined.
4. A content hash skips unchanged documents. Otherwise the document is chunked (~800 tokens, 120 overlap, heading path prepended), embedded in one batch, and written in one transaction.
5. Tombstones delete their documents; the cursor is saved after every page.

**Retrieval** (`packages/rag/src/retrieval/retriever.ts`, `packages/db/src/queries.ts:543`)

1. The caller's source filter is intersected with the principal's enforced scope. An empty scope returns nothing.
2. The query is embedded with the query-side task type.
3. One SQL statement runs a vector search (HNSW, restricted to the active embedding model) and a keyword search (OR-semantics `tsquery`, `ts_rank_cd`), each capped at `topK × 8`, then fuses them with weighted Reciprocal Rank Fusion (k = 60).
4. Scope and metadata filters apply to the fused set; the top `topK` rows come back, with scores normalized so the best is 1.0.

**Generation** (`packages/services/src/ask.ts`, `packages/rag/src/generation/generator.ts`)

1. Results are capped per document. If none remain, a fixed "not enough information" answer returns without calling the model.
2. Chunks become `<document index title section modified>` blocks, escaped against injection.
3. The whole prompt is scanned for TRI. Identifying patterns always block; others follow `GENERATION_TRI_POLICY`.
4. The model answers. Citations are filtered to the `[N]` indices the answer actually uses (grouped forms like `[1, 2]` and `[1-3]` included).
5. The API logs the question **hash**, retrieved chunk IDs, top score, and answer ID. Feedback references the answer ID.

---

## 4. What the system does well

Keep these. Several were hard-won and are easy to break by accident.

| Strength                                    | Where                                                  | Why it matters                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Scope enforcement cannot be bypassed        | `Retriever.search(query, authz)`, `queries.ts:554-601` | `authz` is a required positional argument; an empty scope short-circuits before SQL; the caller filter can only narrow.               |
| Prompt-injection hardening                  | `generator.ts:41-148`                                  | Documents are marked as untrusted data; titles, sections, and bodies are escaped; `modified=` is shape-validated rather than escaped. |
| A system prompt that encodes the job        | `generator.ts:41`                                      | Near-verbatim steps, three explicit coverage modes, conflict surfacing, client-name suppression, and a worked example.                |
| An honest audit trail for citations         | `generator.ts:162-214`                                 | Only cited indices survive, and grouped citation forms are parsed rather than silently dropped.                                       |
| Keyword search that works on real questions | `queries.ts:676-732`                                   | OR-semantics fixed a 33% zero-match rate, and lexemes are `quote_literal`-wrapped so pasted URLs don't break the query.               |
| Embedding-model isolation                   | `queries.ts:747-749`                                   | Vector search only compares chunks embedded by the same provider and model.                                                           |
| A fail-closed sensitivity gate              | `pipeline.ts:296-461`, `classify-document.ts`          | A missing scanner pack blocks ingestion; source class is a ceiling, not a verdict; quarantine writes a durable audit row.             |
| Safe re-ingestion                           | `pipeline.ts:463-558`                                  | A content hash skips unchanged documents, including the "hash matches but zero chunks" straggler case.                                |
| Guarded sync orchestration                  | `apps/worker/src/handlers/sync-source.ts`              | Singleton jobs per source, a stuck-cursor backstop, and bounded pages per job.                                                        |
| Purpose-built table chunking                | `packages/rag/src/chunking/table-chunker.ts`           | Row groups repeat the header row; financial models stay whole; freeform sheets fall back to markdown.                                 |
| Startup index guard                         | `packages/db/src/required-indexes.ts`                  | Boot fails if the HNSW index, GIN index, or tsvector trigger is missing, a failure with no other symptom.                             |
| Draft labelling set server-side             | `ask.ts:51-57`                                         | A typed field that no client or transport can drop.                                                                                   |

---

## 5. Findings index

| ID                                                                                 | Finding                                                                  | Area       | Severity | Verification | Effort |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- | -------- | ------------ | ------ |
| [S-1](#s-1-spreadsheet-rows-are-indexed-without-redaction)                         | Spreadsheet rows are indexed without redaction                           | Safety     | Critical | Verified     | S–M    |
| [S-2](#s-2-a-failed-deletion-is-lost-permanently)                                  | A failed deletion is lost permanently                                    | Safety     | Critical | Verified     | S      |
| [S-3](#s-3-stored-originals-are-unredacted-and-downloadable)                       | Stored originals are unredacted and downloadable                         | Safety     | High     | Verified     | S      |
| [S-4](#s-4-folder-paths-are-exposed-in-citations)                                  | Folder paths are exposed in citations                                    | Safety     | High     | Verified     | S      |
| [S-5](#s-5-sharepoint-permissions-are-not-carried-into-the-index)                  | SharePoint permissions are not carried into the index                    | Safety     | High     | Reported     | L      |
| [S-6](#s-6-document-titles-are-not-redacted)                                       | Document titles are not redacted                                         | Safety     | Medium   | Reported     | S      |
| [S-7](#s-7-path-exclusion-is-hardcoded-sharepoint-only-and-late)                   | Path exclusion is hardcoded, SharePoint-only, and late                   | Safety     | Medium   | Reported     | M      |
| [S-8](#s-8-class-c-and-class-d-are-not-distinguished)                              | Class C and Class D are not distinguished                                | Safety     | Medium   | Reported     | M      |
| [S-9](#s-9-scanner-disposition-is-modeled-but-ignored)                             | Scanner disposition is modeled but ignored                               | Safety     | Low      | Reported     | M      |
| [S-10](#s-10-the-egress-allowlist-does-not-cover-gemini-redirects)                 | The egress allowlist does not cover Gemini redirects                     | Safety     | Low      | Reported     | M      |
| [Q-1](#q-1-the-per-document-cap-truncates-procedures)                              | The per-document cap truncates procedures                                | Quality    | High     | Verified     | S      |
| [Q-2](#q-2-context-is-ordered-by-score-not-by-document)                            | Context is ordered by score, not by document                             | Quality    | High     | Verified     | M      |
| [Q-3](#q-3-the-document-title-is-never-embedded)                                   | The document title is never embedded                                     | Quality    | High     | Verified     | S      |
| [Q-4](#q-4-truncated-answers-are-not-detected)                                     | Truncated answers are not detected                                       | Quality    | Medium   | Plausible    | S      |
| [Q-5](#q-5-follow-up-questions-are-not-supported)                                  | Follow-up questions are not supported                                    | Quality    | High     | Verified     | M      |
| [Q-6](#q-6-the-no-answer-shortcut-almost-never-fires)                              | The no-answer shortcut almost never fires                                | Quality    | Medium   | Verified     | M      |
| [Q-7](#q-7-one-flagged-chunk-blocks-the-whole-answer)                              | One flagged chunk blocks the whole answer                                | Quality    | Medium   | Verified     | S      |
| [Q-8](#q-8-dates-duplicates-and-supersession-are-not-used-in-ranking-or-citations) | Dates, duplicates, and supersession are not used in ranking or citations | Quality    | Medium   | Reported     | M      |
| [Q-9](#q-9-images-and-screenshots-are-dropped)                                     | Images and screenshots are dropped                                       | Quality    | Low      | Reported     | L      |
| [Q-10](#q-10-the-two-answer-paths-build-citations-differently)                     | The two answer paths build citations differently                         | Quality    | Low      | Verified     | S      |
| [R-1](#r-1-filters-run-after-fusion-so-scoped-users-can-get-thin-results)          | Filters run after fusion, so scoped users can get thin results           | Retrieval  | Medium   | Verified     | M      |
| [R-2](#r-2-enabling-reranking-silently-caps-the-candidate-pool)                    | Enabling reranking silently caps the candidate pool                      | Retrieval  | Medium   | Verified     | M      |
| [R-3](#r-3-reranking-is-off-and-not-ready-to-turn-on)                              | Reranking is off and not ready to turn on                                | Retrieval  | Medium   | Reported     | M      |
| [R-4](#r-4-keyword-scores-are-not-length-normalized)                               | Keyword scores are not length-normalized                                 | Retrieval  | Low      | Reported     | S      |
| [R-5](#r-5-ranking-silently-depends-on-cosine-distance)                            | Ranking silently depends on cosine distance                              | Retrieval  | Low      | Reported     | S      |
| [I-1](#i-1-a-parse-or-embedding-failure-drops-a-document-with-no-retry-record)     | A parse or embedding failure drops a document with no retry record       | Ingestion  | High     | Reported     | M      |
| [I-2](#i-2-tables-inside-word-and-pdf-files-are-not-table-aware)                   | Tables inside Word and PDF files are not table-aware                     | Ingestion  | Medium   | Reported     | M      |
| [I-3](#i-3-no-minimum-chunk-size)                                                  | No minimum chunk size                                                    | Ingestion  | Medium   | Reported     | S      |
| [I-4](#i-4-the-parser-has-no-ocr-strategy-or-server-side-timeout)                  | The parser has no OCR strategy or server-side timeout                    | Ingestion  | Medium   | Reported     | S      |
| [I-5](#i-5-overlap-is-sized-by-a-character-estimate)                               | Overlap is sized by a character estimate                                 | Ingestion  | Low      | Reported     | S      |
| [I-6](#i-6-calculator-spreadsheets-add-noise)                                      | Calculator spreadsheets add noise                                        | Ingestion  | Low      | Reported     | S      |
| [E-1](#e-1-no-real-answer-is-ever-quality-scored)                                  | No real answer is ever quality-scored                                    | Evaluation | High     | Reported     | M      |
| [E-2](#e-2-the-ci-retrieval-eval-cannot-detect-regressions)                        | The CI retrieval eval cannot detect regressions                          | Evaluation | High     | Reported     | M      |
| [E-3](#e-3-negative-feedback-cannot-be-diagnosed)                                  | Negative feedback cannot be diagnosed                                    | Evaluation | Medium   | Verified     | M      |
| [E-4](#e-4-class-c-blocking-is-only-unit-tested)                                   | Class C blocking is only unit-tested                                     | Evaluation | Medium   | Reported     | S      |
| [E-5](#e-5-the-browser-suite-runs-a-different-model-than-production)               | The browser suite runs a different model than production                 | Evaluation | Medium   | Reported     | S      |
| [E-6](#e-6-the-real-eval-script-can-destroy-data)                                  | The real-eval script can destroy data                                    | Evaluation | Medium   | Reported     | S      |
| [E-7](#e-7-teams-has-no-feedback-buttons)                                          | Teams has no feedback buttons                                            | Evaluation | Low      | Reported     | S      |
| [F-1](#f-1-generation-continues-after-the-client-disconnects)                      | Generation continues after the client disconnects                        | Operations | Medium   | Verified     | S      |
| [F-2](#f-2-clients-can-request-100-chunks-of-context)                              | Clients can request 100 chunks of context                                | Operations | Medium   | Verified     | S      |
| [F-3](#f-3-the-web-proxy-has-no-upstream-timeout)                                  | The web proxy has no upstream timeout                                    | Operations | Medium   | Verified     | S      |
| [F-4](#f-4-teams-reports-every-failure-as-unavailable)                             | Teams reports every failure as "unavailable"                             | Operations | Low      | Reported     | S      |

---

## 6. Detailed findings

Each finding follows the same shape: **what we found**, **evidence**, **why it matters**, and **recommendation**.

### A. Data safety and compliance

#### S-1. Spreadsheet rows are indexed without redaction

**Severity:** Critical · **Verification:** Verified · **Effort:** S–M

**What we found.** The Layer 1 identifier redaction rewrites only the document's markdown. Spreadsheet chunks are built from the parser's separate `tables` structure, which is never redacted.

**Evidence.**

- `packages/ingestion/src/pipeline.ts:379` — `redacted = redactOrThrow(parsed.markdown, deps.pack)`
- `packages/ingestion/src/pipeline.ts:422` — `parsed.markdown = redacted.text` (the only write-back)
- `packages/rag/src/chunking/composite-chunker.ts:42-55` — spreadsheets are detected from `document.tables` and chunked from each `table`

**Why it matters.** When the scanner masks an identifier rather than quarantining the whole file, the raw value can survive in the table chunks. It is then stored in Postgres and sent to the Gemini embedding API. That is the CR-1 exposure the redaction layer exists to prevent. `PILOT-LAUNCH-STATUS.md` lists it as backlog; it should be treated as a blocker.

**Recommendation.**

1. Apply the same pack redaction to every table cell (headers and rows) before chunking, or regenerate `tables` from the redacted markdown.
2. Hash the redacted table content, so a redaction-only change re-embeds.
3. Add a regression test: an `.xlsx` fixture with an SSN-shaped cell must produce chunks with no raw identifier.

---

#### S-2. A failed deletion is lost permanently

**Severity:** Critical · **Verification:** Verified · **Effort:** S

**What we found.** When deleting a tombstoned document throws, the error is logged and swallowed. The cursor is then saved regardless.

**Evidence.**

- `packages/ingestion/src/pipeline.ts:217-241` — `try { deleteDocumentByExternalId(...) } catch (err) { log.error(...) }`
- `packages/ingestion/src/pipeline.ts:246-247` — `cursor = page.nextCursor; await updateSourceCursor(...)` runs whatever the deletes did
- `packages/connectors/src/sharepoint/index.ts:190-197` — the delta link is stored once a page is drained; Graph does not resend a tombstone the caller has moved past

**Why it matters.** A transient database error during a delete leaves the document and its chunks searchable **forever**, with no signal that the source deleted it. A client file removed from SharePoint for compliance reasons would keep answering questions.

**Recommendation.**

1. Record failed tombstones in a small `pending_deletions (source_id, external_id, attempts, last_error)` table and retry them at the start of every sync. This is better than holding the cursor, because it doesn't stall document updates.
2. Alternatively, don't advance the cursor for a page with any failed delete, and let pg-boss retry the job.
3. Add a periodic reconciliation job: list the source's external IDs and delete any indexed document that no longer exists. This also catches deletions missed for any other reason.
4. Regression test: make the delete throw once; the next sync must remove the document.

---

#### S-3. Stored originals are unredacted and downloadable

**Severity:** High · **Verification:** Verified · **Effort:** S

**What we found.** The object store keeps the raw source bytes. Citations mark a document downloadable whenever an original exists.

**Evidence.**

- `packages/ingestion/src/pipeline.ts:529-531` — `objectStore.put(storageKey, source.content, source.mimeType)` stores the unmodified file
- `packages/rag/src/generation/generator.ts:216-227` — `downloadable: r.document.hasOriginal ?? false`
- Platform spec §3.8 says scrubbed documents must not be downloadable. That rule isn't implemented.

**Why it matters.** Redaction protects the index but not the download button. A user who clicks a citation gets every identifier the scanner masked.

**Recommendation.**

1. Persist `redactionCount` (or a `wasRedacted` flag) on the document row at ingest.
2. Set `downloadable = hasOriginal && !wasRedacted && docClass === "A"`, and enforce the same rule in the download route itself, not only in the citation flag.
3. Optionally, show a "redacted — original not available" label on the citation.

---

#### S-4. Folder paths are exposed in citations

**Severity:** High · **Verification:** Verified · **Effort:** S

**What we found.** `path` is on the metadata allowlist returned to clients.

**Evidence.** `packages/core/src/metadata-policy.ts:51`. Phase 3 of `superpowers/plans/2026-08-03-kb-content-boundary.md` planned to remove it.

**Why it matters.** SharePoint folder names at a CPA firm often contain client names or engagement identifiers. The prompt tells the model not to repeat client names, but the path goes straight to the UI and never passes through the model.

**Recommendation.** Remove `path` from `EXPOSABLE_METADATA_FIELDS`. Keep it internally for path exclusion. If users need location context, expose only the top-level library name.

---

#### S-5. SharePoint permissions are not carried into the index

**Severity:** High (design limitation) · **Verification:** Reported · **Effort:** L

**What we found.** The connector captures title, URL, path, author, and timestamps, but never calls the Graph `/permissions` endpoint. Access is enforced **per source**, not per document.

**Evidence.** `packages/connectors/src/sharepoint/index.ts:283-346` (`toSourceDocument`); `docs/ARCHITECTURE.md` "What this system is NOT".

**Why it matters.** A document SharePoint restricts to partners is visible to every principal granted that source. The design documents say this openly, but the pilot's "Class A only" posture assumes restricted material is never synced. That depends on connection scope and folder exclusions, not on enforced permissions.

**Recommendation.**

- **Short term:** document the assumption in `PILOT-LAUNCH-STATUS.md`. Scope the SharePoint source to libraries whose permission is "all staff", and add a sync-time check that warns when an item has unique (broken-inheritance) permissions.
- **Longer term:** capture a permission fingerprint per document (group IDs), store it, and filter retrieval by the user's group memberships from the Entra token. That is a real authorization feature; decide it explicitly (see [§9](#9-open-questions-and-decisions)).

---

#### S-6. Document titles are not redacted

**Severity:** Medium · **Verification:** Reported (PR #41 review) · **Effort:** S

**What we found.** Titles come from Word properties or the first heading and skip the redaction pass. They are shown in citations and sent to the model in the `title=` attribute.

**Why it matters.** "2024 Smith Family 1040 Notes" is a title. The TRI pre-flight may catch some patterns in titles; the ingest redactor does not.

**Recommendation.** Run the same redaction over `title` (and `headingPath` entries) at ingest, and include them in the class decision.

---

#### S-7. Path exclusion is hardcoded, SharePoint-only, and late

**Severity:** Medium · **Verification:** Reported · **Effort:** M

**What we found.**

- The client-folder denylist (`DEFAULT_EXCLUDED_PATH_FRAGMENTS`) is hardcoded in `packages/core/src/content-safety.ts` (around line 225).
- It is applied in `pipeline.ts:320-337` **after** the file is downloaded and parsed.
- Only the SharePoint connector supplies `metadata.path`. Every other connector logs a warning and skips the check, rather than failing closed.

**Why it matters.** Three problems:

1. It contradicts the content-boundary plan (exclusions belong in per-source config, never committed) and the platform rule that core has zero product-specific rules.
2. Excluded files are still downloaded and parsed, which is wasteful and a larger exposure surface.
3. Adding Gmail, Outlook, or Drive as a source would silently lose the protection.

**Recommendation.**

1. Move exclusions to a per-source `excludePaths` setting, applied in the connector's listing step so files are never fetched.
2. Keep the core denylist only as a defense-in-depth default, loaded from the vertical pack rather than hardcoded.
3. Fail closed (quarantine) when a connector can't supply a path and exclusions are configured.

---

#### S-8. Class C and Class D are not distinguished

**Severity:** Medium · **Verification:** Reported · **Effort:** M

**What we found.** The data-class enum collapses C and D (see the warning in the repo's `CLAUDE.md`). The PR #41 review found the Class C escalation branch is dead code, and a stale comment in `pipeline.ts` says the default class is `'A'` when it is `'D'`.

**Why it matters.** Today both are quarantined, so nothing leaks. But any future change that lets C through for a de-identified workflow also lets D through, and the only guard is unit tests (see [E-4](#e-4-class-c-blocking-is-only-unit-tested)).

**Recommendation.** Give C and D distinct enum values, remove the dead escalation branch or make it reachable, fix the comment, and add an end-to-end test for each class.

---

#### S-9. Scanner disposition is modeled but ignored

**Severity:** Low · **Verification:** Reported · **Effort:** M

**What we found.** Pack scanners declare a `disposition` (`flag`, `redact`, `exclude`), carried through `pack/schema.ts:95`, `load.ts:88`, and `scan.ts:92`. Nothing branches on it: every high-confidence match is masked, and the document is quarantined only if it escalates to Class D.

**Recommendation.** Implement the three behaviors, or remove the field until they're needed, so pack authors aren't misled. The spec makes `exclude` the default for identifying scanners.

---

#### S-10. The egress allowlist does not cover Gemini redirects

**Severity:** Low · **Verification:** Reported (documented in code) · **Effort:** M

**What we found.** `@google/genai` exposes no redirect or custom-fetch hook, so the egress allowlist validates only the first hop (`packages/rag/src/embeddings/gemini.ts:54-60`).

**Recommendation.** Track it as known. If `COMPLIANCE_MODE=client-data` is ever used with a hosted Gemini path, replace the SDK call with a small hand-rolled `fetch` that refuses redirects.

---

### B. Answer quality

#### Q-1. The per-document cap truncates procedures

**Severity:** High · **Verification:** Verified · **Effort:** S

**What we found.** Retrieval fetches exactly `topK` (12) chunks. The per-document cap (3) then removes extras, and nothing replaces them.

**Evidence.** `packages/services/src/ask.ts:128-131` (and `:208-211` for streaming): `capChunksPerDocument(await deps.retriever.search(buildQuery(...)), maxChunksPerDocument)`. The cap itself is at `ask.ts:19-32`.

**Why it matters.** The most common question is "how do I do X", and the answer is usually one SOP. If that SOP spans five chunks, the model sees three of them, possibly steps 1, 2, and 5, and is instructed to reproduce the steps near-verbatim and in order. The result is a confidently incomplete procedure. The context also silently shrinks below 12 chunks.

**Recommendation.**

1. **Backfill:** over-fetch (for example `topK × 3`), apply the cap, then take the first `topK`.
2. **Expand the winners:** for the top one or two documents, fetch neighboring chunks by `ordinal` (±1–2) or the whole section, within a token budget. This is the standard "small-to-big" pattern and fits SOPs well.
3. **Budget by tokens, not chunk count**, for example 6–8k tokens of context.
4. Validate on the gold set ([E-1](#e-1-no-real-answer-is-ever-quality-scored)).

---

#### Q-2. Context is ordered by score, not by document

**Severity:** High · **Verification:** Verified · **Effort:** M

**What we found.** `buildPrompt` emits chunks in fused-score order, each with its own index. Three chunks of one SOP become `[1]`, `[4]`, and `[7]`, interleaved with other documents, in whatever order they scored.

**Evidence.** `packages/rag/src/generation/generator.ts:128-157` (`buildPrompt`) and `:216-227` (`buildCitations`, one citation per chunk).

**Why it matters.**

- The model has to reassemble a procedure from out-of-order fragments; a middle step can easily end up first.
- Citations list one document several times, which reads as corroboration from multiple sources when it isn't.
- Conflict detection is harder, because two versions of one SOP are not visibly grouped.

**Recommendation.**

1. Group results by document; within a document, sort chunks by `ordinal`.
2. Order the groups by their best chunk's score.
3. Emit **one `<document index=N>` block per document**, with its chunks inside in reading order (optionally marking gaps, for example `[…]`).
4. Build citations per document, keeping the chunk IDs as a list for the audit trail.
5. Update the citation filter and the web chips to match, and re-run the prompt quality pass (the prompt comment says these properties are load-bearing).

---

#### Q-3. The document title is never embedded

**Severity:** High · **Verification:** Verified · **Effort:** S (plus a re-embed)

**What we found.** The chunk text that gets embedded starts with the heading path only. Documents with no markdown headings, which is common for Word and PDF output, fall into a single section with an empty heading path, so their chunks carry no identifying context at all.

**Evidence.**

- `packages/rag/src/chunking/markdown-chunker.ts:55-61` — the header is built only from `section.headingPath`
- `markdown-chunker.ts:151` — the fallback section has `headingPath: []`
- `packages/ingestion/src/pipeline.ts:568` — `embedder.embedBatch(chunks.map((c) => c.text))`

**Why it matters.** A chunk reading "3. Apply the template and route for signature" matches many SOPs equally. With "New Client Onboarding SOP › Setup" in front of it, the vector and the keyword index both know which procedure it belongs to. This is one of the cheapest retrieval wins available.

**Recommendation.** Prefix every chunk's **embedded and indexed** text with `Title › heading path`. Either store it in `text` or keep a separate `embed_text`, so the displayed text stays clean. Content hashes will change, so every document re-embeds once (210 chunks: seconds and cents). Run `pnpm eval` before and after.

---

#### Q-4. Truncated answers are not detected

**Severity:** Medium · **Verification:** Plausible · **Effort:** S

**What we found.** The Gemini generator sets `maxOutputTokens: 2048`, with no thinking configuration and no check of `finishReason`.

**Evidence.** `packages/rag/src/generation/generator.ts:386-394` (answer) and `:408-416` (stream).

**Why it matters.** On `gemini-2.5-flash`, thinking is on by default and thinking tokens draw on the output budget. A long, multi-document procedure can come back cut off mid-step, or even empty, and the user sees a partial answer with no warning. The P0 #0 run (51/51 answered) suggests this is not frequent today, but nothing would reveal it if it were.

**Recommendation.**

1. Set `thinkingConfig.thinkingBudget` explicitly (a small budget, or 0 if quality holds on the gold set).
2. Read `finishReason`. On `MAX_TOKENS`, log a marker and append a visible "Answer truncated — ask a narrower question" notice.
3. Emit a metric for truncation rate.

---

#### Q-5. Follow-up questions are not supported

**Severity:** High (product) · **Verification:** Verified · **Effort:** M

**What we found.** Every surface sends a single `question`. There is no history field in the API schema, the web client, or the Teams client.

**Evidence.** `apps/api/src/routes/ask.ts:17-22` (`AskBody`), `apps/teams-bot/src/rag-client.ts:61` (`JSON.stringify({ question })`). Decision B0 in `superpowers/plans/2026-08-01-reranking-and-conversation-memory.md` (Track B) is unbuilt.

**Why it matters.** Chat users naturally ask "what about for payroll clients?" or "and who approves that?". Retrieval on such text returns noise, and the answer is a refusal or something off-topic. Users read this as the bot being broken.

**Recommendation.** Implement B0 as designed:

1. Accept an optional `history` (at most 12 turns / 4,000 characters) on `/ask` and `/ask/stream`, validated with zod.
2. Use a cheap model call to rewrite the latest turn into a standalone question, **for retrieval only**; generation still receives the original question plus the rewritten one.
3. Skip the rewrite when there is no history, or when a heuristic says the question is already standalone.
4. Scan history with the TRI pre-flight too.
5. Add the pointer to `ARCHITECTURE.md` that B0 required.

---

#### Q-6. The no-answer shortcut almost never fires

**Severity:** Medium · **Verification:** Verified · **Effort:** M

**What we found.** The fixed "not enough information" answer is returned without a model call **only when retrieval returns zero rows**. Vector search always returns its nearest neighbors, and the OR-semantics keyword search matches broadly, so retrieval almost never returns zero. Scores are also normalized so the top result is always 1.0, which hides absolute relevance.

**Evidence.** `packages/services/src/ask.ts:133` (`retrieved.length === 0`); `packages/db/src/queries.ts:808-818` (normalization by `maxScore`).

**Why it matters.**

- Every off-topic question ("what's the weather", "draft me an email") costs a full model call and relies entirely on the prompt's refusal branch.
- `topScore` in the audit log is meaningless (always 1.0), so it can't be used to find knowledge gaps.

**Recommendation.**

1. Return raw scores (dense cosine, RRF) alongside the normalized one, and log the raw top dense similarity.
2. Once the gold set exists, set a minimum-relevance threshold (for example top cosine below a tuned value **and** no keyword hit) that short-circuits to the no-answer response.
3. Feed low-score questions into the existing `docs-gap-digest` job as knowledge-gap signals.

---

#### Q-7. One flagged chunk blocks the whole answer

**Severity:** Medium · **Verification:** Verified · **Effort:** S

**What we found.** The TRI pre-flight scans the assembled prompt as one string. If any retrieved chunk contains an identifying pattern, or any pattern under `block` policy, the whole request fails.

**Evidence.** `packages/rag/src/generation/generator.ts:289-315` (`runPreFlight`), called on the full prompt from the Gemini, OpenAI, and Claude generators.

**Why it matters.** One false-positive chunk (EIN-shaped numbers and unformatted SSN-like digits are known risks with unmeasured false-positive rates) makes **every** question that retrieves it fail with a compliance error. The user can't tell why and can't work around it.

**Recommendation.**

1. Scan the **question** separately. If it contains identifying TRI, block with a clear message ("please don't include client identifiers").
2. Scan **each chunk** separately. Drop chunks that trip the policy, log them with chunk ID and pattern label, and answer from the rest.
3. Block the whole request only if nothing usable remains.
4. Surface the dropped-chunk counts in the audit log so the offending documents can be fixed at the source.

---

#### Q-8. Dates, duplicates, and supersession are not used in ranking or citations

**Severity:** Medium · **Verification:** Reported · **Effort:** M

**What we found.**

- `modified=` reaches the model's context (`generator.ts:116-121`), but citations carry no date (`buildCitations`).
- The typed `source_modified_at` column is written but never read at retrieval (M-6).
- There is no near-duplicate guard or recency prior (H-6).
- The `lifecycle_status` and `content_type` columns (migration 0008) are never used in queries.

**Why it matters.** The corpus is "indexed as-is, superseded documents included". Two copies of the same SOP can take several of the 12 slots, pushing out other relevant material, and users can't see which citation is newer.

**Recommendation.**

1. Add `modifiedAt` to citations and show it on the chips.
2. Deduplicate near-identical chunks (same content hash, or high cosine similarity) before assembly, keeping the most recent.
3. Once lifecycle metadata is populated, exclude `archived`/`superseded` documents by default.
4. Consider a mild recency tiebreak, not a strong prior; the prompt rightly treats recency as evidence, not a verdict.

---

#### Q-9. Images and screenshots are dropped

**Severity:** Low · **Verification:** Reported (M-5) · **Effort:** L

**What we found.** Embedded images (common in SOPs: "click here" screenshots) are discarded by the parser.

**Recommendation.** Defer. When it matters, caption images with a vision model at ingest, using a local model under compliance mode, and index the caption with the surrounding section.

---

#### Q-10. The two answer paths build citations differently

**Severity:** Low · **Verification:** Verified · **Effort:** S

**What we found.** The non-streaming path uses `result.citations` from the generator. The streaming path rebuilds them with `buildCitations(retrieved)`.

**Evidence.** `packages/services/src/ask.ts:148` vs `:240`.

**Why it matters.** Both give identical results today, because every generator returns `buildCitations(context)`. A future generator that returns different citations (for example per-document citations from [Q-2](#q-2-context-is-ordered-by-score-not-by-document)) would make the two paths diverge.

**Recommendation.** Build citations in one place (the service layer) for both paths.

---

### C. Retrieval and ranking

#### R-1. Filters run after fusion, so scoped users can get thin results

**Severity:** Medium (latent) · **Verification:** Verified · **Effort:** M

**What we found.** The vector and keyword searches run over **all** chunks, each capped at `topK × 8` candidates (96 at `topK = 12`). The scope filter and metadata filters apply only to the fused set, after that cap.

**Evidence.** `packages/db/src/queries.ts:566` (pool size), `:571-576` (a comment explaining the choice), `:797-800` (the post-filter).

**Why it matters.** With one source and 210 chunks, it doesn't matter. Once the index holds several sources, a user scoped to a small one can have their relevant chunks crowded out of the 96-candidate pool by chunks from sources they can't see. They get few or zero results, **silently**. It is not a leak (the filter still applies), but it quietly degrades answers, and it gets worse as the corpus grows.

**Recommendation.**

1. Check the pgvector version in production (`SELECT extversion FROM pg_extension WHERE extname = 'vector'`). With 0.8+, move the scope filter **inside** both searches and enable `hnsw.iterative_scan = relaxed_order`, so HNSW keeps scanning until enough filtered rows are found.
2. Otherwise, detect a short result (`rows < topK` while candidates were filtered out) and retry once with a larger pool.
3. Add a test: two sources, a scoped principal on the smaller one, a query where the larger source dominates similarity; assert `topK` results come back.

---

#### R-2. Enabling reranking silently caps the candidate pool

**Severity:** Medium · **Verification:** Verified (arithmetic); pgvector version unverified · **Effort:** M

**What we found.** With reranking on, the retriever fetches `topK × poolMultiplier` = 12 × 5 = 60, and hybrid search multiplies again by 8, giving 480 vector candidates. But `hnsw.ef_search` is 100.

**Evidence.** `packages/rag/src/retrieval/retriever.ts:84`, `packages/db/src/queries.ts:566` and `:654`.

**Why it matters.** Without iterative scans, an HNSW scan returns at most roughly `ef_search` rows, so asking for 480 yields about 100. That is harmless today (210 chunks in total) but misleading later: the configuration appears to give the reranker a large pool when it doesn't.

**Recommendation.** Set `ef_search` to at least the requested pool (capped, for example `min(max(pool, 100), 1000)`), or use iterative scans on pgvector 0.8+. Don't stack the two multipliers: when reranking, pass the pool size explicitly.

---

#### R-3. Reranking is off and not ready to turn on

**Severity:** Medium · **Verification:** Reported · **Effort:** M

**What we found.** `RERANK_PROVIDER` defaults to `none` (`packages/core/src/config.ts:683`). The reranker egress gate (A1) is built. Steps A2–A4 (Jina `return_documents: false`, a separate rerank score field, refusing a hosted reranker under client-data mode) are not. A Cohere trial key allows 10 requests per minute; a 20-person pilot would exceed that and the reranker would silently fall back to fusion order.

**Why it matters.** Several docs describe reranking as "one environment variable". It isn't: it sends chunk text to another vendor, which is a CR-1/CR-3 decision, and it needs rate limits the pilot can live with.

**Recommendation.** Finish A2–A5 and R-2. Pick a US vendor with a DPA, or a self-hosted cross-encoder (for example `bge-reranker-base`, which also works under client-data mode). Log the fallback rate. Enable only after it shows a gain on the gold set.

---

#### R-4. Keyword scores are not length-normalized

**Severity:** Low · **Verification:** Reported (L-4) · **Effort:** S

**What we found.** `ts_rank_cd(c.tsv, q)` is called without a normalization flag (`queries.ts:757-759`), so long chunks with many matching terms rank higher.

**Recommendation.** Try normalization `32` (rank / (rank + 1)) or `1` (divide by log length) and compare on the gold set. Because fusion uses rank rather than score, the effect is limited; keep it low priority.

---

#### R-5. Ranking silently depends on cosine distance

**Severity:** Low · **Verification:** Reported · **Effort:** S

**What we found.** Gemini embeddings truncated to 768 dimensions are not unit-length, and the code stores them as-is (`packages/rag/src/embeddings/gemini.ts:92-149`). This is correct only because the HNSW index uses `vector_cosine_ops` (`packages/db/drizzle/0000_init.sql:97-99`).

**Why it matters.** A future switch to inner product "for speed" would silently break ranking.

**Recommendation.** L2-normalize Gemini vectors at ingest and query time, which is cheap and makes the index choice irrelevant, or add a comment and a test that fails if the operator class changes.

---

### D. Ingestion robustness

#### I-1. A parse or embedding failure drops a document with no retry record

**Severity:** High · **Verification:** Reported (H-3); failure counting seen at `pipeline.ts:205-211` · **Effort:** M

**What we found.** A document that fails to parse or embed is counted in `documentsFailed` and logged. The cursor still advances, so a delta sync won't offer that document again until it changes at the source.

**Why it matters.** A transient parser crash or embedding 429 means an SOP is missing from the index indefinitely, with no user-visible sign and no operator queue to act on.

**Recommendation.** Write failures to an `ingest_failures (source_id, external_id, stage, error, attempts)` table (or reuse `ingest_log` with a `failed` disposition), retry them at the start of each sync with backoff, and alert after N attempts. This can share machinery with the S-2 pending-deletions retry.

---

#### I-2. Tables inside Word and PDF files are not table-aware

**Severity:** Medium · **Verification:** Reported (H-4); routing verified at `composite-chunker.ts:42` · **Effort:** M

**What we found.** Table-aware chunking applies only when the parser reports a spreadsheet `sheetType`. Tables inside `.docx` and `.pdf` go through the markdown chunker, which can split a table mid-row and lose the header.

**Recommendation.** Detect markdown table blocks inside the markdown chunker and route them through the table chunker's header-repeating row grouping.

---

#### I-3. No minimum chunk size

**Severity:** Medium · **Verification:** Reported · **Effort:** S

**What we found.** Any non-empty section becomes a chunk (`markdown-chunker.ts:30-53`, `table-chunker.ts:44-149`), including one-word or punctuation-only fragments.

**Why it matters.** Low-information vectors sit near many queries and take retrieval slots.

**Recommendation.** Merge sections under ~40–50 tokens into the neighboring section, or drop them when there is nothing to merge with. Log the count.

---

#### I-4. The parser has no OCR strategy or server-side timeout

**Severity:** Medium · **Verification:** Reported · **Effort:** S

**What we found.** The Unstructured fallback calls `partition(filename=...)` with the default strategy (`services/parser-py/app/main.py`, around line 298). For scanned PDFs this can trigger the slow `hi_res` OCR path. The worker's client timeout ends the wait, but the sidecar keeps working.

**Recommendation.** Pin `strategy="fast"` by default, with `hi_res` only when the fast path yields almost no text. Enforce a server-side time limit per request (run the partition in a subprocess or worker with a timeout), and cap concurrent parses.

---

#### I-5. Overlap is sized by a character estimate

**Severity:** Low · **Verification:** Reported · **Effort:** S

**What we found.** `applyOverlap` converts tokens to characters at 4 characters per token (`markdown-chunker.ts:221-237`).

**Recommendation.** Use the tokenizer that `countTokens` already uses to slice the overlap. Low priority.

---

#### I-6. Calculator spreadsheets add noise

**Severity:** Low · **Verification:** Reported (M-9) · **Effort:** S

**What we found.** Calculation-heavy workbooks (formulas, numeric grids) index as many low-value chunks.

**Recommendation.** Classify at ingest (a high numeric-cell ratio with few text labels) and either index only the sheet names and header rows, or exclude them by `content_type`.

---

### E. Evaluation, feedback, and observability

#### E-1. No real answer is ever quality-scored

**Severity:** High · **Verification:** Reported · **Effort:** M (plus a session with firm staff)

**What we found.**

- The gold-set framework exists, but `GOLD_QUESTIONS = []` (`tests/e2e/src/eval/gold-set.ts`).
- There is no `eval:gold` / `eval:kb` script; the root `package.json` has only `eval` and `eval:real`.
- The faithfulness judge (`tests/e2e/src/eval/faithfulness.ts`) is referenced only by the gold-set module and its spec; nothing runs it on real answers.
- The corpus-grounded tier (`EVAL-CORPUS-GROUND-TRUTH.md`) is designed but not built.

**Why it matters.** Every recommendation in sections B and C changes answer quality. Without a scored set of real firm questions, none of them can be shown to help, and a regression would go unnoticed. `EVAL-GOLD-SET-GUIDE.md` already calls this the blocker for retrieval tuning.

**Recommendation.**

1. Run the gold-set session: 30–50 real staff questions with the expected source document(s) and key facts, including 5–10 that should be refused.
2. Add `pnpm eval:gold`: retrieval metrics (recall@k on expected documents), faithfulness via the judge, citation validity, refusal correctness, and truncation rate.
3. Store results as dated JSON baselines, and require a run for any change tagged retrieval or generation (the repo's TDD rule already asks for this).

---

#### E-2. The CI retrieval eval cannot detect regressions

**Severity:** High · **Verification:** Reported (prior audit, 2026-09-16) · **Effort:** M

**What we found.**

- The CI corpus is 14 easy documents with distinctive vocabulary; real Gemini embeddings score **100%** on recall@5, nDCG@5, and MRR at every weight split (`tests/e2e/src/eval/real-eval-result.md`).
- CI uses a fake embedder whose vectors carry word-overlap signal, so a broken keyword arm still passes: the join keeps the vector results.
- The keyword assertion only checks that `sparseScore` is finite, which `COALESCE(..., 0)` guarantees.
- The harder CPA corpus with negative questions (`tests/e2e/src/eval/corpus-cpa.ts`) is unused.

**Why it matters.** A green eval currently means very little. The 100% ceiling leaves no room to measure an improvement or a regression.

**Recommendation.**

1. Make `corpus-cpa.ts` the CI gate, with its negative questions.
2. Add keyword-only cases (form numbers, work codes like `BK-CATCHUP`) and assert `sparseScore > 0` for at least one hit and that the expected document is in the top k.
3. Add a test that disables the keyword arm (weight 0) and expects those cases to fail, proving the test can fail.
4. Set thresholds below current scores but above a known-bad configuration.

---

#### E-3. Negative feedback cannot be diagnosed

**Severity:** Medium · **Verification:** Verified · **Effort:** M (plus a policy decision)

**What we found.** The audit log stores a SHA-256 **hash** of the question, never the text (`apps/api/src/routes/ask.ts:58`). Answer text is not persisted anywhere. Feedback stores `answerId`, rating, and an optional comment (`packages/services/src/feedback.ts`).

**Why it matters.** A "not helpful" vote links to chunk IDs but not to what was asked or what was said. That's a deliberate privacy choice (questions may contain client details), but it means the feedback loop can't produce gold-set candidates or diagnose failures.

**Recommendation.** Decide explicitly (see [§9](#9-open-questions-and-decisions)). A middle path:

1. Persist question and answer text **only for answers that receive feedback**, after running them through the same TRI redaction as ingest.
2. Encrypt at rest, restrict to an admin role, and expire after a fixed period (for example 90 days).
3. Add a small admin review screen that promotes an item to the gold set.

---

#### E-4. Class C blocking is only unit-tested

**Severity:** Medium · **Verification:** Reported (prior audit) · **Effort:** S

**What we found.** The data-class end-to-end spec exercises only Class D, the one class reachable through the `client_confidential` mapping. C/D parity rests on unit tests alone.

**Recommendation.** Add an end-to-end case that runs `runIngestion` with source document class `"C"` and asserts the document is blocked and logged. Fix the stale "Defaults to 'A'" comment in `pipeline.ts` while there.

---

#### E-5. The browser suite runs a different model than production

**Severity:** Medium · **Verification:** Reported · **Effort:** S

**What we found.** The web end-to-end suite generates with local `llama3.1:8b`. Production uses `gemini-2.5-flash`, and the TRI policy in the two environments may differ (see [§9](#9-open-questions-and-decisions)).

**Why it matters.** The suite verifies wiring (scope, citations, refusal rendering), which it does well, but it says nothing about production answer behavior. That's fine as long as nobody reads it as a quality signal.

**Recommendation.** State this in the suite's README or header, and keep quality claims in the gold-set eval ([E-1](#e-1-no-real-answer-is-ever-quality-scored)).

---

#### E-6. The real-eval script can destroy data

**Severity:** Medium · **Verification:** Reported (C3) · **Effort:** S

**What we found.** `run-real-eval.ts` truncates tables. Pointed at the wrong `DATABASE_URL`, it would erase production data.

**Recommendation.** Refuse to run unless the database name matches an allowlisted eval database (or a `--i-understand` flag is passed), and print the target host before doing anything.

---

#### E-7. Teams has no feedback buttons

**Severity:** Low · **Verification:** Reported · **Effort:** S

**What we found.** Web captures 👍/👎; the Teams bot's Adaptive Card doesn't.

**Recommendation.** Add `Action.Submit` buttons that post to `/feedback` with `channel: "teams"` before the Teams rollout, so pilot feedback is collected from day one.

---

### F. API surface and operations

#### F-1. Generation continues after the client disconnects

**Severity:** Medium · **Verification:** Verified · **Effort:** S

**What we found.** `/ask/stream` hijacks the reply and writes events, but never listens for the client closing the connection.

**Evidence.** `apps/api/src/routes/ask.ts:156-215`.

**Why it matters.** A user who closes the tab or asks again mid-answer still pays for the full generation, and the audit log records an answer nobody received.

**Recommendation.** Create an `AbortController` tied to `request.raw.on("close")`, pass the signal through `askQuestionStream` to the provider call, and stop writing once aborted.

---

#### F-2. Clients can request 100 chunks of context

**Severity:** Medium · **Verification:** Verified · **Effort:** S

**What we found.** `AskBody.topK` accepts up to 100 (`apps/api/src/routes/ask.ts:19`), and the web proxy forwards the client's body unchanged (`apps/web/src/app/api/chat/route.ts`).

**Why it matters.** Any signed-in user can send about 80k tokens of context per call, which is slow and costly, and 100 chunks could exceed the model's useful attention anyway. The rate limit (10 per minute) bounds the damage but doesn't prevent it.

**Recommendation.** Cap `topK` at a server-side maximum (for example 20). In the web proxy, forward only `question` (and later `history`) rather than the raw body.

---

#### F-3. The web proxy has no upstream timeout

**Severity:** Medium · **Verification:** Verified (M-2) · **Effort:** S

**What we found.** The chat route's `fetch` to the API has no abort signal (`apps/web/src/app/api/chat/route.ts`).

**Recommendation.** Add `AbortSignal.timeout()` for time to first byte (for example 30 seconds) and an idle timeout on the stream. Also abort upstream when the browser disconnects (see F-1).

---

#### F-4. Teams reports every failure as "unavailable"

**Severity:** Low · **Verification:** Reported (M-8) · **Effort:** S

**What we found.** `apps/teams-bot/src/rag-client.ts:59` maps every non-OK status to `KbUnavailableError`.

**Recommendation.** Distinguish 401/403 (sign in again), 422 compliance (remove identifiers from the question), 429 (slow down), and 5xx (unavailable), each with its own user message.

---

## 7. Planned capabilities vs. what is built

The plans' checkboxes are not status (`docs/README.md`). This table reflects the code on 2026-09-16.

| Capability                                          | Source                   | Status                       | Evidence                                                                                                      |
| --------------------------------------------------- | ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reranker egress gate (A1)                           | Rerank plan              | Built and wired              | `packages/rag/src/retrieval/reranker.ts:66`, `packages/runtime/src/index.ts:177`                              |
| Reranking enabled                                   | Review H-5               | Built, **off**               | `packages/core/src/config.ts:683`                                                                             |
| Rerank A2–A4                                        | Rerank plan              | Not built                    | No rerank-score field or client-data refusal in `reranker.ts`                                                 |
| Conversation memory / follow-up rewrite (B1–B6)     | Rerank plan Track B      | Not built                    | No `history` in `ask.ts`, API routes, or clients                                                              |
| Local generation (OpenAI-compatible `baseURL`)      | Local-generation plan    | Built, opt-in                | `generator.ts`, `packages/core/src/generation-credentials.ts`, `docs/LOCAL-GENERATION.md`                     |
| Claude provider                                     | Review M-3               | Built                        | `generator.ts` `case "claude"`                                                                                |
| OR-semantics keyword query                          | Review H-1               | Fixed                        | `packages/db/src/queries.ts:676-732`                                                                          |
| Grouped citation parsing                            | Review H-7               | Fixed                        | `generator.ts:162-214`                                                                                        |
| Ingest redaction, class gate, quarantine            | Boundary plan Phase 4    | Built and wired              | `pipeline.ts:353-470`, `classify-document.ts`                                                                 |
| Path exclusion                                      | Boundary plan Phase 2    | Partial, different design    | Hardcoded in `content-safety.ts`; see [S-7](#s-7-path-exclusion-is-hardcoded-sharepoint-only-and-late)        |
| Drop `path` from citations                          | Boundary plan Phase 3    | Not built                    | `metadata-policy.ts:51`; see [S-4](#s-4-folder-paths-are-exposed-in-citations)                                |
| Content sign-off (`screen-signoff.json`)            | Boundary plan Phase 5    | Not done                     | File absent; P0 #1 still open                                                                                 |
| Periodic re-screen job                              | Boundary plan Phase 6    | Not built                    | Only `docs-gap-digest`, `ship-audit-log`, `sync-source` handlers exist                                        |
| Modified date on citations                          | ISSUES H0                | Partial                      | In model context only; see [Q-8](#q-8-dates-duplicates-and-supersession-are-not-used-in-ranking-or-citations) |
| Gold set                                            | EVAL guide               | Framework built, empty       | `GOLD_QUESTIONS = []`                                                                                         |
| `eval:gold` runner                                  | ISSUES C4                | Not built                    | Root `package.json`                                                                                           |
| Faithfulness judge on real answers                  | EVAL-AND-FEEDBACK        | Built, not wired             | `tests/e2e/src/eval/faithfulness.ts`                                                                          |
| Corpus-grounded eval tier                           | EVAL-CORPUS-GROUND-TRUTH | Not built (extractor exists) | `packages/rag/src/extraction/claim-extractor.ts`                                                              |
| Feedback capture                                    | Review M-1               | Web only                     | `apps/api/src/routes/feedback.ts`; none in `apps/teams-bot`                                                   |
| Usage analytics / governance                        | Boundary §0c             | Partial                      | `audit_log`, digest, shipper; lifecycle columns unused                                                        |
| Vertical packs                                      | Platform spec §3         | Partial                      | `packs/cpa/pack.yaml` has scanners only; the prompt is still hardcoded                                        |
| Open data tiers (beyond fixed A/B/C/D)              | Platform spec §3.1       | Not built                    | Fixed enum in `packages/db/src/schema.ts:52`                                                                  |
| `processingVersion`, scrub toggle, settings catalog | Platform spec §3.8       | Not built                    | No matches                                                                                                    |
| Compliance mode `client-data`                       | CR-1                     | Built and wired              | Forces TRI `block`, local embeddings, and a DPA file                                                          |
| TRI generation policy                               | C-1                      | Built; code default `block`  | `config.ts:266`                                                                                               |
| Web browser end-to-end suite                        | 2026-09-13 plan          | Built                        | `tests/web-e2e/`                                                                                              |

---

## 8. Documentation drift

Per the corpus rule in `docs/README.md`, fix the wrong document itself, not only this one.

| #   | Document                                                                    | What it says                                               | Reality                                                                    | Fix                                                                    |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `ARCHITECTURE.md` "What this system is NOT"                                 | "Not a chat platform"; memory lives in the consuming agent | Decision B0 adopts server-side follow-up rewriting                         | Add the B0 pointer the plan required.                                  |
| 2   | `RAG-ARCHITECTURE-GUIDE.md` §5                                              | Keyword search uses `plainto_tsquery` (AND)                | OR-semantics with quoted lexemes                                           | Update §5.                                                             |
| 3   | `packages/rag/src/generation/generator.ts:232`                              | "why `warn` is the default"                                | Code default is `block` (`config.ts:266`)                                  | Fix the comment.                                                       |
| 4   | `PROTOTYPE-READINESS-REVIEW-2026-08-01.md` C-1                              | TRI default is `warn`                                      | Default is `block`; production reportedly runs `warn`                      | Add a correction note.                                                 |
| 5   | `superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md` §1, §7 | Query rewriting excluded as neutral-to-negative            | The rerank plan adopts conversational rewriting (a different problem)      | Reconcile: exclude rewriting for single-turn, adopt it for follow-ups. |
| 6   | Same spec §1 and `EVAL-AND-FEEDBACK.md`                                     | A faithfulness scorer runs in CI                           | Nothing scores real answers                                                | Mark as not yet wired.                                                 |
| 7   | Same spec §1, review H-5                                                    | Reranking is "one env var"                                 | A2–A5 and R-2 are prerequisites                                            | Correct the wording.                                                   |
| 8   | `superpowers/plans/2026-08-03-pii-redaction-before-index.md`                | "Design — not built"                                       | Built (`content-safety.ts`, `pipeline.ts`)                                 | Update the status banner.                                              |
| 9   | `PILOT-LAUNCH-STATUS.md` P0 #1                                              | "Remediation has not started; assume roster retrievable"   | The purge and 47-document rebuild are done (per the file's own top banner) | Rewrite the gate text; keep the audit checkbox open.                   |
| 10  | `TEAMS-MVP-REQUIREMENTS.md`                                                 | Counsel not needed because the corpus has no taxpayer data | That premise was disproved on 2026-08-03                                   | Reconcile with P0 #2.                                                  |
| 11  | `STAFF-BOT-ONE-PAGER.md`                                                    | "Does not have your client files"                          | Now true by screening, not by connection scope                             | Reword to describe the screening.                                      |
| 12  | `EVAL-CORPUS-GROUND-TRUTH.md` prerequisite 4                                | Class A/B determined by connection scope                   | Determined by the ingest class gate                                        | Update the prerequisite.                                               |
| 13  | `pipeline.ts` comment                                                       | Document class "Defaults to 'A'"                           | Defaults to `'D'`                                                          | Fix the comment.                                                       |
| 14  | `docs/README.md` "Known gaps"                                               | Six cited-but-missing documents; only two carry warnings   | Unchanged                                                                  | Add warnings at the remaining citation sites.                          |

---

## 9. Open questions and decisions

These need an owner's decision before, or alongside, the engineering work.

| #   | Question                                                                                                     | Why it matters                                               | Related  | Suggested owner            |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | -------- | -------------------------- |
| 1   | What is production's `GENERATION_TRI_POLICY` right now? The docs disagree (`warn` vs `block`).               | It determines whether false positives block answers.         | Q-7, E-5 | Marcus (check Railway)     |
| 2   | Must SharePoint document permissions be enforced, or is "all-staff libraries only" an acceptable pilot rule? | It decides whether S-5 is a documentation fix or a feature.  | S-5      | Firm (Chris/Doug) + Marcus |
| 3   | May question and answer text be retained for feedback review? If so, for how long and who can see it?        | It unblocks the feedback loop and gold-set growth.           | E-3      | Firm + counsel             |
| 4   | Which reranker, if any: a US-hosted vendor with a DPA, or self-hosted?                                       | CR-1/CR-3 exposure and rate limits.                          | R-3      | Marcus                     |
| 5   | Are KB_SANDBOX and Drafts folders in or out of the index?                                                    | Content-boundary scope.                                      | S-7      | Firm                       |
| 6   | Counsel sign-off (P0 #2) — who, and by when? The firm's build freeze runs Jan 15–Apr 15.                     | It gates the pilot beyond internal use.                      | §3.3     | Marcus + firm              |
| 7   | Which pgvector version does the `postgres-ssl:16.14` image ship?                                             | It decides the R-1/R-2 approach (iterative scans need 0.8+). | R-1, R-2 | Marcus (one SQL query)     |
| 8   | Who runs the gold-set session, and when?                                                                     | It is the blocker for all quality tuning.                    | E-1      | Doug + Marcus              |

---

## 10. Recommended roadmap

Each phase lists its work, how to know it's done, and what to watch for. Every code change follows the repo rules: a failing test first, colocated tests, and `pnpm eval` for anything retrieval-affecting.

### Phase 1 — Close the data-safety gaps (about 2–3 days)

| Work                                                           | Findings         | Done when                                                                                        |
| -------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| Redact table cells before chunking                             | S-1              | An `.xlsx` fixture with an SSN-shaped cell yields chunks without the raw value.                  |
| Retry table for failed tombstones, plus a reconciliation job   | S-2              | A delete that throws once is completed by the next sync (test).                                  |
| Gate downloads on redaction and class                          | S-3              | The download route returns 403 for a redacted document; citation `downloadable` is false (test). |
| Remove `path` from exposable metadata                          | S-4              | The sanitized result contains no `path` (test); the web chips still render.                      |
| Redact titles and heading paths                                | S-6              | A title with an identifier is masked in the index and the prompt (test).                         |
| Document the permission assumption; warn on unique permissions | S-5 (short term) | `PILOT-LAUNCH-STATUS.md` states it; the sync logs items with broken inheritance.                 |

**Watch for:** content hashes change when redaction scope grows, so expect a one-time re-embed of affected documents.

### Phase 2 — Rebuild context assembly (about 3–4 days)

| Work                                                         | Findings | Done when                                                                      |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------ |
| Over-fetch, cap, backfill; expand top documents' neighbors   | Q-1      | A 6-chunk SOP question returns all steps in the gold-set run.                  |
| One `<document>` block per document, chunks in reading order | Q-2      | Prompt snapshot test; per-document citations; web chips updated.               |
| Prefix title and heading path to embedded text; re-embed     | Q-3      | `pnpm eval` and the gold set improve or hold steady; all chunks re-embedded.   |
| Thinking budget, `finishReason` handling, truncation notice  | Q-4      | Truncation is logged and shown; a truncation-rate metric exists.               |
| Per-chunk TRI pre-flight                                     | Q-7      | A fixture with one flagged chunk still answers from the rest (test).           |
| One citation builder for both paths                          | Q-10     | Streaming and non-streaming citations are identical for the same input (test). |

**Watch for:** the system prompt's comment calls its properties load-bearing. Re-run the answer-quality pass after changing block structure.

### Phase 3 — Measure quality (about 3 days plus the staff session)

| Work                                                                         | Findings | Done when                                                          |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Gold-set session (30–50 questions, including refusals)                       | E-1      | `GOLD_QUESTIONS` populated and reviewed by firm staff.             |
| `pnpm eval:gold` with retrieval, faithfulness, citation, and refusal metrics | E-1      | A dated baseline JSON is committed.                                |
| CPA corpus as the CI gate; keyword-only cases                                | E-2      | Disabling the keyword arm makes CI fail.                           |
| Class C end-to-end test; fix stale comment                                   | E-4, S-8 | The test passes; the comment is corrected.                         |
| Guard the real-eval script against wrong databases                           | E-6      | It refuses a non-eval database name.                               |
| Feedback retention (if approved) and Teams feedback                          | E-3, E-7 | A "not helpful" item can be reviewed and promoted to the gold set. |

### Phase 4 — Conversation and relevance (about 3–5 days)

| Work                                                                             | Findings | Done when                                                                                         |
| -------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| B0 follow-up rewriting (retrieval only)                                          | Q-5      | Gold-set follow-up pairs retrieve the right document; history is validated and TRI-scanned.       |
| Raw scores and a no-answer threshold                                             | Q-6      | Off-topic gold questions short-circuit without a model call; audit logs record the raw top score. |
| Dates on citations; near-duplicate collapse                                      | Q-8      | Chips show modified dates; duplicate SOPs occupy one slot.                                        |
| Server-side `topK` cap; forward only allowed fields; stream abort; proxy timeout | F-1–F-3  | Tests for the cap, the abort on disconnect, and the timeout.                                      |
| Differentiated Teams errors                                                      | F-4      | Each status class shows its own message.                                                          |

### Phase 5 — Scale readiness (before the corpus reaches a few thousand chunks)

| Work                                                                              | Findings | Done when                                                       |
| --------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| Filters inside both searches (iterative scans) or an adaptive pool                | R-1      | The two-source scoped test returns `topK` results.              |
| `ef_search` sized to the pool; no stacked multipliers                             | R-2      | Requested and returned candidate counts match (test).           |
| Reranker A2–A5; vendor decision; enable only on a gold-set win                    | R-3      | The gold set shows a gain; the fallback rate is logged.         |
| Failed-document retry queue                                                       | I-1      | A parser failure is retried on the next sync (test).            |
| Table-aware chunking in docx/pdf; minimum chunk size; parser strategy and timeout | I-2–I-4  | Fixtures pass; parser time limit enforced.                      |
| Per-source exclusion config applied at listing                                    | S-7      | Excluded folders are never downloaded (test with a mock Graph). |
| Normalize embeddings or lock the operator class                                   | R-5      | A test fails if the index operator class changes.               |

### Deferred

Image captioning (Q-9), keyword score normalization (R-4), overlap precision (I-5), calculator-sheet handling (I-6), scanner dispositions (S-9), the redirect-safe Gemini transport (S-10), and document-level permission enforcement (S-5 long term, pending decision #2).

---

## 11. Implementation status

Status as of 2026-09-16 on branch `fix/rag-review-findings`. Every change was
written test-first, reviewed by independent agents (repo rules, TypeScript
correctness, and security), and the review findings were fixed in the branch.
Verification at the end of the work: all 12 unit-test packages, the full e2e
suite against a real Postgres (22+ spec files), `pnpm eval` (both corpora),
`pnpm typecheck`, `pnpm lint` (0 errors), and the parser's Python tests.

### 11.1 Fixed

Commits from the parallel branch `fix/rag-retrieval-review` are marked †.

| ID                  | What changed                                                                                                                                                     | Commit(s)                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| S-1                 | Tables (every cell, caption, sheet name) and titles are redacted, not only markdown. Dormant with today's all-Class-D pack, live for any non-escalating scanner. | `f09bb3c`, `534c82a`                       |
| S-2                 | A failed tombstone delete fails the page before the cursor is saved, so the deletion is retried.                                                                 | `aae0c7a`                                  |
| S-3                 | A document with redacted identifiers keeps no downloadable original; any earlier original is removed; the download service independently refuses it.             | `14470d7`                                  |
| S-4                 | `path` removed from the exposable metadata allowlist.                                                                                                            | `656ff4a`                                  |
| S-5 (short term)    | Permission assumption recorded in `PILOT-LAUNCH-STATUS.md`. Per-document enforcement deferred (see 11.2).                                                        | docs                                       |
| S-6                 | Titles redacted (with S-1).                                                                                                                                      | `f09bb3c`                                  |
| S-7                 | SharePoint `excludePaths` per source, applied before download; excluded items reported as deletions. The core denylist remains as defense in depth.              | `70c936f`                                  |
| Q-1                 | Over-fetch before the per-document cap† and neighbour-chunk expansion for the top documents.                                                                     | `95709c4`†, `5ae6e44`                      |
| Q-2                 | One `<document>` block and one citation per source document, chunks in reading order with gap markers.                                                           | `ee52046`                                  |
| Q-3                 | `# Title › heading` prefixed to every chunk; `CONTENT_PROCESSING_VERSION` forces a one-time re-embed. Overlap now applied before the heading.                    | `5c6b7c2`, `5436d9d`                       |
| Q-4                 | Truncation detected on all three providers, with a visible notice and `generation.truncated` log; optional `GENERATION_THINKING_BUDGET`.                         | `5ac1125`                                  |
| Q-5                 | Follow-up condensation (decision B0) across API, MCP, web, and Teams; the rewrite is used for retrieval only.                                                    | `631c5c5`, `7591f9e`, `799cce8`, `cc550e6` |
| Q-6                 | Absolute `top_score` in the audit log†; opt-in relevance floor `RETRIEVAL_MIN_DENSE_SIMILARITY` (off until tuned).                                               | `6d42f1e`†, `bd53ba9`                      |
| Q-7                 | Per-chunk TRI screening via `Generator.screen` (now required by the contract); the question is screened before it is embedded.                                   | `f6d4b14`, `5436d9d`, `aa7afa8`            |
| Q-8                 | Modified dates on citations (web and Teams); duplicate chunk bodies collapsed before the cap, with backfill.                                                     | `d155bfa`, `cc550e6`                       |
| Q-10                | Citations built once, in the service, for both answer paths.                                                                                                     | `ee52046`                                  |
| R-1                 | A filtered hybrid search that returns fewer than `topK` rows is retried once at the maximum pool.                                                                | `2175128`                                  |
| R-2                 | `ef_search` sized to the candidate pool, pool capped at its maximum.                                                                                             | `f08849a`†, `34a3306`†                     |
| R-3 (prerequisites) | Jina `return_documents: false`, `rerankScore` carried, hosted reranker refused under client-data. Enabling is still a decision (11.2).                           | `36ce4f7`                                  |
| R-5                 | Gemini vectors L2-normalized.                                                                                                                                    | `13d1395`                                  |
| I-1                 | Failed documents recorded as `action: "failed"` and retried (≤ 5 attempts) on the first job of each sync.                                                        | `5ba583e`                                  |
| I-2                 | Tables inside prose documents split by whole rows under a repeated header; no character-sliced overlap on tables.                                                | `ec50000`                                  |
| I-3                 | Sections with no real text are not embedded.                                                                                                                     | `ec50000`                                  |
| I-4                 | Parser runs off the event loop; `fast` strategy first, OCR only when needed, bounded by `PARSER_MAX_CONCURRENT_OCR`.                                             | `1fe1fa3`                                  |
| I-5                 | Overlap sized in decoded tokens (a 20-token setting had carried 46 on digit-heavy text).                                                                         | `aa1f383`                                  |
| E-1 (tooling)       | `pnpm eval:gold` against the deployed KB: recall@k, MRR, refusal correctness, fabricated citations, truncation. The gold set itself still needs firm staff.      | `e05f8e4`, `aa7afa8`, `cc550e6`            |
| E-2                 | The CPA corpus gates `pnpm eval`, with thresholds that fail when the keyword arm is disabled, and bare-identifier queries must score through the keyword arm.    | `cd95f55`                                  |
| E-4                 | Class C blocked end to end through the real pipeline and database.                                                                                               | `d3b984c`                                  |
| E-6                 | `truncateAll` refuses non-local databases.                                                                                                                       | `c343ef9`, `cc550e6`                       |
| E-7                 | Teams answer cards collect Helpful / Not helpful, attributed to the verified clicking user.                                                                      | `c972d19`                                  |
| F-1                 | Streaming stops (and aborts the provider request) when the client disconnects; completed answers are still audited.                                              | `fcb60c7`, `cc550e6`                       |
| F-2                 | `/ask` and MCP `ask` cap `topK` at 30; the web BFF forwards only an allow-listed body.                                                                           | `4075645`, `7591f9e`                       |
| F-3                 | Web BFF connect timeout (504), 60-second stream idle timeout, upstream abort on browser disconnect.                                                              | `94884b1`, `cc550e6`                       |
| F-4                 | Teams shows specific messages for compliance refusals, rate limits, access errors, and invalid questions.                                                        | `1682e26`                                  |
| Doc drift           | Items 1–14 of §8, plus API, MCP, connector, and gold-set docs.                                                                                                   | docs commit                                |

### 11.2 Deferred, with the reason

| ID                  | Why it is not done                                                                                                                                                                                                                  | What unblocks it                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| S-5 (enforcement)   | Per-document SharePoint permission enforcement is a real authorization feature and cannot be tested without a live tenant.                                                                                                          | Decision #2; a test tenant.                      |
| S-8 (distinct enum) | `DocumentClass` already distinguishes C and D; only `sources.data_class` lacks a C value. Adding one is a forward-only migration with no current product need. The end-to-end C test now guards the gate.                           | A product need for Class C sources.              |
| S-9                 | Scanner dispositions need a design (what `flag` means operationally) before code.                                                                                                                                                   | Pack contract decision.                          |
| S-10                | Replacing the Gemini SDK call with a hand-rolled, redirect-refusing transport can't be verified without a live API key, and a wrong wire format would break all embedding.                                                          | A key in a test environment.                     |
| R-3 (enable)        | Sends chunk text to a new vendor.                                                                                                                                                                                                   | Vendor/DPA decision #4; a gold-set gain.         |
| R-4                 | Measured: `ts_rank_cd` normalization 32 changed nothing on either corpus, as expected (it preserves rank order, and fusion uses rank). Length-based normalizations could change ranking but these corpora are too small to show it. | The gold set.                                    |
| Q-9                 | Image captioning is a feature, not a fix, and needs a local vision model under compliance mode.                                                                                                                                     | Evidence that SOP screenshots matter to answers. |
| I-6                 | Calculator-sheet handling needs examples from the real corpus to tune a classifier.                                                                                                                                                 | Corpus sample.                                   |
| E-3                 | Making negative feedback diagnosable requires retaining question and answer text.                                                                                                                                                   | Decision #3.                                     |
| E-5                 | Documentation only (added to the browser suite's docs).                                                                                                                                                                             | —                                                |

### 11.3 New findings from the implementation work

| ID  | Finding                                                                                                                                                                                                                                          | Status                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N-1 | `/search` and MCP `search_documents` embedded their query with no TRI screening; `/ask` now screened first.                                                                                                                                      | Fixed where a generator is configured (production): search screens with the generator's policy. A search-only deployment has no policy and stays unscreened. |
| N-2 | The parser's `async` `/parse` handler ran blocking parsers on the event loop, so one OCR job stalled every request, including `/health`.                                                                                                         | Fixed (`1fe1fa3`).                                                                                                                                           |
| N-3 | Chunk overlap was applied to header-prefixed text, burying each continuation chunk's heading behind the previous chunk's tail. Pre-existing; surfaced by review.                                                                                 | Fixed (`5436d9d`).                                                                                                                                           |
| N-4 | Running `pnpm eval`/`pnpm e2e` from a git worktree without `E2E_SKIP_DOCKER_UP=1` recreates the shared `rag-postgres` container bound to the worktree's empty data directory. Happened once during this work and was restored without data loss. | Recorded as a project note; consider making `global-setup.ts` worktree-aware.                                                                                |
| N-5 | The web chat's send button is icon-only with no accessible name.                                                                                                                                                                                 | Fixed.                                                                                                                                                       |
| N-6 | The Teams bot logs with `console` (no structured logger), so its new history and feedback failures are not in the same log stream as the API.                                                                                                    | **Open.**                                                                                                                                                    |
| N-7 | `config.ts` is at 791 of the 800-line cap.                                                                                                                                                                                                       | **Open.** Split the schema by section before the next config addition.                                                                                       |

### 11.4 Operational notes for deploying this branch

1. **Re-sync every source after deploy.** `CONTENT_PROCESSING_VERSION=2` changes every content hash, so the next sync re-chunks and re-embeds all documents (47 documents / 210 chunks today: seconds and cents).
2. **Parser image rebuild required** (`services/parser-py` changed).
3. New optional settings, all documented in `env.example`: `NEIGHBOR_EXPANSION_DOCUMENTS` / `NEIGHBOR_EXPANSION_CHUNKS` (on by default: 2 / 4), `RETRIEVAL_MIN_DENSE_SIMILARITY` (off), `GENERATION_THINKING_BUDGET` (unset), `PARSER_MAX_CONCURRENT_OCR` / `PARSER_OCR_WAIT_SECONDS`, and SharePoint `excludePaths` in source config.
4. **Behavior changes users will see:** answers to follow-ups improve; citations are per document and show dates; an answer cut off at the token limit says so; a question containing a client identifier is refused before retrieval; Teams cards have feedback buttons and clearer errors.
5. After a week of traffic, set `RETRIEVAL_MIN_DENSE_SIMILARITY` from the `audit_log.top_score` distribution, and recalibrate `DOCS_GAP_DIGEST_MIN_SCORE` from the same data.

---

## Appendix A — Method and sources

**Order of work.**

1. **Memory and context.** Serena has no stored memories for this repo. claude-mem supplied session history, including the 2026-09-16 audit of end-to-end test coverage (source of E-2, E-4, E-5).
2. **Documentation.** `docs/README.md` (the index), `ARCHITECTURE.md`, `PILOT-LAUNCH-STATUS.md`, the platform design spec, the content-boundary, rerank/conversation-memory, and local-generation plans, the four `EVAL-*` documents, `PROTOTYPE-READINESS-REVIEW-2026-08-01.md`, `ISSUES-AND-OPTIMIZATIONS.md`, `CPA-COMPLIANCE-REQUIREMENTS.md`, `TEAMS-MVP-REQUIREMENTS.md`, `STAFF-BOT-ONE-PAGER.md`, `DECISION-CPA-KB-RAG-CONVERGENCE.md`, and later superpowers specs on retrieval, evaluation, and the pilot.
3. **Code: retrieval and generation, read directly.** `packages/services/src/{ask,search,feedback}.ts`, `packages/rag/src/retrieval/retriever.ts`, `packages/db/src/queries.ts` (`hybridSearch`), `packages/rag/src/generation/generator.ts`, `packages/core/src/config.ts`, `packages/core/src/metadata-policy.ts`, `apps/api/src/routes/ask.ts`, `apps/web/src/app/api/chat/route.ts`, `apps/teams-bot/src/rag-client.ts`, `env.example`.
4. **Code: ingestion, traced by a delegated code review, then spot-checked.** The worker, `packages/ingestion/src/pipeline.ts`, chunkers, embedders, parser sidecar, SharePoint connector, and schema. S-1, S-2, S-3, and Q-3 were re-read directly before being rated.
5. **Plans vs. code.** A delegated cross-check of every planned capability against the tree (section 7).

**Limits.**

- No production database or Railway environment was queried; production facts come from `PILOT-LAUNCH-STATUS.md` (2026-09-07).
- No tests or evals were run as part of this review.
- Findings marked **Reported** or **Plausible** should be confirmed before fixing.

---

## Appendix B — Glossary

| Term                    | Meaning                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **BFF**                 | Backend-for-frontend: the Next.js server routes in `apps/web` that call the API on the user's behalf, so tokens never reach the browser. |
| **Chunk**               | A slice of a document (~800 tokens) that is embedded and retrieved as a unit.                                                            |
| **Class A/B/C/D**       | Data-sensitivity classes. A is firm-generic content (allowed); C and D contain client data (quarantined).                                |
| **Cursor / delta link** | The connector's bookmark for "what changed since the last sync".                                                                         |
| **ef_search**           | The HNSW search-depth setting; larger means better recall and slower queries.                                                            |
| **Faithfulness**        | Whether every claim in an answer is supported by the cited documents.                                                                    |
| **Gold set**            | Real questions with known correct sources and facts, used to score quality.                                                              |
| **HNSW**                | The approximate nearest-neighbor index pgvector uses for vector search.                                                                  |
| **Hybrid search**       | Vector (semantic) search combined with keyword search.                                                                                   |
| **Reranker**            | A second-stage model that re-scores candidate chunks against the question.                                                               |
| **RRF**                 | Reciprocal Rank Fusion: combines ranked lists by position, `weight / (60 + rank)`.                                                       |
| **Scope / principal**   | The authenticated caller and the set of sources it may read.                                                                             |
| **Small-to-big**        | Retrieve precise small chunks, then give the model their surrounding context.                                                            |
| **Tombstone**           | A connector's record that a source item was deleted.                                                                                     |
| **TRI**                 | Taxpayer return information, protected under IRC §7216.                                                                                  |
| **tsvector / tsquery**  | Postgres full-text search: the indexed document form and the query form.                                                                 |
