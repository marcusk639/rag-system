# Five-Systems Refactor — Resume Notes

**Session paused:** 2026-06-08.
**Plan of record:** [`docs/PLAN-FIVE-SYSTEMS.md`](./PLAN-FIVE-SYSTEMS.md) — read it before resuming; each phase is self-contained.

## ⚠️ FIRST THING ON RESUME: check out the work branch

All Phase 1–3 work lives on branch **`refactor/five-systems-unification`** (off `0d051d7`).
The repo may currently be on a different branch (e.g. `docs/cpa-kb-implementation-plan`), in which
case the working tree shows the **pre-refactor** code — nothing is lost, you're just on the wrong
branch. Run this first:

```bash
git checkout refactor/five-systems-unification
git log --oneline -3   # expect 98d6166, c9279ce, 78aa9d0 on top of 0d051d7
pnpm install && pnpm build
```

These three commits are intact and reachable regardless of the current checkout:

```
98d6166  refactor: single-source filter schema, token verifier, source sanitizer   (Phase 3)
c9279ce  refactor: unify composition root into buildCoreDeps                        (Phase 2)
78aa9d0  fix: make triggerSync the sole ingestion_jobs writer (C2a) + @rag/services  (Phase 1)
```

This branch is **local only — not pushed**. Don't lose it; if `git branch` doesn't list it, the
commits are still recoverable via `git reflog` / the hashes above.

## TL;DR for the next session

Phases **1–3 are DONE, verified, and committed**. Resume at **Phase 5** (pure refactor, no
external deps) or **Phase 4** (needs the parser running). Then **Phase 6** (final verification)
once Docker/DB are available. The working tree is clean — `git log` shows the three phase commits
on top of `0d051d7`.

```
98d6166  refactor: single-source filter schema, token verifier, source sanitizer   (Phase 3)
c9279ce  refactor: unify composition root into buildCoreDeps                        (Phase 2)
78aa9d0  fix: make triggerSync the sole ingestion_jobs writer (C2a) + @rag/services  (Phase 1)
```

## Environment prerequisites to resume (none were available this session)

- `pnpm docker:up` (Postgres + Python parser) — **required for Phase 4 generation, Phase 6 C2a
  DB regression, and app boot/shutdown checks.**
- Network/registry access — **required to add the `openapi-typescript` dev dep in Phase 4.**
- Live connector credentials (SharePoint/GDrive/Gmail/Outlook) — for the Phase 5 e2e safety net.
- Bootstrap each session: `pnpm install && pnpm build` (the workspace `dist/` outputs must exist
  or `@rag/*` type resolution fails during typecheck).

## What's DONE (verified by typecheck + greps + unit tests)

### Phase 1 — `@rag/services` + C2a fix (`78aa9d0`)

- New `packages/services` package: `searchDocuments`, `askQuestion`, `triggerSync`,
  `getDocumentById`, `listPublicSources` (transport-agnostic; `ServiceDeps` in `src/deps.ts`).
- **C2a fixed:** `triggerSync` is the sole writer of `ingestion_jobs`; threads `ingestionId`
  through `SyncSourcePayload`; worker only transitions the row (no more duplicate create).
- `SyncAlreadyRunningError` (`@rag/ingestion`) → HTTP 409 / MCP isError;
  `GenerationNotConfiguredError` (`@rag/services`) → HTTP 503 / MCP isError. Both wired through
  `apps/api/src/error-handler.ts` `STATUS_BY_CODE`.
- All HTTP routes + MCP tools are now thin adapters. MCP `trigger_sync` returns `ingestionId`.

### Phase 2 — `buildCoreDeps` (`c9279ce`)

- New `packages/runtime` package exports `buildCoreDeps(config, logger)` → `{ db, embedder,
retriever, queue, generator, close }`. Uses the worker's hardened `close()` (re-entrancy guard).
- Placed in `@rag/runtime` (NOT `@rag/core`) to avoid the `core → db` import cycle. typecheck
  confirms no cycle.
- `apps/{api,mcp,worker}/src/deps.ts` now call `buildCoreDeps` and layer only their own extras.

### Phase 3 — validation/security single-sourcing (`98d6166`)

- `@rag/core/src/validation.ts` — `filterSchema` + caps (one definition; api+mcp search/ask import it).
- `@rag/core/src/auth.ts` — `createTokenVerifier` (one definition; `apps/api/src/auth.ts` hook +
  MCP `transports/http.ts` guard both use it). **MCP Origin allowlist + zero-token refusal kept.**
  Unit test: `packages/core/src/auth.test.ts` (4 tests, green).
- `@rag/db` `toPublicSource` — one config-stripper; api routes + `listPublicSources` use it.
- Deleted `apps/mcp/src/tools/filter.ts`.

## What REMAINS

### ▶ Phase 5 — connector cursor codec + paginate (RESUME HERE — no external deps)

Pure refactor; verifiable by typecheck + greps even without live services (but the e2e behavior
check needs live connectors — see plan §Phase 5 verification).

- Add `packages/connectors/src/util/cursor.ts` → `makeCursorCodec<T>(name, normalize)`. Base on
  the **Outlook** codec (`outlook/index.ts`, ~`:64-77`) — cleanest. Throw
  `ValidationError("invalid <name> cursor", err)` on parse failure.
- Add `packages/connectors/src/util/paginate.ts` → `paginate({ maxItems, fetchPage })` owning the
  accumulate-until-`maxItems` loop, clamp, and `{ documents, nextCursor, done }` envelope. Model
  `done` on **Outlook's explicit `feedExhausted`** (decouple "done" from "zero docs this page").
- Refactor all 4 connectors to use both utilities; keep each `fetchPage` body + source-specific
  token/API models. **No `BaseConnector`. Keep `T` per connector** (don't unify cursor shapes).
- File sizes for reference: sharepoint 303, gdrive 373, gmail 448, outlook 360 lines.
- `done`-computation drift to collapse: SharePoint `current===null && drives.length===0`;
  GDrive `mode==="delta" && pageToken===startPageToken && docs===0`; Gmail `mode==="delta" &&
docs===0 && pageToken===null`; Outlook explicit `feedExhausted`.
- Verify greps: `grep -rn "Buffer.from(JSON.stringify" packages/connectors/src/*/index.ts` → none;
  `done` computed only in `util/paginate.ts`.
- Suggested commit: `refactor: shared connector cursor codec + paginate utility`.

### ▶ Phase 4 — parser types (BLOCKED on running parser)

- `pnpm docker:up` first (FastAPI exposes `/openapi.json`).
- `pnpm add -D -w openapi-typescript` (needs registry).
- Add root script `gen:parser-types` → emits `packages/core/src/parser-types.generated.ts` from
  the parser OpenAPI. Re-export `ParsedDocument`/`ParsedTable`/etc from `@rag/core` so import sites
  don't change; remove the hand-written `ParsedTable`/`ParsedDocument` from `types.ts` (the
  optionality drift at `types.ts:104-121` disappears). Leave `parser-client.ts` cast as-is.
- **Do NOT hand-edit the generated file. Do NOT add runtime Zod.**
- Suggested commit: `build: generate parser TS types from Pydantic OpenAPI`.

### ▶ Phase 6 — final verification + docs (needs Docker/DB)

- `pnpm typecheck` + `pnpm test` green workspace-wide.
- **C2a regression (scripted):** register a source, trigger sync via HTTP _and_ MCP, assert exactly
  one `ingestion_jobs` row per sync ending `completed`, no orphaned `pending`.
- Single-owner greps (plan §Phase 6) + anti-pattern grep (no `BaseConnector`/`withGeneration`/DI).
- All three apps boot + shut down gracefully (Phase 2 `close()` path).
- Update `docs/ISSUES-AND-OPTIMIZATIONS.md` §11 and `docs/ARCHITECTURE.md` for the new
  `@rag/services` + `@rag/runtime` layers and single-writer ingestion flow.

## Gotchas observed this session

- **A prior/concurrent run had already scaffolded `packages/services` + the C2a queue/worker edits**
  but left them uncommitted and incomplete (adapters unwired, `pnpm install` not run, `apps/api`
  failing typecheck at the old `sources.ts` `enqueueSync` call). If you see unexpected uncommitted
  work on resume, reconcile against these commits before editing.
- `pnpm test` exits non-zero for packages with **no** test files (vitest "No test files found").
  Packages with real tests: `@rag/core` (auth), `@rag/rag` (chunking), `tests/e2e` (needs stack).
- Test/verify per-package, e.g. `pnpm --filter @rag/core test`, to avoid the empty-dir noise.
- Untracked files NOT part of this work (leave them): `.serena/`, `PATHFINDER-2026-06-06/`,
  `package-lock.json` (spurious npm lockfile in a pnpm repo), various `docs/*.md` research notes.
