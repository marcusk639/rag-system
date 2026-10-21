# Plan — `@rag/test-fixtures` shared test doubles (2026-06-23)

**Status:** Ready to execute. Mechanical, green-to-green. Implements Pathfinder **System 1 / D1** (`PATHFINDER-2026-06-23/03-unified-proposal.md`).

**Goal:** One workspace package exporting the canonical `@rag/core` test doubles (`FakeEmbedder`, `FakeConnector`, `FakeGenerator`, `FakeObjectStore`, + the `markdownDoc/plainTextDoc/csvDoc` factories), importable by `packages/*`, `apps/*`, and `tests/e2e` — deleting the parallel inline re-mocks. No behavior change.

---

## Phase 0 — Discovery (facts verified, treat as the contract)

**Workspace / scaffolding**

- `pnpm-workspace.yaml`: globs already include `packages/*`, `apps/*`, `tests/*` — a new `packages/test-fixtures/` is auto-included. No workspace edit needed.
- Root scripts (`package.json`): `build` = `pnpm -r --filter=./packages/* --filter=./apps/* run build`; `test` = `pnpm -r run test`; `typecheck` = `pnpm -r run typecheck`; `e2e` = `pnpm --filter @rag/e2e test`.
- Template to clone: `packages/core/package.json` + `packages/core/tsconfig.json` (shape: `private`, `type:module`, `main/types/exports → ./dist`, scripts `build/dev/typecheck/test`, `tsconfig` extends `../../tsconfig.base.json` with `outDir ./dist`, `rootDir ./src`, `include src/**/*`).
- **No path aliases / no project references** (`tsconfig.base.json` has neither). Inter-package imports (`import … from "@rag/core"`) resolve via package `exports` to built **`dist/`**. ⇒ **`@rag/test-fixtures` must be BUILT before any consumer typechecks/tests.** `pnpm -r build` orders topologically.
- Vitest: per-package (`vitest run`); no root config. `tests/e2e` has its own `vitest.config.ts` (globalSetup). Default vitest resolves workspace deps the same way (to `dist`).

**Exact sources to MOVE (quoted in discovery; copy verbatim, no edits):**

- `tests/e2e/src/fakes/fake-embedder.ts` (full) — imports `node:crypto`, `type { Embedding, EmbeddingProvider } from "@rag/core"`.
- `tests/e2e/src/fakes/fake-connector.ts` (full) — `type { Connector, ConnectorListOptions, ConnectorListResult, SourceDocument } from "@rag/core"`.
- `tests/e2e/src/fakes/fake-generator.ts` (full) — `type { RetrievalResult } from "@rag/core"`; **`type { GenerationResult, Generator } from "@rag/rag"`** ← the cycle trigger (see D-1).
- `tests/e2e/src/fakes/factories.ts` (full) — `type { SourceDocument } from "@rag/core"`.
- `FakeObjectStore` class in `packages/connectors/src/custom/index.test.ts:22-37` — needs `Readable` (`node:stream`) + `type { ObjectStore } from "@rag/core"`. **Leave the sibling `FakeStore` staging mock (lines ~40-55) in place** — not promoted.

**Consumers to re-point (17 e2e imports + 5 inline unit mocks)** — exact file:line list in §"Consumer rewrite map" below.

---

## Decision D-1 (BLOCKING) — break the `rag ↔ test-fixtures` cycle

`FakeGenerator` imports `Generator`/`GenerationResult` from `@rag/rag`. If `@rag/test-fixtures` depends on `@rag/rag`, and `@rag/rag`'s `retriever.test.ts` devDepends on `@rag/test-fixtures` (to get `FakeEmbedder`), that is a **declared dependency cycle** (`pnpm -r build` topo-sort breaks / warns). Pick ONE:

- **D-1a (RECOMMENDED): relocate the `Generator` + `GenerationResult` interface declarations into `@rag/core`** (they join their sibling provider interfaces `EmbeddingProvider`/`Connector`/`ObjectStore` already there), and **re-export them from `@rag/rag`** (`export type { Generator, GenerationResult } from "@rag/core"`) so existing imports in `@rag/rag`/`@rag/services`/`tests-e2e` keep working unchanged. Then `@rag/test-fixtures` depends on **`@rag/core` only** → no cycle. Type-only move, zero behavior change. Verify with `pnpm typecheck` green across the repo.
- **D-1b (fallback, smaller blast radius): keep `FakeGenerator` OUT of this slice.** Move only `FakeEmbedder`/`FakeConnector`/`FakeObjectStore`/factories (all `@rag/core`-only) into `@rag/test-fixtures`; leave `FakeGenerator` in `tests/e2e/src/fakes/` and leave `ask.test.ts`'s inline `{answer:vi.fn}` as-is. No cycle, but D1 only ~80% consolidated; revisit `FakeGenerator` when `Generator` eventually moves to core.

Do NOT: make `@rag/test-fixtures` depend on `@rag/rag` while `@rag/rag` (dev)depends on `@rag/test-fixtures` (the cycle). The plan below assumes **D-1a**; if the team rejects touching `@rag/core`, drop the FakeGenerator tasks per D-1b.

---

## Phase 1 — Scaffold `@rag/test-fixtures` (+ D-1a type relocation)

**What to implement (copy `@rag/core`'s shape):**

1. `packages/test-fixtures/package.json` — clone `packages/core/package.json`; name `@rag/test-fixtures`; `dependencies: { "@rag/core": "workspace:*" }`; `devDependencies: { typescript, vitest }` (match versions in `packages/core`). Scripts: `build`/`dev`/`typecheck`/`test` (`test` = `vitest run --passWithNoTests`, since this package ships no tests of its own — mirror `@rag/runtime`).
2. `packages/test-fixtures/tsconfig.json` — clone `packages/core/tsconfig.json` verbatim.
3. (D-1a) In `packages/core/src/interfaces.ts`: add the `Generator` + `GenerationResult` interface declarations (cut from `packages/rag/src/generation/generator.ts`); export from `packages/core/src/index.ts`. In `packages/rag/src/generation/generator.ts` replace the declarations with `export type { Generator, GenerationResult } from "@rag/core"` (keep `createGenerator`/impls where they are). `GenerationResult.citations` shape moves intact.
4. `packages/test-fixtures/src/` — create `fake-embedder.ts`, `fake-connector.ts`, `fake-generator.ts`, `factories.ts`, `fake-object-store.ts` by **moving the verbatim source** (Phase 0). `fake-generator.ts` now imports `type { GenerationResult, Generator } from "@rag/core"`. `fake-object-store.ts` = the promoted class + `import { Readable } from "node:stream"` + `import type { ObjectStore } from "@rag/core"`.
5. `packages/test-fixtures/src/index.ts` — barrel: `export * from "./fake-embedder.js"` … (NodeNext = `.js` specifiers).

**References to copy:** `packages/core/{package.json,tsconfig.json}`; `packages/runtime/package.json` (the `--passWithNoTests` test script).

**Verification:**

- [ ] `pnpm install` clean (new workspace pkg linked).
- [ ] `pnpm --filter @rag/test-fixtures build` emits `dist/index.js` + `.d.ts`.
- [ ] `pnpm typecheck` green repo-wide (proves D-1a re-export kept all `Generator` importers compiling).
- [ ] `rg "from \"@rag/rag\"" packages/test-fixtures/src` returns nothing (no cycle).

**Anti-pattern guards:** no `MockFactory`/registry/DI — plain class/function exports. No behavior edits to the moved fakes. Don't add `@rag/rag` to test-fixtures deps.

---

## Phase 2 — Re-point `tests/e2e` to the package

**What to implement:** add `@rag/test-fixtures: workspace:*` to `tests/e2e/package.json` devDependencies; delete `tests/e2e/src/fakes/*` (moved); rewrite the 17 imports (exact list below) from `../fakes/fake-*.js` / `../fakes/factories.js` → `@rag/test-fixtures`.

**Consumer rewrite map (e2e):**

- `specs/api.spec.ts:12,13,14` (FakeConnector, FakeGenerator, plainTextDoc)
- `specs/ingestion.spec.ts:3,4`; `specs/retrieval.spec.ts:4,5,6`; `specs/spreadsheet.spec.ts:2,3`; `specs/idempotency.spec.ts:2,3`
- `eval/run-eval.ts:5,6,7`; `helpers/api.ts:13`; `helpers/ingestion.ts:7`

**Verification:**

- [ ] `rg "fakes/fake-|fakes/factories" tests/e2e/src` returns nothing.
- [ ] `pnpm -r build` (so test-fixtures `dist` exists) then `pnpm e2e` green (needs docker stack up).
- [ ] `pnpm --filter @rag/e2e typecheck` green.

**Anti-pattern guards:** keep `.js` import specifiers (NodeNext). Don't leave a dangling `tests/e2e/src/fakes/` dir.

---

## Phase 3 — Replace inline unit mocks (one file at a time, green between each)

Add `@rag/test-fixtures: workspace:*` to the devDependencies of the consuming packages (`@rag/ingestion`, `@rag/rag`, `@rag/services`), then:

**Consumer rewrite map (unit):**

- `packages/rag/src/retrieval/retriever.test.ts:11-19` — delete local `embedder()` literal; `import { FakeEmbedder } from "@rag/test-fixtures"`; replace `embedder()` calls (lines ~37,59,84) with `new FakeEmbedder()`. (NB: local mock used `dimensions:3` + `vector:[0,0,0]`; FakeEmbedder is 768-dim/real-bow. Since `hybridSearch` is `vi.mock`'d here, the embedding vector is never asserted — confirm the test only checks call wiring, then swap. If a test asserts the literal vector, keep a local stub for THAT test.)
- `packages/ingestion/src/pipeline.test.ts:109-116` — replace the `embedder` literal in `makeDeps()` with `new FakeEmbedder()`; `pipeline.test.ts:386-396` — replace `makeObjectStore()` body with `new FakeObjectStore(new Map())` (preserve the `vi.fn` spy expectations: if tests assert `put`/`delete` were called, wrap or spy via `vi.spyOn(store, "put")` instead of relying on `vi.fn` fields).
- `packages/services/src/ask.test.ts:54,85` — replace `{ answer } as … generator` with `new FakeGenerator()` ONLY if the test doesn't assert on `answer` being a `vi.fn` spy; the empty-retrieval test (line 54) asserts the generator is NOT called → keep a spy (`vi.spyOn(gen, "answer")`) so `.not.toHaveBeenCalled()` still works. (D-1b: skip this file.)
- `packages/services/src/documents.test.ts:12-23` — replace `makeObjectStore()` with `new FakeObjectStore(new Map([[key, Buffer.from("file-bytes")]]))`; adjust the one test that asserts `contentLength`/`contentType` (FakeObjectStore returns `application/pdf`, no contentLength — if a test asserts `contentLength:10`, keep its local stub or extend FakeObjectStore minimally in a LATER behavior slice, not here).

> ⚠ Key nuance: several inline mocks are **`vi.fn()` spies** the tests assert on (`toHaveBeenCalled`, return overrides). The shared fakes are concrete classes, not spies. Where a test asserts call-spying, use `vi.spyOn(instance, "method")` on the shared fake rather than forcing the fake to expose `vi.fn` fields. Where a test asserts a specific canned return the fake can't produce, **leave that test's local stub** — partial consolidation is correct; don't distort the fake to fit one assertion.

**Verification (per file + final):**

- [ ] After each file: `pnpm --filter @rag/<pkg> build && pnpm --filter @rag/<pkg> test` green.
- [ ] `rg -n "embed: vi.fn|embedBatch: vi.fn|bucket: \"|answer } as" packages/*/src/**/*.test.ts` — only intentional remaining spies, none re-implementing a whole interface.

**Anti-pattern guards:** don't widen `@rag/test-fixtures` to expose `vi.fn` internals (keeps it framework-agnostic — use `vi.spyOn` at the call site). Don't change fake behavior to satisfy a single assertion.

---

## Final Phase — Verification

1. `pnpm install --frozen-lockfile` (lockfile updated for new pkg) — or `pnpm install` then commit lockfile.
2. `pnpm -r build` green (proves acyclic build order: core → rag → test-fixtures → consumers).
3. `pnpm typecheck` + `pnpm test` green (Docker-free).
4. `pnpm e2e` green (docker stack up).
5. Grep guards:
   - `rg "from \"@rag/rag\"" packages/test-fixtures/src` → empty (no cycle).
   - `rg "fakes/fake-|fakes/factories" tests/e2e` → empty.
   - `rg -c "class FakeEmbedder|class FakeConnector|class FakeGenerator|class FakeObjectStore" -g '!packages/test-fixtures/**'` → 0 (single definition each).
6. Confirm Pathfinder System 2 (embedder injection, `docs/plans/2026-06-22-phase-g3-...` §3B) can now `import { FakeEmbedder } from "@rag/test-fixtures"` — this package is its prerequisite.

## Sizing

Phase 1 S, Phase 2 S, Phase 3 M (per-file spy nuances). Whole slice ~½ day. Lowest-risk if D-1a typecheck is confirmed before Phase 2.
