---
title: Evaluation and feedback
status: current
last_verified: 2026-10-21
verified_against: 6d5b458
answers: How answer and retrieval quality are measured, which command runs which check, what the current numbers are, and how user feedback and the docs-gap digest feed improvement.
read_when: Changing retrieval, chunking, embeddings, prompts or generation; running or recording an eval; building the faithfulness judge; or working on answer feedback.
supersedes: [EVAL-AND-FEEDBACK.md, EVAL-BASELINE.md]
code:
  [
    tests/e2e/src/eval/,
    tests/e2e/src/specs/retrieval-eval.spec.ts,
    tests/e2e/src/specs/retrieval-eval-cpa.spec.ts,
    tests/e2e/src/specs/eval-faithfulness.spec.ts,
    scripts/check-kb-grounding.mjs,
    apps/api/src/routes/feedback.ts,
    packages/db/drizzle/0018_answer_feedback.sql,
    apps/worker/src/handlers/docs-gap-digest.ts,
  ]
---

# Evaluation and feedback

Quality is measured by four mechanisms: retrieval metrics, faithfulness scoring, in-product feedback and
the docs-gap digest. Only retrieval metrics produce numbers today, and only on synthetic corpora. The
faithfulness judge is built as a prompt and parser but is uncalibrated and runs on no real answers. The
gold set that would score the real knowledge base is empty by design until a CPA authors it. So nothing
here yet measures retrieval quality on the firm's own documents, and nothing measures whether answers are
correct.

Related docs:

- [EVAL-GOLD-SET-GUIDE.md](./EVAL-GOLD-SET-GUIDE.md) is the procedure for authoring the gold set.
- [EVAL-CORPUS-GROUND-TRUTH.md](./EVAL-CORPUS-GROUND-TRUTH.md) covers the corpus-grounded tier and claim
  extraction.
- [../architecture/RETRIEVAL.md](../architecture/RETRIEVAL.md) describes what is being measured.
- [../../tests/web-e2e/README.md](../../tests/web-e2e/README.md) covers the browser suite. It checks
  wiring, not quality.
- Open eval and feedback work is tracked in [../KNOWN-ISSUES.md](../KNOWN-ISSUES.md).

## The four mechanisms

| Mechanism            | Answers                                    | Where                                          | State                                                                    |
| -------------------- | ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| Retrieval metrics    | Did the right document come back?          | `tests/e2e/src/eval/metrics.ts`, `run-eval.ts` | Built; runs in CI on two synthetic corpora                               |
| Faithfulness scoring | Is the answer grounded in what came back?  | `tests/e2e/src/eval/faithfulness.ts`           | Scorer and judge prompt built; only unit tests run; judge not calibrated |
| In-product feedback  | What do real users think of an answer?     | `POST /feedback`, `answer_feedback` table      | Built on web and Teams                                                   |
| Docs-gap digest      | What did the knowledge base fail to cover? | `apps/worker/src/handlers/docs-gap-digest.ts`  | Built; weekly; threshold uncalibrated                                    |

Retrieval metrics are recall@k, precision@k, nDCG@k and MRR (`recallAtK`, `precisionAtK`, `ndcgAtK`,
`reciprocalRank`). Hit-rate@k and MAP are not implemented.

## Scoring tiers

`ScoringTier` in `tests/e2e/src/eval/gold-set.ts` has two values, and the split is the core design rule.

| Tier                 | Question it answers                                           | Needs a CPA? | Status        |
| -------------------- | ------------------------------------------------------------- | ------------ | ------------- |
| `tier1-automatable`  | Did the right document come back, and is the answer grounded? | No           | In code       |
| `tier2-cpa-verified` | Is the answer substantively correct as CPA practice?          | Yes          | In code       |
| corpus-grounded      | Does the answer match what the firm's own SOP says?           | No           | Designed only |

Why the split exists:

- **Correctness is a CPA judgment.** Epistemic constraint C2 (from the cpa-consulting workspace) says AI
  does not make tax or accounting determinations. That applies with double force to the artifact used to
  score the system. A tier-2 expected answer comes only from a credentialed reviewer. Today that is Doug;
  see [../GLOSSARY.md](../GLOSSARY.md).
- **Faithfulness is not correctness.** An answer can be perfectly grounded in a retrieved document and
  still be wrong, because the document is outdated or wrong. Faithfulness catches hallucination, not a bad
  source.
- **Unattributed answers are rejected.** `validateGoldSet()` rejects an `expectedAnswer` without
  `verifiedBy` and `verifiedOn`, and it rejects a `tier2-cpa-verified` entry with no `expectedAnswer`.

The corpus-grounded tier is not in `ScoringTier` and has no scorer. Its design and the extraction pieces
that are built are in [EVAL-CORPUS-GROUND-TRUTH.md](./EVAL-CORPUS-GROUND-TRUTH.md).

## Faithfulness design

`faithfulness.ts` scores groundedness: is every claim supported by the retrieved chunks, and does each
citation contain what it is cited for? An LLM is a legitimate judge here because the ground truth is in the
prompt. It compares two texts; it does not recall facts.

- **A fabricated citation is a hard failure, not a low score.** `checkCitations()` finds cited ids missing
  from the retrieved set by set membership, with no model call. Inventing a source is the most damaging
  failure in a professional setting, so it fails a run rather than averaging away.
- **Abstention scores `null`, never 0.** A correct "the documents do not cover this" is a coverage finding,
  not a faithfulness failure. Scoring it 0 would push the system to guess. `aggregateFaithfulness()` counts
  abstentions separately. The generation prompt relies on this. See the `SYSTEM_PROMPT` comment in
  `packages/rag/src/generation/generator.ts`: an over-eager refusal is invisible to this metric, so the
  prompt prefers partial answers.
- **The judge half is not wired to a model.** `buildJudgePrompt` and `parseJudgeReply` exist and are
  unit-tested by `tests/e2e/src/specs/eval-faithfulness.spec.ts`. Nothing calls a model with them. They
  must not gate anything until the calibration spec below is met.

## Calibrated judge specification (open)

Nothing in this section is built. It is the spec for the open judge work tracked in
[../KNOWN-ISSUES.md](../KNOWN-ISSUES.md). Until every acceptance condition holds, judge output is advisory
and must be labelled "judge unvalidated".

Acceptance conditions:

| Condition       | Requirement                                                                             |
| --------------- | --------------------------------------------------------------------------------------- |
| Labelled set    | At least 100 human-labelled (question, answer, context) items                           |
| Agreement       | True-positive rate and true-negative rate each at least 0.85 against the human labels   |
| Model family    | The judge comes from a different model family than the production `GENERATION_PROVIDER` |
| Before any gate | Calibrate first, then set thresholds. A judge that disagrees with humans is not a gate  |

UNVERIFIED: the production `GENERATION_PROVIDER`. `env.example` defaults it to `gemini`, and a `claude`
provider exists. Read `rag-api`'s variables to settle which family the judge must avoid.

Design rules:

1. **Deterministic, structured calls.** Use the judge's own client call at temperature 0, with a JSON
   response schema. Don't route it through `Generator.answer`: the Gemini and OpenAI generators run at
   `temperature: 0.2` and prepend the cited-Q&A system prompt.
2. **Use an ordinal rubric.** Use levels such as 0/1/2 for faithfulness, each defined in the prompt,
   instead of a vague 0–1 float.
3. **Compute citation correctness in the harness, not the judge.** `/ask` already returns citations
   filtered to the `[N]` markers the answer used (`filterCitationsToAnswer`,
   `packages/rag/src/generation/prompt-context.ts`). Compare their document ids to the question's labels
   and report citation precision and recall. `Generator.answer` called directly returns one citation per
   retrieved chunk in context order (`buildCitations`), so don't score against that.
4. **Report a distribution.** Real generation and judging are stochastic. Run the judge at least 3 times
   per item, report mean ± standard deviation, and assert only a loose floor that proves the pipeline ran.
5. **Keep seeded and real sets apart.** Fictional seeded questions and real CPA-authored ones go in
   physically separate, clearly labelled files. A synthetic question must never pass for a validated firm
   question in a recorded baseline.
6. **Don't send real KB content to an external judge without the egress gate.** See
   [Egress caveat](#egress-caveat).

## Commands

The root [`CLAUDE.md`](../../CLAUDE.md) lists these commands. This table records what each one gates.

| Command                                                               | Measures                                                                                          | Corpus                                                                                       | Gate                                                                                                                                                                                   | Network                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `pnpm eval`                                                           | Retrieval metrics with `FakeEmbedder`                                                             | Starter (`corpus.ts`, 14 docs / 17 q) and CPA (`corpus-cpa.ts`, 7 docs / 20 q + 8 negatives) | Starter: recall@5 ≥ 0.8, recall@3 ≥ 0.7, nDCG@5 ≥ 0.6, MRR ≥ 0.6. CPA: recall@1 ≥ 0.88, recall@3 = 1, nDCG@3 ≥ 0.95, MRR ≥ 0.95, and the keyword arm must score each expected document | None                        |
| `pnpm eval:real`                                                      | The same metrics and a five-point dense/sparse sweep, with the configured real embedder           | Both, each into a fresh source                                                               | None; it writes `tests/e2e/src/eval/real-eval-result.md` for you to record below                                                                                                       | Provider API, or local ONNX |
| `pnpm eval:gold`                                                      | Recall@1/3/5, MRR, refusals, fabricated citations and truncation through the deployed `POST /ask` | `gold-set.ts` against production documents                                                   | Exit 2 when the set is empty or invalid or config is bad; exit 1 on a fabricated citation or failed request                                                                            | Deployed API                |
| `npx vitest run --root tests/e2e src/specs/eval-faithfulness.spec.ts` | Faithfulness scorer and gold-set validation unit tests                                            | Fixtures                                                                                     | Test pass/fail                                                                                                                                                                         | None                        |
| `node scripts/check-kb-grounding.mjs <questions.json>`                | Citation validity, self-retrieval and refusal against a deployed KB                               | Title-derived questions                                                                      | Citation validity and refusal; self-retrieval is reported but kept out of the exit gate                                                                                                | Deployed API                |

Running these:

- **`pnpm eval` needs the local stack** (`pnpm docker:up`). It also runs in CI, because `pnpm e2e` in
  `.github/workflows/e2e.yml` includes every spec under `tests/e2e/src/specs/`.
- **`pnpm eval:real` truncates its database.** It calls `truncateAll`, which refuses a non-local host
  unless `E2E_ALLOW_REMOTE_TRUNCATE=1` (`assertDestructiveTestTarget`, `tests/e2e/src/helpers/db.ts`). Point
  `E2E_DATABASE_URL` at a disposable local database.
- **`pnpm eval:real` goes through `loadConfig`, so three settings block it.**
  - `API_TOKENS` must be non-empty.
  - `AUTH_PROVIDER`, if set, must be `static-token`, `oidc` or `composite`; `static` is rejected.
  - `EGRESS_ALLOWED_HOSTS` must include the provider's host, or `EgressPolicy` refuses the call.
- **`pnpm eval:real` runs with any provider.** `EMBEDDING_PROVIDER=local` needs no key. For `openai`, set
  `EMBEDDING_DIMENSIONS=768`, because `chunks.embedding` is `vector(768)` and the `text-embedding-3-*`
  models support truncation.
- **`pnpm eval:gold` settings.** `GOLD_API_URL` must be https (http is allowed only for localhost).
  `GOLD_API_TOKEN` must be scoped to the sources the questions cover. Requests are paced to the `/ask` limit
  of 10 per minute. The full procedure and output-confidentiality rules are in
  [EVAL-GOLD-SET-GUIDE.md](./EVAL-GOLD-SET-GUIDE.md#running-pnpm-evalgold).
- **Deployed grounding results** from `check-kb-grounding.mjs` live in
  [../launch/LAUNCH-STATUS.md](../launch/LAUNCH-STATUS.md).
- **Comparing generation models** for self-hosting uses `run-local-generation-eval.ts`. It is documented in
  [../operations/LOCAL-GENERATION.md](../operations/LOCAL-GENERATION.md).

Example `eval:real` run with Gemini, against the local compose database:

```bash
pnpm docker:up
EMBEDDING_PROVIDER=gemini GEMINI_API_KEY=... \
EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com \
API_TOKENS=local-eval AUTH_PROVIDER=static-token \
E2E_DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
  pnpm eval:real
```

### Egress caveat

The egress guard blocks provider calls by default, which is correct. Overriding it for `eval:real` is
acceptable only because both eval corpora are synthetic; no firm content leaves the machine. Sending real
knowledge-base content to an external model for evaluation is a different act. This applies to a judge
scoring production answers and to claim extraction. It needs the counsel determination in P0 gate 2 (see
[../GLOSSARY.md](../GLOSSARY.md); current status in [../launch/LAUNCH-STATUS.md](../launch/LAUNCH-STATUS.md)).

The older argument was "firm SOPs are Class A/B, so an external judge adds no new disclosure". It no longer
holds: client-identifying material was found inside the indexed KB. Don't reuse that argument.

## Current results

These are the current numbers. Each is dated, and each is synthetic-corpus only. None measures quality on
the firm's knowledge base.

Two facts frame them:

- **The starter corpus is a floor, not a measurement.** Its 14 documents use vocabulary-disjoint topics, so
  keyword overlap alone separates them. MRR is 1.000 at the default weights, which means it can catch only
  catastrophic regressions.
- **The CPA corpus is the discriminating one.** Its documents share vocabulary ("client", "engagement",
  "time entry"), and its CI thresholds fail if hybrid retrieval loses its keyword arm. The starter corpus
  cannot detect that.

**A degenerate metric is a reason to suspect the instrument, not only the data.** Before
2026-08-01 the sparse arm ANDed every lexeme (`plainto_tsquery`), so a single chunk had to contain every
content word of the question. On the firm's real SOP chunks, 5 of 15 realistic staff questions matched zero
chunks on the sparse arm. Varying the sparse weight therefore changed nothing, and a flat sweep was misread
as proof that the corpus alone was at fault. After the OR-semantics fix (now in
`packages/db/src/hybrid-search.ts`), the same sweep on the same corpus responds. The sweep is a working
instrument, and weight changes can be measured on any corpus hard enough to separate them.

## Recorded results

`pnpm eval:real` writes one block per corpus for the configured provider. Paste its output into the
matching subsection below, replacing what is there, and add the date and commit. Record only runs made
after 2026-08-01 (commit `35a4af3`, the sparse OR fix). Runs before that measured a broken sparse arm.

### Provider: `fake` (FakeEmbedder, `pnpm eval`)

`FakeEmbedder` is a deterministic bag-of-words hash, so its "dense" arm is a keyword proxy. These numbers
are a regression trip-wire, not evidence of semantic retrieval quality.

Starter corpus, weight sweep, measured 2026-08-01 after the sparse fix:

| dense | sparse | recall@5 | nDCG@5 | MRR   |
| ----- | ------ | -------- | ------ | ----- |
| 1.0   | 0.0    | 97.1%    | 97.3%  | 1.000 |
| 0.7   | 0.3    | 100.0%   | 99.1%  | 1.000 |
| 0.5   | 0.5    | 100.0%   | 99.5%  | 1.000 |
| 0.3   | 0.7    | 100.0%   | 97.4%  | 0.971 |
| 0.0   | 1.0    | 100.0%   | 97.4%  | 0.971 |

0.7/0.3 is the production default. Source: the H-1b measurement in
[PROTOTYPE-READINESS-REVIEW-2026-08-01](../archive/reviews/PROTOTYPE-READINESS-REVIEW-2026-08-01.md#h-1b--the-flat-weight-sweep-conclusion-was-partly-an-artifact-of-h-1).

CPA corpus, measured 2026-09-16 (recorded in `retrieval-eval-cpa.spec.ts`):

| weights               | recall@1 | recall@3 | nDCG@3 | MRR   |
| --------------------- | -------- | -------- | ------ | ----- |
| dense 0.7, sparse 0.3 | 92.5%    | 100%     | 98.2%  | 0.975 |
| dense 1.0, sparse 0.0 | —        | 95%      | 93.2%  | 0.938 |

### Provider: `gemini`

No run recorded since the sparse fix. The only Gemini run, on 2026-08-01 (commit `c873211`), predates the
sparse fix and covered the starter corpus only. It is superseded. Its output is still the checked-in
`tests/e2e/src/eval/real-eval-result.md`.

### Provider: `local`

No run recorded. The model is `Xenova/bge-base-en-v1.5`, and `CHUNK_SIZE` is capped at 512.

### Provider: `openai`

No run recorded. Set `EMBEDDING_DIMENSIONS=768` first.

## Feedback loop

### How findings become fixes

A not-helpful vote, or a weak result in the docs-gap digest, sorts into one of two queues. The sort is the
point, because the two need different fixes and different owners:

- **"The KB doesn't contain it."** This goes to the content-authoring queue. Firm staff write a document;
  this is the knowledge-base governance work tracked as issue ISS-05 in the cpa-consulting register.
- **"The KB has it, but it wasn't found."** This is engineering work on retrieval.

A raw satisfaction score tells you neither.

The comment box appears only on a thumbs-down, in `apps/web/src/components/answer-feedback/`. Asking why
something failed produces that sort; asking why it worked produces little. The Teams card records a rating
only.

Real questions are the honest source of gold-set candidates. `audit_log` stores question text only when
`AUDIT_LOG_CONTENT=full`. The default is `none`, which keeps only `question_hash`. UNVERIFIED: the production
`AUDIT_LOG_CONTENT` value.

### Answer identity and the feedback table

| Fact             | Current behaviour                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answerId`       | A uuid minted per answer in `packages/services/src/ask.ts`, including the empty-retrieval refusal. It is returned on `/ask`, on the `/ask/stream` `done` event and in the MCP ask tool's `structuredContent`, and stored in `audit_log.answer_id` |
| Route            | `POST /feedback` with `{ answerId: uuid, rating: "helpful" \| "not_helpful", comment?: ≤1000 chars }` returns 204 (`apps/api/src/routes/feedback.ts`)                                                                                             |
| Identity         | `principal_subject` is derived server-side from the authenticated scoped principal, never from the body. It is null for admin and static tokens                                                                                                   |
| No foreign key   | `answer_feedback.answer_id` is a plain column, not a foreign key to `audit_log`, because audit writes are fire-and-forget and the row may not exist                                                                                               |
| One vote         | Unique index `afb_answer_subject_unique` on `(answer_id, principal_subject)` `NULLS NOT DISTINCT`. `submitAnswerFeedback` upserts, so the last vote wins and null-subject re-votes collapse too                                                   |
| Hand-written SQL | Drizzle's `uniqueIndex` cannot emit `NULLS NOT DISTINCT`. `0018_answer_feedback.sql` is the source of truth; the `schema.ts` declaration exists for typing                                                                                        |
| Channel          | `answer_feedback.channel` is `web` or `teams`, from the `X-RAG-Channel` header (anything but `teams` is `web`). This is a different vocabulary from `audit_log.channel` (`api`, `mcp`, `teams`), so don't share the helper                        |
| Comment          | A firm-internal operations signal. It is never sent to any external model, including a future judge. Staff may paste client detail into it                                                                                                        |

`getFeedbackStats` (counts and the 20 most recent not-helpful votes) has no caller yet, and there is no MCP
feedback tool. Both are tracked in [../KNOWN-ISSUES.md](../KNOWN-ISSUES.md).

### Docs-gap digest

A pg-boss scheduled job (`docs-gap-digest.ts`) scans `audit_log` for zero-result and weak `/ask` and `/search`
events over a rolling 7-day window. It logs one `docs.gap_digest.summary` line; there is no table and no UI.
It reads `retrievedCount`, `chunkIds` and `topScore`, never `questionHash`.

| Setting                     | Default     | Note                                                                               |
| --------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `DOCS_GAP_DIGEST_CRON`      | `0 6 * * 1` | Mondays 06:00                                                                      |
| `DOCS_GAP_DIGEST_TZ`        | `UTC`       |                                                                                    |
| `DOCS_GAP_DIGEST_MIN_SCORE` | `0.3`       | Never calibrated. Set it from the observed distribution of real `top_score` values |

`top_score` is the best dense cosine similarity among retrieved chunks (`topRelevanceScore`, `@rag/core`).
Rows written before that fix (`6d42f1e`, on the 2026-09-16 review branch) hold 1.0 and are never flagged.
`gemini-embedding-001` similarities for irrelevant matches commonly sit above 0.3, so expect the default to
under-report.
