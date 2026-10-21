# App Comparison: Product A (`cpa-backend` + `cpa-knowledge-base`) vs Product B (`rag-system`)

_Generated: 2026-06-21 | Codebase paths: `/Users/marcus/dev/cpa-backend`, `/Users/marcus/dev/cpa-knowledge-base`, `/Users/marcus/dev/rag-system` | Domain rubric: `/Users/marcus/dev/cpa-consulting`_

> Method: each codebase was deep-read at the implementation level (not READMEs/filenames) by an independent reviewer to avoid context-bleed. `cpa-consulting` was mined for the requirements rubric a CPA-firm knowledge base must satisfy. Every claim below is grounded in a file path.

---

## Executive Summary

**Build on `rag-system` (Product B). Retire `cpa-backend`. Keep the `cpa-knowledge-base` Next.js UI as a thin chat client only.**

The single most important reason: **Product B can actually answer a question with a cited, grounded response, and Product A cannot.** In `cpa-backend` the entire RAG pipeline — chunking, embedding generation, chunk indexing, retrieval, and LLM generation — is **dead code with zero call sites** (verified: `chunkTextWithOverlap`, `generateEmbedding`, `bulkCreateDataEntityChunks` are never invoked; there is no search endpoint and no LLM call). The `cpa-knowledge-base` frontend is a UI mockup with hardcoded data and a chat "send" handler that is literally `() => {}` (`knowledge-base.tsx:107`). By contrast, `rag-system` runs a complete ingest → hybrid-retrieve → grounded-cited-answer loop with ~48 behavioral test files, a fail-closed per-principal access-control layer, and a PII allowlist — the exact primitives a CPA firm's confidentiality regime demands.

This conclusion independently reproduces a decision the firm's own strategy docs already recorded: `cpa-consulting/docs/rag/platform-decision.md` (dated 2026-06-07) states _"Build the firm's knowledge base on `rag-system`… Retire `cpa-backend`. Do not merge the two backends."_ Our code-level review confirms that decision is correct and, if anything, understated.

---

## Tech Stack Overview

| Dimension        | Product A — `cpa-backend` + `cpa-knowledge-base`          | Product B — `rag-system`                                          |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Shape            | Two repos: Express API + worker, separate Next.js UI      | pnpm monorepo (`apps/`, `packages/`, `services/`)                 |
| Source size      | ~1,659 LOC backend + ~1,021 LOC frontend                  | 134 source TS files, 48 test files                                |
| Vector store     | **Vespa** (schema only; never populated)                  | **Postgres + pgvector** (HNSW + GIN, in use)                      |
| Doc store / DB   | MongoDB                                                   | Postgres (Drizzle)                                                |
| Queue            | Redis Streams + AWS SQS                                   | pg-boss (same Postgres)                                           |
| Embeddings       | OpenAI `text-embedding-3-small` (wired, **never called**) | Gemini `gemini-embedding-001` / OpenAI (provider factory, in use) |
| Generation (LLM) | **None** — no chat-completion code exists                 | Gemini/OpenAI grounded generation w/ citations                    |
| OCR / parsing    | AWS Textract (started, results discarded)                 | FastAPI parser sidecar (MarkItDown→Unstructured, OCR)             |
| Connectors       | None                                                      | SharePoint, Google Drive, Gmail, Outlook (delta-sync)             |
| Agent interface  | None                                                      | MCP server (stdio + HTTP)                                         |
| Auth             | PropelAuth                                                | Pluggable: static token + OIDC/Entra (`AUTH_PROVIDER`)            |
| Tests            | **0**                                                     | 48 files, mostly behavioral                                       |
| CI               | None                                                      | e2e workflow only (no lint/typecheck/coverage gates)              |
| Deploy           | docker-compose, dev-mode containers (`ts-node`/`nodemon`) | Railway + docker-compose; multi-stage parser Dockerfile           |

---

## Retrieval / RAG Quality

### Where Product A leads

- Nothing functional. The **Vespa chunk schema** (`cpa-backend/vespa/schemas/data_entity_chunk.sd`) is the one well-formed artifact: `enable-bm25`, `summary: dynamic`, and a `tensor<float>(x[1536])` embedding with `prenormalized-angular` distance — correctly designed for hybrid BM25 + vector search and matched to the 1536-dim OpenAI model. But it is never fed a document and never queried.

### Where Product B leads

- **Complete, working pipeline** (`rag-system/ingestion/src/pipeline.ts` → `packages/rag/retrieval/retriever.ts` → `packages/db/queries.ts hybridSearch`).
- **Genuine hybrid search**: dense (pgvector HNSW `<=>`) + sparse (`ts_rank_cd` GIN) combined via **Reciprocal Rank Fusion** (k=60) in a single injection-safe SQL round-trip, with filters applied post-CTE so the indexes aren't defeated (`queries.ts:319-520`).
- **Above-average chunking**: heading-hierarchy-aware markdown chunker that prepends a breadcrumb to each chunk, plus a dedicated **table-chunker** and a composite router (`packages/rag/chunking/*`). Tables matter for accounting docs.
- **Citations + hallucination guards**: deterministic `[N]` citations (`generator.ts buildCitations`); empty-retrieval short-circuit returns a fixed "not enough information" answer instead of calling the LLM (`services/ask.ts:82`); explicit prompt-injection defense treating document content as untrusted.
- **Real eval harness**: recall@k / precision@k / nDCG@k / MRR (`tests/e2e/src/eval/*`, `pnpm eval`).

### RAG Verdict

**Product B, decisively.** This is not "B is more polished" — A has no retrieval or generation at all, so there is nothing to compare on quality. B's only RAG-depth gaps are the absence of a reranker (explicit placeholder in `retriever.ts:14`), no query rewriting/HyDE, and no token-budget management before generation. Those are precision-ceiling refinements on a working system, not missing foundations. The firm's rubric (`cpa-consulting/docs/rag/`) sets **top-3 recall** as the usability bar and prefers **sparse-leaning hybrid weighting** for CPA jargon — both directly supported by B's architecture.

---

## Engineering Quality

### Where Product A leads

- Clean, small, feature-organized modules (largest backend file 251 lines); `strict: true` TS in all three repos; low `any` counts (17 in backend, 2 in frontend).
- The Redis Streams consumer in the worker is genuinely thoughtful: consumer groups, exponential backoff with jitter, a retry sorted-set, and a dead-letter queue (`cpa-backend/cpa-worker/redis-consumer/index.ts`).

### Where Product B leads

- **Exemplary discipline**: strict TS with `noUncheckedIndexedAccess`/`noImplicitOverride`, NodeNext, **zero `: any` in production source**, Zod at every external boundary, clean per-app dependency-injection (`deps.ts`), one-owner-per-concern layering.
- **48 mostly behavioral test files** on the security-critical paths — e.g. `access-control.test.ts` (~30 fail-closed/least-privilege cases), `pipeline.test.ts` (448 lines: page budgeting, dedup, tombstones, storage-failure resilience), `auth-scope.test.ts` (end-to-end HTTP scope enforcement incl. privilege-escalation).

### Where Product A actively regresses

- **Zero tests** in both A repos (both `package.json` test scripts are `exit 1`), against the firm's own 80% rule.
- Real bugs: an **infinite-recursion getter** in `cpa-backend/cpa-worker/sqs/index.ts:90-92`; a broken sliding-window rate limiter that opens a new Redis connection per request and never `return`s after 429; a stubbed token-bucket limiter that never calls `next()`; `res`-shadowing in the auth middleware. The frontend ships dead demo code (`types/index.ts`, `ui/card.tsx`) and a scaffolded-but-unused shadcn `cn` helper.

### Engineering Verdict

**Product B, by a wide margin.** A's code is _tidy_ but untested and buggy, and most of it is scaffolding. B's only real weakness is **thin CI** (e2e only; `pnpm lint`/`typecheck` exist but aren't gated) — a fixable process gap, not an architectural one.

---

## Domain Fit & Feature Completeness

### Where Product A leads

- Marginally: it has an S3 presigned-upload flow and a started Textract OCR path. The firm rubric flags Textract as a _possible_ salvage **only if an eval proves it beats `rag-system`'s parser** — otherwise discard.

### Where Product B leads

- **Production-complete delta-sync connectors** for SharePoint (the firm's document system of record), Google Drive, Gmail, and Outlook — idempotent, resumable, tombstone-aware. SharePoint coverage maps directly to the firm's #1 pain ("SharePoint KB is disorganized").
- **MCP tool surface** (`apps/mcp`) — the rubric names the MCP-in-Claude/CoWork surface as the _primary_ Phase-1 channel (Doug and Chris already use it daily).
- **CPA-aware confidentiality layer already partially built**: per-principal source ACL (CR-5), default-deny PII metadata allowlist, parser auth, index/dimension integrity guards — roughly 30–40% of the ~20 documented CPA controls.

### Where both fall short of the rubric

- Neither has tax/workpaper/engagement domain logic yet — both are generic RAG engines (B with a CPA confidentiality layer bolted on, A with nothing). Per the rubric this is acceptable for Phase 1, which is an **internal, cited Q&A bot over Class A/B firm docs** — explicitly _not_ client tax/financial data.
- Still **planned/absent in B**: audit logging (CR-10), data retention/purge (CR-18), server-side chat sessions, the §7216 self-hosted-embedding path (the `local` provider throws "not implemented"), and Teams/SMS adapters.

### Domain Verdict

**Product B.** It already satisfies the connector, agent-surface, and access-control shape the rubric requires; A satisfies none of them. The firm's golden questions (procedural lookups like _"time code for catch-up bookkeeping?"_) are exactly what B's small-corpus hybrid retrieval is built for.

---

## Security & Compliance (highest-weight dimension for a CPA firm)

A CPA firm is bound by IRC §7216 (criminal liability for disclosing return data), Circular 230 §§10.22/10.35 (due-diligence audit trail), GLBA Safeguards Rule, and AICPA §1.700 confidentiality. The rubric makes several items **pass/fail**: fail-closed per-document ACLs enforced as a _pre-filter inside the retrieval query_ (Postgres RLS is **not** reliably enforced under pgvector ANN), in-code refusal to index a document into a class-incompatible index, and a 3-year encrypted audit log of every query.

### Where Product A leads

- Nothing. Its multi-tenancy is **broken**: `cpa-backend/cpa-api/routes/data-entity.ts` lists/reads/deletes documents with `DataEntity.find({})` and `findById` **with no org/user scoping** — any authenticated user can read or delete any firm's documents. The chunk model has no `userId` field, and Vespa documents carry **no tenant field at all**, so even once search is built there is no mechanism to scope retrieval. The repo also commits a `.env` with live-looking keys and a hardcoded 512-char JWT secret (`scripts/jwt.ts:11`). This is disqualifying for client financial data.

### Where Product B leads

- **Mandatory, fail-closed, can't-forget ACL**: `enforcedSourceIds` is a _required positional argument_ to `Retriever.search`/`hybridSearch`, with a pre-DB short-circuit (`queries.ts:335`) — a route physically cannot forget to apply it. `[]` = deny-all, scoped tokens beat admin (least privilege), forbidden-by-id returns 404 (no existence leak). This is the rubric's **pre-filter-inside-the-CTE** requirement, implemented.
- **Default-deny PII allowlist** (`metadata-policy.ts`): only safe metadata fields cross the API; author/from/to/subject are stripped before responses. Correct for taxpayer-identifying data.
- Constant-time token comparison, fail-loud on empty allow-list, OIDC/Entra support, no hardcoded secrets, server-side bearer injection in the web BFF.

### Where Product B still falls short of the rubric

- **No audit logging** (CR-10) — a hard §7216/Circular 230 gate, entirely absent.
- **No data retention/purge/delete path** (CR-18 — no `retain_until`, no purge job).
- **No rate limiting** on any endpoint (`/ask` triggers embed+LLM per call).
- **§7216 path incomplete**: the `local` self-hosted embedding provider throws, so confidential return data cannot yet be processed without egress to Gemini/OpenAI.
- ACL granularity is **per-source, not per-document/field** (rubric wants per-document, SharePoint-ACL-mirrored).

### Security Verdict

**Product B, but not yet compliant on its own.** A is unusable (cross-tenant data exposure + committed secrets). B has the right _architecture_ — the hard part, fail-closed pre-filtered ACLs, is done correctly — and its remaining gaps (audit log, retention, rate limiting, self-hosted embeddings) are additive features on a sound base, not redesigns.

---

## Dimension Scorecard

Scores are 1–10 (evidence-based from the deep reads). "Product A" is scored as the combined backend+frontend system.

| Dimension                         | Product A | Product B | Weight  | Weighted Winner |
| --------------------------------- | --------- | --------- | ------- | --------------- |
| Retrieval / RAG quality           | 1         | 7         | 25%     | **B**           |
| Security & Compliance             | 2         | 7         | **35%** | **B**           |
| Engineering quality               | 4         | 9         | 15%     | **B**           |
| Domain fit & feature completeness | 2         | 6         | 15%     | **B**           |
| Production readiness              | 1         | 5         | 10%     | **B**           |
| **Weighted Total**                | **2.0**   | **6.9**   | 100%    | **Product B**   |

> Security & Compliance carries the highest weight (35%) because for a CPA firm, a confidentiality or §7216 breach is an existential/criminal-liability event, not a feature gap. Retrieval quality (25%) is next because a knowledge base that cannot return an accurate cited answer has no value regardless of its other properties.

---

## Final Recommendation

**This is not close. Adopt `rag-system` (Product B) as the firm's knowledge-base platform.**

- **`rag-system`** — the implementation target. It already completes the retrieve→cited-answer loop, has the connector and MCP surfaces the firm needs, ships a fail-closed ACL + PII allowlist, and is backed by a real test suite. Finish the compliance layer (below) before touching any live client data.
- **`cpa-knowledge-base`** — keep **only the Next.js UI** as a thin chat client pointed at `rag-system`'s API/BFF. Rip out the hardcoded hooks and wire the real chat route. Replace the hardcoded PropelAuth **test-tenant** URL (`page.tsx:7`) with Entra/env-driven auth to match B's provider.
- **`cpa-backend`** — **retire it.** The Vespa+Mongo+SQS+Textract stack is "overengineered on infrastructure and underbuilt on the thing that matters" (the firm's own phrasing, which our review confirms). The only conditional salvage is Textract OCR, and only if an eval proves it beats B's parser sidecar.

There is no scenario in this analysis where Product A wins. It would win on "near-term revenue vs long-term engineering" trade-offs in a typical comparison — but here it has no working product to trade off, and its security model would expose client data on day one.

---

## Key Risks and Gaps (what to close before go-live on `rag-system`)

These are the items that would change "adopt B" from a platform decision into a _production_ decision for live CPA data. All are gaps in B; A's gaps are not worth tracking because A is being retired.

1. **Audit logging (CR-10) — blocking.** Implement the 3-year, encrypted, IT-read-only query log: timestamp, user_id, verbatim query, index set, retrieved chunk/document IDs, answer text, model+version, tool-call ID. This log _is_ the Circular 230 defense.
2. **Data retention / purge (CR-18) — blocking.** Add `retain_until`, `DELETE /sources/:id`, and a purge job.
3. **In-code class enforcement.** Ensure the ingestion pipeline refuses to index a document into a class-incompatible index and that a `firm-sop` query can never return a client chunk. Phase 1 is **Class A + B only**.
4. **§7216 self-hosted path.** The `local` embedding/generation provider currently throws; until it works, restrict to Class A/B and use only enterprise LLM terms that contractually forbid training on inputs.
5. **Rate limiting** on `/ask` and `/search` (embed+LLM cost and abuse protection).
6. **Observability.** Currently only pino stdout — add metrics/tracing/error-tracking and alerting before relying on it operationally.
7. **CI hardening.** Gate `pnpm lint` + `typecheck` + coverage + a secret/dependency scan; today only an e2e workflow runs.
8. **ACL granularity.** Move from per-source to per-document, mirroring SharePoint/Entra ACLs, and benchmark pre- vs post-filter recall as the rubric requires.
9. **Retrieval precision.** Add a reranker and query rewriting once the corpus is loaded; validate against a CPA gold set (top-3 recall bar), and fix the Gemini query/document task-type embedding mismatch the rubric flags before judging model choice.
10. **UI wiring.** Connect the reused `cpa-knowledge-base` UI to the real BFF, add loading/error/empty states, citations display, and basic accessibility (current UI has zero `aria-*`).

**Timing constraint:** the firm has a hard build freeze Jan 15–Apr 15 (tax season); the only implementation window is May–September. Sequence the compliance work (items 1–4) first within that window, since they gate any contact with real firm documents.
