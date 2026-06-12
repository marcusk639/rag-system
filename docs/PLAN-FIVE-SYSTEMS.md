# Implementation Plan — Five-System Unification & C2a Bug Fix

**Source:** `journey-into-rag-system.md` (Pathfinder five-system proposal, obs #189/#192) + live-code verification (2026-06-08).
**Companion source of truth:** `docs/ISSUES-AND-OPTIMIZATIONS.md`.
**Governing principle:** _Prefer deletion over abstraction; one path over configurable paths._ Every phase consolidates duplicated logic into a single owner. No DI containers, no feature flags, no base classes, no options-bags "for flexibility."

**Execution order:** `Phase 1 → Phase 2 → Phase 3 → [Phase 4 ∥ Phase 5] → Phase 6`.
Phase 1 carries the only **confirmed bug** (C2a) and runs first. Phase 2 (composition root) unblocks Phase 3 (security lives in shared packages). Phases 4 and 5 are independent and may run in parallel or any order after 1–3.

Each phase is **self-contained** — runnable in a fresh chat context using only the references in that phase. All `file:line` citations were verified against the working tree on 2026-06-08; re-confirm with a quick read before editing, since earlier phases shift line numbers.

---

## Phase 0 — Verified Facts ("Allowed APIs") & Anti-Patterns

Consolidated from three parallel code-exploration passes. **Trust these over memory; re-read the cited spans before editing.**

### Repo conventions (copy these exactly when creating new packages)

A new workspace package (`@rag/<name>`) follows the existing template (verified against `@rag/ingestion`, `@rag/db`):

`packages/<name>/package.json`:

```json
{
  "name": "@rag/<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "@rag/core": "workspace:*" },
  "devDependencies": { "typescript": "^5.7.2", "vitest": "^2.1.8" }
}
```

`packages/<name>/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

`src/index.ts` re-exports named symbols with `type` modifiers (`export { foo, type Bar } from "./module.js";`). **Note the `.js` extension in relative imports** (ESM/NodeNext) — required throughout this repo.

After creating a package, run `pnpm install` to wire the workspace symlink. **Do not hand-edit `pnpm-lock.yaml`** (blocked by hook).

### Verified DB query layer (`packages/db/src/queries.ts`)

- `createIngestionJob(db, row: NewIngestionJob): Promise<IngestionJob>` — `queries.ts:392`. Inserts and returns the row.
- `updateIngestionJob(db, id: string, patch: Partial<NewIngestionJob>): Promise<void>` — `queries.ts:398`.
- `getSource(db, id)`, `listSources(db)`, `getDocument(db, id)` — same file.
- `ingestion_jobs.status` enum = `"pending" | "running" | "completed" | "failed"` (`schema.ts:38-43`, table `schema.ts:175-204`).

### Verified queue layer (`packages/ingestion/src/queue.ts`)

- `enqueueSync(boss, payload: SyncSourcePayload): Promise<string>` — `queue.ts:40-59`. Uses `singletonKey: "sync:${sourceId}"`, `retryLimit:3`, `retryDelay:60`, `retryBackoff:true`, `expireInHours:6`. **Throws** when pg-boss returns falsy (duplicate already queued).

### Anti-patterns to avoid (these methods/params do NOT exist / must NOT be invented)

- ❌ Do not add a `withGeneration` flag or any options-bag to the composition factory. The unused generator instantiation is cheap.
- ❌ Do not introduce a `BaseConnector` class, a connector plugin registry, or a service registry / DI container.
- ❌ Do not add runtime Zod re-validation of parser output in Phase 4 (generation only; validation is a separate future decision).
- ❌ Do not keep the old double-write "behind a flag" — C2a is a bug, not a feature. Delete the redundant write.
- ❌ Do not assume `@rag/core` may import `@rag/db`/`@rag/rag`/`@rag/ingestion` — see Phase 2 dependency-direction note before placing `buildCoreDeps`.

---

## Phase 1 — Service Layer + C2a Bug Fix _(priority: only confirmed bug)_

**Goal:** Create `@rag/services` as the single home for the five operations' business logic; make HTTP routes and MCP tools thin adapters; make **`triggerSync` the sole writer** of `ingestion_jobs` rows.

### What to implement (copy, don't transform)

1. **Create `packages/services`** per the Phase 0 template. Dependencies: `@rag/core`, `@rag/db`, `@rag/rag`, `@rag/ingestion` (all `workspace:*`).

2. **Author five transport-agnostic functions** in `packages/services/src/`. Copy the core logic from the HTTP routes (they hold the canonical behavior), dropping the Fastify/MCP envelopes:
   - `searchDocuments(deps, input)` — copy from `apps/api/src/routes/search.ts:37-58` (the `topK ?? defaultTopK` defaulting + `retriever.search`).
   - `askQuestion(deps, input)` — copy from `apps/api/src/routes/ask.ts:35-74` (generator-null guard → typed error; empty-results short-circuit; `generator.answer`).
   - `triggerSync(deps, { sourceId, mode })` — copy from `apps/api/src/routes/sources.ts:97-134` BUT see bug fix below.
   - `getDocumentById(deps, id)` — copy from `apps/api/src/routes/documents.ts:10-27`.
   - `listPublicSources(deps)` — copy from `apps/api/src/routes/sources.ts:79-83`, using the shared sanitizer (Phase 3 promotes `toPublicSource`; until then inline the `sanitizeSource` Omit from `sources.ts:26-29`).

3. **Fix C2a inside `triggerSync`** (this is the whole point of Phase 1):
   - `triggerSync` creates **exactly one** `ingestion_jobs` row via `createIngestionJob(db, { sourceId, mode, status: "pending" })` and captures `ingestionRow.id`.
   - Extend `SyncSourcePayload` (`packages/ingestion/src/queue.ts`) to carry `ingestionId: string`. Thread `ingestionRow.id` into the `enqueueSync` payload.
   - **Delete** the worker's own `createIngestionJob` call at `apps/worker/src/handlers/sync-source.ts:29-34`. The worker instead `updateIngestionJob(db, job.data.ingestionId, { status: "running", startedAt: ... })` at the start, and keeps its existing completed/failed updates (`sync-source.ts:53-67`) targeting `job.data.ingestionId`.
   - Define a typed `SyncAlreadyRunningError` (in `@rag/ingestion`) thrown by `enqueueSync` instead of the bare `Error` at `queue.ts:54-56`.

4. **Rewrite the adapters to envelope-only:**
   - HTTP routes (`apps/api/src/routes/{search,ask,sources,documents}.ts`): parse Zod input → call the service → format reply. Map `SyncAlreadyRunningError` → `409`.
   - MCP tools (`apps/mcp/src/tools/{search-documents,ask,trigger-sync,get-document,list-sources}.ts`): parse input → call the service → wrap in MCP content/`structuredContent` envelope. Map `SyncAlreadyRunningError` → `isError: true`. **`trigger_sync` now returns `ingestionId`** (new capability — it previously omitted the row entirely, `trigger-sync.ts:40-43`).

### Documentation references

- HTTP canonical handlers: `apps/api/src/routes/sources.ts:97-134` (sync), `search.ts:37-58`, `ask.ts:35-74`, `documents.ts:10-27`, `sources.ts:79-83`.
- MCP envelopes to preserve (error/text formatting): `apps/mcp/src/tools/ask.ts:54-114` (`renderAnswer`), `search-documents.ts:53-75` (`formatResults`), `trigger-sync.ts:22-71`.
- Worker handler to edit: `apps/worker/src/handlers/sync-source.ts:16-72` (full handler quoted in fact-finding; the duplicate create is at `:29-34`).
- DB signatures: Phase 0.

### Verification checklist

- [ ] `pnpm typecheck` passes workspace-wide.
- [ ] One sync (HTTP **or** MCP) produces **exactly one** `ingestion_jobs` row whose `status` transitions `pending → running → completed`. SQL check: `SELECT id, status, count(*) FROM ingestion_jobs GROUP BY 1,2` — no orphaned `pending` rows after a completed sync.
- [ ] `grep -rn "createIngestionJob" apps/worker` → **no matches** (worker no longer creates rows).
- [ ] `grep -rn "createIngestionJob" apps/` → only inside `@rag/services` callers, not in route/tool files directly.
- [ ] Duplicate sync returns `409` (HTTP) and `isError` (MCP); both originate from one `SyncAlreadyRunningError`.
- [ ] MCP `trigger_sync` response includes `ingestionId`.
- [ ] `pnpm test` green.

### Anti-pattern guards

- ❌ No shared base class for routes/tools — adapters are a few lines each.
- ❌ Do not leave the worker's `createIngestionJob` "just in case." Delete it.
- ❌ Do not invent new DB columns; `ingestion_jobs` already has every status/field needed (Phase 0).

---

## Phase 2 — Composition Root (`buildCoreDeps`)

**Goal:** Collapse the three hand-copied dependency graphs into one factory; adopt the worker's hardened `close()`.

### ⚠ Dependency-direction decision (resolve before coding)

The prior proposal said `packages/core/src/runtime.ts`. **But `@rag/core` is the contracts package** and a factory there must import `@rag/db`, `@rag/rag`, `@rag/ingestion` — inverting the layering and risking an import cycle (`core → db → core`).
**Recommended:** create a new `@rag/runtime` package (Phase 0 template) that depends on core/db/rag/ingestion/connectors and exports `buildCoreDeps`. This mirrors the `@rag/services` move and keeps `@rag/core` dependency-free. If you instead place it in `core`, first prove there is no cycle (`pnpm typecheck`); if a cycle appears, fall back to `@rag/runtime`.

### What to implement (copy, don't transform)

- Author `buildCoreDeps(config, logger)` returning `{ db, embedder, retriever, queue, generator, close }`. Copy the wiring verbatim from `apps/api/src/deps.ts:27-73` (the cleanest core-only graph): `createDb`, `createQueue`, `createEmbeddingProvider`, `new Retriever(...)`, the generator gate.
- Use the **worker's `close()`** as the canonical implementation — copy from `apps/worker/src/deps.ts:95-111` (re-entrancy `closed` guard + dual try/catch + `.error` logging). Do **not** copy API's bare `close()` (`deps.ts:68-71`) or MCP's queue-only try/catch (`deps.ts:73-80`).
- Rewrite the three `deps.ts` to call `buildCoreDeps`, then layer their specializations:
  - `apps/api/src/deps.ts` — core only.
  - `apps/mcp/src/deps.ts` — core + `config`, `logger` in returned `Deps` (verified extras).
  - `apps/worker/src/deps.ts` — core + `parser` (`HttpParserClient`), `chunker` (`CompositeChunker`), `makeConnector` (`createConnector` adapter) from `deps.ts:57-93`.

### Documentation references

- `apps/api/src/deps.ts:27-73`, `apps/mcp/src/deps.ts:32-83`, `apps/worker/src/deps.ts:51-124` (full graphs quoted in fact-finding).
- Identical-across-all-three lines: `createDb`, `createEmbeddingProvider`, `Retriever` ctor, `createQueue`, generator gate.

### Verification checklist

- [ ] `pnpm typecheck` passes; **no circular-dependency error** (if using `core`, confirm explicitly; else use `@rag/runtime`).
- [ ] All three apps boot (`pnpm dev:api`, `pnpm dev:mcp`, `pnpm dev:worker`) and shut down cleanly on SIGINT (graceful queue stop + db close, logged once).
- [ ] `grep -rn "createDb\|createQueue\|new Retriever" apps/*/src/deps.ts` → core wiring appears only via `buildCoreDeps`, not re-inlined.
- [ ] `close()` is idempotent: calling twice does not double-stop the queue (re-entrancy guard present).

### Anti-pattern guards

- ❌ No options-bag/feature flags on `buildCoreDeps`. Each app composes its own extras after calling it.
- ❌ Do not move parser/chunker/makeConnector into the shared factory — they are worker-only.

---

## Phase 3 — Validation & Security Consolidation

**Goal:** Single-source the DoS filter caps, the constant-time token verifier, and source credential-stripping. (Depends on Phase 2 packages existing.)

### Verified current state (note: less duplicated than the report claimed)

- **Filter schema** is byte-identical in `apps/api/src/routes/search.ts:15-28` and `apps/api/src/routes/ask.ts:9-18`. MCP **already** centralized it in `apps/mcp/src/tools/filter.ts:11-22` (imported by its search/ask tools). So the work is: promote one shared `filterSchema` and make **all three** import it. Caps: value `max(256)`, array `max(50)`, key `max(64)`, `MAX_FILTER_KEYS=20`.
- **Token verify** is identical: `apps/api/src/auth.ts:19-28` (named `verifyToken`) and `apps/mcp/src/transports/http.ts:50-62` (inline lambda). Both: pre-hash tokens with SHA-256 at startup, per-request constant-time loop with `timingSafeEqual`.
- **Source sanitize**: API `sanitizeSource` Omit at `apps/api/src/routes/sources.ts:26-29` (applied at `:75,:82,:93`); MCP hand-projects 4 fields at `list-sources.ts:16-20`. Both already drop `config` — promote the Omit version so it can't drift.

### What to implement (copy, don't transform)

1. `@rag/core/src/validation.ts` — move the `filterSchema` + the four cap constants here once. Update `search.ts`, `ask.ts`, and `apps/mcp/src/tools/filter.ts` to import it. Delete the local copies.
2. `@rag/core/src/auth.ts` — `createTokenVerifier(tokens): (presented: string) => boolean`, copied from `apps/api/src/auth.ts:19-28` (the standalone-function form). `createAuthHook` (Fastify) and the MCP `guard` both call it. **Keep MCP-only extras in place**: the Origin allowlist and zero-token startup refusal (`http.ts:64-89`, `:44-48`) are legitimate browser-threat-model defenses — do not move or delete them.
3. `toPublicSource(row): Omit<Source, "config">` in `@rag/db` (`packages/db/src/queries.ts` or `types.ts`), copied from `sanitizeSource`. Both API routes and MCP `list_sources` import it. (If MCP intentionally returns a narrower shape, derive it from `toPublicSource(row)` rather than re-hand-projecting.)

### Verification checklist

- [ ] Lowering `MAX_FILTER_KEYS` in `@rag/core/src/validation.ts` changes the limit on `/search`, `/ask`, and MCP search/ask simultaneously (one edit, three surfaces).
- [ ] `grep -rn "MAX_FILTER_KEYS\|timingSafeEqual\|config: _config" apps/` → definitions gone from app code; only imports remain.
- [ ] A constant-time-verify unit test passes (valid + invalid token; behavior unchanged from before).
- [ ] MCP still rejects disallowed `Origin` (403) and refuses to start with zero tokens.
- [ ] `config` blob absent from every `GET /sources`, `GET /sources/:id`, and MCP `list_sources` response.

### Anti-pattern guards

- ❌ Do not remove MCP's Origin allowlist or zero-token refusal in the name of "deduplication."
- ❌ Do not create a pluggable validation-strategy abstraction. One schema, imported.

---

## Phase 4 — Parser Types (Pydantic → generated TS) _(parallel-safe)_

**Goal:** Eliminate the manual TS↔Python type sync. Pydantic becomes the single source of truth; TS types are generated from the parser's OpenAPI.

### Verified drift

- Python `ParsedTable` (`services/parser-py/app/main.py:80-89`) has non-optional-with-defaults `headers=[]`, `rows=[]`, `row_count=0`, `column_count=0`; `_CamelModel` (`:73-77`) aliases snake→camel; `/parse` uses `response_model_by_alias=True` (`:107`).
- TS `ParsedTable` (`packages/core/src/types.ts:104-121`) declares all those fields **optional** (`headers?`, `rows?`, `rowCount?`, `columnCount?`) — the drift.
- TS client casts the response as-is, no validation (`packages/rag/src/parser/parser-client.ts:15-55`, cast at `:48`).
- **No codegen tooling exists** (root `package.json` has no `gen:*` script; no `openapi-typescript` dependency).

### What to implement

1. Add `openapi-typescript` as a dev dependency at the root (`pnpm add -D -w openapi-typescript`).
2. Add a root script `"gen:parser-types"` that reads the parser's `/openapi.json` (FastAPI exposes it by default) and emits `packages/core/src/parser-types.generated.ts`. Document that the parser container must be up (`pnpm docker:up`) to regenerate.
3. Re-export the generated `ParsedDocument`/`ParsedTable`/etc. from `@rag/core` so **import statements elsewhere do not change** — only the backing definition moves from hand-written (`types.ts:74-121`) to generated. The optionality drift disappears because the generator reflects the Pydantic defaults.
4. Leave `parser-client.ts` casting as-is (no runtime Zod — explicitly out of scope, see anti-patterns).

### Verification checklist

- [ ] `pnpm gen:parser-types` (with parser running) produces `parser-types.generated.ts`; `pnpm typecheck` passes against it.
- [ ] Generated `ParsedTable` spreadsheet fields match the Python contract (not spuriously optional).
- [ ] `grep -rn "interface ParsedTable\|interface ParsedDocument" packages/core/src/types.ts` → hand-written copies removed (or now re-exports of generated).
- [ ] A parser round-trip (`POST /parse` a `.xlsx`) deserializes into the generated types without TS errors.

### Anti-pattern guards

- ❌ Do not add runtime Zod re-validation now (generation only).
- ❌ Do not hand-edit `parser-types.generated.ts`.

---

## Phase 5 — Connector Utilities (`makeCursorCodec` + `paginate`) _(parallel-safe)_

**Goal:** Collapse four identical base64(JSON) cursor codecs and four drifting paging loops into two shared utilities.

### Verified state

- All four connectors have shell-identical `encodeCursor`/`decodeCursor`: SharePoint `index.ts:67-84`, GDrive `:36-56`, Gmail `:38-58`, Outlook `:64-77`.
- The **`done` flag is computed three+ different ways** (confirmed drift): SharePoint `done = current===null && drives.length===0` (`:161`); GDrive `done = mode==="delta" && pageToken===startPageToken && docs===0` (`:124-127`); Gmail `done = mode==="delta" && docs===0 && pageToken===null` (`:105-108`); Outlook uses an explicit `feedExhausted` flag (`:159`).
- `Connector` interface (`packages/core/src/interfaces.ts:80-99`): `list()` returns `{ documents, nextCursor: string|null, done: boolean }`; cursor is an opaque string.
- `packages/connectors/src/util/` already exists (`errors.ts`, `html.ts`) — add the new utilities here.

### What to implement (copy from the cleanest template)

1. `packages/connectors/src/util/cursor.ts`: `makeCursorCodec<T>(name, normalize)` returning `{ encode(c: T): string, decode(raw: string): T }`. Base it on the **Outlook** codec (simplest, cleanest error path, `index.ts:64-77`); `normalize(parsed)` supplies the per-connector defaulting that each `decode` currently inlines. Throw `ValidationError("invalid <name> cursor", err)` on parse failure (matches current behavior).
2. `packages/connectors/src/util/paginate.ts`: `paginate({ maxItems, fetchPage })` that owns the accumulate-until-`maxItems` loop, the clamp, and the `{ documents, nextCursor, done }` envelope. Model the done-semantics on **Outlook's explicit `feedExhausted`** approach (decouples "done" from "zero docs this page" — the correct semantics; pages of only drafts/removals are still real pages). Each connector implements only `fetchPage(cursor)`.
3. Refactor all four connectors to use both utilities. Keep source-specific token/API models and the `fetchPage` body inside each connector. **No `BaseConnector` inheritance.**

### Documentation references

- Codecs + paging loops quoted in fact-finding; canonical template = Outlook `index.ts:64-77` (codec) and `:109-161` (paging).
- Interface contract: `packages/core/src/interfaces.ts:80-99`.

### Verification checklist

- [ ] All four connectors compile; `grep -rn "Buffer.from(JSON.stringify" packages/connectors/src/*/index.ts` → no per-connector codecs remain (only `util/cursor.ts`).
- [ ] `done` is computed in exactly one place (`util/paginate.ts`); per-connector ad-hoc `done` expressions removed.
- [ ] Connector behavior unchanged against existing e2e/integration tests (delta replay still terminates; pages of only-skipped items don't falsely report `done`).

### Anti-pattern guards

- ❌ No `BaseConnector` class or inheritance tree — composition via the two utilities only.
- ❌ Do not collapse the four cursor _shapes_ into one type — keep `T` per connector; only the codec/paging _mechanics_ are shared.

---

## Phase 6 — Final Verification

**Goal:** Prove the whole refactor holds together and no anti-pattern leaked in.

### Cross-cutting checks

- [ ] `pnpm typecheck` and `pnpm test` green workspace-wide.
- [ ] **C2a regression:** scripted end-to-end — register a source, trigger a sync via HTTP and (separately) via MCP; assert exactly one `ingestion_jobs` row per sync, ending `completed`, no orphaned `pending`.
- [ ] **Single-owner greps (must each return only the intended single definition):**
  - `grep -rn "createIngestionJob(" apps/` → only in `@rag/services`.
  - `grep -rn "MAX_FILTER_KEYS" packages apps` → one definition (`@rag/core/src/validation.ts`).
  - `grep -rn "timingSafeEqual" packages apps` → one definition (`@rag/core/src/auth.ts`).
  - `grep -rn "Buffer.from(JSON.stringify" packages/connectors` → one definition (`util/cursor.ts`).
  - `grep -rn "interface ParsedTable" packages` → zero hand-written (generated/re-exported).
- [ ] **Anti-pattern grep:** no `class BaseConnector`, no `withGeneration`, no DI-container/service-registry wiring introduced.
- [ ] All three apps boot and shut down gracefully (Phase 2 close() path).
- [ ] MCP security extras intact: Origin allowlist + zero-token refusal still enforced.
- [ ] Update `docs/ISSUES-AND-OPTIMIZATIONS.md` §11 roadmap and `docs/ARCHITECTURE.md` to reflect the new `@rag/services` (+ `@rag/runtime`) layer and single-writer ingestion flow.

### Suggested commits (one per phase, conventional-commits)

1. `fix: make triggerSync the sole ingestion_jobs writer (C2a) + extract @rag/services`
2. `refactor: unify composition root into buildCoreDeps`
3. `refactor: single-source filter schema, token verifier, source sanitizer`
4. `build: generate parser TS types from Pydantic OpenAPI`
5. `refactor: shared connector cursor codec + paginate utility`

---

## Appendix — Confidence & Known Gaps (from Phase 0 fact-finding)

- **High confidence:** C2a bug, enqueueSync semantics, all five twin-handler pairs, the three close() variants, filter/token/sanitize duplication, parser drift, connector codec/paging drift — all read from current files with line numbers.
- **Open decisions the executor must make:**
  - Phase 1: backfill or ignore pre-existing orphaned `pending` rows (one-off cleanup `UPDATE`/`DELETE` vs. leave as historical noise).
  - Phase 2: `@rag/runtime` package vs. `packages/core/src/runtime.ts` (recommended: new package, to avoid the import cycle).
  - Phase 4: pin `openapi-typescript` major version; decide whether `gen:parser-types` runs in CI or only on demand.
  - Phase 5: whether attachment-bearing connectors (Gmail/Outlook) need a per-item externalId convention preserved through `paginate` (their `messageId/attachmentId` formats differ).
