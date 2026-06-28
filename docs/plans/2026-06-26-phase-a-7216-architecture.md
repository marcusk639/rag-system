# Phase A — §7216 Architecture: Self-hosted Embeddings + Egress Control

> **Why this exists.** The `CPA-KB-IMPLEMENTATION-SPEC.md` Phase A gates ALL real firm-document
> ingestion. Until these tasks are complete, only synthetic/demo data may enter the pipeline.
>
> **Context.** Cross-reference: `CPA-COMPLIANCE-REQUIREMENTS.md` CR-1, CR-3, CR-4;
> `CPA-KB-IMPLEMENTATION-SPEC.md` Phase A; `cpa-consulting/docs/rag/compliance-scope.md` §2.
>
> **Owner:** Marcus Klein — complete before firm documents touch the system (Sept 2026 build window).

---

## Task A-1 — Implement `LocalEmbeddingProvider` (CRITICAL PATH)

**Status:** COMPLETE — `0ca7fbd`  
**Estimate:** 2 days (implementation + tests)  
**Satisfies:** CR-1 (no TRI egress for embeddings), CR-3 (US-located computation)

The `local` case in `packages/rag/src/embeddings/factory.ts:42` currently throws. This task
implements it using `@huggingface/transformers` (ONNX runtime) so all embedding happens
on-process with zero network egress.

### Sub-tasks

- [x] Add `@huggingface/transformers` to `packages/rag/package.json` dependencies
- [x] Create `packages/rag/src/embeddings/local.ts` — `LocalEmbeddingProvider` class
  - Lazy-init pipeline (downloads model on first call; subsequent calls hit disk cache)
  - Default model: `Xenova/bge-base-en-v1.5` (768-d; matches `chunks.embedding` column)
  - `embedBatch()` — batch feature-extraction, mean pool, L2-normalize
  - `embedQuery()` — prepend BGE query instruction prefix before embedding
  - Dimension guard: assert `output.dims[1] === this.dimensions` after first batch
  - `EmbeddingError` on shape mismatch or pipeline failure
- [x] Wire into `factory.ts` — replace the `throw` in `case "local"` with `new LocalEmbeddingProvider(...)`
- [x] Update `env.example`
  - `EMBEDDING_PROVIDER=local` (document as the firm default for compliance)
  - `EMBEDDING_MODEL=Xenova/bge-base-en-v1.5` (document as default)
  - `HF_CACHE_DIR` (optional; defaults to `~/.cache/huggingface`)
- [x] Write unit tests in `packages/rag/src/embeddings/local.test.ts`
  - Provider constructs without network (mock `@huggingface/transformers` pipeline)
  - `embed()` returns a vector with correct dimensions
  - `embedBatch()` returns one vector per input, order preserved
  - `embedQuery()` prepends the BGE instruction prefix
  - Shape mismatch → `EmbeddingError`

### Acceptance criteria (from spec)

- [x] `EMBEDDING_PROVIDER=local` produces 768-d vectors with no network egress  
      (verified by an egress-assertion test that mocks/stubs all network — no HTTP during `embedBatch`)
- [x] Existing e2e suite passes with `EMBEDDING_PROVIDER=local` substituted

### First-startup note

`bge-base-en-v1.5` is ~430 MB. Production deployment must pre-warm the cache during image
build or a startup script so the first query doesn't time out. Add a `scripts/warm-model.ts`
one-liner: `await createEmbeddingProvider(cfg.embedding).embed("warmup")` and document it in
`DEPLOYMENT.md`.

---

## Task A-2 — Egress allow-list module

**Status:** COMPLETE — `8214f9d`  
**Estimate:** 1 day  
**Satisfies:** CR-1 (partial, generation side), CR-3

A small module that validates every outbound HTTPS host against a configurable allow-list
before a generation provider call is made. Fail-closed: if the host is not on the list, throw
rather than allowing the call.

### Sub-tasks

- [x] Create `packages/core/src/egress-policy.ts`
  - `EgressPolicy` class: constructed from `EGRESS_ALLOWED_HOSTS` env (comma-sep, e.g.
    `generativelanguage.googleapis.com,api.openai.com`)
  - `assertAllowed(url: string): void` — parses hostname, throws `EgressError` if not in set
  - `EGRESS_ALLOWED_HOSTS` may be empty string → no external calls permitted (local-only mode)
- [x] Add `EgressError` to `packages/core/src/errors.ts`
- [x] Add `EGRESS_ALLOWED_HOSTS` to config + `env.example`
- [x] Wire `assertAllowed()` into the generation layer — call before each LLM request in
      `packages/rag/src/generation/generator.ts`
- [x] Tests: allowed host passes; unlisted host throws; empty allow-list blocks everything

---

## Task A-3 — TRI-pattern pre-flight scanner

**Status:** COMPLETE — `8214f9d`  
**Estimate:** 1.5 days  
**Satisfies:** CR-1 (TRI gate before external generation call)

Before any text is sent to an external generation API, scan it for taxpayer return information
(TRI) patterns. If TRI is detected AND the generation provider is external (not self-hosted),
block the call and log a compliance event.

### Sub-tasks

- [x] Create `packages/core/src/tri-scanner.ts`
  - `scanForTRI(text: string): TRIScanResult` — returns `{ detected: boolean, patterns: string[] }`
  - Patterns to detect (with tests for each):
    - US SSN: `\b\d{3}-\d{2}-\d{4}\b`
    - US EIN: `\b\d{2}-\d{7}\b`
    - "taxpayer" + amount pattern: `taxpayer.{0,30}\$[\d,]+` (loose; tune with examples)
    - Named tax-form references with amounts: `(Form 1040|1065|1041|1120).{0,50}\$[\d,]+`
  - `TRIScanResult` returned — caller decides action (don't swallow in scanner)
- [x] Integrate into generation `generator.ts` — when provider is external and `scanForTRI` hits,
      throw `ComplianceError("TRI detected in generation input; use self-hosted generation or obtain §7216 consent")`
- [x] Add `ComplianceError` to `packages/core/src/errors.ts`
- [x] Unit tests:
  - SSN in text → detected
  - EIN in text → detected
  - Tax form + amount → detected
  - Clean firm SOP text → not detected
  - Detection blocks external generation call (integration test with mocked provider)

---

## Task A-4 — Docs + env updates

**Status:** COMPLETE  
**Estimate:** 0.5 days

- [x] Update `ARCHITECTURE.md`: replaced "Gemini as default" section with full provider matrix
      including local ONNX implementation details (model, cache path, first-startup behavior)
- [x] Update `CPA-KB-IMPLEMENTATION-SPEC.md` Phase A acceptance checkboxes — recorded below
- [x] Update `DEPLOYMENT.md`: added "Local embedding provider setup" section documenting
      `HF_CACHE_DIR`, the warm-model script, disk/memory estimates, and compliance checklist
- [x] Update `env.example`: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `HF_CACHE_DIR`,
      `EGRESS_ALLOWED_HOSTS`, `COMPLIANCE_MODE` with full `# COMPLIANCE MODE` comment block

---

## Task A-5 — Phase A acceptance gate

**Status:** COMPLETE (technical gate green; DPA awaits counsel sign-off)  
**Estimate:** 0.5 days (run + record)

Execute the full acceptance criteria from `CPA-KB-IMPLEMENTATION-SPEC.md` Phase A:

- [x] `EMBEDDING_PROVIDER=local` produces 768-d vectors — 15 unit tests in `local.test.ts` pass; no HTTP during embed (pipeline mocked)
- [x] External generation call to a non-allow-listed host is blocked — 13 tests in `egress-policy.test.ts` pass
- [x] TRI-pattern scanner blocks a document containing a synthetic SSN from reaching external generation — 13 tests in `tri-scanner.test.ts` pass
- [x] `COMPLIANCE_MODE=client-data` added to config; service refuses to boot without `docs/compliance/vendor-dpa-*.md` — 4 tests in `config.test.ts` pass
- [x] `docs/compliance/` directory created with `README.md` (template + activation instructions)
- [x] Run full test suite — 121 unit + 35 e2e = 156 tests, 0 failures (2026-06-27)
- [x] Record outcome below

---

## Sequencing

```
A-1 (local embedder) ──► A-2 (egress policy) ──► A-4 (docs)
                      └──► A-3 (TRI scanner) ──► A-5 (gate)
```

A-1 is the sole blocker — it unblocks A-2 and A-3 in parallel. A-4 and A-5 run last.

---

## What Phase A does NOT do

- Does not implement Class A/B classification tags at ingest (that is Phase 1, task §4.2-1
  in `kb-design.md`) — Phase A is the §7216 plumbing; classification is the firm-SOP layer on top.
- Does not implement the audit log, citation renderer, de-identification pre-pass, or weekly digest.
  Those follow in the Sept build window after Phase A is green.
- Does not implement Teams/SMS channel adapters — Phase 1b, after the Doug soft-launch.

---

## Phase A completion record

| Check                                        | Result | Date       | Notes |
| -------------------------------------------- | ------ | ---------- | ----- |
| Local embedder: 768-d vectors, no HTTP       | PASS   | 2026-06-27 | 15 unit tests; `local.test.ts`; ONNX pipeline mocked, no real network |
| Egress block: non-allow-listed host rejected | PASS   | 2026-06-27 | 13 unit tests; `egress-policy.test.ts` |
| TRI scanner: synthetic SSN blocked           | PASS   | 2026-06-27 | 13 unit tests; `tri-scanner.test.ts`; SSN, EIN, form+amount patterns |
| DPA on file + startup validation             | PARTIAL | 2026-06-27 | `COMPLIANCE_MODE=client-data` gate implemented + tested (4 unit tests). DPA file is a placeholder (`docs/compliance/README.md`). Actual signed DPA + **[COUNSEL]** sign-off pending Sept build window. |
| Full test suite: no regressions              | PASS   | 2026-06-27 | 121 unit + 35 e2e = 156 total, 0 failures |

**Phase A technical gate: GREEN.** Firm documents may not enter the pipeline until the Sept build window when:
1. A real signed DPA is filed as `docs/compliance/vendor-dpa-<vendor>.md`
2. `COMPLIANCE_MODE=client-data` is set in the production `.env`
3. **[COUNSEL]** confirms §7216 + GLBA adequacy
