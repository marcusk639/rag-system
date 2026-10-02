# Adversarial review — `2026-10-02-local-llm-verification-design.md`

**Reviewer:** plan-reviewer (independent verification against code, not against the spec's own claims)
**Date:** 2026-10-02
**Verdict:** **Do not implement as written.** The spec file no longer exists on disk,
Amendment 1's rescope of item 5 rests on a misread comment block, and the
answer-quality harness the spec says is missing already exists in this repo.
Items 1, 3 and 4 are sound in intent but each has a blocking prerequisite the
spec does not name.

The five problems the author already found (HF cold-cache vs. air-gap; shared
512-token query+doc budget; `gpt-oss:20b` never actually pulled; seven items too
many; no runtime budget) are **not restated here**. Everything below is new.

---

## S0 — Blockers

### 1. The spec is gone. HEAD deleted it.

`d828975` (HEAD) replaced the 359-line spec with Amendment 2 alone:

```
.../2026-10-02-local-llm-verification-design.md | 42 insertions(+), 359 deletions(-)
```

The working-tree file is 42 lines and opens at `## Amendment 2`. The commit
message says it "moves the amendment-2 content onto this branch" — it destroyed
the body and Amendment 1 instead. The only surviving copy is
`git show a499097:docs/superpowers/specs/2026-10-02-local-llm-verification-design.md`
(this review was conducted against that). **Restore before anything else** —
nothing in items 1–7 is implementable from the file as committed.

### 2. Amendment 1's load-bearing fact is a misread comment. CI does not run local generation.

The amendment states: "`.github/workflows/web-e2e.yml:20` — the job runs
`ollama serve` and `ollama pull llama3.1:8b`", and concludes local generation
"runs in the web-e2e workflow". Commit `a499097`'s subject repeats it: "local
generation already runs in web-e2e CI".

`web-e2e.yml:1-22` is a **comment block**. Line 20 is
`#   ollama serve & ollama pull llama3.1:8b`, inside a "Run the full suite
locally" instruction. The same comment says the opposite of the amendment:

- `web-e2e.yml:10-12` — "The generation-dependent specs (compliance.spec.ts,
  kb.spec.ts — citations, self-retrieval, refusal) are **deliberately NOT run
  here**."
- `tests/web-e2e/package.json` — `"test:browser:ci": "playwright test
--grep-invert @needs-8b-model"`, and all five generation tests carry that tag
  (`kb.spec.ts:33,64,76,95`; `compliance.spec.ts` ×1).

Likewise the "real cross-model comparison" cited at `web-e2e.yml:15-16` is prose
in that comment — a human counting passing tests by hand. There is no scoring
code, no artifact, no re-runnable measurement. The spec elevates a code comment
to a measurement and then rescopes item 5 onto it. **The rescope premise is
false.**

### 3. The answer-quality harness already exists. Both versions of item 5 are wrong.

Original item 5: "The existing harness is a **retrieval** eval (recall/MRR) …
It does not measure answer quality." Revised item 5: extend web-e2e instead.

Reality — `tests/e2e/src/eval/gold-eval.ts`, `scoreGoldRun`, pure and
unit-tested in `tests/e2e/src/specs/gold-eval.spec.ts`, wired as
`pnpm eval:gold` (root `package.json`) → `tests/e2e/src/eval/run-gold-eval.ts`:

| Item 5's proposed check                    | Already implemented                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Citation resolution (fabricated citations) | `gold-eval.ts:35` `fabricatedCitations`                                                                |
| Refusal correctness                        | `gold-eval.ts:31-34` `coverage.correctlyRefused`, `wrongRefusals`, `isRefusal()`                       |
| Format compliance / truncation             | `gold-eval.ts:36` `truncated` (uses `TRUNCATION_NOTICE`)                                               |
| Groundedness                               | **genuinely absent** — `gold-eval.ts:13-14` says faithfulness "needs a reviewer or a calibrated judge" |

And `tests/web-e2e/playwright.config.ts:7-8` already rules on the question the
amendment reopened: web-e2e "is **not an answer-quality signal for production**,
which uses different models; answer quality is measured by `pnpm eval:gold`."

The real gap is much narrower than either version of item 5:

- `tests/e2e/src/eval/gold-set.ts:93` — `export const GOLD_QUESTIONS:
GoldQuestion[] = []`. The set is **empty**, and `run-gold-eval.ts` refuses to
  run on an empty set by design.
- `run-gold-eval.ts:1-17` targets the **real firm SharePoint corpus** and warns
  its output "is still firm-confidential material" — so its report can never be
  the committed public comparison table success criterion 5 asks for.

**Correct item 5:** populate a gold set against the synthetic corpus and add a
model dimension to `run-gold-eval.ts` (it already speaks plain HTTP to `/ask` —
no browser, no Playwright boot, ~seconds per question). Reuse `scoreGoldRun`
unchanged. Add groundedness there if wanted. Do not build a second harness, and
do not put this in Playwright.

---

## S1 — Critical

### 4. Widening the gate to `none | local` admits an **unpoliced** egress path

Item 3 asserts the local reranker needs "no `EgressPolicy` call because there is
no egress to police." That is false as the local provider is written, and the
compliance gate is the wrong place to encode the assumption.

`packages/rag/src/embeddings/local.ts:126-137` — dynamic import, sets
`env.cacheDir` from `HF_CACHE_DIR`, then `pipeline("feature-extraction",
this.model)`. It never sets `env.allowRemoteModels = false`, never sets
`env.localModelPath`, and `@huggingface/transformers` defaults
`allowRemoteModels = true`. Its own error text admits it:

> `local.ts:146` — "first run requires internet access to download weights"

`packages/rag/src/embeddings/factory.ts:63-66` constructs
`LocalEmbeddingProvider` with **no `egressPolicy` at all**, so
`EgressPolicy.assertAllowed` is never offered the huggingface.co URL.
`EGRESS_ALLOWED_HOSTS=127.0.0.1` therefore cannot block it (`egress-policy.ts`
only inspects URLs it is handed).

Consequence for the spec's own test: **success criterion 4** ("removing the
endpoint host from `EGRESS_ALLOWED_HOSTS` produces `EGRESS_BLOCKED`") passes
while a cold-cache HF download still succeeds. It proves the generation path and
says nothing about the two ONNX paths. That is a green test over an open hole.

This belief is already encoded in a passing test:
`packages/rag/src/embeddings/local.test.ts:151` — _"makes no HTTP calls — all
inference is handled in-process (no egress)"_ — asserted while
`vi.mock("@huggingface/transformers")` (line 30) replaces the downloader.

Minimum fix before any gate widening:

1. Under `COMPLIANCE_MODE=client-data`, set `env.allowRemoteModels = false`
   (and/or `env.localModelPath`) for **both** ONNX providers, and make a missing
   cache a loud boot failure rather than a silent download.
2. Extend `scripts/warm-model.ts` — it warms the **embedder only**
   (`warm-model.ts:26-33`). A deployment that pre-warms per the current docs
   still takes a cold HF download for the reranker on first query.
3. Only then widen the gate.

### 5. `packages/core/src/config.ts` is 791 lines against a hard 800-line cap

`scripts/check-file-sizes.mjs` sets `MAX_LINES = 800` and blocks the commit;
`config.ts` is not on the grandfather list. Items 1 and 3 **both** edit it
(provider-aware default; `local` added to `rerank.provider`). The split is a
**hard prerequisite**, not the "may need splitting" the spec's testing section
offers. Conversely `packages/rag/src/retrieval/reranker.ts` is **184 lines** —
the spec names both as equally at risk and is wrong in both directions.

### 6. The logit-vs-softmax unit test cannot detect the thing it exists for

The risk table's mitigation for inverted ranking is "Explicit unit test asserting
known-relevant ranks above known-irrelevant", and the testing table says
`local-reranker.test.ts` should mirror `local.test.ts`.

`local.test.ts:30` is `vi.mock("@huggingface/transformers", …)` — the model is
fully mocked and the output tensor is hand-authored (`vi.hoisted` block, lines
8-31). A reranker test "mirroring" it asserts over a tensor the test author
wrote, so it verifies **the author's belief about the head shape**, not the
model's actual head. If Amendment 2's single-scalar-logit reading is wrong, that
test still goes green.

The inversion risk needs **one opt-in integration test against the real
`Xenova/bge-reranker-base` ONNX weights**, run deliberately, with a fixed
relevant/irrelevant pair. Note also that onnxruntime-node has previously aborted
this repo's short-lived runners at process exit (SIGABRT/134 after work
completed) — gate such a test on verified output state, not the child's exit
code, and expect a second resident ONNX model to compound it.

### 7. web-e2e's "refusal correctness" is a verbatim-string check, not refusal correctness

The amendment claims the web-e2e assertions "are exactly the mechanical checks
item 5 proposed to build — refusal correctness and citation presence". The
refusal one is not.

`apps/web/src/components/chat-interface/chat-interface.tsx:111-112` renders
`data-testid="refusal"` only when
`message.content.includes(EMPTY_ANSWER)` — i.e. only when the answer contains,
verbatim, `packages/services/src/ask.ts:116-117`:

> "The available documents do not contain enough information to answer that."

`kb.spec.ts:53` asserts that testid is visible. So the check measures _did the
model reproduce one mandated sentence word-for-word_ — an instruction-following
test. A model that refuses correctly in its own words is scored as a
confabulation. Across models that is a false signal, not a weaker one.

Worse, `.includes()` anywhere in the content is precisely the shape this repo
already identified as wrong and fixed: `gold-eval.ts:49-55` matches the
**opening line only**, because "Matching anywhere would misread an answer that
quotes the phrase", with a dedicated regression test at `gold-eval.spec.ts:95`.
Extending web-e2e as the multi-model vehicle **propagates the buggy detector and
discards the corrected one.**

---

## S2 — Major

### 8. Amendment 2's "convenient alignment" is keyed to the embedding provider, not the reranker

Amendment 2: "the reranker's 512-token limit matches
`LOCAL_PROVIDER_MAX_CHUNK_SIZE` (512) … No new chunking constraint."

`LOCAL_PROVIDER_MAX_CHUNK_SIZE` (`config.ts:572`) is applied only inside
`if (provider === "local")` (`config.ts:622`), where `provider` is
`EMBEDDING_PROVIDER` (`config.ts:591`). So:

`RERANK_PROVIDER=local` + `EMBEDDING_PROVIDER=gemini` + `COMPLIANCE_MODE=none`
— a configuration the gate widening makes _attractive_ ("free local reranking,
no vendor") — keeps `CHUNK_SIZE` at its 800 default and silently truncates every
pair at rerank time, with no warning (`local.ts`'s overlong-text backstop is on
the embedder, not the reranker).

"No new chunking constraint" holds **only** inside compliance mode. Outside it,
item 3 introduces a second, unenforced 512-token constraint. This compounds the
shared query+doc budget the author already found.

### 9. `RERANK_POOL_MULTIPLIER` × an in-process cross-encoder is never priced

`retriever.ts:84` — `fetchK = this.reranker ? topK * this.rerankPoolMultiplier
: topK`. Defaults: `poolMultiplier` 5 (`config.ts:199`), `defaultTopK` 12
(`config.ts:158`) → **60 query-document cross-encoder forward passes per
query**, in-process, on the API's event loop.

For a hosted reranker that is one HTTP call with vendor-side batching — the
multiplier is nearly free, which is why 5 is the default. For an in-process
BERT-base cross-encoder at 512 tokens it is the dominant per-query cost. The
spec has no latency budget, no reduced `poolMultiplier` for `local`, and no
concurrency bound. Separately, all three backends call `buildCoreDeps`, so up to
three resident copies of the reranker weights.

### 10. The degradation path is silent and unbounded — and item 4's probe covers the wrong component

Confirmed as the spec claims (answering the degradation question): `Reranker`
(`packages/core/src/interfaces.ts:101-115`) explicitly sanctions throwing —
"callers degrade to the pre-rerank (RRF) order" — and `retriever.ts:111-116`
does exactly that (`results.slice(0, topK)`). The interface imposes nothing
about transport, so a no-network provider **does** fit cleanly. `createReranker`'s
gate at `reranker.ts:146` matches the spec's quote verbatim, and the `switch` is
exhaustive with no `default`, so adding `local` to the enum without a case is a
compile error rather than a silent hole. Those spec claims check out.

What does not: the only failure signal is
`packages/runtime/src/index.ts:223` — a pino `warn`, no metric, no counter. A
local reranker that can never load (air-gapped host, no warmed cache) therefore
degrades **every** query to RRF forever while the deployment believes reranking
is on; and `local.ts:140-142` resets the cached promise on failure, so every
query re-attempts the load. Item 4 adds a startup probe for the **generation**
endpoint — the component that already fails loudly at request time via
`GenerationNotConfiguredError` — and adds none for the reranker, the component
that fails silently. The probe is pointed at the wrong target.

### 11. `COMPLIANCE_MODE=client-data` will not boot without a vendor-DPA file

`config.ts:775-783` — client-data mode throws at startup unless
`docs/compliance/vendor-dpa-<vendor>.md` exists (`defaultCheckDpa`,
`config.ts:551-559`; documented at `env.example:367`). The compliance-posture
section and success criterion 3 never mention it.

Two consequences:

- The only such file in the repo is **`vendor-dpa-google-gemini.md`**. So the
  "no outbound calls, no subprocessor" deployment boots _solely because a Gemini
  DPA is on file_, and the check is vendor-agnostic (any matching filename). The
  gate is satisfied by evidence about a vendor that is explicitly not in use.
- The check is **cwd-relative** (`config.ts:552`), so a container that ships
  `dist/` without `docs/` fails to boot in client-data mode. That is a live trap
  for the "fully-local recipe" item 7 is meant to document.

Item 2 did this correctly for `API_TOKENS` ("intended behavior, document it").
This is its exact sibling and was missed.

### 12. The Gemini baseline column cannot be produced by the chosen vehicle

Success criterion 5 wants local models and the Gemini baseline "in one table",
and revised item 5 nominates web-e2e as the producer. web-e2e cannot produce the
Gemini row:

- `tests/web-e2e/src/env.ts:31` — `EGRESS_ALLOWED_HOSTS: "127.0.0.1"`, and
  `env.ts:9-11` warns the variable **REPLACES rather than merges**, so
  `generativelanguage.googleapis.com` is unreachable by construction.
- `env.ts:23,29-30` — `GENERATION_PROVIDER: "openai"` with
  `GENERATION_BASE_URL`. Switching to gemini while that is set is refused by
  design (`GEMINI_BASE_URL_REFUSAL`), and a key would be needed.

Producing the baseline means breaking the harness's stated hermeticity premise.
`eval:gold`'s runner has no such constraint — another reason item 5 belongs
there.

### 13. The multi-model run is architecturally a CI matrix, is slow, and is misleading

Answering the "can it be parameterized cheaply" question directly: **no.**
`GENERATION_MODEL` lives in `E2E_ENV` (`env.ts:28`), consumed by
`playwright.config.ts:19-33` as `webServer.env`. It is baked into process
launch, not a test parameter — so there is no `test.describe.each` route. Each
model is a **full suite invocation that reboots API and web**. The hook already
exists (`E2E_GENERATION_MODEL`); what the amendment calls "a parameterized run"
is a matrix of N invocations.

Cost, per model: two webServer boots (120s budgets each), one Ollama cold model
load, five generation-dependent tests (`kb.spec.ts` ×4, `compliance.spec.ts` ×1)
at `workers: 1`, `fullyParallel: false`, `timeout: 120_000`. Realistically
~3–6 min/model for 8b-class on Metal and materially more for a 20B MoE —
**roughly 20–40 minutes for a five-model matrix, on the happy path.**

What makes it misleading rather than merely slow:

- A previously recorded **~8% no-token stall rate (5/65) on the local
  llama3.1:8b stack**, unexplained by concurrent load. Each stall burns the full
  120s and saturates the CPU so following tests fail on time-to-headers. Across
  5 models × 5 tests ≈ 25 generation tests, expect ~2 spurious failures per
  matrix, **indistinguishable from real model failures**. The spec's two carried
  constraints cover fixture wording and empty citation sets — not the stall,
  which is the actual known source of nondeterminism.
- Of the five assertions, one is fully model-independent
  (`kb.spec.ts:85`, `chipCount === payload.citations.length` — a UI/BFF
  consistency check), one is a verbatim-string refusal check (finding 7), and
  one asserts the **top-ranked** chip is a specific document
  (`kb.spec.ts:40`, `chips.first()).toContainText("New Client Onboarding")`) —
  an ordering assertion that a model citing `[2]` before `[1]` fails for reasons
  unrelated to answer quality. That is ~2 meaningful bits per model for a
  20–40-minute run.
- `gpt-oss:20b` cannot run on a GitHub runner at all (12.8 GiB weights,
  CPU-only, ~14 GB free disk), so the committed table would be a one-machine
  artifact no reviewer can reproduce — in tension with success criterion 6.

Fragility note: `E2E_ENV` sets no `RETRIEVAL_MIN_DENSE_SIMILARITY`, so the
refusal test does currently reach the model. If anyone later sets that floor in
the harness, `ask.ts:419`/`:520` short-circuits to the fixed `EMPTY_ANSWER`
**without a model call** and the refusal assertion silently becomes
model-independent — still green, now meaningless for every row of the table.

---

## S3 — Minor

14. **Item 1 overstates the gap.** "`loadConfig` applies no provider-aware
    default" — it already has provider-aware logic (the chunk-size cap,
    `config.ts:620-638`), just not for the model name. The cap's warning text
    hardcodes `Xenova/bge-base-en-v1.5` (`config.ts:630`), so once the model is
    provider-defaulted, a user who picks a different local model with a longer
    window still gets capped to 512 by a message naming the wrong model.
15. **`scripts/warm-model.ts` bypasses `loadConfig`** — it reads
    `EMBEDDING_MODEL` directly and hardcodes `dimensions: 768`
    (`warm-model.ts:17,28`). Item 1's fix in `loadConfig` does not reach it.
    Extract a shared default helper or the two will drift.
16. `EMBEDDING_DIMENSIONS` defaults to 768 (`config.ts:654`), which matches
    `Xenova/bge-base-en-v1.5` — so item 1's change does **not** break
    dimensions, and `local.ts:267-272`'s dimension guard backstops a mismatch.
    No action; recorded because the question was raised.

---

## Spec claims verified correct

Worth recording so the next reader does not re-check them:

| Claim                                                                        | Status                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `config.ts:74` `tokens: z.array(z.string()).min(1)`                          | ✅ exact                                                             |
| `config.ts:670` `tokens: parseMultiValueSecret(env.API_TOKENS ?? "")`        | ✅ exact                                                             |
| `env.example:24` documents the non-empty requirement                         | ✅ exact                                                             |
| `env.example:77` ships an active `EMBEDDING_MODEL=gemini-embedding-001`      | ✅ exact                                                             |
| `config.ts:653` has no provider-aware model default                          | ✅                                                                   |
| `createReranker` gate condition as quoted                                    | ✅ `reranker.ts:146`, verbatim                                       |
| `rerank.provider` enum lives in `packages/core/src/config.ts`                | ✅ line 191                                                          |
| Retriever degrades to pre-rerank RRF order on reranker failure               | ✅ `retriever.ts:111-116`                                            |
| `Reranker` interface admits a no-network, no-`EgressPolicy` provider cleanly | ✅ `interfaces.ts:101-115`                                           |
| Ollama `POST /v1/embeddings` → 501 justifies in-process ONNX embeddings      | ✅ reasoning holds                                                   |
| `llm` reranker must stay blocked under `client-data`                         | ✅ reasoning holds; it is also unimplemented (`reranker.ts:179-182`) |

---

## Recommended resequencing

1. **Restore the spec** (finding 1). Nothing else can proceed.
2. **Correct Amendment 1** (finding 2) and retract commit `a499097`'s claim.
3. **Split `config.ts`** below 800 lines (finding 5) — gates items 1 and 3.
4. **Item 1** (embedding-model default) — smallest, genuinely needed, now
   unblocked. Share the default with `warm-model.ts` (finding 15).
5. **Offline enforcement for both ONNX providers** (finding 4) — a prerequisite
   for item 3's gate widening _and_ the only thing that makes the compliance
   posture section true.
6. **Item 2 + the DPA gate** (finding 11) as one documentation change.
7. **Item 5, rewritten**: populate `gold-set.ts` against the synthetic corpus and
   add a model dimension to `run-gold-eval.ts`. Drop the web-e2e extension
   entirely (findings 3, 7, 12, 13).
8. **Item 3 (local reranker)** only after 5, with a real-weights integration test
   (finding 6), a `local`-specific `poolMultiplier` and latency budget
   (finding 9), a reranker health signal (finding 10), and a chunk-size
   constraint keyed on the _reranker_ provider (finding 8).
9. **Item 4** retargeted or dropped; **items 6 and 7** last.

Items 3, 5 and the `config.ts` split are each a plan of their own. The author's
own "seven items is too many" conclusion is right, and the real count is higher
than seven.
