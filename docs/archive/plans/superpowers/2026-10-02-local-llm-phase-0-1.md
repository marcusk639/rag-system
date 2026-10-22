---
status: archived
archived: 2026-10-22
superseded_by: [docs/specs/local-llm-verification.md]
---

> **Archived 2026-10-22.** Historical record, not current; the code and the live docs win where they disagree. Phases 0 and 1 shipped through PRs #89, #100 and #103 (the config split landed as `config-schema.ts`, not this plan's file layout). Current source: [specs/local-llm-verification.md](../../../specs/local-llm-verification.md).

# Local LLM Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `EMBEDDING_PROVIDER=local` work from a single env var, and make `COMPLIANCE_MODE=client-data` actually refuse to reach the network — after splitting `config.ts` below the 800-line cap so those edits can be committed at all.

**Architecture:** Three sequential tasks. Task 1 is a pure mechanical split of `packages/core/src/config.ts` (791 lines, cap 800) with zero behavior change, keeping the `@rag/core` public surface identical via a re-export. Task 2 adds a provider-aware embedding-model default behind one shared exported helper that both `loadConfig` and `scripts/warm-model.ts` consume. Task 3 sets `@huggingface/transformers`' `env.allowRemoteModels = false` when compliance mode forbids egress, turning a silent HuggingFace download into a loud failure.

**Tech Stack:** TypeScript (ESM, NodeNext), zod, vitest, `@huggingface/transformers` 3.8.1, pnpm workspace.

**Spec:** `docs/specs/local-llm-verification.md` (Phases 0 and 1). Independent review: `docs/archive/reviews/2026-10-02-local-llm-verification-REVIEW.md`.

## Global Constraints

- **800-line hard cap per source file.** `scripts/check-file-sizes.mjs` blocks the commit. `packages/core/src/config.ts` is currently **791** lines. Only `packages/db/src/queries.ts` is grandfathered; never extend that list.
- **Test colocation.** `foo.ts` → `foo.test.ts` in the same directory.
- **Test-first.** Bug fixes MUST start with a regression test reproducing the bug.
- **Installed `@huggingface/transformers` version is 3.8.1** (the declared range is `^3.5.2`). Offline-control properties on its `env` object, verified from `types/env.d.ts` in the installed package: `allowRemoteModels: boolean` (defaults `true`), `allowLocalModels: boolean` (defaults `true` outside a browser), `localModelPath: string`.
- **Do not edit `.env`.** The template is `env.example`.
- **No attribution lines** in commit messages.
- Per-package single-test invocation: `pnpm --filter @rag/core test -- <pattern>` and `pnpm --filter @rag/rag test -- <pattern>` (both packages' `test` script is `vitest run`).
- On a fresh checkout run `pnpm -r build` first; tests resolve workspace deps via `dist/`.

## Review Focus

Failure modes the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

1. **`EMBEDDING_PROVIDER=local` with an explicit non-bge `EMBEDDING_MODEL`** — the chunk cap still clamps to 512 and its warning names `Xenova/bge-base-en-v1.5` regardless of what the user chose, so the message blames the wrong model. Test in Task 2.
2. **`COMPLIANCE_MODE=client-data` with a cold model cache** — must fail loudly at load, not download weights. Test in Task 3.
3. **`COMPLIANCE_MODE=none` with the local provider** — must still be allowed to download, or local dev breaks. Offline enforcement must not be applied unconditionally. Test in Task 3.
4. **`scripts/warm-model.ts` with `EMBEDDING_MODEL` unset** — must warm the same model `loadConfig` would select, or the pre-warm populates a cache the service never reads. Test in Task 2.
5. **The `config.ts` split changing the public surface** — `import { Config, loadConfig } from "@rag/core"` must keep working; `packages/core/src/index.ts:7` is `export * from "./config.js"`, so anything moved out of `config.ts` disappears from `@rag/core` unless re-exported. Test in Task 1.

---

## Task 1: Split `packages/core/src/config.ts` below the 800-line cap

Pure refactor. No behavior change, no new tests of behavior — one guard test that the public surface survived.

**Files:**

- Create: `packages/core/src/config-schema.ts`
- Create: `packages/core/src/config-auth.ts`
- Modify: `packages/core/src/config.ts` (791 lines → ~245)
- Test: `packages/core/src/config-surface.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `config-schema.ts` exports `Config` (the zod schema, `const`) and `Config` (the inferred `type`). `config-auth.ts` exports `parseOidcScopeMap`, `parseOidcAdminClaims`, `parseMultiValueSecret`, `buildAuthConfig`. `config.ts` continues to export `loadConfig` and re-exports everything from `config-schema.ts`.

What moves, from the verified symbol inventory:

| Destination         | Symbols                                                                                 | Current lines         |
| ------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| `config-schema.ts`  | `Config` zod schema + `Config` type                                                     | 12–408                |
| `config-auth.ts`    | `parseOidcScopeMap`, `parseOidcAdminClaims`, `parseMultiValueSecret`, `buildAuthConfig` | 416–548               |
| `config.ts` (stays) | `defaultCheckDpa`, `LOCAL_PROVIDER_MAX_CHUNK_SIZE`, `loadConfig`                        | 555–561, 572, 575–791 |

All four auth helpers and `defaultCheckDpa` are **file-private today** (no code outside `config.ts` references them), so moving them breaks no importer. Only `Config` and `loadConfig` are real public surface.

- [ ] **Step 1: Write the surface-guard test**

Create `packages/core/src/config-surface.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Config, loadConfig } from "./index.js";

describe("@rag/core config public surface", () => {
  it("still exports the Config zod schema and loadConfig after the split", () => {
    expect(typeof loadConfig).toBe("function");
    expect(Config).toBeDefined();
    // `Config` is a zod object: it must expose .parse
    expect(typeof (Config as { parse?: unknown }).parse).toBe("function");
  });
});
```

- [ ] **Step 2: Run it to confirm it passes BEFORE the split**

Run: `pnpm --filter @rag/core test -- config-surface`
Expected: PASS. This is a guard, not a red test — it must pass before and after, and it is what catches a split that drops an export.

- [ ] **Step 3: Create `config-schema.ts`**

Move lines 12–408 of `config.ts` verbatim (the `export const Config = z.object({...})` and `export type Config = z.infer<typeof Config>;`). Carry over only the imports those lines need:

```ts
import { z } from "zod";
import { parsePrincipalsConfig } from "./access-control.js";
import { OidcConfig } from "./oidc-auth.js";
```

Do not reformat or alter the schema body — a diff that is purely a move is reviewable; one with incidental edits is not.

- [ ] **Step 4: Create `config-auth.ts`**

Move lines 416–548 verbatim (`parseOidcScopeMap`, `parseOidcAdminClaims`, `parseMultiValueSecret`, `buildAuthConfig`). Change each from a bare `function` to `export function`. Imports needed:

```ts
import { z } from "zod";
import { OidcConfig } from "./oidc-auth.js";
```

`buildAuthConfig` returns an inline object literal type, not `Config["auth"]`, so this file does not import from `config-schema.ts` — keeping it free of circular-import risk.

- [ ] **Step 5: Trim `config.ts` and re-export the schema**

Delete the moved regions. Add at the top, after the remaining imports:

```ts
import {
  buildAuthConfig,
  parseMultiValueSecret,
  parseOidcAdminClaims,
  parseOidcScopeMap,
} from "./config-auth.js";
import { Config } from "./config-schema.js";

// Re-exported so `@rag/core`'s barrel (`export * from "./config.js"`) keeps
// surfacing the schema and its type. Without this, splitting the schema out
// silently removes `Config` from the package's public API.
export * from "./config-schema.js";
```

`loadConfig` already calls `Config.parse(...)`, `buildAuthConfig(env)`, `parseMultiValueSecret(...)` and the OIDC parsers — those call sites need no change now that the names are imported.

- [ ] **Step 6: Verify the split compiles, behaves, and fits**

Run: `pnpm --filter @rag/core typecheck`
Expected: no errors.

Run: `pnpm --filter @rag/core test`
Expected: PASS, including the pre-existing `config.test.ts` and the new `config-surface.test.ts`. The existing suite is the real regression net here — if `loadConfig` still passes it, the move was clean.

Run: `wc -l packages/core/src/config.ts packages/core/src/config-schema.ts packages/core/src/config-auth.ts`
Expected: every file under 800; `config.ts` around 245 lines.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config-schema.ts packages/core/src/config-auth.ts packages/core/src/config-surface.test.ts
git commit -m "refactor(core): split config.ts below the 800-line cap

791 of 800 lines left no room for the provider-aware embedding default or a
new rerank provider enum value. Moves the zod schema to config-schema.ts and
the four private auth/env helpers to config-auth.ts, leaving loadConfig,
defaultCheckDpa and LOCAL_PROVIDER_MAX_CHUNK_SIZE in config.ts.

No behavior change. config.ts re-exports config-schema.ts so the @rag/core
barrel keeps surfacing Config and loadConfig; config-surface.test.ts guards
that."
```

---

## Task 2: Provider-aware embedding-model default, shared with `warm-model.ts`

**Files:**

- Modify: `packages/core/src/config.ts` (the `embedding.model` assignment, currently line 653; and the chunk-cap warning, currently ~line 630)
- Modify: `scripts/warm-model.ts:17,29`
- Modify: `env.example:77`
- Test: `packages/core/src/config.test.ts`

**Interfaces:**

- Consumes: Task 1's `config.ts` / `config-schema.ts` layout.
- Produces: `export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/bge-base-en-v1.5"` and `export function defaultEmbeddingModel(provider: "gemini" | "openai" | "local"): string`, both from `packages/core/src/config.ts` and therefore from `@rag/core`.

The bug: `config.ts:653` reads

```ts
model: env.EMBEDDING_MODEL ?? "gemini-embedding-001",
```

so `EMBEDDING_PROVIDER=local` with `EMBEDDING_MODEL` unset hands `gemini-embedding-001` to the ONNX loader, which tries to fetch a nonexistent HuggingFace repo. `env.example:77` ships that Gemini name as an active line, so following the template reproduces it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/config.test.ts`, following that file's existing pattern of spreading a base env object:

```ts
describe("embedding model default is provider-aware", () => {
  it("defaults to the local ONNX model when provider is local", () => {
    const cfg = loadConfig(
      { ...BASE_ENV, EMBEDDING_PROVIDER: "local", EMBEDDING_MODEL: undefined },
      { checkDpa: () => true, warn: () => {} },
    );
    expect(cfg.embedding.model).toBe("Xenova/bge-base-en-v1.5");
  });

  it("still defaults to the Gemini model when provider is gemini", () => {
    const cfg = loadConfig(
      { ...BASE_ENV, EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: undefined },
      { checkDpa: () => true, warn: () => {} },
    );
    expect(cfg.embedding.model).toBe("gemini-embedding-001");
  });

  it("never overrides an explicitly set EMBEDDING_MODEL", () => {
    const cfg = loadConfig(
      {
        ...BASE_ENV,
        EMBEDDING_PROVIDER: "local",
        EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
      },
      { checkDpa: () => true, warn: () => {} },
    );
    expect(cfg.embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  // Review Focus 1: the cap must name the model it actually capped.
  it("names the configured model in the chunk-size cap warning", () => {
    const warnings: string[] = [];
    loadConfig(
      {
        ...BASE_ENV,
        EMBEDDING_PROVIDER: "local",
        EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
        CHUNK_SIZE: "800",
      },
      { checkDpa: () => true, warn: (m) => warnings.push(m) },
    );
    expect(warnings.join("\n")).toContain("Xenova/all-MiniLM-L6-v2");
    expect(warnings.join("\n")).not.toContain("Xenova/bge-base-en-v1.5");
  });
});
```

If `config.test.ts` names its base env object something other than `BASE_ENV`, use that file's actual name — it defines one at the top with `API_TOKENS: "tok1"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @rag/core test -- config`
Expected: the `local` default test FAILS with `expected 'gemini-embedding-001' to be 'Xenova/bge-base-en-v1.5'`; the cap-warning test FAILS because the message hardcodes the bge name. The gemini and explicit-override tests should already PASS.

- [ ] **Step 3: Add the shared default helper**

In `packages/core/src/config.ts`, above `loadConfig`:

```ts
/**
 * The local ONNX embedding model. 768-dim and a hard 512-token window, which is
 * what LOCAL_PROVIDER_MAX_CHUNK_SIZE is sized for.
 *
 * Exported because `scripts/warm-model.ts` must warm the SAME model
 * `loadConfig` selects — a pre-warm that populates a different cache entry is
 * worse than none, since it looks like it worked.
 */
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/bge-base-en-v1.5";

/** The default embedding model for a provider when EMBEDDING_MODEL is unset. */
export function defaultEmbeddingModel(
  provider: "gemini" | "openai" | "local",
): string {
  switch (provider) {
    case "local":
      return DEFAULT_LOCAL_EMBEDDING_MODEL;
    case "openai":
      return "text-embedding-3-small";
    case "gemini":
      return "gemini-embedding-001";
  }
}
```

- [ ] **Step 4: Use it, and fix the cap warning**

Replace line 653:

```ts
model: env.EMBEDDING_MODEL ?? defaultEmbeddingModel(provider),
```

The chunk-cap block computes its warning before `cfg` exists, so derive the model name once above it and use it in both places:

```ts
const embeddingModel = env.EMBEDDING_MODEL ?? defaultEmbeddingModel(provider);
```

Then in the cap warning, replace the hardcoded `(Xenova/bge-base-en-v1.5)` with `(${embeddingModel})`, and use `embeddingModel` for `model:` at line 653.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rag/core test -- config`
Expected: PASS, all four new tests plus the pre-existing suite.

- [ ] **Step 6: Make `warm-model.ts` share the default**

In `scripts/warm-model.ts`, replace line 17 and the hardcoded dimensions at line 29:

```ts
import { createEmbeddingProvider } from "@rag/rag";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "@rag/core";

const model = process.env["EMBEDDING_MODEL"] ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
```

and

```ts
const provider = createEmbeddingProvider({
  provider: "local",
  model,
  dimensions: 768,
});
```

Leave `dimensions: 768` — it matches `EMBEDDING_DIMENSIONS`' own default and `local.ts`'s dimension guard backstops a mismatch. Update the doc comment at line 12, which currently states the default inline, to name the constant instead so it cannot drift again.

- [ ] **Step 7: Verify the warm script agrees with `loadConfig`**

Run: `pnpm --filter @rag/core test -- config` and `pnpm --filter @rag/core typecheck`
Expected: PASS.

Run: `npx tsx scripts/warm-model.ts`
Expected: prints `Warming local embedding model: Xenova/bge-base-en-v1.5 …` then `Model ready.` — the same model string the first test now asserts `loadConfig` selects (Review Focus 4).

- [ ] **Step 8: Update `env.example`**

Change line 77 from an active `EMBEDDING_MODEL=gemini-embedding-001` to a commented line explaining that leaving it unset selects the right model per provider, and that setting it to a Gemini model name while `EMBEDDING_PROVIDER=local` is the misconfiguration this default exists to prevent. Keep `EMBEDDING_DIMENSIONS=768`.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts scripts/warm-model.ts env.example
git commit -m "fix(core): default the embedding model per provider

EMBEDDING_PROVIDER=local with EMBEDDING_MODEL unset handed
gemini-embedding-001 to the ONNX loader, which then attempted a HuggingFace
fetch for a repo that cannot serve it. env.example shipped that Gemini name as
an active line, so following the template reproduced it.

Adds DEFAULT_LOCAL_EMBEDDING_MODEL and defaultEmbeddingModel(provider), both
consumed by loadConfig and scripts/warm-model.ts so the pre-warm cannot warm a
model the service will not load. Also fixes the chunk-cap warning, which named
Xenova/bge-base-en-v1.5 while capping whatever model was configured."
```

---

## Task 3: Offline enforcement for the local ONNX provider

The security-relevant task. The spec's compliance claim — a `client-data` deployment "makes no outbound calls" — is **false today**, and the test that was supposed to prove it cannot.

**Files:**

- Modify: `packages/rag/src/embeddings/local.ts` (constructor; `_loadPipeline`, lines 121–150)
- Modify: `packages/rag/src/embeddings/factory.ts` (the `local` case)
- Test: `packages/rag/src/embeddings/local.test.ts`

**Interfaces:**

- Consumes: Task 2's `DEFAULT_LOCAL_EMBEDDING_MODEL` (not required, but the provider's own fallback should reference the same value).
- Produces: `LocalEmbeddingProvider`'s options gain `offline?: boolean`. `createEmbeddingProvider` passes `offline: opts?.complianceMode === "client-data"`.

### Why the obvious test is worthless, and what to assert instead

`local.test.ts:30` does `vi.mock("@huggingface/transformers", …)`, and `local.test.ts:151` asserts the provider "makes no HTTP calls — all inference is handled in-process (no egress)". That assertion is **vacuous**: the mock replaced the very code that would make the calls. Do not write a new test in that shape.

Assert instead that **our code sets the documented offline flag on the `env` object the library gave us**. That is the contract we own. Whether `allowRemoteModels = false` then prevents fetching is `@huggingface/transformers`' contract, documented in its own source (`src/env.js:7` shows `env.allowRemoteModels = false;` as the offline switch) and typed at `types/env.d.ts:67`. Verifying the library's own behavior is not this repo's job; verifying that we configure it is.

- [ ] **Step 1: Write the failing tests**

In `packages/rag/src/embeddings/local.test.ts`, the hoisted `vi.mock` block already fabricates the module. Extend the mocked module so the `env` object it returns is a real, inspectable object shared with the test, then add:

```ts
describe("offline enforcement", () => {
  it("forbids remote model loading when offline is set", async () => {
    const provider = new LocalEmbeddingProvider({
      model: "Xenova/bge-base-en-v1.5",
      dimensions: 768,
      offline: true,
    });
    await provider.embed("hello");
    expect(mockEnv.allowRemoteModels).toBe(false);
  });

  // Review Focus 3: local dev must still be able to download.
  it("leaves remote model loading enabled when offline is not set", async () => {
    const provider = new LocalEmbeddingProvider({
      model: "Xenova/bge-base-en-v1.5",
      dimensions: 768,
    });
    await provider.embed("hello");
    expect(mockEnv.allowRemoteModels).not.toBe(false);
  });

  // Review Focus 2: a cold cache under offline must fail loudly, and the error
  // must not tell the operator to go and fetch weights it has just forbidden.
  it("fails with an offline-specific message when the cache is cold", async () => {
    mockPipeline.mockRejectedValueOnce(
      new Error("Could not locate file in local cache"),
    );
    const provider = new LocalEmbeddingProvider({
      model: "Xenova/bge-base-en-v1.5",
      dimensions: 768,
      offline: true,
    });
    await expect(provider.embed("hello")).rejects.toThrow(
      /offline.*cache|cache.*offline/i,
    );
    await expect(provider.embed("hello")).rejects.not.toThrow(
      /requires internet access/i,
    );
  });
});
```

Use the mock variable names the existing hoisted block already defines; add a shared `mockEnv` to it if it does not expose one.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @rag/rag test -- local`
Expected: the first test FAILS (`allowRemoteModels` is never set, so it is `undefined`, not `false`); the third FAILS because the current error text at `local.ts:146` always says "first run requires internet access to download weights".

- [ ] **Step 3: Add `offline` to the provider**

In `local.ts`, extend the constructor options with `offline?: boolean` and store `this.offline = opts.offline ?? false;`.

In `_loadPipeline`, after the existing `HF_CACHE_DIR` block and before the `pipeline(...)` call:

```ts
// Under COMPLIANCE_MODE=client-data no weight download is permitted: the
// deployment's whole claim is that nothing leaves the network. transformers.js
// defaults allowRemoteModels to true, and this provider is constructed without
// an EgressPolicy, so nothing else would stop a cold-cache fetch to
// huggingface.co. Forbidding it here turns a silent download into a throw.
if (this.offline) {
  env.allowRemoteModels = false;
}
```

Then make the catch block's message conditional, so an offline failure does not instruct the operator to do the thing that was just forbidden:

```ts
const remedy = this.offline
  ? `Offline mode is enabled (COMPLIANCE_MODE=client-data), so no weights may be ` +
    `downloaded. Pre-populate the cache with "npx tsx scripts/warm-model.ts" on a ` +
    `machine that has network access, and point HF_CACHE_DIR at it.`
  : `Ensure @huggingface/transformers is installed and the model is reachable ` +
    `(first run requires internet access to download weights; subsequent runs use HF_CACHE_DIR).`;

throw new EmbeddingError(
  `Failed to load local embedding model "${this.model}": ${(err as Error).message}. ${remedy}`,
  err,
);
```

Keep the `this._pipelinePromise = null;` reset above it unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rag/rag test -- local`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Wire it from the factory**

In `packages/rag/src/embeddings/factory.ts`, the `local` case currently passes only `model` and `dimensions`. Add the offline flag:

```ts
case "local":
  // No API key required — all inference runs on-process via ONNX.
  // `offline` is what makes the §7216 no-egress claim true: without it a cold
  // cache silently downloads weights from huggingface.co, and this provider
  // gets no EgressPolicy, so EGRESS_ALLOWED_HOSTS cannot block that.
  return new LocalEmbeddingProvider({
    model: cfg.model,
    dimensions: cfg.dimensions,
    offline: opts?.complianceMode === "client-data",
  });
```

- [ ] **Step 6: Verify the whole package and the type surface**

Run: `pnpm --filter @rag/rag test`
Expected: PASS.

Run: `pnpm --filter @rag/rag typecheck`
Expected: no errors.

- [ ] **Step 7: Correct the now-false test name in `local.test.ts`**

The pre-existing test at line 151 claims the provider "makes no HTTP calls … (no egress)" while mocking the downloader. Rename it to what it actually verifies — that `embed` resolves without touching a network client in the mocked harness — and add a one-line comment stating that genuine no-egress behavior is enforced by `offline` and asserted by the tests added in Step 1. Leaving the old name is how the false belief survived review once already.

- [ ] **Step 8: Commit**

```bash
git add packages/rag/src/embeddings/local.ts packages/rag/src/embeddings/factory.ts packages/rag/src/embeddings/local.test.ts
git commit -m "fix(rag): forbid remote model downloads under client-data compliance

The 'no outbound calls' claim was false. local.ts never set
allowRemoteModels=false, transformers.js defaults it to true, and factory.ts
builds the provider with no EgressPolicy — so EGRESS_ALLOWED_HOSTS=127.0.0.1
could not block a cold-cache fetch to huggingface.co, and the
remove-the-host/expect-EGRESS_BLOCKED check passed over that hole.

Adds an offline option set from COMPLIANCE_MODE=client-data, makes a cold cache
throw with a remedy that does not tell the operator to download what was just
forbidden, and renames the pre-existing 'makes no HTTP calls' test, which
asserted that while mocking the downloader."
```

---

## Self-review notes

**Spec coverage.** Phase 0a → Task 1. Phase 0b → Task 3 (the embedder half; the reranker half of 0b does not exist yet and belongs to Phase 3's own spec, which must extend `warm-model.ts` then). Phase 1a → Task 2. Phase 1b → already done and recorded in the spec under "Phase 1b result".

**Known gap, deliberately not in scope.** Phase 0b in the spec says offline enforcement for "both ONNX providers". Only the embedder exists today, so only it is covered here. Phase 3 must not add a local reranker without adding the same `offline` flag and extending `warm-model.ts` to warm it — `warm-model.ts` currently warms the embedder only, so a reranker added without that leaves a cold cache on first query, which under `offline` is a hard failure.

**Type consistency.** `DEFAULT_LOCAL_EMBEDDING_MODEL` and `defaultEmbeddingModel` are defined in Task 2 Step 3 and used in Task 2 Steps 4 and 6. `offline` is added in Task 3 Step 3 and consumed in Step 5. `createEmbeddingProvider`'s existing `opts?.complianceMode` is the source of the flag — no new parameter.

**Review Focus coverage.** 1 → Task 2 Step 1 (cap-warning test). 2 → Task 3 Step 1 (cold-cache test). 3 → Task 3 Step 1 (offline-unset test). 4 → Task 2 Step 7 (warm script prints the same model). 5 → Task 1 Step 1 (surface guard).
