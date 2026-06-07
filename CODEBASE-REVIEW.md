# Codebase Review

**Date:** 2026-06-06
**Scope:** entire repository (`/Users/marcus/dev/rag-system`)
**Stack detected:** TypeScript pnpm monorepo (Node 22) · Fastify HTTP API · MCP server (stdio + HTTP) · pg-boss worker · Drizzle ORM + Postgres + pgvector · Gemini/OpenAI embeddings & generation · Microsoft Graph (SharePoint, Outlook) + Google (Drive, Gmail) connectors · Python FastAPI parser sidecar · Vitest
**Source files reviewed:** 84 (TS/Python/SQL)
**Docs reviewed:** 14 markdown files
**Reviewers:** 6 parallel specialists — security, TypeScript, database/pgvector, architecture/quality, dependencies/env, docs-vs-code

---

## Executive Summary

This is a well-engineered, disciplined codebase. It honors nearly all of its stated architectural ground rules: no app imports `pg`/`drizzle-orm` directly, no HTTP route runs a sync synchronously (all enqueue via pg-boss), both factories are exhaustive with `never` guards, all four connectors implement the same interface, strict TypeScript is fully enabled, and Zod guards every external boundary. Documentation is unusually well-aligned with code.

The highest-impact issues are: (1) `POST /sources` echoed the full `config` blob (credential-bearing) in its response while GET routes strip it — **fixed**; (2) the Python parser sidecar runs with no authentication and was host-exposed — **port now bound to loopback**, auth still needs a decision; (3) the MCP `search`/`ask` filters were unbounded while the HTTP API caps them, enabling query amplification — **fixed**; and (4) the HNSW and tsvector GIN indexes exist only in hand-authored SQL and are invisible to Drizzle, so the next `drizzle-kit generate` would emit `DROP INDEX` and silently destroy retrieval performance — **needs a decision**.

| Severity | Count | Auto-fixed    | Requires Decision |
| -------- | ----- | ------------- | ----------------- |
| CRITICAL | 3     | 3 (1 partial) | 1                 |
| HIGH     | 13    | 1             | 12                |
| MEDIUM   | ~21   | —             | ~21               |
| LOW      | ~9    | —             | ~9                |
| Docs gap | 6     | 5             | 1                 |

---

## Priority 1: Docs ↔ Code Discrepancies

### Auto-Fixed

| Doc / Code                                                                                                | What Changed                                                                         | File                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| `Connector` interface described as `list/fetch/delta`                                                     | Corrected to `validate/list/fetch`; delta is driven by the `cursor` arg to `list()`  | `CLAUDE.md`                     |
| Comment pointed to non-existent `0001_init.sql`                                                           | Corrected to `0000_init.sql`                                                         | `packages/db/src/schema.ts:123` |
| GET/POST `/sources` examples showed `config`, but code strips it via `sanitizeSource`                     | Removed `config` from examples; added a note that all source responses omit `config` | `docs/API.md`                   |
| Outlook source config missing `includeAttachments` (it exists in `outlook/config.ts`, default `true`)     | Added field to the documented config                                                 | `docs/CONNECTORS.md`            |
| `LOG_LEVEL`, `MCP_ALLOWED_ORIGINS`, `MCP_MAX_SESSIONS`, `PARSER_MAX_UPLOAD_BYTES` read in code but absent | Added all four with comments/defaults                                                | `env.example`                   |

### Requires Human Decision

| Finding                    | Doc says                                                                                          | Code does                                                                                                                  | Recommendation                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `local` embedding provider | `env.example` & `ARCHITECTURE.md` list `local (transformers.js, bge-small)` as a swappable option | `embeddings/factory.ts` throws `ValidationError("local provider not yet implemented")`; no `LocalEmbeddingProvider` exists | Either implement it or mark `local` as "planned / not yet implemented" in both docs |

---

## CRITICAL Findings

### [C1] `POST /sources` leaked the full connector config in its response — FIXED

**Domain:** Security · flagged by 3 specialists (security, architecture, docs)
**File:** `apps/api/src/routes/sources.ts:73`
**Issue:** GET routes call `sanitizeSource()` to strip the `config` JSONB (site IDs, Drive folder IDs, Gmail queries, OAuth subjects, operator-supplied credential-like values), but the create handler returned the raw row.
**Fix applied:** `POST /sources` now returns `sanitizeSource(row)`.
**Confidence:** 98

### [C2] Python parser sidecar has no authentication and was host-exposed — PARTIALLY FIXED

**Domain:** Security · flagged by 2 specialists (security, dependencies)
**File:** `services/parser-py/app/main.py`, `docker/docker-compose.yml:36`
**Issue:** The parser exposes `POST /parse` on `0.0.0.0:8000` with no auth. Any process reaching the port can POST arbitrary binaries into MarkItDown/LibreOffice/Unstructured/Tesseract (long CVE history), bypassing all API-level auth and size limits.
**Fix applied:** docker-compose now binds the port to `127.0.0.1:8000:8000` (loopback only). Node services still reach it via the compose network.
**Fix still needed (decision):** Add a shared-secret header (`X-Parser-Token` from a `PARSER_SECRET` env var) checked by FastAPI middleware, with `HttpParserClient` sending it. This touches Python + the Node client + env, so it is left for explicit approval.
**Confidence:** 92

### [C3] MCP `search`/`ask` filters were unbounded (query amplification) — FIXED

**Domain:** Security
**File:** `apps/mcp/src/tools/search-documents.ts:24`, `apps/mcp/src/tools/ask.ts:27`
**Issue:** MCP accepted `z.record(z.union([z.string(), z.array(z.string())]))` with no bounds, while the HTTP API caps keys (≤20), key length (≤64), value length (≤256), array length (≤50). An authenticated MCP caller could send hundreds of multi-KB keys, ballooning the hybrid-search SQL into a massive N-way OR scan.
**Fix applied:** Added `apps/mcp/src/tools/filter.ts` with the same caps as the API and wired both tools to it.
**Confidence:** 95

---

## HIGH Findings

### [H1] `/ready` leaked raw DB error (connection string w/ credentials) — FIXED

**Domain:** Security · **File:** `apps/api/src/server.ts:60`
**Issue:** On a failed DB ping the 503 body returned `(err as Error).message`; `pg` connection errors include the full `DATABASE_URL` with credentials.
**Fix applied:** Returns static `"database unavailable"`; full error still logged server-side.
**Confidence:** 90

### [H2] HNSW + tsvector GIN indexes are invisible to Drizzle — next `generate` would DROP them

**Domain:** Database · **File:** `packages/db/src/schema.ts:126-168` vs `packages/db/drizzle/0000_init.sql:97-102`
**Issue:** `chunks_embedding_hnsw_idx` (HNSW, `vector_cosine_ops`) and `chunks_tsv_idx` (GIN) exist only in hand-authored SQL. The Drizzle `pgTable` model omits them, so `drizzle-kit generate` will diff them as removed and emit `DROP INDEX`, collapsing dense + full-text search to sequential scans.
**Fix needed:** Express them in `schema.ts` via Drizzle's raw index escape, or exclude those index names from auto-diffing and document that `0000_init.sql` is the source of truth. **Decision required.**
**Confidence:** 100

### [H3] GIN `jsonb_ops` index does not accelerate the `->>` metadata filter

**Domain:** Database · **File:** `packages/db/drizzle/0001_documents_metadata_gin.sql`
**Issue:** The metadata post-filter uses `doc.metadata->>'key' IN (...)`. GIN `jsonb_ops` only accelerates `?`/`@>`/`@@`, not `->>` text equality — so metadata filtering is still a full scan; the migration comment is factually wrong.
**Fix needed:** Use B-tree expression indexes per filterable key, or switch the query to `@>` containment with `jsonb_path_ops`.
**Confidence:** 90

### [H4] `express@4` runtime with `@types/express@5` types (MCP)

**Domain:** Dependencies · **File:** `apps/mcp/package.json`
**Issue:** Runtime is Express 4 but types are Express 5; `http.ts` handler/middleware signatures type-check against the wrong major — runtime mismatches won't be caught by `tsc`.
**Fix needed:** Align both to one major (downgrade `@types/express` to `^4.17` or upgrade `express` to `^5`).
**Confidence:** 98

### [H5] `source.kind as never` defeats exhaustiveness checking

**Domain:** TypeScript/Architecture · **File:** `apps/worker/src/deps.ts:88`
**Issue:** DB `kind` (string) is cast to `never` to satisfy `createConnector`. A new `SourceKind` would compile silently and crash at the factory `default` branch at runtime.
**Fix needed:** `SourceKind.parse(source.kind)` (the Zod schema is already exported) before passing.
**Confidence:** 90

### [H6] Parser HTTP response cast to `ParsedDocument` with no runtime validation

**Domain:** TypeScript · **File:** `packages/rag/src/parser/parser-client.ts:48`
**Issue:** `(await response.body.json()) as ParsedDocument` — a malformed/partial sidecar response silently corrupts ingested documents downstream.
**Fix needed:** Define `ParsedDocumentSchema` in `@rag/core` and `.parse()` the response.
**Confidence:** 92

### [H7] `mcp-session-id` header cast drops the `string[]` case

**Domain:** TypeScript · **File:** `apps/mcp/src/transports/http.ts:110,182`
**Issue:** `req.headers["mcp-session-id"] as string | undefined` — a repeated header yields `string[]`, so `transports.get(sessionId)` always misses and every follow-up is treated as a new session.
**Fix needed:** `Array.isArray(raw) ? raw[0] : raw`.
**Confidence:** 95

### [H8] `console.error` in the pg-boss error handler

**Domain:** Quality · flagged by 3 specialists · **File:** `packages/ingestion/src/queue.ts:33`
**Issue:** Only non-test `console.*` in production code; emits unstructured text to stderr, bypasses pino log levels, breaks JSON log aggregation. Violates project coding standards.
**Fix needed:** Thread a `Logger` into `createQueue` and call `logger.error({ err }, ...)`. (Signature change across app `deps.ts` — left for approval.)
**Confidence:** 95

### [H9] No rate limiting on any API or MCP endpoint

**Domain:** Security · **File:** `apps/api/src/server.ts`, `apps/mcp/src/transports/http.ts`
**Issue:** `POST /ask` triggers an embedding + LLM call per request; a tight loop by any valid token holder drains quota/cost and can saturate the DB pool.
**Fix needed:** Add `@fastify/rate-limit` (stricter on `/ask` and `/sources/:id/sync`); rate-limit the MCP HTTP transport.
**Confidence:** 85

### [H10] Weak API-token policy

**Domain:** Security · **File:** `packages/core/src/config.ts:27`
**Issue:** Tokens validated only as non-empty strings; `env.example` default `dev-token-change-me` could ship to prod.
**Fix needed:** `z.array(z.string().min(32)).min(1)` and reject known default values at startup.
**Confidence:** 78

### [H11] Generation API key silently coupled to the embedding provider key

**Domain:** Architecture · **File:** `apps/api/src/deps.ts`, `apps/mcp/src/deps.ts`
**Issue:** The generator is constructed with `config.embedding.apiKey`. Mixing `EMBEDDING_PROVIDER=gemini` with `GENERATION_PROVIDER=openai` passes the Gemini key to OpenAI; failure surfaces as opaque runtime API errors, not at startup.
**Fix needed:** Add a `GENERATION_API_KEY` (default to the matching provider key) in `loadConfig`.
**Confidence:** 88

### [H12] `(err as Error).message` in catch blocks

**Domain:** TypeScript · **File:** `embeddings/gemini.ts:72`, `embeddings/openai.ts:57`, `parser-client.ts:36`
**Issue:** Under `strict`, `err` is `unknown`; a non-Error throw yields `undefined` messages — silent empty errors in logs.
**Fix needed:** `err instanceof Error ? err.message : String(err)` (the pattern already used correctly in `main.ts`).
**Confidence:** 90

### [H13] `listSources` has no LIMIT

**Domain:** Database · **File:** `packages/db/src/queries.ts:43`
**Issue:** `SELECT * FROM sources ORDER BY created_at` with no bound; called by API and MCP. No pagination contract.
**Fix needed:** Add a `limit` (default ~200) and/or cursor pagination.
**Confidence:** 90

---

## MEDIUM Findings

| #   | Domain       | File                                             | Issue                                                                                                                                                                                                                                        | Conf |
| --- | ------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| M1  | Security/DB  | `queries.ts:252`                                 | Metadata filter **keys** are not validated against an allowlist before building SQL. They _are_ bound as parameters (not injectable today), but add `/^[a-z_][a-z0-9_]*$/i` validation as defense-in-depth.                                  | 75   |
| M2  | Security/DB  | `queries.ts:270`                                 | `sql.raw(String(efSearch))` for the HNSW GUC is safe only because the value is numerically clamped; fragile if the type ever loosens. Use parameterized interpolation or a `Number.isFinite` guard.                                          | 80   |
| M3  | DB           | `queries.ts:111`                                 | Upsert "was inserted" relies on `xmax = 0` (fragile on PG15+) and `content_changed` may arrive as a string `'t'`/`'f'` from `db.execute`. Prefer `content_hash IS DISTINCT FROM` alone and coerce the boolean explicitly.                    | 85   |
| M4  | Dependencies | `packages/db`, `packages/connectors`, `apps/api` | Unused runtime deps shipped to prod: `postgres` (db uses `pg`), `@microsoft/microsoft-graph-client` + `isomorphic-fetch` (connectors hand-roll fetch), `@fastify/sensible` (api). Remove.                                                    | 92   |
| M5  | Dependencies | `apps/api`, `apps/e2e`                           | `pg-boss` version drift (`^10.1.5` vs `^10.1.6`) and a redundant direct dep in `@rag/api` (only the type is needed via `@rag/ingestion`).                                                                                                    | 88   |
| M6  | DB           | `queries.ts:127`                                 | `deleteDocumentsByExternalIds` passes an unbounded `IN` list — can exceed the 65k bind-parameter limit on large delta syncs. Batch into ≤1000 or use `= ANY($1::text[])`.                                                                    | 90   |
| M7  | DB/Arch      | `schema.ts:152`                                  | `vector(768)` hardcoded with no startup guard; `EMBEDDING_PROVIDER=openai` (1536) without the column ALTER fails only at first insert, after spending embedding credits. Assert `config.embedding.dimensions` matches the column at startup. | 90   |
| M8  | DB           | `0001_documents_metadata_gin.sql`                | `CREATE INDEX` (non-CONCURRENTLY) inside a migration transaction locks writes to `documents` for the build duration.                                                                                                                         | 90   |
| M9  | Dependencies | `services/parser-py/requirements.txt`            | `markitdown[all]==0.0.1a4` is a pinned **alpha** pre-release (stable 0.1.x exists); `unstructured`/others use exact `==` pins with no hash verification.                                                                                     | 90   |
| M10 | Dependencies | `packages/*/package.json`                        | Five library packages import `node:*`/`Buffer` but none declare `@types/node`; works only via root hoist — breaks under strict pnpm hoisting.                                                                                                | 88   |
| M11 | Dependencies | `ingestion`, `connectors`                        | `pino` is a type-only import but declared as a runtime `dependency`; move to `devDependencies`.                                                                                                                                              | 90   |
| M12 | Security     | `parser-py/app/main.py:263,285`                  | Raw Python exception text returned in 500 `detail` (paths/internals/doc data) and propagated into the job error column. Return static `"parse failed"`.                                                                                      | 80   |
| M13 | Security     | `generation/generator.ts:61`                     | Prompt-injection sanitizer only escapes `</document>`; a malicious chunk can inject `<document index=...>` to fake a context boundary.                                                                                                       | 70   |
| M14 | Security     | `gdrive/index.ts:278`, `routes/sources.ts:43`    | Connector-specific config (e.g. GDrive `query`) is `z.record(z.unknown())` at `POST /sources` and only validated at sync time. Validate with the connector schema at creation.                                                               | 80   |
| M15 | Architecture | `packages/rag` → `@rag/db`                       | `Retriever` couples the retrieval package directly to the DB layer, limiting independent testability. Consider an `@rag/retrieval` leaf or move into apps.                                                                                   | 80   |
| M16 | Architecture | `routes/ask.ts`, `routes/search.ts`              | `FilterSchema`/`FilterValue` duplicated verbatim across both API routes (MCP now shares one). Extract to a shared module.                                                                                                                    | 90   |
| M17 | DB           | `schema.ts:156`                                  | `chunks.tsv` is nullable; a NULL tsv is silently excluded from sparse retrieval (degraded recall, no warning). Add `NOT NULL DEFAULT to_tsvector('english','')`.                                                                             | 90   |
| M18 | Security     | `connectors/util/html.ts`                        | Regex-based `htmlToText` is not a real parser; malformed tags can leak attribute content into indexed text. Use `sanitize-html` or route through the parser sidecar.                                                                         | 65   |
| M19 | Architecture | `gmail/index.ts:166`                             | Gmail does not bootstrap a baseline `historyId` before the initial scan (GDrive captures `startPageToken` first), so changes during the initial scan can be missed.                                                                          | 88   |
| M20 | Security     | `error-handler.ts`, `server.ts:98`               | 404 handler reflects raw `request.url` into the response body. Use a static "Route not found".                                                                                                                                               | 75   |
| M21 | Security     | `sharepoint/index.ts:71`                         | `decodeCursor` accepts `driveId`/`next` URLs without validation; largely mitigated by `GraphClient.toAbsolute()`'s host allowlist. Validate cursor fields on decode.                                                                         | 70   |

---

## LOW Findings

- **L1** `apps/mcp/src/server.ts:38` — `documents://{id}` resource accepts any string (no UUID check, unlike the `get_document` tool). (60)
- **L2** `env.example:7` / `packages/db/src/client.ts` — document `sslmode=require` for prod `DATABASE_URL`; confirm the client enforces SSL outside dev. (60)
- **L3** `packages/db/drizzle.config.ts:8` — falls back to a hardcoded `rag:rag@localhost` if `DATABASE_URL` is unset; throw instead. (100)
- **L4** `packages/db/drizzle/meta/_journal.json` — `0000_init.sql` is intentionally outside Drizzle tracking; `drizzle-kit push` will always show a full diff. Document loudly + never use `push` in prod. (100)
- **L5** `generation/generator.ts` — generator SDK errors aren't wrapped in a `RagError`; add `GenerationError` for consistent logging + 502/503 mapping. (70)
- **L6** `ingestion/src/queue.ts:53` — `enqueueSync` throws a plain `Error` on pg-boss dedup; API maps it to 500 instead of 409. Add a typed `DuplicateJobError`. (72)
- **L7** `connectors/src/sharepoint/client.ts:150` — shared `GraphClient` error messages say `"sharepoint:"` even when used by Outlook. (78)
- **L8** `connectors/src/gmail/parse.ts:33` — `collectPart` returns `""` as a "not found" sentinel but is typed `string`; prefer `string | undefined`. (65)
- **L9** `chunking/markdown-chunker.ts:227` — overlap uses a fixed 4-chars/token ratio; off for code/CJK (acknowledged in comments). (78)

---

## Domain Summaries

**Security** — Strong fundamentals: constant-time token comparison with SHA-256 pre-hashing, parameterized Drizzle queries, a Graph host allowlist (SSRF defense), multipart header-injection guards, and a baseline prompt-injection defense. Top residual risks were the `POST /sources` config leak and unauthenticated/host-exposed parser (both addressed/mitigated), plus the absence of rate limiting.

**TypeScript** — Exemplary: all strict flags on (incl. `noUncheckedIndexedAccess`, `noImplicitOverride`), NodeNext with explicit `.js` extensions, no `any`/`@ts-ignore` in production. Remaining gaps are unvalidated external-boundary casts (`ParsedDocument`, `source.kind as never`, `mcp-session-id`) and `(err as Error)` patterns.

**Database / pgvector** — Architecturally sound (correct RRF hybrid query, content-hash idempotency, scoped transactions, pooled connections with `statement_timeout`). The serious items are index drift (Drizzle would drop HNSW/GIN), an ineffective metadata GIN index, and the missing startup dimension guard.

**Architecture & Quality** — Honors its ground rules with high fidelity; clean DI via `deps.ts`. Main concerns: `@rag/rag → @rag/db` coupling, the worker `as never` cast, the generation/embedding key coupling, and `console.error` in the queue.

**Dependencies & Environment** — No hardcoded secrets. Cleanup needed: four unused runtime deps, the express major mismatch, the markitdown alpha pin, per-package `@types/node` declarations, and pg-boss drift. Four env vars were missing from `env.example` (now added).

**Docs vs Code** — Excellent alignment; every command, path, route, MCP tool, error code, and the embedding contract verified. Five small discrepancies auto-fixed; one unimplemented `local` provider needs a decision.

---

## Actions Taken

- [x] Fixed: `POST /sources` now strips `config` from its 201 response — `apps/api/src/routes/sources.ts`
- [x] Fixed: `/ready` returns a static error instead of the raw DB error (credential leak) — `apps/api/src/server.ts`
- [x] Mitigated: parser sidecar port bound to `127.0.0.1` (loopback only) — `docker/docker-compose.yml`
- [x] Fixed: MCP `search`/`ask` filters bounded to match the API caps — new `apps/mcp/src/tools/filter.ts`, wired into both tools
- [x] Docs: corrected `Connector` interface description (`validate/list/fetch`) — `CLAUDE.md`
- [x] Docs: corrected stale `0001_init.sql` → `0000_init.sql` — `packages/db/src/schema.ts`
- [x] Docs: removed `config` from `/sources` examples + added the stripping note — `docs/API.md`
- [x] Docs: added Outlook `includeAttachments` field — `docs/CONNECTORS.md`
- [x] Docs: added `LOG_LEVEL`, `MCP_ALLOWED_ORIGINS`, `MCP_MAX_SESSIONS`, `PARSER_MAX_UPLOAD_BYTES` — `env.example`
- [ ] Requires decision: add `PARSER_SECRET` auth to the parser sidecar (Python + Node client + env)
- [ ] Requires decision: how to keep HNSW/tsvector GIN indexes from being dropped by Drizzle (H2)
- [ ] Requires decision: implement or re-label the `local` embedding provider (docs B1)

---

## Recommended Next Steps

1. **Resolve the index drift (H2).** This is a latent foot-gun that silently destroys retrieval performance on the next `drizzle-kit generate`. Decide on the Drizzle strategy and add a regression guard.
2. **Add parser authentication (C2 remainder).** Loopback binding mitigates local dev; a `PARSER_SECRET` header is needed before any networked deployment.
3. **Fix the express major mismatch (H4)** and the boundary-validation gaps (H5–H7) — they compile cleanly today but fail at runtime.
4. **Add a startup dimension guard (M7)** and rate limiting (H9) before production traffic.
5. **Dependency cleanup (M4, M5, M10, M11)** — low-risk, reduces attack surface and install size.
