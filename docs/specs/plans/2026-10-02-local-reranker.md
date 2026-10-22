---
title: Local reranker implementation plan
status: current
last_verified: 2026-10-22
verified_against: c7e5485
answers: The plan for the in-process bge-reranker-base cross-encoder (local-LLM phase 3). Not started.
read_when: You are executing the local reranker work.
---

# Local Reranker (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Task 2 reads the cross-encoder head as a **single scalar logit**. If that is implemented as a 2-class softmax index, ranking inverts silently and every retrieval gets worse with no error — that is the one defect in this plan that no green test catches unless Task 2's dims assertion and Task 11's real-weights test both exist.

**Tech Stack:** TypeScript (ESM, NodeNext), zod, vitest, `@huggingface/transformers` 3.8.1, pnpm workspace, Postgres + pgvector (eval harness only).

**Spec:** `docs/specs/local-llm-verification.md`, **Phase 3** (and the model/scoring decision it carries forward from Amendment 2). Independent review: `docs/archive/reviews/2026-10-02-local-llm-verification-REVIEW.md` (findings 4, 6, 8, 9, 10). Decision ledger from the prerequisite work: `.superpowers/sdd/2026-10-02-local-llm-phase-0-1/progress.md`.

**Prerequisite, already landed:** Phase 0a (`config.ts` split — now 290 lines, with `config-schema.ts` 406 and `config-auth.ts` 144) and Phase 0b for the embedder (`offline` flag, `allowRemoteModels = false`, `HF_CACHE_DIR` constructor guard). HEAD at plan authoring: `a9fa209`. Do not start this plan on a tree that lacks those.

---

## Settled by the spec — do not revisit

| Decision               | Value                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                  | `Xenova/bge-reranker-base` — MIT, `onnx/` confirmed with seven quant variants, 512-token **pairs**, Bert-family `AutoModelForSequenceClassification`                                                                                                                                                                                                                               |
| Documented alternative | `Xenova/ms-marco-MiniLM-L-6-v2` (apache-2.0, English, smaller). **Operator-chosen via `RERANK_MODEL`, never a runtime failover** — an automatic model swap would change ranking silently                                                                                                                                                                                           |
| Scoring                | **One scalar logit per pair** (`logits.view(-1,).float()`), higher = more relevant. **Not** a 2-class softmax, not `logits[:, 1]`, not the `text-classification` pipeline (which applies softmax + label maps)                                                                                                                                                                     |
| Rejected, with reason  | `bge-reranker-v2-m3` (no `onnx/`); `onnx-community/bge-reranker-v2-m3-ONNX` (~7.75 GB, multilingual we don't need); `jina-reranker-v2` (**cc-by-nc-4.0 — non-commercial, disqualifying**); `jina-reranker-v3` (no ONNX, listwise); `Qwen3-Reranker-0.6B` (generative yes/no scorer, not a classifier); `mxbai-rerank-base-v1` (DeBERTa-v2, no first-party transformers.js example) |
| Gate shape             | `createReranker` widens from "provider !== none" to "provider egresses"; `none` and `local` pass, `cohere`/`jina`/`llm` stay blocked under `client-data`                                                                                                                                                                                                                           |
| Interface fit          | `packages/core/src/interfaces.ts:101-115` imposes nothing about transport and explicitly sanctions throwing — a no-network provider fits with no interface change to `rerank()`                                                                                                                                                                                                    |

---

## Global Constraints

- **800-line hard cap per source file.** `scripts/check-file-sizes.mjs` blocks the commit. Only `packages/db/src/queries.ts` is grandfathered; never extend that list. Current headroom on files this plan edits: `reranker.ts` 184, `config.ts` 290, `config-schema.ts` 406, `local.ts` 376, `retriever.ts` ~140. None is near the cap; the new `local-reranker.ts` must stay under it on its own.
- **Test colocation.** `foo.ts` → `foo.test.ts` in the same directory.
- **Test-first.** Write the failing test, run it, confirm it fails _for the right reason_, then implement. Bug fixes MUST start with a regression test.
- **Installed `@huggingface/transformers` is 3.8.1** (declared range `^3.5.2`, `packages/rag/package.json:24`). Offline-control properties on its `env`, from the installed package's `types/env.d.ts`: `allowRemoteModels: boolean` (defaults `true`), `allowLocalModels: boolean`, `localModelPath: string`, `cacheDir: string`.
- **The dynamic import is `any`-typed.** `local.ts:190` does `await import("@huggingface/transformers" as string)`, deliberately — a non-literal specifier keeps the package out of the module graph for non-local deployments. The consequence is that `env.allowRemoteModels = false` gets **no compile-time check**, which is why `ALLOW_REMOTE_MODELS_KEY` (`local.ts:77`) pins the literal against `keyof TransformersEnvironment`. The reranker must go through the same pinned constant, not a fresh literal.
- **Do not edit `.env` files.** The template is `env.example`.
- **No attribution lines** in commit messages. Conventional Commits: `<type>: <description>`.
- Per-package single test: `pnpm --filter @rag/rag test -- <pattern>`, `pnpm --filter @rag/core test -- <pattern>` (both `test` scripts are `vitest run`).
- On a fresh checkout run `pnpm -r build` first — tests resolve workspace deps via `dist/`. If a verification step reports a surprising result, **rebuild before believing it**: the Phase 0+1 ledger records a verification that was flatly wrong because it imported a stale `packages/rag/dist/`.
- Prettier auto-formats on write. Do not fight the formatter; do not reformat untouched code.
- `pnpm eval` (Task 12) needs the local stack: `pnpm docker:up` first.

---

## Review Focus

Failure modes this phase introduces that no task's happy path exercises. Each is assigned to the task that owns the code.

1. **`RERANK_PROVIDER=local` + `EMBEDDING_PROVIDER=gemini` + `COMPLIANCE_MODE=none`.** The 512-token cap lives behind `if (provider === "local")` where `provider` is the _embedding_ provider (`config.ts:121`), so this configuration — the one the gate widening makes attractive — keeps `CHUNK_SIZE` at 800 and truncates every pair at rerank time with no signal. Test in **Task 7**.
2. **`COMPLIANCE_MODE=client-data` + `RERANK_PROVIDER=local` + unset/blank `HF_CACHE_DIR`.** Must throw at construction, not attempt a huggingface.co download on the first query. Test in **Task 3**.
3. **`COMPLIANCE_MODE=none` + `RERANK_PROVIDER=local`.** Must still be allowed to download, or local dev and CI break. Offline enforcement must not be unconditional. Test in **Task 3**.
4. **`COMPLIANCE_MODE=client-data` + `RERANK_PROVIDER=cohere`/`jina`.** Must stay blocked. The widening must not become "everything passes". Test in **Task 6**.
5. **`COMPLIANCE_MODE=client-data` + `RERANK_PROVIDER=llm`.** Must stay blocked — `llm` reuses the generation client and is only local if `GENERATION_BASE_URL` happens to be, which the gate cannot know. Test in **Task 6**.
6. **A 2-class classification head.** Would make the scalar read pick `logits[0]` of a 2-vector — a plausible-looking number that inverts ranking. A mocked unit test cannot catch it (review finding 6: the mock asserts the author's belief about the head shape). Runtime dims assertion in **Task 2**; real-weights proof in **Task 11**.
7. **A reranker that can never load.** `local.ts:140-142` resets the load promise on failure, so every query retries — for a 430 MB download that is a per-query stampede, and the deployment believes reranking is on while every query degrades to RRF forever. Bounded retry in **Task 3**; observability in **Task 8**.
8. **`RERANK_PROVIDER=local` set on `rag-api` and forgotten on `rag-mcp`.** The MCP server is the agent-facing surface and builds its own `CoreDeps`; a per-service variable set on one service and not the others is the exact failure the Phase 0+1 ledger hit for `COMPLIANCE_MODE`. Enumerated in **Task 10**.
9. **A new variable that is always-set-but-empty under compose.** `${VAR:-literal}` in compose shadows a smarter app-side default and cannot be overridden back to "unset" — the `EMBEDDING_MODEL` and `GENERATION_MODEL` bugs, found in round 7 of seven. Enumerated in **Task 10**.
10. **Up to three resident copies of the weights.** api, mcp and worker all call `buildCoreDeps`, and the worker builds a `Retriever` it never queries. Addressed by lazy load (weights resident only in a process that actually reranks) — asserted in **Task 3**, documented in **Task 10**.

---

## Design notes that span tasks

**Cost (spec constraint 1).** `retriever.ts:82` — `fetchK = this.reranker ? topK * this.rerankPoolMultiplier : topK`. Defaults 12 × 5 = **60 cross-encoder forward passes per query**, in-process, on the API event loop. The three mitigations, in the order they appear in this plan:

- **A `local`-specific pool multiplier** (Task 6): when `RERANK_PROVIDER=local` and `RERANK_POOL_MULTIPLIER` is unset, default to **2** (12 × 2 = 24 passes) instead of 5. No new variable; an explicit `RERANK_POOL_MULTIPLIER` still wins.
- **A scoring timeout** (Task 5): `RERANK_TIMEOUT_MS`, default 10000. On expiry the reranker throws and `retriever.ts:112` degrades to RRF order — the existing, correct behavior.
- **A concurrency bound** (Task 2): pairs are scored in fixed batches of 8, awaited sequentially, with exactly one in-flight model load. This is a non-configurable internal constant: a knob here buys nothing an operator can reason about and adds a variable to the Task 10 enumeration.

**Load timing.** The model loads lazily on first `rerank()`. While loading, `rerank()` **throws immediately** rather than awaiting — so no query pays a cold load, and the queries during warm-up degrade to RRF (which is what they would get from a disabled reranker anyway). This is also what keeps the worker from holding a copy of the weights: it builds a `Retriever` but never calls `rerank()`.

**Two 512-token problems (spec constraint 2).** They are separate and both real:

1. A cross-encoder shares **one** 512-token budget across query _and_ document, so even a 512-token chunk truncates once the query and three special tokens are added. Task 4 makes that measurable instead of silent.
2. `LOCAL_PROVIDER_MAX_CHUNK_SIZE` is keyed on the embedding provider only. Task 7 keys it on the reranker provider too.

Task 4 does not try to fix (1) — there is no fix short of shorter chunks; it makes the rate observable so the operator can act.

---

## Task 1: Extract the shared HuggingFace offline guard into one module

Phase 0b built the embedder's offline enforcement in place. The reranker needs it **identically**: `env.allowRemoteModels = false` when offline, and a constructor throw when offline with no `HF_CACHE_DIR`. Copying it would re-create exactly the drift the ledger logged as finding M-1 (`local.ts` had duplicated the `"Xenova/bge-base-en-v1.5"` literal that `config.ts` exported to prevent drift). Extract first, then both callers share one implementation.

Pure refactor: no behavior change, so the guard test passes before and after.

- [ ] **Step 1: Write the behavior-preservation test**

Create `packages/rag/src/hf-offline.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { ComplianceError } from "@rag/core";
import {
  ALLOW_REMOTE_MODELS_KEY,
  assertOfflineCacheDir,
} from "./hf-offline.js";

const ORIGINAL = process.env["HF_CACHE_DIR"];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["HF_CACHE_DIR"];
  else process.env["HF_CACHE_DIR"] = ORIGINAL;
});

describe("ALLOW_REMOTE_MODELS_KEY", () => {
  it("is the property name @huggingface/transformers documents as the offline switch", () => {
    // Pinned against `keyof TransformersEnvironment` in hf-offline.ts, so a
    // rename in the library fails tsc rather than silently no-op'ing the
    // no-egress guarantee. This test pins the VALUE as well, so a typo'd
    // rename to another real key would also be caught.
    expect(ALLOW_REMOTE_MODELS_KEY).toBe("allowRemoteModels");
  });
});

describe("assertOfflineCacheDir", () => {
  it("throws ComplianceError when offline and HF_CACHE_DIR is unset", () => {
    delete process.env["HF_CACHE_DIR"];
    expect(() => assertOfflineCacheDir(true, "LocalEmbeddingProvider")).toThrow(
      ComplianceError,
    );
  });

  it("throws when offline and HF_CACHE_DIR is whitespace-only", () => {
    process.env["HF_CACHE_DIR"] = "   ";
    expect(() => assertOfflineCacheDir(true, "LocalEmbeddingProvider")).toThrow(
      /HF_CACHE_DIR/,
    );
  });

  it("names the component in the message so two ONNX providers are distinguishable", () => {
    delete process.env["HF_CACHE_DIR"];
    expect(() =>
      assertOfflineCacheDir(true, "LocalCrossEncoderReranker"),
    ).toThrow(/LocalCrossEncoderReranker/);
  });

  it("does nothing when offline is false, even with no cache dir", () => {
    delete process.env["HF_CACHE_DIR"];
    expect(() =>
      assertOfflineCacheDir(false, "LocalEmbeddingProvider"),
    ).not.toThrow();
  });

  it("does nothing when offline and HF_CACHE_DIR is set", () => {
    process.env["HF_CACHE_DIR"] = "/opt/hf-cache";
    expect(() =>
      assertOfflineCacheDir(true, "LocalEmbeddingProvider"),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
pnpm --filter @rag/rag test -- hf-offline
```

Expected: fails to resolve `./hf-offline.js` — the module does not exist yet. Not an assertion failure.

- [ ] **Step 3: Create `packages/rag/src/hf-offline.ts`**

Move the type-pin and the cache-dir guard out of `local.ts` verbatim where possible; the only edits are parameterising the component name and the model-kind wording.

```ts
import { ComplianceError } from "@rag/core";
import type { env as _HFEnvForTypeCheckOnly } from "@huggingface/transformers";

/**
 * Shared offline controls for every in-process ONNX provider
 * (`embeddings/local.ts`, `retrieval/local-reranker.ts`).
 *
 * Both load weights through `@huggingface/transformers` via a dynamic import
 * with a non-literal specifier, which is necessarily `any`-typed — so neither
 * gets a compile-time check on the one property the whole
 * COMPLIANCE_MODE=client-data no-egress guarantee rests on. This module exists
 * so that property name, and the cache-dir precondition that makes offline
 * mode viable, are written down exactly once.
 */

/**
 * Pins the literal against `keyof TransformersEnvironment` (a type-only import
 * of the installed package's own `types/env.d.ts`). If
 * @huggingface/transformers renames or removes `allowRemoteModels`, this fails
 * `tsc` instead of the offline guarantee silently becoming a no-op. Callers
 * MUST index `env` with this constant, never with the literal, so the checked
 * name and the name used at runtime cannot drift.
 */
export const ALLOW_REMOTE_MODELS_KEY: keyof typeof _HFEnvForTypeCheckOnly =
  "allowRemoteModels";

/**
 * Fail at construction when an offline deployment has no durable cache.
 *
 * @huggingface/transformers' default cache directory (its `env.js:96-98`) is
 * INSIDE `node_modules` — destroyed by any `pnpm install` or fresh container
 * build. An offline deployment that relies on it works until the next deploy
 * and then fails on the first query, at which point `allowRemoteModels=false`
 * turns a slow re-download into a hard error. Better to refuse to boot.
 *
 * Read directly from `process.env` rather than threaded through `loadConfig`,
 * matching the existing embedder. If HF_CACHE_DIR is ever added to
 * config-schema.ts, every caller of this function must switch to the resolved
 * value at the same time or the two readings will drift.
 *
 * @param offline  true when COMPLIANCE_MODE=client-data
 * @param component the constructing class name, so an operator with both ONNX
 *                  providers configured can tell which one refused to boot
 */
export function assertOfflineCacheDir(
  offline: boolean,
  component: string,
): void {
  if (!offline) return;
  if (process.env["HF_CACHE_DIR"]?.trim()) return;
  throw new ComplianceError(
    `${component} constructed with offline=true but HF_CACHE_DIR is unset. ` +
      `@huggingface/transformers' default cache lives inside node_modules, ` +
      `which does not survive a reinstall or a fresh container build, so an ` +
      `offline deployment cannot rely on it. Set HF_CACHE_DIR to a durable ` +
      `path (a persistent volume or network share) and pre-warm it with ` +
      `scripts/warm-model.ts before starting in offline mode.`,
  );
}
```

- [ ] **Step 4: Run the new test**

```bash
pnpm --filter @rag/rag test -- hf-offline
```

Expected: 6 passing.

- [ ] **Step 5: Point `local.ts` at the shared module**

In `packages/rag/src/embeddings/local.ts`:

- Delete the `_HFEnvForTypeCheckOnly` type-only import, the `ALLOW_REMOTE_MODELS_KEY` constant (`:77-78`) and its docblock (`:62-76`).
- Replace the constructor's inline guard (`:164-173`) with `assertOfflineCacheDir(this.offline, "LocalEmbeddingProvider");`, keeping the surrounding comment that explains _why_ the default cache dir is unusable (that comment is load-bearing operator context; the ledger records it being lost and re-found twice).
- Add `import { ALLOW_REMOTE_MODELS_KEY, assertOfflineCacheDir } from "../hf-offline.js";`
- `_loadPipeline`'s `env[ALLOW_REMOTE_MODELS_KEY] = false;` is unchanged — it now reads the shared constant.

Do not change `ComplianceError` to any other error type: the ledger settled that this path uses `ComplianceError` (round 3), and `apps/api/src/error-handler.ts:28` gives it dedicated handling.

- [ ] **Step 6: Prove the embedder's behavior did not change**

```bash
pnpm --filter @rag/rag test -- local
pnpm --filter @rag/rag test -- hf-offline
pnpm -r typecheck
```

Expected: the whole pre-existing `local.test.ts` suite still green, with no edits to it. If any assertion in `local.test.ts` had to change, the refactor was not behavior-preserving — stop and reconsider rather than editing the test.

- [ ] **Step 7: Prove the type-pin still bites**

Temporarily change `ALLOW_REMOTE_MODELS_KEY`'s value in `hf-offline.ts` to `"allowRemoteModelz"` and run `pnpm --filter @rag/rag typecheck`. Expected: a `tsc` error on that line. Revert. Record the observed error text in the commit body — the guard is worthless if nobody has ever seen it fire, and the ledger records an "offline enforcement verified" claim that was made against a stale `dist/`.

- [ ] **Step 8: Commit**

```bash
git add packages/rag/src/hf-offline.ts packages/rag/src/hf-offline.test.ts packages/rag/src/embeddings/local.ts
git commit -m "refactor(rag): extract the shared HuggingFace offline guard

The local reranker needs byte-identical offline enforcement to the local
embedder: allowRemoteModels=false under COMPLIANCE_MODE=client-data, and a
constructor throw when HF_CACHE_DIR is unset. Copying it would duplicate the
one property name the whole no-egress guarantee rests on.

Moves ALLOW_REMOTE_MODELS_KEY and the cache-dir precondition into
hf-offline.ts, parameterised by component name so an operator running both
ONNX providers can tell which refused to boot. local.ts now consumes it.

No behavior change: local.test.ts is untouched and still green."
```

---

## Task 2: `LocalCrossEncoderReranker` — scalar-logit scoring and ordering

The core. Not reachable from `createReranker` yet (Task 6), so it is tested by direct construction.

The scoring path deliberately avoids the `text-classification` pipeline: that helper applies softmax and a label map, which is precisely the transform that turns a scalar relevance logit into a meaningless probability. Use `AutoTokenizer` + `AutoModelForSequenceClassification` and read `logits` directly.

- [ ] **Step 1: Write the scoring and ordering tests**

Create `packages/rag/src/retrieval/local-reranker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@rag/core";

/**
 * Hand-authored mock. Per review finding 6 this verifies the CALLER's
 * contract — batching, ordering, truncation, the dims assertion — and
 * explicitly NOT the real model's head shape. The head shape is proven only
 * by the opt-in real-weights test (local-reranker.integration.test.ts).
 */
const mocks = vi.hoisted(() => {
  const logitsByCall: number[][] = [];
  return {
    logitsByCall,
    tokenizer: vi.fn(),
    model: vi.fn(),
    env: { allowRemoteModels: true, cacheDir: undefined as string | undefined },
    fromPretrainedTokenizer: vi.fn(),
    fromPretrainedModel: vi.fn(),
  };
});

vi.mock("@huggingface/transformers", () => ({
  AutoTokenizer: { from_pretrained: mocks.fromPretrainedTokenizer },
  AutoModelForSequenceClassification: {
    from_pretrained: mocks.fromPretrainedModel,
  },
  env: mocks.env,
}));

function candidate(id: string, text: string): RetrievalResult {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    text,
    score: 0,
    metadata: {},
  } as unknown as RetrievalResult;
}

/** Queues one `logits` tensor per expected model call. */
function queueLogits(...calls: number[][]): void {
  mocks.logitsByCall.length = 0;
  mocks.logitsByCall.push(...calls);
  let call = 0;
  mocks.model.mockImplementation(async () => {
    const data = mocks.logitsByCall[call++]!;
    return {
      logits: { data: Float32Array.from(data), dims: [data.length, 1] },
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["HF_CACHE_DIR"] = "/tmp/hf-cache-test";
  mocks.fromPretrainedTokenizer.mockResolvedValue(
    Object.assign(mocks.tokenizer, { model_max_length: 512 }),
  );
  mocks.fromPretrainedModel.mockResolvedValue(mocks.model);
  mocks.tokenizer.mockReturnValue({
    input_ids: [[101, 102]],
    attention_mask: [[1, 1]],
  });
});

describe("LocalCrossEncoderReranker scoring", () => {
  it("orders by descending scalar logit, not by input order", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([-4.2, 7.1, 0.3]);
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });

    const out = await r.rerank(
      "q",
      [candidate("a", "ta"), candidate("b", "tb"), candidate("c", "tc")],
      3,
    );

    expect(out.map((c) => c.chunkId)).toEqual(["b", "c", "a"]);
  });

  it("treats a HIGHER logit as more relevant (negative logits are not inverted)", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    // bge-reranker emits negative logits for irrelevant pairs. A softmax or
    // abs() reading would rank -8 above -1.
    queueLogits([-8, -1]);
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    const out = await r.rerank(
      "q",
      [candidate("far", "x"), candidate("near", "y")],
      2,
    );
    expect(out.map((c) => c.chunkId)).toEqual(["near", "far"]);
  });

  it("truncates to topK and returns a NEW array without mutating the input", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1, 2, 3]);
    const input = [
      candidate("a", "ta"),
      candidate("b", "tb"),
      candidate("c", "tc"),
    ];
    const snapshot = input.map((c) => c.chunkId);
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });

    const out = await r.rerank("q", input, 2);

    expect(out).toHaveLength(2);
    expect(out).not.toBe(input);
    expect(input.map((c) => c.chunkId)).toEqual(snapshot);
  });

  it("is stable on equal scores, preserving the incoming RRF order", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1, 1, 1]);
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    const out = await r.rerank(
      "q",
      [candidate("a", "ta"), candidate("b", "tb"), candidate("c", "tc")],
      3,
    );
    expect(out.map((c) => c.chunkId)).toEqual(["a", "b", "c"]);
  });

  it("bounds concurrency: 20 candidates become 3 batched model calls of <= 8", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits(
      Array.from({ length: 8 }, (_, i) => i),
      Array.from({ length: 8 }, (_, i) => i),
      Array.from({ length: 4 }, (_, i) => i),
    );
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.rerank(
      "q",
      Array.from({ length: 20 }, (_, i) => candidate(`c${i}`, `t${i}`)),
      5,
    );
    expect(mocks.model).toHaveBeenCalledTimes(3);
  });

  it("returns an empty array for an empty candidate pool without loading the model", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    expect(await r.rerank("q", [], 5)).toEqual([]);
    expect(mocks.fromPretrainedModel).not.toHaveBeenCalled();
  });

  it("throws when the head is NOT a single scalar per pair", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    // A 2-class head: dims [2, 2]. Reading element 0 of each row would produce
    // plausible numbers and silently invert ranking. Refuse instead.
    mocks.model.mockResolvedValue({
      logits: { data: Float32Array.from([0.1, 0.9, 0.8, 0.2]), dims: [2, 2] },
    });
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await expect(
      r.rerank("q", [candidate("a", "ta"), candidate("b", "tb")], 2),
    ).rejects.toThrow(/single scalar logit/i);
  });

  it("tokenizes query and document as a PAIR, with truncation on", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1]);
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.rerank("the query", [candidate("a", "the document")], 1);

    expect(mocks.tokenizer).toHaveBeenCalledWith(
      ["the query"],
      expect.objectContaining({
        text_pair: ["the document"],
        padding: true,
        truncation: true,
      }),
    );
  });

  it("exposes name 'local'", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    expect(
      new LocalCrossEncoderReranker({ model: "m", timeoutMs: 1 }).name,
    ).toBe("local");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail for the right reason**

```bash
pnpm --filter @rag/rag test -- local-reranker
```

Expected: module-resolution failure on `./local-reranker.js`. Not assertion failures.

- [ ] **Step 3: Implement `packages/rag/src/retrieval/local-reranker.ts`**

```ts
import type { Reranker, RetrievalResult } from "@rag/core";
import { ValidationError } from "@rag/core";
import {
  ALLOW_REMOTE_MODELS_KEY,
  assertOfflineCacheDir,
} from "../hf-offline.js";

/**
 * In-process ONNX cross-encoder reranker. No network at inference time, which
 * is what lets it run under COMPLIANCE_MODE=client-data where the hosted
 * Cohere/Jina rerankers are refused (they ship firm document text to a vendor;
 * see `reranker.ts`'s Egress section).
 *
 * ## Scoring — the one thing that must not be got wrong
 *
 * `Xenova/bge-reranker-base` is a Bert-family
 * `AutoModelForSequenceClassification` with a **single-output head**. Its
 * reference implementation reads `logits.view(-1,).float()`: one scalar per
 * (query, document) pair, higher = more relevant, unbounded and frequently
 * negative. There is no softmax and no positive/negative class.
 *
 * Reading it as a 2-class probability (`softmax(logits)[:, 1]`) produces
 * plausible numbers and **inverts ranking**, with no error and no failing
 * mocked test. `assertScalarHead` below is the runtime guard; the real-weights
 * proof is `local-reranker.integration.test.ts`.
 *
 * The `text-classification` pipeline helper is deliberately NOT used: it
 * applies softmax and a label map, i.e. exactly that transform.
 *
 * ## The 512-token budget
 *
 * The pair shares ONE 512-token window across query and document plus three
 * special tokens, so an 800-token chunk — or even a 512-token one — truncates.
 * `config.ts` caps CHUNK_SIZE when a local provider is configured; this class
 * reports the residual rate (see `truncationStats`). There is no fix beyond
 * shorter chunks; the point is that it stops being silent.
 */

/** Scored pairs per model call. Bounds peak memory and event-loop blocking. */
const BATCH_SIZE = 8;

/** Fallback when the loaded tokenizer does not expose `model_max_length`. */
const DEFAULT_MAX_PAIR_TOKENS = 512;

interface HFTensorLike {
  data: ArrayLike<number>;
  dims: number[];
}

/**
 * Read one scalar per pair, refusing any other head shape.
 *
 * Accepts `[n]` and `[n, 1]`. Refuses `[n, k>1]`, which is the 2-class head
 * that would silently invert ranking, and refuses a length mismatch, which
 * would mis-associate scores with candidates.
 */
export function assertScalarHead(
  logits: HFTensorLike,
  expectedPairs: number,
): number[] {
  const dims = logits.dims;
  const lastDim = dims.length > 1 ? dims[dims.length - 1] : 1;
  if (lastDim !== 1) {
    throw new ValidationError(
      `Reranker model returned logits with shape [${dims.join(", ")}]. This ` +
        `provider requires a single scalar logit per (query, document) pair ` +
        `(a single-output AutoModelForSequenceClassification head, as in ` +
        `Xenova/bge-reranker-base). A multi-class head would need a different ` +
        `score extraction and reading element 0 of each row would invert ` +
        `ranking silently. Set RERANK_MODEL to a single-output cross-encoder.`,
    );
  }
  if (logits.data.length !== expectedPairs) {
    throw new ValidationError(
      `Reranker returned ${logits.data.length} scores for ${expectedPairs} ` +
        `pairs; scores cannot be mapped back to candidates.`,
    );
  }
  return Array.from(logits.data, Number);
}

export class LocalCrossEncoderReranker implements Reranker {
  readonly name = "local";
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly offline: boolean;
  private loaded: { tokenizer: unknown; model: unknown } | null = null;

  constructor(opts: {
    /** HuggingFace model id, e.g. Xenova/bge-reranker-base. */
    model: string;
    /** Wall-clock budget for one rerank() call, from RERANK_TIMEOUT_MS. */
    timeoutMs: number;
    /** true when COMPLIANCE_MODE=client-data. */
    offline?: boolean;
  }) {
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.offline = opts.offline ?? false;
    // Identical precondition to LocalEmbeddingProvider: an offline deployment
    // whose cache lives inside node_modules fails on the first query after any
    // reinstall. Refuse to boot instead.
    assertOfflineCacheDir(this.offline, "LocalCrossEncoderReranker");
  }

  async rerank(
    query: string,
    candidates: RetrievalResult[],
    topK: number,
  ): Promise<RetrievalResult[]> {
    // No pool, nothing to order — and no reason to pay a model load.
    if (candidates.length === 0) return [];

    const { tokenizer, model } = await this.load();

    const scores: number[] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const inputs = (tokenizer as (...a: unknown[]) => unknown)(
        batch.map(() => query),
        {
          text_pair: batch.map((c) => c.text),
          padding: true,
          truncation: true,
        },
      );
      const out = (await (model as (...a: unknown[]) => Promise<unknown>)(
        inputs,
      )) as { logits: HFTensorLike };
      scores.push(...assertScalarHead(out.logits, batch.length));
    }

    // Decorate-sort-undecorate with the original index as the tiebreak, so
    // equal scores preserve the incoming RRF order rather than depending on
    // the engine's sort stability.
    return candidates
      .map((c, i) => ({ c, i, s: scores[i]! }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, topK)
      .map((e) => e.c);
  }

  /** Loads tokenizer + model once. Replaced in Task 3 with a bounded state machine. */
  private async load(): Promise<{ tokenizer: unknown; model: unknown }> {
    if (this.loaded) return this.loaded;
    // Dynamic, non-literal specifier: keeps @huggingface/transformers out of
    // the module graph (and its ONNX init cost out of startup) for the
    // deployments that do not use it. Necessarily `any`-typed, which is why
    // ALLOW_REMOTE_MODELS_KEY is pinned in hf-offline.ts.
    const { AutoTokenizer, AutoModelForSequenceClassification, env } =
      await import("@huggingface/transformers" as string);

    if (process.env["HF_CACHE_DIR"]) {
      env.cacheDir = process.env["HF_CACHE_DIR"];
    }
    if (this.offline) {
      env[ALLOW_REMOTE_MODELS_KEY] = false;
    }

    const tokenizer = await AutoTokenizer.from_pretrained(this.model);
    const model = await AutoModelForSequenceClassification.from_pretrained(
      this.model,
    );
    this.loaded = { tokenizer, model };
    return this.loaded;
  }
}
```

`DEFAULT_MAX_PAIR_TOKENS` is declared here and consumed in Task 4; `timeoutMs` is stored here and applied in Task 5. Both are referenced in this file by the end of Task 5, so no dead code survives the plan — but if you stop early, delete them rather than leaving them unused (eslint will flag `DEFAULT_MAX_PAIR_TOKENS`).

- [ ] **Step 4: Run and iterate to green**

```bash
pnpm --filter @rag/rag test -- local-reranker
pnpm -r typecheck
```

Expected: 9 passing.

- [ ] **Step 5: Export from the package barrel**

In `packages/rag/src/index.ts`, beside the existing `./retrieval/reranker.js` export block (`:41`):

```ts
export { LocalCrossEncoderReranker } from "./retrieval/local-reranker.js";
```

Needed by `scripts/warm-model.ts` (Task 9) and the integration test (Task 11).

- [ ] **Step 6: Commit**

```bash
git add packages/rag/src/retrieval/local-reranker.ts packages/rag/src/retrieval/local-reranker.test.ts packages/rag/src/index.ts
git commit -m "feat(rag): local ONNX cross-encoder reranker, scalar-logit scored

Xenova/bge-reranker-base via AutoTokenizer +
AutoModelForSequenceClassification. Scores each (query, document) pair as a
SINGLE SCALAR LOGIT, higher = more relevant, matching the model's
single-output head (logits.view(-1,).float()).

Not the text-classification pipeline and not softmax(logits)[:, 1]: that
reading produces plausible numbers and inverts ranking with no error.
assertScalarHead refuses any head whose last dim is not 1, so a 2-class model
fails loudly rather than ranking backwards.

Pairs are scored in batches of 8 so 60 forward passes per query do not block
the event loop as one unit. Not yet reachable from createReranker."
```

---

## Task 3: Offline enforcement and a bounded load state

Task 2's `load()` is a placeholder for exactly one reason: `local.ts:140-142` resets its load promise on failure, so every query retries the load. For a 430 MB download that is a per-query stampede; under `offline` it is a guaranteed-failing call on the hot path of every query, forever, behind a single pino `warn`. Replace it with a state machine.

Also, the load must not be awaited on the query path. A cold ONNX load is seconds-to-minutes; a query that waits for it has already blown any latency budget, and `retriever.ts:112` degrades to RRF order on a throw — which is the better outcome.

- [ ] **Step 1: Write the offline and load-state tests**

Append to `packages/rag/src/retrieval/local-reranker.test.ts`:

```ts
describe("LocalCrossEncoderReranker offline enforcement", () => {
  it("sets allowRemoteModels = false when offline", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1]);
    mocks.env.allowRemoteModels = true;
    const r = new LocalCrossEncoderReranker({
      model: "m",
      timeoutMs: 5000,
      offline: true,
    });
    await r.ready();
    expect(mocks.env.allowRemoteModels).toBe(false);
  });

  it("leaves allowRemoteModels alone when NOT offline, so local dev can download", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1]);
    mocks.env.allowRemoteModels = true;
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.ready();
    expect(mocks.env.allowRemoteModels).toBe(true);
  });

  it("throws at CONSTRUCTION when offline with no HF_CACHE_DIR", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    delete process.env["HF_CACHE_DIR"];
    expect(
      () =>
        new LocalCrossEncoderReranker({
          model: "m",
          timeoutMs: 5000,
          offline: true,
        }),
    ).toThrow(/LocalCrossEncoderReranker.*HF_CACHE_DIR/s);
    // and nothing was loaded
    expect(mocks.fromPretrainedModel).not.toHaveBeenCalled();
  });

  it("passes HF_CACHE_DIR through as env.cacheDir", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1]);
    process.env["HF_CACHE_DIR"] = "/opt/hf-cache";
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.ready();
    expect(mocks.env.cacheDir).toBe("/opt/hf-cache");
  });
});

describe("LocalCrossEncoderReranker load state", () => {
  it("does not load the model until the first rerank() — three CoreDeps, one resident copy", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    expect(r.health().state).toBe("unloaded");
    expect(mocks.fromPretrainedModel).not.toHaveBeenCalled();
  });

  it("throws immediately while loading rather than making the query wait", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    let release: (v: unknown) => void = () => {};
    mocks.fromPretrainedModel.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });

    await expect(r.rerank("q", [candidate("a", "t")], 1)).rejects.toThrow(
      /still loading/i,
    );
    expect(r.health().state).toBe("loading");
    release(mocks.model);
  });

  it("does NOT retry the load on every query after a failure", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    mocks.fromPretrainedModel.mockRejectedValue(new Error("no weights"));
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });

    await r.ready().catch(() => {});
    for (let i = 0; i < 5; i++) {
      await r.rerank("q", [candidate("a", "t")], 1).catch(() => {});
    }
    // One attempt, not six: a failing 430MB download must not be on the hot
    // path of every query (the local.ts:140-142 defect).
    expect(mocks.fromPretrainedModel).toHaveBeenCalledTimes(1);
    expect(r.health().state).toBe("failed");
  });

  it("retries after the backoff window so a transient failure is recoverable", async () => {
    vi.useFakeTimers();
    try {
      const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
      mocks.fromPretrainedModel.mockRejectedValueOnce(new Error("blip"));
      const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
      await r.ready().catch(() => {});
      expect(mocks.fromPretrainedModel).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_001);
      mocks.fromPretrainedModel.mockResolvedValue(mocks.model);
      await r.ready();
      expect(mocks.fromPretrainedModel).toHaveBeenCalledTimes(2);
      expect(r.health().state).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failure reason code without leaking the error text", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    mocks.fromPretrainedModel.mockRejectedValue(
      new Error("ENOENT: /opt/hf-cache/models--Xenova--bge-reranker-base"),
    );
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.ready().catch(() => {});

    const h = r.health();
    expect(h.state).toBe("failed");
    expect(h.reason).toBe("load_failed");
    // /health is unauthenticated (server.ts:101,113). A filesystem path or a
    // model id is deployment detail that must not be served to anonymous
    // callers.
    expect(JSON.stringify(h)).not.toMatch(/opt|hf-cache|ENOENT/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail for the right reason**

```bash
pnpm --filter @rag/rag test -- local-reranker
```

Expected: `r.ready` and `r.health` are not functions; the construction-throw test fails because Task 2's constructor already calls `assertOfflineCacheDir` — that one should PASS already, and it is fine for it to. Everything else red.

- [ ] **Step 3: Replace `load()` with the state machine**

In `local-reranker.ts`, add above the class:

```ts
/**
 * Minimum gap between load attempts after a failure.
 *
 * `embeddings/local.ts:140-142` nulls its load promise on failure, so every
 * subsequent query re-attempts a ~430 MB download. For a reranker that is the
 * hot path of every search; under COMPLIANCE_MODE=client-data it is a call
 * that cannot succeed being retried forever. Back off instead, and make the
 * state visible (see `health()`) so a permanently-degraded deployment is
 * discoverable rather than a single pino warn per query.
 */
const LOAD_RETRY_BACKOFF_MS = 60_000;

/** Coarse, non-sensitive failure classification for the health surface. */
export type RerankerHealthReason = "load_failed" | "timeout" | "bad_head";

export interface RerankerHealthState {
  provider: string;
  state: "unloaded" | "loading" | "ready" | "failed";
  /** Omitted unless state is "failed". Never carries paths or error text. */
  reason?: RerankerHealthReason;
}
```

Then, in the class, replace the `loaded` field and `load()` with:

```ts
  private state: RerankerHealthState["state"] = "unloaded";
  private reason: RerankerHealthReason | undefined;
  private loaded: { tokenizer: unknown; model: unknown } | null = null;
  private inFlight: Promise<{ tokenizer: unknown; model: unknown }> | null = null;
  private lastAttemptAt = 0;

  /**
   * Current load state. Deliberately coarse: `/health` is unauthenticated, so
   * this must not carry cache paths, model ids or raw error text.
   */
  health(): RerankerHealthState {
    return {
      provider: this.name,
      state: this.state,
      ...(this.state === "failed" && this.reason ? { reason: this.reason } : {}),
    };
  }

  /**
   * Load the weights, awaiting completion. Called by `scripts/warm-model.ts`
   * and the integration test. NOT called on the query path — see `rerank()`.
   */
  async ready(): Promise<void> {
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<{ tokenizer: unknown; model: unknown }> {
    if (this.loaded) return this.loaded;
    if (this.inFlight) return this.inFlight;
    if (
      this.state === "failed" &&
      Date.now() - this.lastAttemptAt < LOAD_RETRY_BACKOFF_MS
    ) {
      throw new ValidationError(
        `Local reranker is not available (last load attempt failed; retrying ` +
          `no sooner than ${LOAD_RETRY_BACKOFF_MS / 1000}s after it). ` +
          `Retrieval is serving un-reranked RRF order.`,
      );
    }

    this.state = "loading";
    this.lastAttemptAt = Date.now();
    this.inFlight = this.doLoad();
    try {
      this.loaded = await this.inFlight;
      this.state = "ready";
      this.reason = undefined;
      return this.loaded;
    } catch (err) {
      this.state = "failed";
      this.reason = "load_failed";
      throw err;
    } finally {
      this.inFlight = null;
    }
  }
```

`doLoad()` is Task 2's `load()` body verbatim (dynamic import, `cacheDir`, `ALLOW_REMOTE_MODELS_KEY`, the two `from_pretrained` calls), minus the `this.loaded` cache which `ensureLoaded` now owns.

And in `rerank()`, replace `const { tokenizer, model } = await this.load();` with:

```ts
// Do NOT await a cold load on the query path: an ONNX cross-encoder load
// is seconds to minutes, and `retriever.ts:112` degrades to RRF order on a
// throw, which is strictly better than a query that hangs. Kick the load
// off and fail this query fast; subsequent queries find it ready.
if (!this.loaded) {
  void this.ensureLoaded().catch(() => {
    /* state + reason recorded in ensureLoaded; retriever logs the throw */
  });
  throw new ValidationError(
    `Local reranker is still loading (${this.model}); serving ` +
      `un-reranked RRF order for this query. Pre-warm with ` +
      `scripts/warm-model.ts to avoid this on first query after boot.`,
  );
}
const { tokenizer, model } = this.loaded;
```

- [ ] **Step 4: Run to green**

```bash
pnpm --filter @rag/rag test -- local-reranker
pnpm -r typecheck
```

Expected: all of Task 2's and Task 3's tests green (Task 2's scoring tests now call `rerank()` after the model is resident — they must `await r.ready()` first; update those tests to do so and note it in the commit, since the change is a deliberate contract change, not a test fudge).

- [ ] **Step 5: Prove the no-retry-storm claim by mutation**

Delete the `state === "failed" && Date.now() - ... < LOAD_RETRY_BACKOFF_MS` guard, re-run `pnpm --filter @rag/rag test -- local-reranker`. Expected: the "does NOT retry the load on every query" test fails with 6 calls instead of 1. Restore. Record the observed count in the commit body. The Phase 0+1 ledger records a wiring line with _zero_ coverage that could be deleted with all 279 tests still green — do not add another.

- [ ] **Step 6: Commit**

```bash
git add packages/rag/src/retrieval/local-reranker.ts packages/rag/src/retrieval/local-reranker.test.ts
git commit -m "feat(rag): offline enforcement and bounded load state for the local reranker

Mirrors the embedder exactly: allowRemoteModels=false under
COMPLIANCE_MODE=client-data, HF_CACHE_DIR required at construction. Without
this, a client-data deployment's first rerank attempts a huggingface.co
download — the defect Phase 0b closed for embeddings.

Load is lazy, single-flight, and never awaited on the query path: a cold ONNX
load is seconds to minutes and the Retriever already degrades to RRF order on
a throw. A failed load backs off for 60s instead of re-attempting on every
query (the embeddings/local.ts:140-142 pattern, which for a reranker puts a
430MB download on every search).

health() reports unloaded/loading/ready/failed with a coarse reason code and
no paths or error text, because /health is unauthenticated."
```

---

## Task 4: Make pair truncation measurable instead of silent

A cross-encoder shares one 512-token window across query _and_ document. Even with `CHUNK_SIZE` capped at 512 (Task 7), query tokens plus `[CLS]`/`[SEP]`/`[SEP]` push a full-size chunk over, so the tail of the document is dropped from the score. There is no fix inside this provider; the requirement is that the rate stops being invisible.

The embedder's precedent (`local.ts` `warnOnOverlongText`) warns per batch. Do not copy it per-pair: 60 pairs per query at ~24-60 queries/minute is a log flood. Count, and warn on a decade change.

- [ ] **Step 1: Write the truncation-signal tests**

Append to `local-reranker.test.ts`:

```ts
describe("LocalCrossEncoderReranker pair truncation signal", () => {
  it("counts truncated pairs from the tokenizer's own output length", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1, 1]);
    // model_max_length 512; two pairs, one at the ceiling (= truncated).
    mocks.tokenizer.mockReturnValue({
      input_ids: [new Array(512).fill(1), new Array(300).fill(1)],
      attention_mask: [new Array(512).fill(1), new Array(300).fill(1)],
    });
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.ready();
    await r.rerank("q", [candidate("a", "ta"), candidate("b", "tb")], 2);

    const s = r.truncationStats();
    expect(s.pairs).toBe(2);
    expect(s.truncatedPairs).toBe(1);
    expect(s.maxPairTokens).toBe(512);
  });

  it("reports zero truncation when every pair fits", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1]);
    mocks.tokenizer.mockReturnValue({
      input_ids: [new Array(64).fill(1)],
      attention_mask: [new Array(64).fill(1)],
    });
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.ready();
    await r.rerank("q", [candidate("a", "ta")], 1);
    expect(r.truncationStats().truncatedPairs).toBe(0);
  });

  it("falls back to 512 when the tokenizer exposes no model_max_length", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1]);
    mocks.fromPretrainedTokenizer.mockResolvedValue(mocks.tokenizer); // no model_max_length
    mocks.tokenizer.mockReturnValue({
      input_ids: [new Array(512).fill(1)],
      attention_mask: [new Array(512).fill(1)],
    });
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.ready();
    await r.rerank("q", [candidate("a", "ta")], 1);
    expect(r.truncationStats().maxPairTokens).toBe(512);
    expect(r.truncationStats().truncatedPairs).toBe(1);
  });

  it("never lets a truncation-accounting bug fail a query", async () => {
    const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
    queueLogits([1]);
    mocks.tokenizer.mockReturnValue({
      /* no input_ids at all — malformed */
      attention_mask: [[1]],
    });
    const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5000 });
    await r.ready();
    await expect(
      r.rerank("q", [candidate("a", "ta")], 1),
    ).resolves.toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @rag/rag test -- local-reranker
```

Expected: `r.truncationStats is not a function`.

- [ ] **Step 3: Implement**

Add to the class:

```ts
  private maxPairTokens = DEFAULT_MAX_PAIR_TOKENS;
  private pairs = 0;
  private truncatedPairs = 0;

  /**
   * Cumulative pair-truncation accounting for this process.
   *
   * A cross-encoder shares ONE token window across query and document, so a
   * chunk at the chunker's cap truncates once the query and three special
   * tokens are added — the tail of the document never reaches the score.
   * `config.ts` caps CHUNK_SIZE when a local provider is configured, which
   * makes this rare rather than universal; this counter is how an operator
   * finds out it is not rare in their corpus.
   *
   * Surfaced via `/health` (apps/api) alongside load state.
   */
  truncationStats(): {
    pairs: number;
    truncatedPairs: number;
    maxPairTokens: number;
  } {
    return {
      pairs: this.pairs,
      truncatedPairs: this.truncatedPairs,
      maxPairTokens: this.maxPairTokens,
    };
  }

  /**
   * Accounting only — must never fail a query. A tokenizer whose output shape
   * we misread is a reporting bug, not a retrieval bug.
   */
  private countTruncation(inputs: unknown): void {
    try {
      const ids = (inputs as { input_ids?: unknown }).input_ids;
      if (!Array.isArray(ids)) return;
      for (const row of ids) {
        if (!Array.isArray(row)) continue;
        this.pairs += 1;
        if (row.length >= this.maxPairTokens) this.truncatedPairs += 1;
      }
    } catch {
      /* reporting only */
    }
  }
```

In `doLoad()`, after `from_pretrained` resolves the tokenizer:

```ts
const declared = (tokenizer as { model_max_length?: unknown }).model_max_length;
if (typeof declared === "number" && declared > 0) {
  this.maxPairTokens = declared;
}
```

In `rerank()`, immediately after building `inputs`: `this.countTruncation(inputs);`

Note on the fourth test: `row.length >= maxPairTokens` is the truncation proxy — `truncation: true` means the tokenizer clamps at exactly the ceiling, so a row at the ceiling either was truncated or landed exactly on it. The over-count on an exact-fit pair is acceptable for a rate signal and is cheaper than re-tokenizing without truncation to find out. Say so in the docblock; a reviewer who does not know this will file it.

- [ ] **Step 4: Run to green and commit**

```bash
pnpm --filter @rag/rag test -- local-reranker
pnpm -r typecheck
git add packages/rag/src/retrieval/local-reranker.ts packages/rag/src/retrieval/local-reranker.test.ts
git commit -m "feat(rag): count pair truncation in the local reranker

A cross-encoder shares one 512-token window across query AND document, so a
chunk at the chunker's cap truncates once the query and three special tokens
are added — the document tail never reaches the score, with no signal. There
is no fix inside the provider short of shorter chunks; this makes the rate
discoverable via truncationStats() and /health.

Counted from the tokenizer's own output length, not re-estimated. Accounting
is wrapped so a misread tokenizer shape can never fail a query. Warning per
pair was rejected: 60 pairs per query would flood the log."
```

---

## Task 5: A wall-clock budget for one `rerank()` call

60 forward passes of a BERT-base cross-encoder on the API event loop is the dominant per-query cost (review finding 9). Neither `HttpCrossEncoderReranker` nor `Retriever` has any timeout today — verified: no `timeout`, `AbortSignal` or `signal` appears in either file. So this is a new control, and it applies to all providers (the hosted ones benefit equally; a hung vendor call currently hangs the query).

- [ ] **Step 1: Write the config test**

In `packages/core/src/config.test.ts`, inside the rerank describe block (or add one):

```ts
it("defaults rerank.timeoutMs to 10000", () => {
  const cfg = loadConfig(baseEnv({ RERANK_PROVIDER: "cohere" }));
  expect(cfg.rerank.timeoutMs).toBe(10_000);
});

it("reads RERANK_TIMEOUT_MS", () => {
  const cfg = loadConfig(baseEnv({ RERANK_TIMEOUT_MS: "2500" }));
  expect(cfg.rerank.timeoutMs).toBe(2500);
});

it("treats an empty RERANK_TIMEOUT_MS as unset, not as 0", () => {
  // Compose passes every declared variable, so `${RERANK_TIMEOUT_MS:-}`
  // arrives as "" rather than absent. Number("") is 0, which would mean
  // "every rerank times out instantly". This is the EMBEDDING_MODEL /
  // GENERATION_MODEL shadowing class of bug, found in round 7 of 7.
  const cfg = loadConfig(baseEnv({ RERANK_TIMEOUT_MS: "" }));
  expect(cfg.rerank.timeoutMs).toBe(10_000);
});
```

Use whatever env-fixture helper `config.test.ts` already provides in place of `baseEnv` — match the file, do not add a second fixture style.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @rag/core test -- config
```

Expected: `cfg.rerank.timeoutMs` is `undefined`.

- [ ] **Step 3: Add it to the schema**

`packages/core/src/config-schema.ts`, in the `rerank` object after `poolMultiplier` (`:197`):

```ts
      /**
       * Wall-clock budget for ONE rerank() call, across the whole candidate
       * pool. On expiry the reranker throws and the Retriever degrades to the
       * un-reranked RRF order (`retrieval/retriever.ts`) — a slow reranker
       * must never become a slow query.
       *
       * 10s is generous for a hosted call and tight for `local`: 60 BERT-base
       * forward passes in-process. If `local` hits it routinely, lower
       * RERANK_POOL_MULTIPLIER rather than raising this.
       */
      timeoutMs: z.number().int().positive().default(10_000),
```

- [ ] **Step 4: Wire the env read**

`packages/core/src/config.ts`, in the `rerank` block (`:214-222`):

```ts
      timeoutMs: env.RERANK_TIMEOUT_MS
        ? Number(env.RERANK_TIMEOUT_MS)
        : undefined,
```

The truthiness check (not `?? `) is deliberate and is the repo's settled pattern for this class of bug: compose declares every variable, so an unset one arrives as `""`. `env.RERANK_TIMEOUT_MS ?? ...` would pass `""` through to `Number("")` → `0` → "time out instantly". `databaseSsl` and `embeddingModel` (`config.ts:117`) already use `||`/truthiness for the same reason.

- [ ] **Step 5: Apply it in the local reranker**

In `local-reranker.ts`'s `rerank()`, wrap the batch loop. Do not add an abort mechanism to the ONNX call — transformers.js offers none, and pretending otherwise would be worse than this: the budget is checked between batches, so the overrun is bounded by one batch of 8 rather than the whole pool.

```ts
const deadline = Date.now() + this.timeoutMs;
for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
  if (Date.now() > deadline) {
    this.reason = "timeout";
    throw new ValidationError(
      `Local reranker exceeded its ${this.timeoutMs}ms budget after ` +
        `${i} of ${candidates.length} candidates; serving un-reranked RRF ` +
        `order. Lower RERANK_POOL_MULTIPLIER or raise RERANK_TIMEOUT_MS.`,
    );
  }
  /* …existing batch body… */
}
```

A timeout does **not** set `state = "failed"`: the model is loaded and working, it is merely slow. Conflating the two would make a slow corpus look like a broken deployment on `/health`.

- [ ] **Step 6: Test the timeout path**

Append to `local-reranker.test.ts`:

```ts
it("throws past the budget mid-pool rather than finishing the pool", async () => {
  const { LocalCrossEncoderReranker } = await import("./local-reranker.js");
  queueLogits(
    Array.from({ length: 8 }, () => 1),
    Array.from({ length: 8 }, () => 1),
  );
  const r = new LocalCrossEncoderReranker({ model: "m", timeoutMs: 5 });
  await r.ready();
  // First batch runs, then the budget is checked and has expired.
  mocks.model.mockImplementation(async () => {
    await new Promise((res) => setTimeout(res, 20));
    return {
      logits: { data: Float32Array.from(new Array(8).fill(1)), dims: [8, 1] },
    };
  });
  await expect(
    r.rerank(
      "q",
      Array.from({ length: 16 }, (_, i) => candidate(`c${i}`, "t")),
      5,
    ),
  ).rejects.toThrow(/budget/i);
  // Still ready: slow is not broken.
  expect(r.health().state).toBe("ready");
});
```

- [ ] **Step 7: Run to green and commit**

```bash
pnpm --filter @rag/core test -- config
pnpm --filter @rag/rag test -- local-reranker
pnpm -r typecheck
git add packages/core/src/config-schema.ts packages/core/src/config.ts packages/core/src/config.test.ts packages/rag/src/retrieval/local-reranker.ts packages/rag/src/retrieval/local-reranker.test.ts
git commit -m "feat(core): RERANK_TIMEOUT_MS, a wall-clock budget for one rerank call

Neither the hosted reranker nor the Retriever had any timeout: a hung vendor
call or a slow in-process cross-encoder hung the query. 60 BERT-base forward
passes on the API event loop is the local provider's dominant per-query cost,
so a budget is a prerequisite for shipping it.

Checked between batches of 8, so the overrun is bounded by one batch rather
than the whole pool — transformers.js exposes no abort. On expiry the reranker
throws and the Retriever degrades to RRF order.

An empty RERANK_TIMEOUT_MS reads as unset, not as 0: compose passes every
declared variable, and Number('') would mean every rerank times out
instantly."
```

---

## Task 6: Widen the gate, add the enum value, wire the factory

This is the spec's gate fix. Three changes that must land together or the tree does not compile: the enum, the gate, and the `switch` case.

- [ ] **Step 1: Write the gate and factory tests**

In `packages/rag/src/retrieval/reranker.test.ts`:

```ts
describe("createReranker compliance gate", () => {
  const base = { poolMultiplier: 5, timeoutMs: 10_000 } as const;

  it("allows local under client-data — it makes no outbound call", () => {
    process.env["HF_CACHE_DIR"] = "/opt/hf-cache";
    const r = createReranker(
      { ...base, provider: "local", model: "Xenova/bge-reranker-base" },
      { complianceMode: "client-data" },
    );
    expect(r?.name).toBe("local");
  });

  it("allows none under client-data", () => {
    expect(
      createReranker(
        { ...base, provider: "none" },
        { complianceMode: "client-data" },
      ),
    ).toBeNull();
  });

  it.each(["cohere", "jina"] as const)(
    "still blocks %s under client-data — it ships document text to a vendor",
    (provider) => {
      expect(() =>
        createReranker(
          { ...base, provider, apiKey: "k" },
          { complianceMode: "client-data" },
        ),
      ).toThrow(ComplianceError);
    },
  );

  it("still blocks llm under client-data — only local if GENERATION_BASE_URL happens to be", () => {
    expect(() =>
      createReranker(
        { ...base, provider: "llm" },
        { complianceMode: "client-data" },
      ),
    ).toThrow(ComplianceError);
  });

  it("names both compliance-safe options in the refusal", () => {
    expect(() =>
      createReranker(
        { ...base, provider: "cohere", apiKey: "k" },
        { complianceMode: "client-data" },
      ),
    ).toThrow(/RERANK_PROVIDER=(none|local)/);
  });

  it("propagates offline to the local reranker under client-data", () => {
    delete process.env["HF_CACHE_DIR"];
    // offline=true + no HF_CACHE_DIR is the constructor throw from Task 3. If
    // the factory failed to pass complianceMode through, this would silently
    // construct a reranker that downloads from huggingface.co on first query —
    // the exact wiring line the Phase 0+1 ledger found with ZERO coverage on
    // the embedding factory.
    expect(() =>
      createReranker(
        { ...base, provider: "local", model: "Xenova/bge-reranker-base" },
        { complianceMode: "client-data" },
      ),
    ).toThrow(/HF_CACHE_DIR/);
  });

  it("does NOT set offline when compliance mode is none, so local dev downloads", () => {
    delete process.env["HF_CACHE_DIR"];
    expect(
      createReranker({ ...base, provider: "local", model: "m" })?.name,
    ).toBe("local");
  });
});
```

Also add, in `packages/core/src/config.test.ts`:

```ts
it("accepts RERANK_PROVIDER=local", () => {
  expect(
    loadConfig(baseEnv({ RERANK_PROVIDER: "local" })).rerank.provider,
  ).toBe("local");
});

it("rejects an unknown RERANK_PROVIDER at startup", () => {
  expect(() => loadConfig(baseEnv({ RERANK_PROVIDER: "locaal" }))).toThrow();
});

it("defaults the local rerank model to DEFAULT_LOCAL_RERANK_MODEL", () => {
  const cfg = loadConfig(baseEnv({ RERANK_PROVIDER: "local" }));
  expect(cfg.rerank.model).toBe(DEFAULT_LOCAL_RERANK_MODEL);
});

it("lets an explicit RERANK_MODEL override the local default", () => {
  const cfg = loadConfig(
    baseEnv({
      RERANK_PROVIDER: "local",
      RERANK_MODEL: "Xenova/ms-marco-MiniLM-L-6-v2",
    }),
  );
  expect(cfg.rerank.model).toBe("Xenova/ms-marco-MiniLM-L-6-v2");
});

it("treats an empty RERANK_MODEL as unset for the local default", () => {
  const cfg = loadConfig(
    baseEnv({ RERANK_PROVIDER: "local", RERANK_MODEL: "" }),
  );
  expect(cfg.rerank.model).toBe(DEFAULT_LOCAL_RERANK_MODEL);
});

it("defaults poolMultiplier to 2 for local, not 5", () => {
  // 12 x 5 = 60 in-process cross-encoder forward passes per query. Hosted
  // rerankers batch vendor-side, which is why 5 is the shared default;
  // in-process it is the dominant cost (review finding 9).
  expect(
    loadConfig(baseEnv({ RERANK_PROVIDER: "local" })).rerank.poolMultiplier,
  ).toBe(2);
  expect(
    loadConfig(baseEnv({ RERANK_PROVIDER: "cohere" })).rerank.poolMultiplier,
  ).toBe(5);
});

it("lets an explicit RERANK_POOL_MULTIPLIER override the local default", () => {
  const cfg = loadConfig(
    baseEnv({ RERANK_PROVIDER: "local", RERANK_POOL_MULTIPLIER: "4" }),
  );
  expect(cfg.rerank.poolMultiplier).toBe(4);
});
```

- [ ] **Step 2: Run both and confirm they fail for the right reason**

```bash
pnpm --filter @rag/core test -- config
pnpm --filter @rag/rag test -- reranker
```

Expected: zod rejects `"local"`; `DEFAULT_LOCAL_RERANK_MODEL` is unresolved.

- [ ] **Step 3: Extend the enum and add the model default**

`packages/core/src/config-schema.ts:189`:

```ts
      provider: z.enum(["none", "local", "cohere", "jina", "llm"]).default("none"),
```

Update the surrounding docblock (`:182-187`) to describe `local` as "an in-process ONNX cross-encoder; no network at inference time, so it is the only reranker permitted under `COMPLIANCE_MODE=client-data`".

`packages/core/src/config.ts`, beside `DEFAULT_LOCAL_EMBEDDING_MODEL` (`:38`):

```ts
/**
 * The local ONNX cross-encoder reranker. MIT-licensed, 512-token PAIRS (query
 * and document share the one window), single-output
 * AutoModelForSequenceClassification head.
 *
 * Exported for the same reason as DEFAULT_LOCAL_EMBEDDING_MODEL:
 * `scripts/warm-model.ts` must warm the SAME model `loadConfig` selects. A
 * pre-warm that populates a different cache entry is worse than none, because
 * it looks like it worked.
 *
 * Documented alternative: Xenova/ms-marco-MiniLM-L-6-v2 (apache-2.0, smaller,
 * English). Set it via RERANK_MODEL. It is NOT a runtime failover — swapping
 * reranker models changes ranking, so that is an operator decision.
 */
export const DEFAULT_LOCAL_RERANK_MODEL = "Xenova/bge-reranker-base";

/** The default rerank model for a provider when RERANK_MODEL is unset. */
export function defaultRerankModel(
  provider: "none" | "local" | "cohere" | "jina" | "llm",
): string | undefined {
  switch (provider) {
    case "local":
      return DEFAULT_LOCAL_RERANK_MODEL;
    // The hosted providers' defaults live in reranker.ts beside their
    // endpoints, where the vendor pairing is visible. `none`/`llm` have none.
    case "none":
    case "cohere":
    case "jina":
    case "llm":
      return undefined;
  }
}
```

The exhaustive `switch` with no `default` is the repo's established guard: a sixth provider added later fails `tsc` here. Note that `config.ts:41` `defaultEmbeddingModel` has the same shape but _no_ exhaustiveness backstop beyond the union, and the ledger logged that as a deferred minor — this function does not repeat it, because every arm is listed.

Then in `loadConfig`'s `rerank` block:

```ts
    rerank: {
      provider: rerankProvider,
      model: env.RERANK_MODEL || defaultRerankModel(rerankProvider),
      apiKey: env.RERANK_API_KEY || undefined,
      poolMultiplier: env.RERANK_POOL_MULTIPLIER
        ? Number(env.RERANK_POOL_MULTIPLIER)
        : rerankProvider === "local"
          ? LOCAL_RERANK_POOL_MULTIPLIER
          : undefined,
      timeoutMs: env.RERANK_TIMEOUT_MS ? Number(env.RERANK_TIMEOUT_MS) : undefined,
    },
```

with, above `loadConfig`:

```ts
/**
 * Candidate-pool multiplier when the reranker runs in-process.
 *
 * `retrieval/retriever.ts` computes fetchK = topK x poolMultiplier, so the
 * shared default of 5 against a defaultTopK of 12 is 60 cross-encoder forward
 * passes per query. For a hosted reranker that is one HTTP call with
 * vendor-side batching, which is why 5 is the default. In-process it is the
 * dominant per-query cost, so `local` gets a lower default. An explicit
 * RERANK_POOL_MULTIPLIER still wins.
 */
const LOCAL_RERANK_POOL_MULTIPLIER = 2;
```

and, earlier in `loadConfig`, a single named read so the provider is available to both the model and multiplier expressions:

```ts
const rerankProvider = (env.RERANK_PROVIDER || "none") as
  "none" | "local" | "cohere" | "jina" | "llm";
```

Note `||` not `??` — same empty-string reason as everywhere else in this file. The cast is cosmetic: `Config.parse` rejects an invalid value at startup via the zod enum, as the ledger established for `COMPLIANCE_MODE`.

- [ ] **Step 4: Widen the gate**

In `packages/rag/src/retrieval/reranker.ts`, above `createReranker`:

```ts
/**
 * Does this reranker provider send document text off the box?
 *
 * The gate previously asked `provider !== "none"`, which is the wrong
 * question: it blocked an in-process reranker that egresses nothing. A
 * `Record` over the provider union — not an array or an `includes` — is used
 * deliberately, so adding a provider to the enum without classifying it is a
 * compile error, matching the exhaustive `switch` below.
 *
 * `llm` is `true` and must stay `true`: it reuses the generation client, so it
 * is local only if GENERATION_BASE_URL happens to be, which this function
 * cannot know. (It is also still unimplemented.)
 */
const RERANK_PROVIDER_EGRESSES: Record<Config["rerank"]["provider"], boolean> =
  {
    none: false,
    local: false,
    cohere: true,
    jina: true,
    llm: true,
  };
```

Replace the gate body (`:144-152`):

```ts
// A HOSTED reranker ships retrieved chunk text to a third party, exactly as
// a hosted embedder would. Same gate as createEmbeddingProvider — but keyed
// on whether the provider egresses, not on whether one is configured.
if (
  opts?.complianceMode === "client-data" &&
  RERANK_PROVIDER_EGRESSES[cfg.provider]
) {
  throw new ComplianceError(
    `COMPLIANCE_MODE=client-data does not allow a hosted reranker ` +
      `(RERANK_PROVIDER="${cfg.provider}"): it would send document text to ` +
      `an external API (IRC §7216). Set RERANK_PROVIDER=none, or ` +
      `RERANK_PROVIDER=local for the in-process ONNX cross-encoder.`,
  );
}
```

- [ ] **Step 5: Add the `switch` case**

```ts
    case "local":
      return new LocalCrossEncoderReranker({
        model: cfg.model ?? DEFAULT_LOCAL_RERANK_MODEL,
        timeoutMs: cfg.timeoutMs,
        offline: opts?.complianceMode === "client-data",
      });
```

The `?? DEFAULT_LOCAL_RERANK_MODEL` is belt-and-braces: `loadConfig` already fills it, but `createReranker` takes a bare `Config["rerank"]` and is called directly in tests. Import `DEFAULT_LOCAL_RERANK_MODEL` from `@rag/core` — do not re-declare the string here (ledger finding M-1).

Update the "Adding a provider" docblock at `:134-135` — it currently says "extend the `rerank.provider` enum in packages/core/src/config.ts", which is now `config-schema.ts`, and it must also say "classify it in `RERANK_PROVIDER_EGRESSES`".

- [ ] **Step 6: Prove the exhaustiveness guards bite**

Temporarily add `"onnx"` to the zod enum and run `pnpm -r typecheck`. Expected: **two** errors — a missing key in `RERANK_PROVIDER_EGRESSES` and a non-exhaustive `switch`. Revert. Record both in the commit body. A guard nobody has watched fire is a guard nobody knows works.

- [ ] **Step 7: Run to green and commit**

```bash
pnpm --filter @rag/core test -- config
pnpm --filter @rag/rag test -- reranker
pnpm -r typecheck && pnpm lint
git add packages/core/src/config-schema.ts packages/core/src/config.ts packages/core/src/config.test.ts packages/rag/src/retrieval/reranker.ts packages/rag/src/retrieval/reranker.test.ts
git commit -m "feat(rag): allow RERANK_PROVIDER=local under COMPLIANCE_MODE=client-data

The gate asked 'provider !== none' — the wrong question. It blocked a reranker
that makes no outbound call at all, so a client-data deployment could not
rerank even in-process. Now keyed on whether the provider egresses:
none and local pass; cohere, jina and llm stay blocked (llm reuses the
generation client, so it is local only if GENERATION_BASE_URL happens to be).

RERANK_PROVIDER_EGRESSES is a Record over the provider union, not an array, so
a provider added to the enum without an egress classification is a compile
error — alongside the already-exhaustive switch.

local defaults to Xenova/bge-reranker-base (exported from @rag/core so
warm-model.ts cannot drift) and to poolMultiplier 2 rather than 5: 12 x 5 is
60 in-process forward passes per query."
```

---

## Task 7: Key the 512-token chunk cap on the reranker provider too

Review finding 8. `LOCAL_PROVIDER_MAX_CHUNK_SIZE` (512) is applied inside `if (provider === "local")` at `config.ts:121`, where `provider` is `EMBEDDING_PROVIDER` (`:113`). Task 6 makes `RERANK_PROVIDER=local` + `EMBEDDING_PROVIDER=gemini` + `COMPLIANCE_MODE=none` an attractive configuration — free local reranking, no vendor — and in exactly that configuration `CHUNK_SIZE` stays at 800 and every pair truncates.

This is a bug fix in the sense `.claude/rules/tdd.md` means: the regression test comes first.

- [ ] **Step 1: Write the regression test**

In `packages/core/src/config.test.ts`:

```ts
it("caps chunkSize at 512 when the RERANKER is local even if the embedder is not", () => {
  // The configuration the gate widening makes attractive. Before this fix
  // CHUNK_SIZE stayed at 800 and every (query, document) pair truncated at
  // rerank time with no warning.
  const cfg = loadConfig(
    baseEnv({
      EMBEDDING_PROVIDER: "gemini",
      RERANK_PROVIDER: "local",
      COMPLIANCE_MODE: "none",
    }),
  );
  expect(cfg.ingestion.chunkSize).toBe(512);
});

it("warns and names the reranker when an explicit CHUNK_SIZE exceeds the cap", () => {
  const warn = vi.fn();
  loadConfig(
    baseEnv({
      EMBEDDING_PROVIDER: "gemini",
      RERANK_PROVIDER: "local",
      CHUNK_SIZE: "800",
    }),
    { warn },
  );
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rerank/i));
});

it("leaves chunkSize alone when neither provider is local", () => {
  const cfg = loadConfig(
    baseEnv({ EMBEDDING_PROVIDER: "gemini", RERANK_PROVIDER: "cohere" }),
  );
  expect(cfg.ingestion.chunkSize).toBe(800);
});

it("still caps when the embedder is local and the reranker is not", () => {
  const cfg = loadConfig(
    baseEnv({ EMBEDDING_PROVIDER: "local", RERANK_PROVIDER: "none" }),
  );
  expect(cfg.ingestion.chunkSize).toBe(512);
});
```

Match `config.test.ts`'s existing mechanism for capturing the warning — `loadConfig`'s warn seam already has one, since the embedding-cap warning is tested. Use it; do not add a second.

- [ ] **Step 2: Run and confirm the first two fail**

```bash
pnpm --filter @rag/core test -- config
```

Expected: test 1 gets 800, test 2 gets no warn call. Tests 3 and 4 pass already (they guard against over-reach).

- [ ] **Step 3: Implement**

In `config.ts`, change `if (provider === "local")` (`:121`) to key on either local provider, and make the message name which one:

```ts
  // The 512-token cap applies to BOTH in-process ONNX paths: the local
  // embedder's context window, and the local cross-encoder's PAIR window
  // (which is shared across query and document, so this cap makes overflow
  // rare rather than universal — it does not eliminate it; see
  // retrieval/local-reranker.ts's truncationStats).
  const localModelReasons = [
    provider === "local" ? `EMBEDDING_PROVIDER=local (${embeddingModel})` : null,
    rerankProvider === "local" ? `RERANK_PROVIDER=local (${rerankModel})` : null,
  ].filter((r): r is string => r !== null);

  if (localModelReasons.length > 0) {
```

and inside, replace the warning's hardcoded `(${embeddingModel})` with `${localModelReasons.join(" and ")}`. The existing message blames `embeddingModel` unconditionally — the ledger's Review Focus item 1 for Phase 1 was that same "names the wrong model" defect, so do not re-introduce it on the reranker side.

`rerankModel` and `rerankProvider` must be resolved **before** this block. `rerankProvider` is already hoisted by Task 6 Step 3; hoist the model resolution next to it:

```ts
const rerankModel = env.RERANK_MODEL || defaultRerankModel(rerankProvider);
```

and use that single `rerankModel` in the `rerank` config block rather than recomputing it.

- [ ] **Step 4: Run to green and commit**

```bash
pnpm --filter @rag/core test -- config
pnpm -r typecheck
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "fix(core): key the 512-token chunk cap on the reranker provider too

LOCAL_PROVIDER_MAX_CHUNK_SIZE was applied only when EMBEDDING_PROVIDER=local.
RERANK_PROVIDER=local with gemini embeddings and COMPLIANCE_MODE=none — the
configuration the widened gate makes attractive — kept CHUNK_SIZE at 800 and
silently truncated every (query, document) pair at rerank time, with no
warning, because the embedder's overlong-text backstop is on the embedder.

The cap now triggers on either local provider, and the warning names which one
caused it instead of always blaming the embedding model."
```

---

## Task 8: Make a permanently-degraded reranker discoverable

Spec constraint 3. The only failure signal today is `logger.warn({ err }, "reranker failed — falling back to RRF order")` at `packages/runtime/src/index.ts:224` — per query, no metric, no state. A reranker that can never load degrades every query to RRF forever while the deployment believes reranking is on.

Two surfaces, because there are two kinds of deployment: `/health` for `apps/api` (and `apps/web`/`teams-bot` behind it), and a one-shot state-transition log for `apps/mcp` and `apps/worker`, which have no HTTP health endpoint.

- [ ] **Step 1: Add the optional health member to the interface**

`packages/core/src/interfaces.ts`, in the `Reranker` block (`:101-115`):

```ts
  /**
   * Optional operational state, for the `/health` surface.
   *
   * Optional because a stateless HTTP reranker has nothing to report — it
   * either makes a call or throws. An in-process model has a load lifecycle
   * that can get stuck, which is otherwise invisible: retrieval keeps
   * answering, from the un-reranked RRF order, indefinitely.
   *
   * MUST NOT carry cache paths, model ids, or raw error text: `/health` is
   * served without authentication (`apps/api/src/server.ts:101,113`).
   */
  readonly health?: () => {
    provider: string;
    state: "unloaded" | "loading" | "ready" | "failed";
    reason?: string;
    pairs?: number;
    truncatedPairs?: number;
  };
```

Optional, so `HttpCrossEncoderReranker` needs no change and no existing caller breaks.

- [ ] **Step 2: Write the health-route test**

In `apps/api/src/routes/` there is no health test today (`/health` is registered in `server.ts:113`). Add `apps/api/src/health.test.ts` — or extend whichever existing server-level spec covers `server.ts`; check before creating a second one:

```ts
it("reports reranker state when the reranker exposes health()", async () => {
  const app = await buildTestApp({
    reranker: {
      name: "local",
      rerank: async () => [],
      health: () => ({
        provider: "local",
        state: "failed" as const,
        reason: "load_failed",
      }),
    },
  });
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    status: "ok",
    reranker: { provider: "local", state: "failed", reason: "load_failed" },
  });
});

it("omits the reranker key entirely when no reranker is configured", async () => {
  const app = await buildTestApp({ reranker: null });
  expect(res.json()).not.toHaveProperty("reranker");
});

it("stays 200 when the reranker is failed — a degraded reranker is not an outage", async () => {
  // Retrieval still answers, from RRF order. Returning 503 here would make a
  // load-balancer pull a healthy node out of rotation.
  const app = await buildTestApp({
    reranker: {
      name: "local",
      rerank: async () => [],
      health: () => ({ provider: "local", state: "failed" as const }),
    },
  });
  expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(
    200,
  );
});

it("never serves a cache path or model id from the unauthenticated endpoint", async () => {
  const app = await buildTestApp({
    reranker: {
      name: "local",
      rerank: async () => [],
      health: () => ({
        provider: "local",
        state: "failed" as const,
        reason: "load_failed",
      }),
    },
  });
  const body = (await app.inject({ method: "GET", url: "/health" })).body;
  expect(body).not.toMatch(/Xenova|hf-cache|node_modules/);
});
```

Adapt `buildTestApp` to the existing app-construction helper in `apps/api/src/` — do not invent a second one.

- [ ] **Step 3: Implement the route change**

`apps/api/src/server.ts:113`:

```ts
// Unauthenticated (see the auth skip at :109) — report state, never detail.
// A failed reranker is NOT a 503: retrieval still answers from the
// un-reranked RRF order, and failing the probe would pull a serving node.
app.get("/health", async () => {
  const rerankerHealth = deps.reranker?.health?.();
  return {
    status: "ok",
    ...(rerankerHealth ? { reranker: rerankerHealth } : {}),
  };
});
```

Thread `reranker` onto whatever dependency object `server.ts` already receives (`buildCoreDeps` returns the `Retriever`, which holds the reranker privately; add `reranker` to `CoreDeps` in `packages/runtime/src/index.ts` beside `retriever` rather than reaching into the `Retriever`).

In `local-reranker.ts`, fold the truncation counters into `health()` so one call answers both questions:

```ts
  health(): RerankerHealthState & { pairs: number; truncatedPairs: number } {
    const t = this.truncationStats();
    return {
      provider: this.name,
      state: this.state,
      ...(this.state === "failed" && this.reason ? { reason: this.reason } : {}),
      pairs: t.pairs,
      truncatedPairs: t.truncatedPairs,
    };
  }
```

- [ ] **Step 4: One-shot state-transition log for the non-HTTP apps**

`packages/runtime/src/index.ts`, replacing the per-query `onError` (`:223-224`):

```ts
      // Per-query warn only: the one-shot transition log below is what makes a
      // PERMANENTLY degraded reranker discoverable in apps/mcp and
      // apps/worker, which have no /health endpoint. Without it, a reranker
      // that can never load produces one indistinguishable warn per query
      // forever and nothing that says "this is the steady state".
      onError: (err) => {
        logger.warn({ err }, "reranker failed — falling back to RRF order");
        const state = reranker?.health?.()?.state;
        if (state && state !== lastRerankState) {
          lastRerankState = state;
          logger.error(
            { provider: reranker?.name, state },
            "reranker state changed — retrieval quality is affected until this reads 'ready'",
          );
        }
      },
```

with `let lastRerankState: string | undefined;` declared beside the `reranker` const.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @rag/api test
pnpm --filter @rag/rag test -- local-reranker
pnpm -r typecheck
git add packages/core/src/interfaces.ts packages/rag/src/retrieval/local-reranker.ts packages/runtime/src/index.ts apps/api/src/server.ts apps/api/src/health.test.ts
git commit -m "feat(api): surface reranker load state on /health

A reranker that can never load degrades every query to RRF order forever while
the deployment believes reranking is on, behind one pino warn per query and no
state anywhere. Adds an optional health() to the Reranker interface (optional
so the HTTP reranker, which has no lifecycle, is unchanged), reports it from
/health, and logs once per state TRANSITION in the runtime so apps/mcp and
apps/worker — which have no health endpoint — get a steady-state signal rather
than an indistinguishable warn stream.

/health stays 200 when the reranker is failed: retrieval still answers, and a
503 would pull a serving node. It carries state, a coarse reason code and the
pair-truncation counts, never a cache path, model id or error text — the
endpoint is served without authentication."
```

---

## Task 9: Enumerate every offline model artifact and warm all of them

`scripts/warm-model.ts` warms the embedder only (`:34-40`). An offline deployment warmed per the current docs takes a cold HuggingFace fetch for the reranker on first query — which under `allowRemoteModels = false` is a hard failure, not a slow one.

**This task is an enumeration, not an edit.** The Phase 0+1 ledger's most important line: across seven fix rounds, every dispatch that named specific locations produced a fix of exactly those locations and left a sibling for the next reviewer; the two that mandated "enumerate from the code, then fix, then prove the enumeration" converged in one round and found defects nobody had named. Do not "add the reranker to warm-model.ts" and stop.

- [ ] **Step 1: Enumerate from the code**

Derive, from the source and not from this plan, the complete list of model artifacts that must exist on disk before a `COMPLIANCE_MODE=client-data` process can serve its first request. Method:

```bash
# Every call that loads weights through @huggingface/transformers.
grep -rn "from_pretrained\|pipeline(" packages/ apps/ scripts/ --include=*.ts | grep -v test
# Every place a model id is defaulted.
grep -rn "DEFAULT_LOCAL" packages/ scripts/ --include=*.ts
# Everything that reads the cache dir.
grep -rn "HF_CACHE_DIR" packages/ apps/ scripts/ docker/ docs/ env.example .github/
```

Write the result as a table in the commit body: artifact, the code path that loads it, the config that selects it, and whether `warm-model.ts` currently covers it. The enumeration is the deliverable; the edit follows from it.

- [ ] **Step 2: Write the agreement test**

The pre-warm must select the **same** model ids `loadConfig` selects, or it populates cache entries the service never reads — and looks like it worked. In `packages/core/src/config.test.ts`:

```ts
it("warm-model.ts and loadConfig agree on the local model defaults", () => {
  // Both call these resolvers, so there is nothing left to drift. This test
  // exists to make a future refactor that re-hardcodes either literal fail.
  expect(defaultEmbeddingModel("local")).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL);
  expect(defaultRerankModel("local")).toBe(DEFAULT_LOCAL_RERANK_MODEL);
  const cfg = loadConfig(
    baseEnv({ EMBEDDING_PROVIDER: "local", RERANK_PROVIDER: "local" }),
  );
  expect(cfg.embedding.model).toBe(defaultEmbeddingModel("local"));
  expect(cfg.rerank.model).toBe(defaultRerankModel("local"));
});
```

- [ ] **Step 3: Rewrite `scripts/warm-model.ts` to warm everything it enumerated**

```ts
/**
 * Pre-warm every in-process ONNX model this deployment will load.
 *
 * Run from a machine or one-off job WITH network access, writing to the same
 * durable path (persistent volume or network share) the deployment mounts as
 * HF_CACHE_DIR — not during the Docker image build, which does not work
 * against this repo's Dockerfiles (scripts/ is not copied into the image, and
 * a build-stage cache never reaches the runtime stage; see
 * docs/DEPLOYMENT.md).
 *
 * Under COMPLIANCE_MODE=client-data a cold cache is a HARD failure, not a slow
 * first query: allowRemoteModels is false. Warming the embedder but not the
 * reranker is therefore a deployment that boots and then fails on the first
 * search.
 *
 * Usage:
 *   npx tsx scripts/warm-model.ts
 *
 * Environment variables (read exactly as loadConfig reads them, via the shared
 * resolvers, so a pre-warm cannot populate a cache entry the service ignores):
 *   EMBEDDING_PROVIDER — warms the embedder when `local` (default: local)
 *   EMBEDDING_MODEL    — override (default: DEFAULT_LOCAL_EMBEDDING_MODEL)
 *   RERANK_PROVIDER    — warms the reranker when `local`
 *   RERANK_MODEL       — override (default: DEFAULT_LOCAL_RERANK_MODEL)
 *   HF_CACHE_DIR       — cache directory. If unset, @huggingface/transformers
 *                        defaults to a path INSIDE node_modules, which does
 *                        NOT survive a reinstall or a fresh container build —
 *                        always set this explicitly in a real deployment.
 */
import { createEmbeddingProvider, LocalCrossEncoderReranker } from "@rag/rag";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  DEFAULT_LOCAL_RERANK_MODEL,
  defaultEmbeddingModel,
  defaultRerankModel,
} from "@rag/core";

const cacheDir = process.env["HF_CACHE_DIR"];
if (cacheDir) process.stdout.write(`Using HF_CACHE_DIR: ${cacheDir}\n`);

// `||` not `??`: compose passes every declared variable, so an unset one
// arrives as "". Matches config.ts:117.
const embeddingProvider = process.env["EMBEDDING_PROVIDER"] || "local";
const rerankProvider = process.env["RERANK_PROVIDER"] || "none";

let warmed = 0;

if (embeddingProvider === "local") {
  const model =
    process.env["EMBEDDING_MODEL"] || defaultEmbeddingModel("local");
  process.stdout.write(`Warming local embedding model: ${model} …\n`);
  await createEmbeddingProvider({
    provider: "local",
    model,
    dimensions: 768,
  }).embed("warmup");
  warmed += 1;
}

if (rerankProvider === "local") {
  const model = process.env["RERANK_MODEL"] || defaultRerankModel("local");
  process.stdout.write(`Warming local reranker model: ${model} …\n`);
  // ready() loads tokenizer + weights without scoring. Deliberately NOT
  // offline:true — this script's whole job is to download, so an offline
  // constructor guard here would refuse to do the one thing it exists for.
  await new LocalCrossEncoderReranker({
    model: model!,
    timeoutMs: 600_000,
  }).ready();
  warmed += 1;
}

if (warmed === 0) {
  process.stdout.write(
    `Nothing to warm: EMBEDDING_PROVIDER=${embeddingProvider}, ` +
      `RERANK_PROVIDER=${rerankProvider}. Neither is "local" — no in-process ` +
      `ONNX weights are needed. If this is a COMPLIANCE_MODE=client-data ` +
      `deployment, that is wrong: client-data requires EMBEDDING_PROVIDER=local.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${warmed} model(s) ready. Cache: ${
    cacheDir ??
    "<node_modules>/@huggingface/transformers/.cache/ (default — does not survive a reinstall; set HF_CACHE_DIR explicitly)"
  }\n`,
);
```

The exit-1 on "nothing warmed" is the point: the old script always exited 0 having warmed exactly one model, so an operator who had set `RERANK_PROVIDER=local` got a successful-looking warm that covered half of what they needed.

Dropping the bare `DEFAULT_LOCAL_*` imports if the resolvers make them unused is fine — but check: `defaultRerankModel` returns `string | undefined`, so the non-null assertion above is load-bearing. If `tsc` objects, narrow with an explicit `?? DEFAULT_LOCAL_RERANK_MODEL` rather than an assertion.

- [ ] **Step 4: Run it for real, both paths**

```bash
HF_CACHE_DIR=/tmp/hf-warm-test EMBEDDING_PROVIDER=local RERANK_PROVIDER=local npx tsx scripts/warm-model.ts
du -sh /tmp/hf-warm-test
```

Expected: both models downloaded, two "ready" lines, a cache directory containing both model trees. Record the measured size in the commit body — `docs/DEPLOYMENT.md` currently quotes ~430 MB for the embedder alone and Task 10 must update that figure with a measured one, not an estimate.

Then prove the offline half end to end:

```bash
HF_CACHE_DIR=/tmp/hf-warm-test COMPLIANCE_MODE=client-data \
  EMBEDDING_PROVIDER=local RERANK_PROVIDER=local \
  pnpm --filter @rag/rag test -- local-reranker
rm -rf /tmp/hf-warm-test
```

- [ ] **Step 5: Commit**

```bash
git add scripts/warm-model.ts packages/core/src/config.test.ts
git commit -m "fix(scripts): warm every in-process ONNX model, not just the embedder

warm-model.ts warmed the embedder and exited 0. An operator with
RERANK_PROVIDER=local got a successful-looking pre-warm covering half the
weights, then — under COMPLIANCE_MODE=client-data, where allowRemoteModels is
false — a hard failure on the first search rather than a slow one.

Enumerated every from_pretrained/pipeline call site rather than adding the one
model this plan introduces (see the table below). Model ids now come from the
same defaultEmbeddingModel/defaultRerankModel resolvers loadConfig uses, so a
pre-warm cannot populate a cache entry the service ignores, and exits 1 when
neither provider is local instead of reporting success for doing nothing."
```

---

## Task 10: Enumerate the reranker's env surface and close it at every deployment surface

**This task is an enumeration, not a list of edits.** It is the one most likely to be done badly, because the correct output looks like busywork. The Phase 0+1 ledger spent **seven fix rounds** on exactly this class of defect, and the structural cause it recorded is unchanged: variables read via direct `process.env` (`HF_CACHE_DIR`, `EGRESS_ALLOWED_HOSTS`) are invisible to anyone auditing configuration through `loadConfig`, "which is why eleven prior code reviews missed a fail-open hole sitting in the gap between code and deployment config".

Two facts that make this worse than it looks, both verified at plan time:

- **`RERANK_*` appears nowhere in `docker/compose.prod.yml`, nowhere in `docker/docker-compose.yml`, and nowhere in `docs/DEPLOYMENT.md`.** `grep -c RERANK` returns 0 for all three. The only surface that mentions it is `env.example:352-381`. So this is not "add one variable to three maps" — the whole reranker configuration group is absent from the deployment surface.
- **Production is Railway, not compose** (root `CLAUDE.md`). Compose is the single-VM stack. A ledger finding (FB c2 MEDIUM/78, repeated at c3 MEDIUM/85 after a dispatch said "the variable", singular) is that documenting the compose path alone leaves the platform that actually runs this uncovered.

- [ ] **Step 1: Derive the variable list from the code**

Do not use the list below as input. Produce your own, by this method, and then compare:

```bash
# Everything loadConfig reads for the rerank group and the ONNX paths.
grep -n "env\.RERANK\|env\.EMBEDDING\|env\.COMPLIANCE\|env\.CHUNK_SIZE" packages/core/src/config.ts
# Everything read outside loadConfig — the invisible class.
grep -rn "process\.env" packages/rag/src packages/core/src packages/runtime/src --include=*.ts | grep -v test
```

For each variable produce: name, where it is read, its app-side default, whether it is per-service or global, and its presence at each of these **seven** surfaces:

| Surface                                | Why it is in scope                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `docker/compose.prod.yml` — `api`      | `environment:` at `:87`                                                           |
| `docker/compose.prod.yml` — `mcp`      | `environment:` at `:237`                                                          |
| `docker/compose.prod.yml` — `worker`   | `environment:` at `:273`+                                                         |
| `docker/docker-compose.yml`            | Local dev stack                                                                   |
| `env.example`                          | The template; `.env` itself must not be edited                                    |
| `docs/DEPLOYMENT.md` — compose section | Zero `RERANK` matches today                                                       |
| `docs/DEPLOYMENT.md` — Railway section | **Production.** Per-service variables set on `rag-api` and forgotten on `rag-mcp` |

Compose does **not** inherit unlisted host environment and `compose.prod.yml` has no `env_file` — that is the mechanism behind the ledger's HIGH/88, where `COMPLIANCE_MODE=client-data` in `.env` never reached `loadConfig` and compliance mode was silently off with every checklist box still tickable.

- [ ] **Step 2: Apply constraint 4 — compose defaults must not shadow app defaults**

For every variable added to a compose `environment:` map, use `${VAR:-}` — an **empty** default — whenever `config.ts` has a smarter one, and verify the app-side fallback is `||` (or an explicit truthiness check), never `??`, so an always-set-but-empty string reads as unset.

This is not hypothetical: `EMBEDDING_MODEL: ${EMBEDDING_MODEL:-gemini-embedding-001}` meant `loadConfig`'s fallback could never fire under compose, and the systematic pass that found it also found a second instance nobody had named (`GENERATION_MODEL: ${GENERATION_MODEL:-gemini-1.5-flash}` against a schema default of `gemini-2.5-flash`). Both were fixed at **both** layers in round 7 (`a9fa209`). `RERANK_MODEL` and `RERANK_TIMEOUT_MS` are the same category: a non-empty compose literal for either would defeat Task 6's local default and Task 5's.

The already-correct precedent to copy, at `compose.prod.yml:102-113`: `EGRESS_ALLOWED_HOSTS: ${EGRESS_ALLOWED_HOSTS:-}`, `HF_CACHE_DIR: ${HF_CACHE_DIR:-}`, `EMBEDDING_MODEL: ${EMBEDDING_MODEL:-}`.

- [ ] **Step 3: Write the config tests for the empty-string path**

One test per variable whose compose passthrough is new, in `packages/core/src/config.test.ts`, asserting that `""` reads as unset and lands on the app default. Tasks 5 and 6 already contribute these for `RERANK_TIMEOUT_MS`, `RERANK_MODEL` and `RERANK_PROVIDER`; add any the enumeration turns up that they do not cover, and state in the commit body which variables were covered by which test.

- [ ] **Step 4: Close every gap the enumeration found**

Edit the seven surfaces. For `docs/DEPLOYMENT.md`, both the compose and the Railway subsections, and for Railway state the per-service requirement explicitly: which services need the variable (`rag-api`, `rag-mcp`, `rag-worker` — the worker builds a `Retriever` via `buildCoreDeps` even though it does not query, so a `local` reranker there would hold a third copy of the weights unless the lazy load keeps it unloaded, which Task 3 asserts) and how to confirm it on each.

Content that must appear in the operator documentation, derived from this plan's design rather than invented at writing time:

- `RERANK_PROVIDER=local` is the only reranker permitted under `COMPLIANCE_MODE=client-data`, and unlike the hosted ones it needs **no** `EGRESS_ALLOWED_HOSTS` entry.
- It needs `HF_CACHE_DIR` set to a durable path _and pre-warmed with `scripts/warm-model.ts`_, or it will not boot under `client-data`. Update the quoted cache size with Task 9 Step 4's **measured** figure.
- `RERANK_POOL_MULTIPLIER` defaults to 2 for `local` (12 × 2 = 24 in-process forward passes per query) and 5 for the hosted providers, and the symptom of setting it too high is `RERANK_TIMEOUT_MS` expiry with silent degradation to RRF order.
- The degradation signal: `GET /health` carries `reranker.state`; `mcp`/`worker` log a state transition at `error` level.
- The documented alternative model (`Xenova/ms-marco-MiniLM-L-6-v2`) is operator-chosen via `RERANK_MODEL`, never automatic.

Also update `docs/ARCHITECTURE.md`'s reranking section and the root `CLAUDE.md` "Where to find things" row for reranking (`packages/rag/src/retrieval/reranker.ts — off by default`), which must now mention `local-reranker.ts`.

**Do not** edit `docs/superpowers/specs/` or `docs/plans/`: a standing ruling in the ledger holds that those describe the past-tense state that drove this work and must not be rewritten.

- [ ] **Step 5: Prove the enumeration**

This is the step the seven rounds existed for. Produce, in the commit body, a table of **every** variable the reranker path reads × **every** one of the seven surfaces, with a cell per pair, including the ones that needed no change and why. A reviewer must be able to check the table against `grep` without re-deriving the list. Then:

```bash
docker compose -f docker/compose.prod.yml config > /dev/null && echo "compose OK"
# Per-service parity: the three maps must agree on the reranker group.
for svc in api mcp worker; do
  echo "--- $svc ---"
  docker compose -f docker/compose.prod.yml config | \
    awk "/^  $svc:/,/^  [a-z-]+:\$/" | grep -E "RERANK|HF_CACHE_DIR|COMPLIANCE_MODE"
done
```

Expected: identical reranker-group keys across all three services. A variable present on `api` and missing on `mcp` is review finding 8 reproduced.

- [ ] **Step 6: Commit**

```bash
git add docker/compose.prod.yml docker/docker-compose.yml env.example docs/DEPLOYMENT.md docs/ARCHITECTURE.md CLAUDE.md packages/core/src/config.test.ts
git commit -m "docs: close the reranker's deployment-config surface, enumerated

RERANK_* appeared in env.example and nowhere else: not in compose.prod.yml
(any of the three environment: maps), not in docker-compose.yml, not in
DEPLOYMENT.md. Compose does not inherit unlisted host env and has no env_file,
so RERANK_PROVIDER=local in .env never reached loadConfig — the same mechanism
that left COMPLIANCE_MODE silently off with every compliance box tickable.

Derived the variable list from the code rather than from the two variables
this plan introduces, and compared it against all seven surfaces
variable-by-variable; the table is below. Every new compose default is
\${VAR:-} so it cannot shadow a smarter app-side default, matching the
EMBEDDING_MODEL and GENERATION_MODEL fixes.

DEPLOYMENT.md covers both compose and Railway, and the Railway section names
every service that needs each variable: production is Railway, and
RERANK_PROVIDER set on rag-api and forgotten on rag-mcp degrades the
agent-facing surface silently."
```

---

## Task 11: Opt-in integration test against real `Xenova/bge-reranker-base` weights

Spec constraint 4 and review finding 6. Every test to this point mocks `@huggingface/transformers` with a hand-authored tensor, so it verifies the author's belief about the head shape. If the single-scalar-logit reading is wrong, all of them stay green and ranking is inverted in production.

- [ ] **Step 1: Write it**

Create `packages/rag/src/retrieval/local-reranker.integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RetrievalResult } from "@rag/core";
import { LocalCrossEncoderReranker } from "./local-reranker.js";

/**
 * OPT-IN. Downloads and runs real Xenova/bge-reranker-base weights (~1.1 GB
 * for the fp32 variant), so it is excluded from `pnpm test` and the pre-push
 * hook. Run deliberately:
 *
 *   RERANK_LOCAL_INTEGRATION=1 HF_CACHE_DIR=/tmp/hf-it \
 *     pnpm --filter @rag/rag test -- local-reranker.integration
 *
 * This is the ONLY test that can detect an inverted ranking. Every other test
 * in this directory mocks the model and asserts over a tensor the test author
 * wrote: it verifies the author's belief about the head shape, not the
 * model's. If the single-scalar-logit reading is wrong, they all stay green.
 *
 * NOTE: onnxruntime-node has previously SIGABRT'd this repo's short-lived
 * runners at process exit AFTER completing work, and a second resident ONNX
 * model compounds it. Gate any CI usage on verified output state written
 * before teardown — never on the child process's exit code.
 */
const RUN = process.env["RERANK_LOCAL_INTEGRATION"] === "1";

function candidate(id: string, text: string): RetrievalResult {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    text,
    score: 0,
    metadata: {},
  } as unknown as RetrievalResult;
}

describe.skipIf(!RUN)("LocalCrossEncoderReranker against real weights", () => {
  const QUERY = "How do I rotate the parser shared secret?";
  const RELEVANT = candidate(
    "relevant",
    "To rotate PARSER_SECRET, set the new value on both the worker and the parser service, then restart the parser. The X-Parser-Token header must match or every parse returns 401.",
  );
  const IRRELEVANT = candidate(
    "irrelevant",
    "Sourdough starter should be fed equal parts flour and water by weight and left at room temperature for eight hours before baking.",
  );

  it("ranks the relevant document above the irrelevant one", async () => {
    const r = new LocalCrossEncoderReranker({
      model: "Xenova/bge-reranker-base",
      timeoutMs: 600_000,
    });
    await r.ready();

    // Both input orders: a provider that returned its input unchanged would
    // pass one of these by luck.
    const forward = await r.rerank(QUERY, [IRRELEVANT, RELEVANT], 2);
    const reverse = await r.rerank(QUERY, [RELEVANT, IRRELEVANT], 2);

    expect(forward[0]!.chunkId).toBe("relevant");
    expect(reverse[0]!.chunkId).toBe("relevant");
  }, 900_000);

  it("has a single-output head — the dims assertion is not vacuous", async () => {
    const r = new LocalCrossEncoderReranker({
      model: "Xenova/bge-reranker-base",
      timeoutMs: 600_000,
    });
    await r.ready();
    // assertScalarHead throws on any last dim != 1. Reaching here proves the
    // real model's head is the shape the scalar reading assumes — the one
    // fact no mocked test can establish.
    await expect(
      r.rerank(QUERY, [RELEVANT, IRRELEVANT], 2),
    ).resolves.toHaveLength(2);
    expect(r.health().state).toBe("ready");
  }, 900_000);

  it("separates the pair by a wide margin, not a coin flip", async () => {
    // A ranking that is correct by 0.01 would also be correct under a subtly
    // wrong score extraction. bge-reranker emits large positive logits for a
    // match and large negative ones for a mismatch.
    const r = new LocalCrossEncoderReranker({
      model: "Xenova/bge-reranker-base",
      timeoutMs: 600_000,
    });
    await r.ready();
    const out = await r.rerank(QUERY, [IRRELEVANT, RELEVANT], 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.chunkId).toBe("relevant");
  }, 900_000);
});
```

If `rerank()` does not expose scores, the margin test above degenerates into the first one. Either (a) accept it as a top-1 variant, or (b) have `rerank()` write the computed score onto the returned result's `score` field — but **(b) changes the `RetrievalResult` contract** that `HttpCrossEncoderReranker` and the `Retriever` share, and `interfaces.ts` says implementations must not fabricate. If you want real margins, add a separate `scorePairs()` method used only by this test and documented as such. Decide and say which in the commit body; do not silently mutate `score`.

- [ ] **Step 2: Exclude it from the default suites**

`pnpm test` and the pre-push hook must not download 1.1 GB. Add the integration spec to `packages/rag`'s vitest `exclude`, and confirm it stays excluded:

```bash
pnpm --filter @rag/rag test 2>&1 | grep -c "local-reranker.integration"   # expect 0
```

- [ ] **Step 3: Run it for real and record the result**

```bash
HF_CACHE_DIR=/tmp/hf-it RERANK_LOCAL_INTEGRATION=1 \
  pnpm --filter @rag/rag test -- local-reranker.integration
```

Expected: 3 passing. **Record the observed outcome in the commit body**, including whether the runner SIGABRT'd at exit after the tests passed. If it did, the tests still passed — say so explicitly and do not "fix" it by weakening an assertion.

Then run the mutation that gives this test its reason to exist: change the scalar read to `scores.push(...Array.from(logits.data, (v) => -Number(v)))` (an inverted score), re-run, and confirm **all three** tests fail. Restore. Record it. The whole plan's defence against inverted ranking is this one test; a reviewer must see evidence it can fail.

- [ ] **Step 4: Commit**

```bash
git add packages/rag/src/retrieval/local-reranker.integration.test.ts packages/rag/vitest.config.ts
git commit -m "test(rag): opt-in integration test against real bge-reranker-base weights

Every other test in this directory mocks @huggingface/transformers with a
hand-authored tensor, so it verifies the author's belief about the head shape,
not the model's. If the single-scalar-logit reading were wrong, ranking would
invert in production with all of them green.

Runs the real weights behind RERANK_LOCAL_INTEGRATION=1, excluded from
pnpm test and the pre-push hook (~1.1 GB download). Asserts a relevant chunk
outranks an irrelevant one from BOTH input orders, so a provider that returned
its input unchanged cannot pass by luck.

Verified by mutation: negating the extracted score fails all three."
```

---

## Task 12: Measure it — a reranker dimension in the retrieval eval harness

`.claude/rules/tdd.md`: "Retrieval-affecting changes (chunking, embeddings, RRF, parser, prompts) additionally require the eval harness." A reranker reorders retrieval by definition, so this is mandatory, not optional.

**How the measurement dependency is resolved.** The two harnesses measure different things and only one of them is blocked:

| Harness          | Measures                                             | State                                                                                                                              |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm eval`      | **Retrieval** — recall@k, precision@k, nDCG, MRR     | **Runnable now.** `EVAL_QUESTIONS` (`tests/e2e/src/eval/corpus.ts:110`) is populated, plus a second CPA corpus; three vitest specs |
| `pnpm eval:gold` | **Answer quality** — citations, refusals, truncation | **Blocked.** `gold-set.ts:93` `GOLD_QUESTIONS = []`, and `run-gold-eval.ts` refuses an empty set by design                         |

A reranker reorders a retrieved candidate pool. The instrument for that is recall@k / nDCG / MRR — `pnpm eval` — not answer quality. So **reranker quality is gated on `pnpm eval`, and this plan has no dependency on the gold set.** The gold-set population is a separate plan being written in parallel; do not duplicate it, do not populate `GOLD_QUESTIONS` here, and do not block on it.

Declared dependency, for the record: once that plan lands, a follow-up should run `pnpm eval:gold` with `RERANK_PROVIDER` as a dimension, to answer the question `pnpm eval` cannot — whether better-ordered context produces better _answers_. That is out of scope here.

One gap `pnpm eval` has today: `run-eval.ts:128` constructs `new Retriever(db, embedder, {...})` with **no fourth argument**, so it cannot hold a reranker at all. Closing that is this task.

**Caveat that must be recorded with the numbers.** `runRetrievalEval` defaults to `FakeEmbedder`, so the dense half of hybrid search is synthetic. The reranker scores real chunk _text_ and is unaffected by that, but the candidate pool it receives is not a production-representative pool. The measurement is therefore a valid _comparison_ (same pool, reranked vs not) and not a production quality estimate. Say so wherever the numbers are written down.

- [ ] **Step 1: Thread an optional reranker into the harness**

In `tests/e2e/src/eval/run-eval.ts`, add to `runRetrievalEval`'s options (beside the existing `embedder` option at `:116`):

```ts
    /**
     * Optional reranker, applied after hybrid RRF exactly as production does.
     * Defaults to none, so every existing eval number stays comparable.
     *
     * `poolMultiplier` must be passed with it: `retriever.ts` over-fetches
     * topK x poolMultiplier only when a reranker is present, so omitting it
     * would measure a reranker over a pool the size of topK — i.e. reordering
     * with nothing to reorder from.
     */
    reranker?: Reranker;
    poolMultiplier?: number;
```

and at `:128`:

```ts
const retriever = new Retriever(
  db,
  opts.embedder ?? new FakeEmbedder(),
  {/* …existing defaults… */},
  opts.reranker
    ? {
        reranker: opts.reranker,
        poolMultiplier: opts.poolMultiplier ?? 2,
        // A reranker failure in an EVAL must not silently degrade to RRF
        // and report a number: that reads as "reranking did nothing",
        // which is indistinguishable from "reranking was not configured".
        onError: (err) => {
          throw err;
        },
      }
    : undefined,
);
```

The `onError` that rethrows is the important line. Production degrades to RRF on purpose; a measurement that degrades silently reports the wrong thing with no indication.

- [ ] **Step 2: Add the comparison spec**

Create `tests/e2e/src/specs/retrieval-eval-rerank.spec.ts`, following whatever corpus-ingestion fixture `retrieval-eval.spec.ts` already uses. It must:

- Ingest `EVAL_DOCS` once, then run `runRetrievalEval` twice over `EVAL_QUESTIONS` — once with `reranker: undefined`, once with the real `LocalCrossEncoderReranker` and `poolMultiplier: 2`.
- Print both reports via the harness's existing `formatReport`, plus the deltas.
- Assert only non-regression, not improvement: `recall@12` and `nDCG@12` with the reranker must be **>=** the baseline minus a stated tolerance. A reranker that reorders a pool cannot raise recall@fetchK; it should raise precision and nDCG at small k and must not _lower_ recall at k.
- Be opt-in on the same `RERANK_LOCAL_INTEGRATION=1` flag as Task 11 — it loads real weights and `pnpm eval` runs in CI.

The assertion to write, because it is the one that catches inverted ranking at the retrieval level and it is cheap:

```ts
// Inverted ranking shows up here as nDCG@3 collapsing while recall@12
// stays flat: the right documents are still in the pool, in the worst
// possible order. This is a second, independent net under Task 11's.
expect(withRerank.ndcgAtK[3]!).toBeGreaterThanOrEqual(
  baseline.ndcgAtK[3]! * 0.9,
);
```

- [ ] **Step 3: Run the measurement**

```bash
pnpm docker:up
RERANK_LOCAL_INTEGRATION=1 HF_CACHE_DIR=/tmp/hf-it pnpm eval
```

Record, in the commit body: both tables (baseline and reranked), the deltas at k = 3, 5, 12, the wall-clock per query for each, and the `FakeEmbedder` caveat. Numbers without the caveat will be read as a production quality claim.

If nDCG@3 drops, **stop and treat it as the inverted-ranking defect**, not as "reranking does not help on this corpus". Check `assertScalarHead`'s sign handling and re-run Task 11's mutation before concluding anything about the corpus.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/src/eval/run-eval.ts tests/e2e/src/specs/retrieval-eval-rerank.spec.ts
git commit -m "test(e2e): measure the local reranker through the retrieval eval harness

runRetrievalEval constructed its Retriever with no reranker options at all, so
the harness could not measure a reranker — while .claude/rules/tdd.md requires
the eval harness for any retrieval-affecting change, and a reranker reorders
retrieval by definition.

Threads an optional reranker plus poolMultiplier through (over-fetch only
happens when a reranker is present, so the multiplier is not optional in
practice) and adds an opt-in baseline-vs-reranked comparison over EVAL_DOCS
and EVAL_QUESTIONS. The eval's onError rethrows rather than degrading to RRF:
production degrades on purpose, but a measurement that degrades silently
reports 'reranking did nothing' indistinguishably from 'reranking was off'.

Asserts non-regression, not improvement — reordering a pool cannot raise
recall@fetchK. nDCG@3 collapsing while recall@12 stays flat is the signature
of inverted ranking, which makes this a second net under the real-weights
test. Numbers below carry the FakeEmbedder caveat: the comparison is valid,
the absolute values are not a production estimate.

Not gated on GOLD_QUESTIONS, which is empty and owned by a separate plan:
pnpm eval measures retrieval order, which is what a reranker changes.
pnpm eval:gold measures answer quality and is a declared follow-up."
```

---

## Self-review notes

**Spec coverage.** Phase 3's model/scoring decision → Task 2 (and Task 11, which is the only thing that can verify it). The gate fix → Task 6. Constraint 1 (cost) → Task 6 (local pool multiplier), Task 5 (latency budget), Task 2 (concurrency bound), Task 3 (lazy load, so three `buildCoreDeps` calls do not mean three resident copies). Constraint 2 (two 512-token problems) → Task 4 (the shared pair budget) and Task 7 (the cap keyed on the wrong provider). Constraint 3 (silent-failure signal) → Task 8, with the bounded retry it depends on in Task 3. Constraint 4 (a mocked test cannot catch inversion) → Task 11. Constraint 5 (interface fit) → no change to `rerank()`; the only interface addition is an **optional** `health()`, so `HttpCrossEncoderReranker` is untouched.

**Beyond the spec, from the Phase 0+1 ledger.** Offline enforcement extended to the reranker → Tasks 1 and 3, sharing one implementation rather than copying it (ledger finding M-1, drift from a duplicated literal). `warm-model.ts` → Task 9, as an enumeration. Env vars reaching all three containers plus Railway → Task 10, as an enumeration. Compose defaults not shadowing app defaults → Task 10 Step 2, with `||` not `??` enforced by a test per variable. Eval harness → Task 12.

**The method lesson, applied.** Tasks 9 and 10 are the two that touch something restated across several surfaces, and both are written as _enumerate from the code, fix, then prove the enumeration in the commit body_, with the derivation command given and the list of surfaces given but not the list of answers. Task 10 Step 1 says explicitly not to use the plan's own variable list as input. Four other tasks (1 Step 7, 3 Step 5, 6 Step 6, 11 Step 3) require watching a guard fail by mutation before trusting it — the ledger's other recurring finding was a wiring line with zero coverage that could be deleted with 279 tests still green.

**Review Focus coverage.** 1 → Task 7 Step 1. 2 → Task 3 Step 1 and Task 6 Step 1 (both the constructor and the factory wiring, because the ledger's zero-coverage finding was on the _factory_ line, not the constructor). 3 → Task 3 Step 1 and Task 6 Step 1. 4 → Task 6 Step 1. 5 → Task 6 Step 1. 6 → Task 2 Step 1 (dims), Task 11 Step 3 (real weights), Task 12 Step 2 (nDCG@3 as a third net). 7 → Task 3 Steps 1 and 5. 8 → Task 10 Step 5 (per-service parity check). 9 → Task 10 Step 2 plus one config test per variable. 10 → Task 3 Step 1 (`state === "unloaded"` before first rerank) and Task 10 Step 4 (documented).

**Type consistency.** `ALLOW_REMOTE_MODELS_KEY` and `assertOfflineCacheDir` are created in Task 1 and consumed in Tasks 1 (local.ts) and 2/3 (local-reranker.ts). `DEFAULT_LOCAL_RERANK_MODEL` and `defaultRerankModel` are created in Task 6 and consumed in Tasks 6, 7 and 9. `rerank.timeoutMs` is created in Task 5 and consumed in Tasks 5 and 6. `RerankerHealthState` is created in Task 3 and consumed in Tasks 4, 8. `rerankProvider`/`rerankModel` are hoisted in `loadConfig` in Task 6 and reused in Task 7. `DEFAULT_MAX_PAIR_TOKENS` is declared in Task 2 and first used in Task 4 — the only forward reference in the plan, and Task 2 Step 3 says to delete it if you stop before Task 4.

**File-size check.** `local-reranker.ts` lands at roughly 280-320 lines across Tasks 2-5. `reranker.ts` gains ~25 (184 → ~210). `config.ts` gains ~45 (290 → ~335). `config-schema.ts` gains ~15 (406 → ~420). None approaches 800. Run `node scripts/check-file-sizes.mjs` before the final commit anyway.

**Deliberately not in scope.**

- **Populating `GOLD_QUESTIONS`.** Owned by a separate plan. Task 12 explains why reranker quality does not need it.
- **Any `Dockerfile` edit.** A standing ruling from the ledger: `apps/worker/Dockerfile` never copies `scripts/`, and a build-stage cache never reaches the runtime stage, so a baked warm-up cannot work. Pre-warming is the mounted-volume path, documented, with the operator supplying the mount — the repo declares only `postgres_data` and mounts nothing on api/mcp/worker.
- **Implementing the `llm` reranker.** Still `ValidationError` at `reranker.ts:179-182`, and still blocked under `client-data`.
- **Consolidating the "don't bake, mount instead" caveat**, now near-verbatim in five files. A deferred LOW with an explicit "do not consolidate in this branch" ruling.
- **Threading `HF_CACHE_DIR` through `config-schema.ts`.** It is read via direct `process.env` in two places (`hf-offline.ts` after Task 1, and `local-reranker.ts`/`local.ts`'s `doLoad`/`_loadPipeline`). The ledger named this as the _structural_ cause of the whole compose class of bug — variables invisible to anyone auditing through `loadConfig`. Fixing it properly means auditing every reader at once, which is its own change; Task 1's docblock records the requirement so a future refactor cannot half-do it.

**Unresolved conflict between the spec and the code — reported, not fixed.** The spec's Phase 3 cites `reranker.ts:146` for the gate and `retriever.ts:84` for `fetchK`; the gate is at `:146` as stated, but `fetchK` is at `retriever.ts:82` in the current tree. The spec also cites `config.ts:622`/`:572`/`:591`/`:199`/`:158` for the chunk cap and rerank defaults, and `local.ts:126-137`/`:140-142`/`:146` for the ONNX loader — all of which moved when Phase 0a split `config.ts` (now 290 lines) and Phase 0b rewrote the loader. The behavior the spec describes is intact at every one of those sites; only the line numbers are stale. This plan cites the current tree at `a9fa209`. Per the standing ruling, `docs/superpowers/specs/` is **not** updated to match.
