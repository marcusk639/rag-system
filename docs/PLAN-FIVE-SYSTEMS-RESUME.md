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

## ✅ ALL PHASES COMPLETE (2026-06-10)

**All six phases are DONE, verified, and committed.** Phase 4 (`f1ee05e`, generated parser types)
and Phase 6 (`3950c37`, final verification + docs) landed on 2026-06-10 against the live local
stack. Phase 6 verification results: workspace typecheck + 21 unit tests green; C2a single-writer
proven structurally (worker has zero `createIngestionJob`) and at runtime (one sync → one row);
single-owner + anti-pattern greps clean; all three apps (api/mcp/worker) boot and shut down
gracefully through `buildCoreDeps`/`close()`; MCP Origin allowlist + token requirement intact.
Two non-blocking follow-ups recorded in `docs/ISSUES-AND-OPTIMIZATIONS.md` §11 (orphaned-`pending`
on duplicate trigger; `ParsedDocument.metadata` typed `Record<string, never>`) were both
**resolved 2026-06-10** — see §11 for details.

The historical resume detail below is retained for context.

## TL;DR (historical)

Phases **1–3 and 5 are DONE, verified, and committed**. The only work left is **Phase 4**
(needs the parser running + npm registry) and **Phase 6** (final verification — needs Docker/DB).
Both are blocked without the local stack. `git log` shows the four phase commits on top of `0d051d7`.

```
4e49f1e  refactor: shared connector cursor codec + paginate utility                 (Phase 5)
98d6166  refactor: single-source filter schema, token verifier, source sanitizer   (Phase 3)
c9279ce  refactor: unify composition root into buildCoreDeps                        (Phase 2)
78aa9d0  fix: make triggerSync the sole ingestion_jobs writer (C2a) + @rag/services  (Phase 1)
```

## Environment prerequisites to resume

**Docker is now installed (2026-06-09):** Colima + docker CLI 29.5.3 + compose v2 (5.1.4), via
`brew install colima docker docker-compose`. The compose plugin is symlinked into
`~/.docker/cli-plugins/docker-compose`. The active docker context is `colima`.

- **On resume, start the engine first:** `colima start` (the VM stops on reboot / `colima stop`).
  Verify with `docker ps`. Then `pnpm docker:up` (builds the parser image, pulls Postgres+pgvector),
  then `pnpm db:migrate`.
- Network/registry access — needed to add the `openapi-typescript` dev dep in Phase 4
  (`pnpm add -D -w openapi-typescript`). Registry was reachable on 2026-06-09.
- Live connector credentials (SharePoint/GDrive/Gmail/Outlook) — only for the optional Phase 5 e2e
  safety net; not needed for Phase 4 or the Phase 6 C2a/boot checks.
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

### ✅ Phase 5 — connector cursor codec + paginate (DONE — `4e49f1e`)

- `packages/connectors/src/util/cursor.ts` → `makeCursorCodec<T>(name, normalize)`: single
  base64(JSON) encode/decode; per-connector defaulting in `normalize`; malformed cursors throw
  `ValidationError("invalid <name> cursor", err)`.
- `packages/connectors/src/util/paginate.ts` → `paginate({ maxItems, cursor, encode, fetchPage })`
  owns the accumulate-until-`maxItems` loop, the clamp, and the `{ documents, nextCursor, done }`
  envelope. Each connector implements only `fetchPage(cursor, remaining)` → `ConnectorPage<T>`
  (`{ documents, cursor, done }`).
- All 4 connectors refactored; `T` kept per connector (only codec/paging mechanics shared, no
  `BaseConnector`). GDrive/Gmail mode-split became `fetchInitialPage`/`fetchDeltaPage`; the
  initial→delta flip now happens mid-`list()` (paginate keeps draining) — strictly more docs/call,
  still terminating.
- `done` unified on Outlook's feed-exhaustion semantics (decoupled from "zero docs this page");
  the three ad-hoc done formulas are gone. SharePoint's surviving `const done` is its per-page
  feed-exhaustion signal (drive-queue empty) returned to `paginate` — correct, not the old
  list-level formula.
- **Verified:** typecheck green workspace-wide; `@rag/connectors` builds; greps clean
  (no per-connector `Buffer.from(JSON.stringify` in `*/index.ts`; codec in one place). Behavioral
  e2e against live connectors still deferred to Phase 6 (needs the stack).

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
