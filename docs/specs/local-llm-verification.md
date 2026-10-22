---
title: Local LLM verification and air-gap completion
status: current
last_verified: 2026-10-22
verified_against: c7e5485
answers: The multi-phase program for running fully local (embedder, reranker, generator) under COMPLIANCE_MODE=client-data. Phases 0-1 shipped; the reranker, gold-set and later phases have not.
read_when: You are working on local models, offline operation or the local reranker.
---

# Local LLM Support: Verification and Air-Gap Completion

**Date:** 2026-10-02
**Status:** Rewritten after independent adversarial review. Not yet implementable as a single plan — see "This is a program, not a plan."
**Review:** `docs/archive/reviews/2026-10-02-local-llm-verification-REVIEW.md` (16 findings)
**Extends:** `docs/archive/plans/superpowers/2026-08-03-local-generation.md`

## Retractions

This document previously made three claims that were wrong. They are retracted
here rather than deleted, because each was committed and acted upon.

**R1 — "Local generation runs in web-e2e CI." FALSE.** Commit `a499097` read
`.github/workflows/web-e2e.yml:20` as a CI step. It is a **comment block**, under
a "run the suite locally" heading. The same comment at lines 10-12 says the
generation-dependent specs are _deliberately not run_ there, and
`tests/web-e2e/package.json` ships `test:browser:ci = playwright test
--grep-invert @needs-8b-model`, which all five generation tests carry. CI does
not exercise local generation. The original spec's "not exercised" was closer to
correct, and `a499097` replaced a defensible statement with a false one.

**R2 — "The cross-model comparison is a measurement." FALSE.** The 10/10, 9/10,
5/10 figures at `web-e2e.yml:15-16` are prose in that same comment, not output
from a recorded run.

**R3 — "The reranker's 512-token limit conveniently matches the chunk cap."
FALSE, and it inverted a real risk into a reassurance.** Two independent reasons,
below in Phase 3.

## This is a program, not a plan

The earlier version listed seven items as one plan. That was wrong on count and
on sequencing. `config.ts`'s split, the local reranker, and the gold-set work are
each a plan of their own. What follows is a **dependency-ordered program**; only
Phase 0 and Phase 1 are specified tightly enough to implement. Later phases get
their own specs when reached, informed by what the earlier ones learn.

Nothing in a later phase may be started to "unblock" an earlier one.

## Verified environment facts

Measured 2026-10-02, and re-confirmed by independent review where noted. These
stand.

**Host:** Apple M5 Pro, 48 GB unified, macOS 26.6. Ollama 0.33.3 at
`127.0.0.1:11434`. `127.0.0.1:8000` is held by Docker, so vLLM's default port is
unavailable here and is not part of the Mac recipe.

**Ollama's OpenAI emulation**, probed directly:

| Behavior                       | Result                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /v1/models`               | Works; `{object:"list",data:[{id,object,created,owned_by}]}`                                           |
| `max_tokens`                   | Accepted; no `max_completion_tokens` rename needed                                                     |
| `usage`                        | Populated: `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens` |
| `response_format: json_schema` | Honored; returned conforming JSON                                                                      |
| Unknown model                  | HTTP 404, `type: "not_found_error"`                                                                    |
| `POST /v1/embeddings`          | HTTP **501** — "does not support embeddings. Start it with `--embeddings`"                             |

The 501 justifies keeping embeddings in-process ONNX rather than over HTTP
(reasoning confirmed by review).

**Models** (Ollama registry manifests): `gpt-oss:20b` = 13,793,422,144 B
(~12.8 GiB), Apache 2.0 read from the license blob. `gpt-oss:120b` exists but is
~60-65 GB in MXFP4 and does **not** fit 48 GB — excluded on memory, not
availability. `qwen3:8b` and `qwen3:30b-a3b` available.

**`gpt-oss:20b` has now been pulled and run — see "Phase 1b result" below.** It
serves correctly on Metal under Ollama 0.33.3 at 14.0 s warm for a 5,075-token
prompt. Two hazards came out of running it (a 225.6 s cold load, and a
`reasoning` field that competes with `content` for `max_tokens` and can return an
empty answer), and citation fidelity did not survive a larger context under a
hand-written prompt. It remains a **candidate, not a confirmed default** until
measured through `pnpm eval:gold` with the real `ask.ts` prompt in Phase 4.

MXFP4 is gpt-oss's distributed artifact, not a deploy-time choice: do not use
community GGUF requantizations (double-quantizing an already-4.25-bit model) and
do not "upgrade" to BF16 (~2.6× memory, no accuracy gain).

## What already exists (do not rebuild)

| Capability                                          | Location                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| Generation against any OpenAI-compatible `baseURL`  | `packages/rag/src/generation/generator.ts` → `OpenAIGenerator`           |
| In-process ONNX embeddings, no key                  | `packages/rag/src/embeddings/local.ts` → `LocalEmbeddingProvider`        |
| Compliance gate forcing local embeddings            | `packages/rag/src/embeddings/factory.ts`                                 |
| Gemini + `baseURL` refused at startup, deliberately | `GEMINI_BASE_URL_REFUSAL`                                                |
| **Answer-quality scoring**                          | `tests/e2e/src/eval/gold-eval.ts` → `scoreGoldRun`, via `pnpm eval:gold` |
| Retrieval eval                                      | `pnpm eval` / `pnpm eval:real`                                           |

`scoreGoldRun` already implements fabricated-citation detection
(`gold-eval.ts:35`), refusal correctness (`:31-34`), and truncation (`:36`), and
is unit-tested in `gold-eval.spec.ts`. **Only groundedness is genuinely absent**
(`gold-eval.ts:13-14` says faithfulness "needs a reviewer or a calibrated
judge").

`tests/web-e2e/playwright.config.ts:7-8` already settles the venue question:
web-e2e "is **not an answer-quality signal for production** … answer quality is
measured by `pnpm eval:gold`."

The architectural decision stands: self-hosted generation is reached through
`GENERATION_PROVIDER=openai` + `GENERATION_BASE_URL`. No `local` generation
provider.

---

## Phase 0 — Prerequisites (block everything else)

### 0a. Split `packages/core/src/config.ts`

It is **791 lines against a hard 800-line cap** (`scripts/check-file-sizes.mjs`,
not grandfathered). Phases 1 and 3 both edit it, so any edit lands over the cap
and the pre-commit hook blocks the commit. Split by responsibility.

This is a prerequisite, not a cleanup. Correspondingly,
`packages/rag/src/retrieval/reranker.ts` is **184 lines** and needs no split —
the earlier version named both as at-risk and was wrong in both directions.

### 0b. Offline enforcement for both ONNX providers

The compliance claim "makes no outbound calls" is **currently false**, and the
test that was supposed to prove it cannot:

- `local.ts:126-137` sets `env.cacheDir` from `HF_CACHE_DIR` but never sets
  `env.allowRemoteModels = false` or `env.localModelPath`, and
  `@huggingface/transformers` defaults `allowRemoteModels = true`. Its own error
  text at `local.ts:146` admits "first run requires internet access to download
  weights."
- `factory.ts:63-66` constructs `LocalEmbeddingProvider` with **no
  `egressPolicy` at all**, so `EgressPolicy` is never handed the huggingface.co
  URL and `EGRESS_ALLOWED_HOSTS=127.0.0.1` cannot block it.
- Consequently the old success criterion "remove the host → `EGRESS_BLOCKED`"
  goes green while a cold-cache HF download succeeds. It tests the generation
  path only.
- The false belief is already load-bearing in a passing test:
  `local.test.ts:151` asserts "makes no HTTP calls … (no egress)" while line 30
  `vi.mock`s the downloader.

Required, in order: under `COMPLIANCE_MODE=client-data` set
`allowRemoteModels = false` (and/or `localModelPath`) for **both** ONNX
providers; make a missing cache a loud boot failure rather than a silent
download; extend `scripts/warm-model.ts`, which warms the **embedder only**
(`:26-33`), so a documented pre-warm does not leave a reranker cold.

Only after this may Phase 3 widen the compliance gate.

---

## Phase 1 — Smallest real fix, plus actually running the model

### 1a. Provider-aware embedding-model default

`env.example:77` ships an active `EMBEDDING_MODEL=gemini-embedding-001` and
`config.ts:653` has no provider-aware model default, so flipping only
`EMBEDDING_PROVIDER=local` hands a Gemini model name to the ONNX loader.

Default to `Xenova/bge-base-en-v1.5` when the provider is `local` and the model
is unset. Two refinements from review:

- `loadConfig` _does_ already have provider-aware logic (the chunk cap,
  `config.ts:620-638`) — the gap is the model name specifically, not the pattern.
- `scripts/warm-model.ts:17,28` reads `EMBEDDING_MODEL` directly and hardcodes
  `dimensions: 768`, bypassing `loadConfig`. Extract a shared default helper or
  the two drift.
- The cap's warning text hardcodes `Xenova/bge-base-en-v1.5` (`config.ts:630`),
  so a user choosing a different local model with a longer window is capped to
  512 by a message naming the wrong model. Fix while adjacent.

`EMBEDDING_DIMENSIONS` already defaults to 768, matching bge-base, and
`local.ts:267-272` guards a mismatch — this change does not disturb dimensions.

Regression test first.

### 1b. Pull and run `gpt-oss:20b`

Pull it, serve it, ask one corpus question, confirm a cited answer. Record
latency for a ~200-token answer over ~4k tokens of context. If it fails on Metal,
or its output format fights the citation prompt, fall back to `qwen3:8b` and say
so. This is cheap and removes the program's largest unverified assumption.

---

## Phase 2 — Documentation truth

### 2a. `API_TOKENS` and the vendor-DPA gate, together

Both are intended behavior that reads as a bug, and both block a fully-local run:

- `config.ts:74` `tokens: z.array(z.string()).min(1)` fed from `config.ts:670`;
  an empty allow-list throws. `env.example:24` documents it as by design.
  Relaxing it would let a misconfigured deployment accept every caller. Document;
  do not change.
- `config.ts:775-783` — `COMPLIANCE_MODE=client-data` **refuses to boot** unless
  `docs/compliance/vendor-dpa-*.md` exists. Two traps: the only such file is
  `vendor-dpa-google-gemini.md`, so the "no subprocessor" deployment boots
  _solely because a Gemini DPA is on file_ and the check is vendor-agnostic; and
  the check is cwd-relative (`config.ts:552`), so an image shipping `dist/`
  without `docs/` cannot boot in client-data mode.

The DPA gate is the exact sibling of the `API_TOKENS` finding and was missed in
the earlier version. Whether a vendor-agnostic filename check is the right gate
for a no-vendor deployment is a question for the compliance owner, not something
to quietly work around.

### 2b. Rewrite `docs/LOCAL-GENERATION.md`

Replace "not exercised in this environment" with what Phase 1b actually
established. Keep the `EGRESS_BLOCKED` verification, but state plainly that it
covers generation only and not the ONNX model-download path until Phase 0b lands.

**Air-gapped only while the endpoint is genuinely local.** The moment
`GENERATION_BASE_URL` names a remote host — including a rented cloud GPU VM — the
deployment is _self-hosted_, a subprocessor exists, and the tcpdump verification
stops applying.

---

## Phase 3 — Local reranker (own spec; do not start before Phase 0)

**Model decision stands:** `Xenova/bge-reranker-base` — confirmed `onnx/` with
seven quant variants, MIT, 512-token pairs, Bert-family
`AutoModelForSequenceClassification`. Fallback
`Xenova/ms-marco-MiniLM-L-6-v2` (apache-2.0, English, smaller). Scoring is a
**single scalar logit**, not a 2-class softmax (`logits.view(-1,).float()`).

Rejected: official `bge-reranker-v2-m3` (no `onnx/`);
`onnx-community/bge-reranker-v2-m3-ONNX` (~7.75 GB, multilingual we don't need);
**`jina-reranker-v2` (cc-by-nc-4.0 — non-commercial, disqualifying)**;
`jina-reranker-v3` (no ONNX, listwise); `Qwen3-Reranker-0.6B` (generative
yes/no scorer, not a classifier); `mxbai-rerank-base-v1` (DeBERTa-v2, no
first-party transformers.js example).

**The gate fix remains correct:** `reranker.ts:146` asks `provider !== "none"`
rather than "does this provider egress", so `client-data` blocks even a
non-egressing reranker. Widen to `none | local`; keep `llm` blocked (it is only
local if `GENERATION_BASE_URL` happens to be — and it is also unimplemented,
`reranker.ts:179-182`). The `switch` is exhaustive with no `default`, so adding
the enum value without a case is a compile error, not a silent hole.

Five constraints this phase must satisfy, none of which the earlier version had:

1. **Cost.** `retriever.ts:84` `fetchK = topK × poolMultiplier` — defaults 12 × 5
   = **60 cross-encoder forward passes per query**, in-process on the API event
   loop. Nearly free for a hosted reranker with vendor batching; dominant for a
   local one. Needs a `local`-specific multiplier, a latency budget, and a
   concurrency bound. All three backends call `buildCoreDeps`, so up to three
   resident copies of the weights.
2. **Two separate 512-token problems.** A cross-encoder shares one 512-token
   budget across query _and_ document, so 512-token chunks truncate. And
   `LOCAL_PROVIDER_MAX_CHUNK_SIZE` is applied only when `EMBEDDING_PROVIDER` is
   `local` (`config.ts:622`) — so `RERANK_PROVIDER=local` with gemini embeddings
   and `COMPLIANCE_MODE=none` keeps `CHUNK_SIZE` at 800 and truncates every pair
   silently. The cap must be keyed on the _reranker_ provider too.
3. **Silent-failure signal.** The only failure signal today is a pino `warn`
   (`runtime/index.ts:223`) — no metric. A reranker that can never load degrades
   every query to RRF forever while the deployment believes reranking is on, and
   `local.ts:140-142` resets the promise so every query retries the load. The
   reranker needs the health signal; the earlier Phase-4 probe pointed at
   _generation_, which already fails loudly via `GenerationNotConfiguredError`.
4. **A mocked unit test cannot catch inverted ranking.** `local.test.ts:30`
   mocks `@huggingface/transformers` with a hand-authored tensor, so a test
   "mirroring" it verifies the author's belief about the head shape, not the
   model's. Needs one **opt-in integration test against real
   `Xenova/bge-reranker-base` weights**. Note onnxruntime-node has previously
   SIGABRT'd this repo's short-lived runners at process exit after completing
   work — gate on verified output state, not the child's exit code, and expect a
   second resident ONNX model to compound it.
5. **Interface fit is confirmed.** `interfaces.ts:101-115` imposes nothing about
   transport and explicitly sanctions throwing, so a no-network provider fits
   cleanly.

---

## Phase 4 — Answer-quality comparison (own spec)

**Do not build a new harness and do not extend web-e2e.** Both earlier versions
of this item were wrong.

Use `scoreGoldRun` unchanged. The real gap is narrow:

- `tests/e2e/src/eval/gold-set.ts:93` — `GOLD_QUESTIONS = []`. Empty, and
  `run-gold-eval.ts` refuses to run on an empty set by design.
- `run-gold-eval.ts:1-17` targets the **real firm SharePoint corpus** and warns
  its output is firm-confidential, so it can never be the committed public table.

Correct scope: populate a gold set against the **synthetic** corpus, and add a
model dimension to `run-gold-eval.ts` — which speaks plain HTTP to `/ask`, no
browser, seconds per question. Add groundedness there if wanted, since that is
the one check genuinely missing.

Why web-e2e is the wrong vehicle, recorded so it is not revisited:

- Its refusal check is a **verbatim-string match**:
  `chat-interface.tsx:111` renders `data-testid="refusal"` only when the content
  `.includes(EMPTY_ANSWER)`. It measures whether a model reproduced one mandated
  sentence word-for-word, so a model refusing correctly in its own words scores
  as a confabulation. `.includes()` anywhere is the exact shape `gold-eval.ts:49-55`
  already **fixed** (opening-line match only, regression test at
  `gold-eval.spec.ts:95`). Extending web-e2e propagates the buggy detector and
  discards the corrected one.
- `GENERATION_MODEL` is baked into process launch (`env.ts:28` →
  `playwright.config.ts` `webServer.env`), so there is no `describe.each` route —
  each model is a full suite invocation rebooting API and web. ~3-6 min/model for
  8b-class, more for a 20B MoE: **~20-40 min for a five-model matrix**, happy
  path.
- A recorded **~8% no-token stall rate (5/65)** on the local 8b stack means ~2
  spurious failures per matrix, indistinguishable from real model failures. This
  is the actual known nondeterminism source — not the fixture-wording and
  empty-citation traps noted below.
- Of five assertions, one is model-independent (`kb.spec.ts:85`), one is the
  verbatim refusal check, and one asserts the **top** chip is a specific document
  (`kb.spec.ts:40`) — an ordering assertion a model citing `[2]` first fails for
  non-quality reasons. ~2 meaningful bits per model.
- The **Gemini baseline is unreachable** there: `env.ts:31` sets
  `EGRESS_ALLOWED_HOSTS: "127.0.0.1"` and the variable _replaces_ rather than
  merges, and gemini + `baseURL` is refused by design. `eval:gold`'s runner has
  no such constraint.
- `gpt-oss:20b` cannot run on a GitHub runner at all (12.8 GiB, CPU-only,
  ~14 GB disk), so any table produced there is a one-machine artifact.

Two traps that still apply wherever this runs:

- **Refusals are sensitive to fixture phrasing.** A prior "model refuses
  prematurely" diagnosis was wrong; rewording a fixture from naming a code to
  stating its value turned 5/5 refusals into 5/5 correct answers with model and
  prompt unchanged. Hold fixtures fixed across models; rule out the fixture
  before blaming the model.
- **Citation assertions must assert a non-empty set first**, or a per-citation
  loop passes vacuously over zero citations.

Fragility note: `E2E_ENV` sets no `RETRIEVAL_MIN_DENSE_SIMILARITY`. If anyone
sets that floor, `ask.ts:419`/`:520` short-circuits to the fixed `EMPTY_ANSWER`
**without a model call**, and any refusal assertion silently becomes
model-independent — still green, now meaningless.

---

## Phase 5 — Deployment surface (last)

Inference is **not** containerized on macOS: a container gets no Metal access and
would silently fall back to CPU, producing misleading latency. Ollama runs as a
host process; compose keeps providing Postgres and the parser only.

A Linux/GPU inference profile ships only as explicitly-unverified, carrying the
caveat that MXFP4 kernels are strong on Blackwell, adequate on Hopper/AMD, and
reported broken on Ampere with no official AWQ/GPTQ gpt-oss fallback — so an
Ampere-or-older box should use a dense Qwen3-class model with AWQ-4bit or FP8.
Not verified first-hand; test on the actual card before any claim.

---

## Success criteria

Replacing the earlier set, which contained an escape hatch and an unprovable
claim.

1. `EMBEDDING_PROVIDER=local` with no `EMBEDDING_MODEL` boots and embeds, and
   `warm-model.ts` agrees with `loadConfig` on the default.
2. `gpt-oss:20b` has been run and its latency recorded — or its rejection, with a
   reason, and a named replacement.
3. `config.ts` is under 800 lines with the cap hook passing.
4. With `COMPLIANCE_MODE=client-data` and a cold model cache, startup **fails
   loudly** rather than downloading from huggingface.co.
5. A `pnpm eval:gold` run over a **synthetic** gold set produces a per-model
   table that is committable — i.e. contains no firm-confidential content.
6. `docs/LOCAL-GENERATION.md` contains no claim that was not exercised, and
   distinguishes self-hosted from air-gapped.

Criterion 3 of the earlier set ("or documents precisely why it cannot") is
removed as an escape hatch. The earlier criterion 5, a Gemini-baseline table from
web-e2e, is removed as unachievable by that vehicle.

## Phase 1b result (measured 2026-10-02) — `gpt-oss:20b` runs, with two hazards

Pulled (13 GB on disk) and run against Ollama 0.33.3 on the M5 Pro / 48 GB host.
No longer arithmetic.

| Run                              | Prompt tokens | Completion | Elapsed     | finish_reason | Cited?                 |
| -------------------------------- | ------------- | ---------- | ----------- | ------------- | ---------------------- |
| cold load, 6 chunks              | 1,561         | 168        | **225.6 s** | stop          | yes `[1]`              |
| warm, 8 chunks, `max_tokens` 250 | 5,075         | 115        | **14.0 s**  | stop          | **no**                 |
| warm, 8 chunks, `max_tokens` 64  | 5,075         | 64         | **1.4 s**   | length        | **no — empty content** |

It produces correct, grounded answers. The first run returned exactly the right
refusal-free answer with a `[1]` citation. But:

**H1 — cold load is 225.6 s versus 14.0 s warm.** Ollama unloads after
`keep_alive` (default 5 min idle), so the first request after a quiet period
takes ~3.75 minutes. Any timeout tuned to warm latency will fail the first real
query of the day and look like a hang, not a load. The deployment needs either a
`keep_alive` long enough to prevent unloading, a warm-up request on boot, or a
timeout that tolerates a cold load — and the operator documentation must say
which.

**H2 — `reasoning` is a separate response field and it competes with the answer
for `max_tokens`.** The message carries `['content', 'reasoning', 'role']`. At
`max_tokens: 64` the model spent the whole budget on 339 characters of
`reasoning`, returned **`content: ""`** and `finish_reason: "length"`. This is
structurally the same hazard `GENERATION_THINKING_BUDGET` exists to manage for
Gemini, but on the OpenAI-compatible path where the repo has no equivalent
control. `GENERATION_MAX_OUTPUT_TOKENS` defaults to 2048, which appears
sufficient — but the failure mode is an **empty answer**, not a truncated one,
and an empty answer with zero citations is exactly the shape that passes a
vacuous citation assertion and may render as a refusal. Before this model is
trusted: verify what `OpenAIGenerator` does with empty `content` plus
`finish_reason: "length"`, and whether `onTruncated` fires.

**Citation fidelity did not survive the larger context.** The 6-chunk run cited
`[1]`; both 8-chunk runs (5,075 prompt tokens) returned no `[N]` marker at all.
This used a minimal hand-written prompt, **not** the repo's real `ask.ts` prompt,
so it is not a verdict on the repo's behavior — but it is a strong signal that
citation fidelity for this model must be measured with the real prompt through
`pnpm eval:gold` (Phase 4) before `gpt-oss:20b` is adopted as the default. On
present evidence it is a viable candidate, not a confirmed choice.

Success criterion 2 is satisfied: the model has been run and its latency
recorded. Criterion 2 does not assert it is the right model.
