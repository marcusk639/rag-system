---
title: Chunk-size sweep
status: current
last_verified: 2026-10-22
verified_against: c7e5485
answers: An offline harness design for choosing the local-embedder chunk size by measured answer quality. Its plan is written; nothing is built yet.
read_when: You are about to change chunk size or overlap, or to build the sweep harness.
---

# Chunk-size sweep — design

**Date:** 2026-10-13 (redesigned 2026-10-16 around answer quality) · **Author:** Marcus Klein (with Claude) · **Status:** Plan written 2026-10-16 ([plan](plans/2026-10-16-chunk-size-sweep.md)); not yet implemented

## Summary

An offline harness that chooses the chunk size giving the **best answer
quality**. It snapshots production document markdown (read-only, after firm
sign-off), generates **synthetic** questions with a **local** model, re-ingests
the snapshot at each candidate `{chunkSize × overlap}` through the real
ingestion and `/ask` retrieval path, and measures **context sufficiency**:
whether the context the generator actually receives contains the answering
passage. The current reference configuration is kept unless another is
**clearly better** and passes a generation check. One command:
`pnpm eval:chunk-sweep`.

## Contents

1. [Problem](#problem)
2. [Goals and non-goals](#goals-and-non-goals)
3. [Decisions](#decisions)
4. [Precondition: firm sign-off](#precondition-firm-sign-off)
5. [Dependencies](#dependencies)
6. [Architecture](#architecture)
7. [Stage: export](#stage-export)
8. [Stage: generate](#stage-generate)
9. [Stage: sweep](#stage-sweep)
10. [Stage: report and decision rule](#stage-report-and-decision-rule)
11. [Safety rails](#safety-rails)
12. [Data handling](#data-handling)
13. [Testing](#testing)
14. [Build sequence](#build-sequence)
15. [Acceptance criteria](#acceptance-criteria)
16. [Risks and limitations](#risks-and-limitations)
17. [Later](#later)
18. [Alternatives rejected](#alternatives-rejected)

## Problem

Chunk size is currently a guess (`CHUNK_SIZE`, default 800; capped for the local
embedder). The existing harnesses cannot choose it:

- `run-eval.ts` scores recall/nDCG against **document** ids. Chunk size mostly
  moves _which passage_ reaches the generator, which that metric cannot see.
- The only populated corpus is synthetic. `gold-set.ts` is empty by design, and
  its header documents that the synthetic set detects only catastrophic
  regressions (MRR ceiling 1.000).
- Answer quality depends on what the generator reads — the top results after
  the per-document cap and neighbor expansion — not on any single chunk's rank.

## Goals and non-goals

**Goals**

- Choose the chunk size and overlap for the local embedder that maximizes
  answer quality, keeping the current configuration unless another is clearly
  better.
- Measure what the generator actually receives, for both short lookups and
  questions that need several sentences.
- Run end to end from one command, resumable, without manual labeling.

**Non-goals**

- **Not a gold set.** Synthetic questions never enter `GOLD_QUESTIONS` and never
  carry an `expectedAnswer`. They measure _relative_ differences between
  configurations; their absolute scores are not quality claims. This respects
  the `gold-set.ts` constraint against presenting invented questions as
  evidence, and epistemic constraint C2 (no AI-made CPA determinations).
- Not a refusal/coverage eval (`run-local-generation-eval.ts` keeps that job).
- Not tuning RRF weights, reranking or embedding models.
- Not spreadsheets, CSV or markdown tables (see [Stage: export](#stage-export)).
- No production code changes beyond those in [Dependencies](#dependencies).
- Cost (chunk count, storage, embedding time, prompt tokens) is reported, not
  optimized.

## Decisions

| #   | Decision                                                                                                                                        | Reason                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| D1  | Question generation uses a **local model only** (OpenAI-compatible endpoint on loopback, e.g. Ollama).                                          | Production document text is client data; no new egress.                                                           |
| D2  | Snapshot and question set live in a **gitignored local directory** under the data-handling rules.                                               | Client-derived text on disk must never be committed or synced.                                                    |
| D3  | Questions are generated from **document passages, never from chunks**.                                                                          | Generating from chunks biases toward the chunk size that produced them.                                           |
| D4  | The sweep measures the **real** ingestion and `/ask` retrieval path.                                                                            | An in-memory replica would tune a different system.                                                               |
| D5  | **The whole process is loopback-only** — parser sidecar, generation, embedding, reranker and content scan; the audit sink is never constructed. | Client text must not leave the machine through any provider.                                                      |
| D6  | **Objective: best answer quality.** The reference is kept unless another configuration is clearly better; a tie keeps the reference.            | Changing chunk size forces a full re-chunk and re-embed; only a real improvement justifies it.                    |
| D7  | **Primary metric: context sufficiency** on the combined generator context, over a short and a long question group.                              | The generator reads all its context together; long questions expose fragmentation that one-sentence lookups hide. |
| D8  | **One-sided superiority tests** against the reference with a minimum effect, a document-level paired bootstrap and Holm correction.             | Guards against picking noise (winner's curse) while matching D6.                                                  |
| D9  | **A generation check gates adoption:** the winner must not be worse than the reference on cited-span rate.                                      | Catches a configuration that retrieves well but yields worse answers.                                             |
| D10 | **The eval DB is positively identified, never inferred** — dedicated URL, loopback, marker row, matching `system_identifier`.                   | The e2e URL falls back to the developer's dev DB; loopback checks miss tunnels and socket URLs.                   |
| D11 | **No export without the firm's written sign-off.**                                                                                              | Copying production text to a developer machine is a new use of client data.                                       |

## Precondition: firm sign-off

Before the export stage runs against production, the firm must approve in
writing copying production document text (class A/B only) to a developer
machine for system evaluation, including a determination of whether IRC §7216
applies to any of that text. The export refuses to run unless
`.eval-data/SIGNOFF` exists and names the approver and date; that file is a
record, not an authorization mechanism. Everything in
[Build sequence](#build-sequence) steps 1–2 runs on fixture data and does not
need the sign-off.

## Dependencies

- **Review finding #1 (local chunk budget) — needed before the real sweep runs,
  not before building.** Until every stored local chunk fits bge's 512-token
  limit, a local "chunk size" setting does not control the real chunk size. The
  sweep passes #1's budget option (`maxChunkTokens`) through and asserts zero
  over-limit chunks per configuration.
- **`runOneIngestion`** (`tests/e2e/src/helpers/ingestion.ts:30`) accepts
  `chunkSize`, `chunkOverlap`, a real `embedder` and one `sourceDocClass` per
  call; it needs the #1 budget option passed through. It takes a `db` handle;
  the sweep passes its own (see [Safety rails](#safety-rails)).
- **`markdownDoc`** (`packages/test-fixtures/src/factories.ts:7`) already exists
  (`text/markdown`).
- **Exact bge token counts.** `LocalEmbeddingProvider` gains a public
  `countTokens(texts)` using the loaded pipeline's tokenizer (`pipe.tokenizer`,
  as `warnOnOverlongText` does, `packages/rag/src/embeddings/local.ts:~259`),
  counting exactly what the model receives: special tokens included, document
  side without the query prefix. Production-code change 1 of 2.
- **A DB-free redaction decision.** `runRedactionGate` needs a `db` and writes
  events (`packages/ingestion/src/ingest-gates.ts:248-251`). Its
  scan-and-quarantine decision is extracted into a pure function that the gate
  calls and the export pre-screen reuses. Behaviour-preserving, covered by the
  existing gate tests. Production-code change 2 of 2.
- **The `/ask` retrieval step without generation.** Context sufficiency needs
  the exact context `askQuestion` would pass to the generator (retrieval,
  duplicate collapse, per-document cap, neighbor expansion). The plan either
  reuses an existing exported step from `packages/services/src/ask.ts` or
  exports the retrieval half as a function with no behaviour change; if that
  is a production-code change it is listed in the plan.
- **Local model:** an OpenAI-compatible endpoint (Ollama). `@rag/e2e` adds the
  `openai` client (already in `@rag/rag`). Two setup requirements:
  - **Context window set explicitly.** Ollama's default context window is small
    (2–4k tokens depending on version; unverified for the installed one), the
    OpenAI-compatible endpoint cannot set it per request, and Ollama drops
    overflow silently. Setup sets it via `OLLAMA_CONTEXT_LENGTH` or a Modelfile
    and records the value; the harness reads it back and refuses to start if
    it is lower than the largest prompt the generation check will send.
  - **Structured output.** Whether the OpenAI-compatible endpoint enforces a
    JSON schema depends on the Ollama version (unverified). The walking
    skeleton checks it; if unsupported, the client uses Ollama's native
    `format` parameter instead. Either way the reply is validated with zod.
- **Local stack:** Docker Postgres and the parser sidecar (`pnpm docker:up`).

## Architecture

Four stages under `tests/e2e/src/eval/chunk-sweep/`, each a separate `tsx` entry
point that caches its output keyed by a hash of its inputs and skips when that
hash is unchanged. `pnpm eval:chunk-sweep` runs all four in order.

```
export   prod DB (read-only role) ──► <data>/snapshot/           sampled active docs
generate snapshot ──► loopback model ──► <data>/questions.json   synthetic questions
sweep    snapshot + questions ──► eval DB, per config ──► <data>/runs/<config>.json
report   runs ──► <data>/sweep-report.md                          numbers only
```

`<data>` is `tests/e2e/.eval-data/` (gitignored, mode `0700`, files `0600`; see
[Data handling](#data-handling)).

**Cache keys** include, besides each stage's data inputs: a hash of the
ingestion, chunking and retrieval source files; the model **digest** (not tag);
and the hardware and runtime versions, since Ollama's seed reproduces only on
the same hardware and version. Runs cached before #1 merges are therefore never
reused after it.

## Stage: export

- Refuses to run without `.eval-data/SIGNOFF` (D11).
- Connects only through `PROD_READONLY_DATABASE_URL`; never reads
  `DATABASE_URL`. The URL should name a SELECT-only role; the session also sets
  `default_transaction_read_only = on` as defense in depth.
- Records production's `system_identifier` in the manifest when the role can
  read it (unverified on Railway's image).
- Selects `documents` rows with `lifecycle_status = 'active'` joined to
  `sources`, with `sources.data_class` mapped by `mapDataClassToDocumentClass`
  (`packages/ingestion/src/classify-source.ts:24`), as the worker does
  (`apps/worker/src/handlers/sync-source.ts:133`).
- **Filters** (each counted in the manifest):
  - document class A and B only (C/D are blocked by `ClassBlockedError`,
    `packages/ingestion/src/pipeline.ts:471-480`);
  - spreadsheets and CSV excluded (production chunks them from structured rows
    that stored markdown cannot rebuild);
  - documents the current scanner pack (`packs/cpa`) would quarantine, via the
    shared pure redaction decision.
- **Sampling:** default 300 documents (`--docs N`; more if the corpus allows),
  stratified by source and `mime_type` family with a minimum of 5 per non-empty
  stratum, fixed seed. Results describe this sample, not production's mix; the
  report states the strata.
- Writes one JSON file per document plus `manifest.json`.

## Stage: generate

**Passage selection** — two groups of equal size:

| Group | Passage                                                    | Purpose                                                           |
| ----- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Short | 1–2 sentences, 15–60 words                                 | Lookups                                                           |
| Long  | 3+ consecutive sentences, 61–150 words, within one section | Questions that need several sentences — where fragmentation hurts |

- Skip tables of contents, bare headings, link lists and markdown tables.
- Up to 2 passages per group per document, from different thirds of the
  document.
- **Duplicate and near-duplicate filter:** drop a passage if its 5-word shingle
  Jaccard with any window of another document is ≥ 0.9 (templates, "Policy
  v2.0" vs "v2.1"): a sibling document could answer it equally well.

**Question writing** (loopback model, temperature 0.2, fixed seed, model digest
recorded)

- **Prompt input:** the passage and the paragraph before and after it — **no
  heading path and no document title.** Every chunk opens with its heading line,
  so a question that reuses heading words would match every chunk of that
  section under keyword search, and smaller sizes produce more such chunks; that
  would bias the comparison. The report also splits Q(c) by whether the
  question shares any word with the passage's heading path.
- **Structured output:** the model is called with a JSON schema (see
  [Dependencies](#dependencies)) and the reply is validated with zod; an
  invalid reply gets one retry, then the passage is dropped and counted.
- **Untrusted input:** the passage and context are wrapped in delimiters, and
  the prompt states that text inside them is document data, never instructions.
  An injected instruction can at worst produce a bad question, which the
  filters drop; questions are never executed.
- **Style mix:** each passage is assigned, by seed, one of three styles so the
  set resembles how staff search: a natural question, a terse keyword query, or
  a task request ("how do I…").
- **Long group:** the prompt requires a question whose answer needs most of the
  passage, not one sentence of it.
- Filters, each counted by reason:
  1. **Lexical copy:** for the question and task styles, content-word overlap
     above 0.5 → one paraphrase retry; drop if still above. The **keyword**
     style is almost all content words by nature, so this rule would remove
     most of it; instead a keyword query must contain at least one content word
     that is not in the passage (a synonym or paraphrase), with one retry. Copy
     rates are reported per style.
  2. **Answerability:** a second call — by default the same model, or a
     different local model via `--judge-model` — sees only the passage and the
     question and returns whether the passage answers it; for the long group,
     also whether the answer needs more than one sentence. Drop on "no". The
     judge only keeps or drops; it never decides what is scored.
  3. **Near-duplicate questions:** token-set Jaccard ≥ 0.8 with a kept question →
     drop.

**Record schema**

```ts
interface SyntheticQuestion {
  id: string; // "syn-<hash>", stable across reruns
  question: string;
  style: "question" | "keyword" | "task";
  group: "short" | "long";
  docExternalId: string;
  spanText: string; // verbatim passage = the answer span
  spanWords: number;
  spanSentences: string[]; // the passage split into sentences, for long-group scoring
  headingPath: string[]; // recorded for the heading-overlap split, never shown to the model
  position: "begin" | "middle" | "end";
  overlapScore: number;
  generator: { modelDigest: string; promptVersion: number; seed: number };
}
```

- Target: at least 400 kept questions, split evenly between groups.
- `--sample 10` prints 10 random kept questions with their passages to the
  terminal for the human spot check — the only place passage text is shown.

## Stage: sweep

**Grid:** local provider, `chunkSize ∈ {192, 256, 320, 390}` ×
`overlap ∈ {0%, 15%}` = 8 configurations. **Reference: 390 / 15%** — current
behaviour after #1 and the largest size the local budget allows.
Pre-registered; changing it requires a spec change.

**A/A run:** the reference is ingested a second time into a fresh eval DB. Its
difference from the first reference run measures the eval's own noise,
including any nondeterminism in the HNSW index build. If the A/A context
sufficiency differs by more than 1 point, the sweep stops: noise would swamp
real differences, and the report says so.

**Retrieval settings** are explicit flags with defaults equal to the code
defaults (`HYBRID_DENSE_WEIGHT` 0.7, `HYBRID_SPARSE_WEIGHT` 0.3, `defaultTopK`
12, per-document cap and neighbor expansion as in config, reranker none); the
report records them.

Per configuration:

1. Run the [pre-flight checks](#safety-rails); then truncate the eval DB (never
   the marker table).
2. Ingest each source's documents with one `runOneIngestion` call per source,
   using `markdownDoc` with `.md` **appended** to the stored title, so the
   parser — which routes by filename extension before MIME type
   (`services/parser-py/app/main.py:161,181-191`; the pipeline passes `title` as
   the filename, `packages/ingestion/src/pipeline.ts:518-521`) — takes the
   markdown path. Re-parsed titles are the first H1 or the filename stem, so
   they never carry `.md`.
3. Assert, or fail the configuration loudly:
   - zero parse failures and zero quarantined documents;
   - every document parsed by MarkItDown and its re-parsed, re-redacted
     markdown equal to the snapshot after whitespace normalization (assumes
     near-verbatim conversion and idempotent re-redaction, both unverified —
     the walking skeleton checks them first);
   - every passage found in its document's re-ingested markdown (unreachable
     passages dropped identically for every configuration, and counted);
   - the same document and question set as every other configuration;
   - zero chunks over bge's limit counted on exactly the model input
     (`countTokens`).
4. For each question, run the `/ask` retrieval step (no generation) with the
   same embedder instance that ingested the corpus, and record the context the
   generator would receive.
5. Write `runs/<config>.json`; a crash resumes at the next unfinished
   configuration.

**Normalization** for all matching: lowercase, **delete** markdown markup
characters (`*`, `_`, `` ` ``, `#`, `>`, `|`, link brackets) rather than matching
pairs, collapse whitespace.

**Primary metric — context sufficiency (per question, 0 or 1):**

- Short group: the normalized passage appears in full within the normalized
  combined context.
- Long group: the combined context covers at least 80% of **all** the passage's
  sentences (`spanSentences`), each counted as covered when it appears in full.
  Scoring is deterministic and never depends on the judge model's choices.

Q(c) is the mean over all questions; it is also reported per group, per style
and per position.

**Diagnostics** (reported, never decide):

| Metric                                                                                                                                      | What it separates                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containment ceiling — share of passages wholly inside some stored chunk (long group: share of its sentences in one chunk), retrieved or not | Boundary damage from ranking effects; also flags matching bugs (a passage in no chunk and not split across neighbours means normalization is wrong) |
| Span recall@5 per chunk, document recall@5                                                                                                  | Ranking quality, comparable to `run-eval.ts`                                                                                                        |
| Chunk count; mean and p95 chunk tokens; max true bge tokens                                                                                 | Storage and embedding cost                                                                                                                          |
| Context tokens per question (combined generator context)                                                                                    | Prompt cost                                                                                                                                         |

## Stage: report and decision rule

- **Minimum effect δ = 1 point** of context sufficiency: smaller improvements do
  not justify a full re-chunk. Pre-registered; confirm or change before the full
  run, never after seeing results.
- **Bootstrap:** resample **documents** with replacement (a document's questions
  move together), **B = 10,000**, fixed seed, the **same indices for every
  configuration**. Δ\*\_c,b = Q_b(c) − Q_b(reference).
- **Superiority test per configuration** (H0: Δ_c ≤ δ), by inverting the
  uncentered percentile distribution (acceptable for a mean over ~300 clusters;
  the plan may switch to the basic bootstrap if a fixture shows skew):
  p_c = (1 + #{b : Δ\*\_c,b ≤ δ}) / (B + 1).
- **Holm over the 7 non-reference configurations** (family-wise α = 0.05):
  sort ascending; reject while p\_(i) ≤ α / (7 − i + 1).
- **Winner:** among configurations whose H0 is rejected, the one with the highest
  point estimate Q(c); if none, the reference.
- **Minimum detectable effect, reported first:** after the reference, the A/A
  run and 320 / 15% are scored, the report projects the Holm-level half-width of
  the paired difference at full sample size. "Keep the reference" is always
  reported together with this number, so "no clear improvement" is never read as
  "no improvement".

**Generation check** (D9) — only when the winner is not the reference:

- 250 questions drawn by a seed fixed before the sweep runs, stratified by group
  and style.
- Both the winner and the reference run through the **unchanged**
  `askQuestion` with the loopback generation model **pinned by digest**, at the
  temperature production uses for answers (0.2, set inside the generator,
  `packages/rag/src/generation/generator.ts:339,473,499`). The harness does not
  override it: measuring greedy decoding would measure a behaviour users never
  get, and overriding it would need a production-code change. The generator's
  existing `maxOutputTokens` option is set large enough that answers are not cut
  off (the plan sets it from the reference run's longest answer plus margin).
  Answers that stop at the token limit are counted and reported per arm.
- **Generation A/A run:** the reference arm is answered twice. The difference in
  cited-span rate between the two runs measures sampling noise at temperature
  0.2 (plus any nondeterminism in Ollama's batching). If it exceeds **2
  points**, the check is reported **"uninformative"** and does not gate, as with
  the floor below. Per-question sampling variation is otherwise absorbed by the
  paired bootstrap, since both arms answer the same questions.
- **No silent truncation:** every prompt's token count is checked against the
  configured context window before it is sent; one over the limit fails the
  check rather than letting Ollama drop its start. Larger chunks produce longer
  prompts, so truncation would penalize exactly the configurations being
  compared.
- **Informativeness floor:** this check uses a local model, not production's
  generator (Gemini by default, `env.example:435-436`), because of D5. A small
  model may fail citation formatting for reasons unrelated to chunking. If the
  reference's cited-span rate is below **50%**, the check is reported
  **"uninformative"** and does not gate; the decision then rests on context
  sufficiency alone and the report flags it for human review.
- **Gated:** cited-span rate — the answer cites a document whose context chunks
  contain the passage (long group: cover 80% of its sentences). The winner is
  adopted only if H0: rate(reference) − rate(winner) ≥ 5 points is rejected
  (one-sided, α = 0.05, same document-level bootstrap). Otherwise the reference
  is kept and the report says which check failed.
- **Reported:** answered rate (`isRefusal` from `@rag/services`),
  `citationWarnings` rate, context and prompt tokens, answers cut off at
  `max_tokens`.

**Final result** — exactly one: **"keep the reference"** (no configuration
clearly better, or the generation check failed) or **"adopt <config>"** (the
generation check passed, or was uninformative — then marked for human review).
Adopting means a separate, reviewed change to production chunking.

The report holds aggregate numbers, filter and exclusion counts, sample sizes,
bounds, the minimum detectable effect and retrieval settings — never question or
passage text.

## Safety rails

| Rail                        | Enforcement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never write to production   | Export uses only `PROD_READONLY_DATABASE_URL` (SELECT-only role recommended) plus a read-only session; the sweep never reads that variable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Never truncate the wrong DB | Requires **all** of: (1) the URL from `CHUNK_SWEEP_DATABASE_URL` only — no fallback to `E2E_DATABASE_URL`, `DATABASE_URL` or the default dev URL (`tests/e2e/src/env.ts:42-44`); (2) a loopback host, rejecting socket URLs whose `?host=` names a remote host (the existing check `tests/e2e/src/helpers/db.ts:46` treats them as local); (3) a `chunk_sweep_marker` row; (4) the DB's `system_identifier` equal to the one stored in that row at init, re-checked before every truncate, and different from production's when known. `--init-eval-db` runs migrations and creates the marker only on an **empty** database (zero rows in `sources`, `documents`, `chunks`, `ingestion_jobs`; no marker); it fails if `system_identifier` is unreadable. Refuses if `E2E_ALLOW_REMOTE_TRUNCATE` is set. |
| No shared e2e DB helpers    | The sweep never imports `openTestDb`, `truncateAll`, `makeTestConfig` or `env.databaseUrl` (`tests/e2e/src/helpers/db.ts:8,63-64`, `tests/e2e/src/env.ts:64`), which resolve the shared e2e URL and would guard one database while acting on another. It uses its own DB module that takes the URL explicitly; an import-graph test enforces this.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| No egress (D5)              | Pre-flight resolves the parser URL (`tests/e2e/src/env.ts:45-47`), generation and judge base URLs, embedding provider, reranker and content-scan endpoints, and refuses anything that is not loopback or the in-process `local` embedder. The harness builds its own deps and never constructs the audit sink (`packages/runtime/src/index.ts:191-234`).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| No client text in git       | `.eval-data/` in `.gitignore`; `scripts/check-secrets.mjs` rejects staged paths under it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| No client text in reports   | Report builder tested with a sentinel string planted in fixture passages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Data handling

Client text exists outside the running process in three places: the
`.eval-data/` directory, the eval database's Docker volume, and anything that
copies either.

- **Disk encryption required.** Export refuses to run unless the OS reports
  full-disk encryption (FileVault on macOS; the plan names the check per OS).
- **Not synced or backed up.** Export refuses if `.eval-data/` resolves inside a
  known sync root (iCloud Drive, Dropbox, OneDrive, Google Drive). The setup
  step excludes `.eval-data/` and the eval DB volume from Time Machine
  (`tmutil addexclusion`); the export checks the exclusion is present.
- **Purge removes everything:** `--purge` deletes `.eval-data/`, truncates the
  eval DB (marker-checked) **and** removes its Docker volume.
- **Retention:** the manifest records the export date; the report warns when the
  snapshot is older than 30 days and recommends purging or re-exporting.

## Testing

Test-first, colocated vitest in `@rag/e2e`, no Docker needed:

- **Passage selection:** both groups' bounds, skip rules, thirds, shingle
  near-duplicate filter.
- **Question generation:** schema validation and the single retry; style
  assignment by seed; the prompt never containing the heading path or title;
  the lexical-copy rule for question and task styles and the new-word rule for
  the keyword style; answerability as keep/drop only (including the long-group
  "more than one sentence" check); near-duplicate filter; all with a mocked
  model.
- **Matching:** markup deletion including a `**` pair straddling the passage
  boundary; short-group full containment; long-group 80% coverage of all
  passage sentences; containment ceiling.
- **Decision rule:** fixtures for no configuration clearly better; one clearly
  better; several, picking the highest estimate; an improvement below δ; Holm
  changing a borderline verdict; documents with several questions moving
  together; the A/A stop; the minimum-detectable-effect projection.
- **Generation check:** passing, failing and inconclusive fixtures; the
  "uninformative" branches below the 50% floor and above the 2-point generation
  A/A difference; a prompt over the context window failing the check; answers
  cut off at the token limit counted per arm; the harness never passing a
  temperature.
- **Cache keys:** change with code hash, model digest, prompt version, seed,
  hardware/runtime and snapshot.
- **Rails and data handling:** every pre-flight refusal (missing URL, missing
  marker, socket URL with a remote host, override env set, changed
  `system_identifier`, non-loopback endpoints, missing sign-off, no disk
  encryption, sync-root location); `--init-eval-db` refusing a non-empty DB; the
  import-graph test; the sentinel string absent from the report.
- **Model client:** behind an interface and mocked; one opt-in smoke test
  against a real endpoint only when `OLLAMA_URL` is set, which also checks the
  configured context window and structured-output support.
- **`countTokens`:** unit test in `@rag/rag`, including special tokens.

Integration (`pnpm e2e`, Docker, already in CI): the walking skeleton becomes
the integration test — report produced, rails hold, rerun hits every cache,
zero parse failures and over-limit chunks.

## Build sequence

1. **Walking skeleton (fixture data):** `--init-eval-db`, 10 fixture documents, a
   fake question generator, the reference plus one configuration, all four
   stages end to end, rails included. Verifies the open assumptions: `.md`
   reaches MarkItDown in the parser container, the markdown round trip and
   re-redaction are exact, `system_identifier` is readable locally.
2. **In parallel, independent of #1 and of sign-off (fixture data):** passage
   selection and question generation against a local model; matching and
   metrics; bootstrap, decision rule, generation check and report; data-handling
   checks.
3. **After sign-off:** export against production; generate the real question
   set; human spot check.
4. **After #1 merges:** wire the budget option and `countTokens`; run the
   reference, A/A and 320 / 15%; then the remaining configurations; then the
   generation check if a winner emerges.

## Acceptance criteria

1. Written firm sign-off recorded before any export (D11).
2. `pnpm eval:chunk-sweep` runs end to end on the developer machine against a
   real snapshot with all pre-flight and data-handling checks passing.
3. At least 400 questions kept, split evenly between groups; filter and
   exclusion counts reported by reason.
4. A/A difference within 1 point; zero parse failures, quarantined documents and
   over-limit chunks; every document parsed by MarkItDown with a matching round
   trip.
5. The report opens with sample sizes and the minimum detectable effect, gives
   every configuration's Q with its interval and the diagnostics, and ends in
   exactly one of "keep the reference" or "adopt <config>".
6. A truncate is impossible without the marker and a matching
   `system_identifier` (tested), and the sweep reads no database URL except
   `CHUNK_SWEEP_DATABASE_URL`.
7. A human spot check of 10 questions (`--sample 10`) judges them plausible staff
   questions, in all three styles.
8. Unit tests, integration test, typecheck, lint and format pass; nothing under
   `.eval-data/` is staged.

## Risks and limitations

- **Synthetic questions are easier than real ones.** They share vocabulary with
  their passages, which favors sparse retrieval. Mitigated by the lexical-copy
  filter, the style mix and reading only relative differences; a real gold set
  remains the stronger signal.
- **Local-model quality,** including the answerability judge. Mitigated by the
  optional separate judge model and the human spot check.
- **Context sufficiency is a proxy.** It measures whether the answer is in front
  of the generator, not whether the generator uses it well; the generation
  check covers the gap only for the winner.
- **The generation check uses a different model than production.** D5 forces a
  local model while production generates with Gemini by default; a small model
  with a short context window and weaker instruction-following may favor
  smaller contexts. The check is relative (same model on both arms), and the 50%
  floor marks it uninformative when the model cannot cite reliably. It runs at
  production's answer temperature (0.2), so it is noisier than greedy decoding;
  the generation A/A run measures that noise.
- **Resolution.** Improvements smaller than the reported minimum detectable
  effect cannot be seen; "keep the reference" is always reported with it.
- **Coverage gaps.** Spreadsheets, CSV, markdown tables and class C/D documents
  are excluded; the result applies to prose documents of class A/B.
- **Runtime.** Nine local ingests (eight configurations plus the A/A run) of
  ~300 documents on CPU, plus question generation and the generation check
  (750 local answers: 250 for the winner, 250 twice for the reference); many
  hours. Mitigated by per-configuration caching and resume.
- **Snapshot drift.** Re-export when the corpus mix changes materially.

## Later

- Gemini grid `{400, 600, 800, 1200}` behind `--provider gemini`, refused
  outright when production runs `COMPLIANCE_MODE=client-data`.
- A spreadsheet/table track that ingests original files rather than stored
  markdown.
- Re-running the sweep against a real gold set once one exists.

## Alternatives rejected

- **"Smallest size no worse than the reference":** assumed smaller is better
  without stating why; replaced by D6.
- **Short lookup questions only:** cannot see the fragmentation that small
  chunks cause (D7).
- **One monolithic script:** every failure restarts from scratch.
- **In-memory retrieval replica:** scores a different ranking than production's
  Postgres hybrid search (D4).
- **Generating questions from chunks:** biased toward the generating chunk size
  (D3).
- **Frontier model for generation:** new egress of client text (D1).
- **Exact (non-index) vector search for the eval:** removes HNSW noise but stops
  measuring the real path; the A/A run measures that noise instead.
