---
title: Answer-quality gold set implementation plan
status: current
last_verified: 2026-10-22
verified_against: c7e5485
answers: The plan for a synthetic gold set and a per-model answer-quality table in pnpm eval:gold. Not started.
read_when: You are executing the gold-set work or comparing generation models.
---

# Answer-Quality Gold Set (Synthetic) + Model Dimension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a committable per-model answer-quality table by populating a **synthetic** gold set derived from `tests/e2e/src/eval/corpus-cpa.ts` and adding a **model dimension** to `pnpm eval:gold`, scored by the existing `scoreGoldRun` — extended with two new failure classes it cannot currently express (empty-content and uncited-answer).

**Architecture:** Six tasks. Tasks 1–3 are pure/CI-safe (new synthetic gold set, two new `GoldReport` fields, embedder pinning in `buildTestApi`). Task 4 adds a `GOLD_CORPUS=synthetic` mode to `run-gold-eval.ts` that seeds the CPA corpus once into a local Postgres, then iterates models by rebuilding the in-process Fastify app with a different `Generator` — one process, one seeding, N model rows, 3 passes each. Task 5 optionally wires the already-written-but-dead `faithfulness.ts` judge. Task 6 records the run with full provenance.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, tsx, Fastify `inject()`, Drizzle/Postgres + pgvector, Ollama 0.33.3 OpenAI emulation, `@rag/rag` `OpenAIGenerator`/`GeminiGenerator`.

**Spec:** `docs/specs/local-llm-verification.md` — **Phase 4**, and success criterion 5. Prior-phase ledger: `.superpowers/sdd/2026-10-02-local-llm-phase-0-1/progress.md`.

## Correction to the spec, recorded here because it changes the plan

The spec says (line 94) "**Only groundedness is genuinely absent** (`gold-eval.ts:13-14` says faithfulness 'needs a reviewer or a calibrated judge')". **That is only half true and the plan must not be read as if it were fully true.**

`tests/e2e/src/eval/faithfulness.ts` (201 lines) already exists and implements, with real bodies:

- `checkCitations` — deterministic, no-model fabricated-citation detection by set membership (`:75-86`).
- `buildJudgePrompt` — a full LLM-judge groundedness prompt, written to score entailment only and to treat abstention as correct, not as a failure (`:98-132`).
- `parseJudgeReply` — JSON extraction that throws rather than guessing (`:135-168`).
- `aggregateFaithfulness` — mean over scoreable answers only, abstentions reported separately rather than zeroed, fabricated citations counted as their own hard-fail number (`:185-199`).

It is covered by 10 passing unit tests in `tests/e2e/src/specs/eval-faithfulness.spec.ts`.

**What is actually missing is the judge call and the wiring.** Nothing in the repo imports `faithfulness.ts` outside its own spec: `scoreGoldRun` does not use it, `run-gold-eval.ts` does not import it, and no code ever sends `buildJudgePrompt`'s output to a model. Consequence for this plan: Task 5 is a ~60-line wiring task against a finished library, not a design task, and it stays optional and last because an uncalibrated judge is exactly the "confident, meaningless numbers" failure `gold-set.ts:20-23` warns about.

Second correction, smaller: the spec/brief premise that "corpus injection is already parameterized" at `gold-set.ts:107` and `:144` is true of the **validators** (`validateGoldSet`, `isGoldSetUsable`) and false of the **runner** — `run-gold-eval.ts:43`, `:50`, `:79` and `:112` all reference the module constant `GOLD_QUESTIONS` directly. The validators need no change; the runner is the only plumbing to add.

## Global Constraints

- **800-line hard cap per source file** (`scripts/check-file-sizes.mjs`, pre-commit). `run-gold-eval.ts` is 171 lines; the synthetic collector goes in its own module so that file stays small.
- **Test colocation.** `foo.ts` → `foo.test.ts` in the same directory. Note `tests/e2e` is the exception the repo already lives with: its vitest `include` is `src/specs/**/*.spec.ts`, so tests for `src/eval/*.ts` go in `src/specs/*.spec.ts` (that is where `gold-eval.spec.ts` and `eval-faithfulness.spec.ts` already are). Follow the existing location, not the colocation rule, in this package.
- **Test-first.** Every behavioral change starts with a failing test.
- **`GOLD_QUESTIONS` in `gold-set.ts` must stay empty.** It is documented as the **real firm SharePoint** set keyed to production `externalId`s, and `eval-faithfulness.spec.ts` asserts `isGoldSetUsable()` is `false` for the shipped set. Populating it with synthetic questions would both break that test and destroy the file's contract. The synthetic set gets its own file.
- **No `expectedAnswer` anywhere in the synthetic set.** `expectedAnswer` is a CPA judgment (epistemic constraint C2, `gold-set.ts:25-28`). Every synthetic question is `tier: "tier1-automatable"`, so `validateGoldSet` passes without a `verifiedBy`. This plan measures retrieval, coverage/refusal, citation fidelity, truncation and (optionally) groundedness — **not** substantive correctness. Any wording that implies otherwise is a defect.
- **Fixtures must be byte-identical across models.** A prior "model refuses prematurely" conclusion was wrong: rewording a fixture from naming a code to stating its value flipped 5/5 refusals to 5/5 correct answers with model and prompt unchanged. No refusal may be attributed to a model until the fixture is ruled out — Task 3 adds the mechanical guard that makes this checkable rather than promised.
- **Citation assertions must assert a non-empty set before looping.** A per-citation loop over zero citations passes vacuously. Task 2 makes the empty set its own reported class.
- **The eval TRUNCATEs its database.** `truncateAll` wipes `chunks, documents, ingestion_jobs, sources`. A worktree bind-mount has previously destroyed local DB data. The runner must call the existing `assertDestructiveTestTarget` and must require `E2E_DATABASE_URL` explicitly — see Task 4 Step 2.
- **The runner is `tsx`, not vitest**, so `src/setup/global-setup.ts` does **not** run and nothing executes `docker compose up` behind your back. `E2E_SKIP_DOCKER_UP=1` is therefore irrelevant here — but Postgres **and** the parser must already be up, because `runOneIngestion` wires a real `HttpParserClient` (`helpers/ingestion.ts:58`). Bring them up with `pnpm docker:up` first.
- **One embedder instance, both sides.** `helpers/ingestion.ts:41` says it in the code: "the embedder used here MUST match the one passed to the retriever". Seeding with a `FakeEmbedder` and querying with a real one silently degrades retrieval to the sparse channel, so a self-retrieval assertion can pass on keyword match alone. Task 3 makes the instance shareable.
- **`EGRESS_ALLOWED_HOSTS` unset means deny-all**, not allow-all (`egress-policy.ts:30-39`). Every model row needs its host on the list or every `/ask` throws `EgressError`.
- **Do not edit `.env`.** Template is `env.example`.
- **No attribution lines** in commit messages.
- Single-test invocation: `pnpm --filter @rag/e2e test -- <pattern>`. On a fresh checkout run `pnpm -r build` first.

## What runs in CI vs local-only

| Artifact                                                                                                        | Venue                                 | Why                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `gold-set-synthetic.ts` + its spec, extended `gold-eval.ts` + spec, TRI guard, fixture-invariance helper + spec | **CI** (`pnpm test`)                  | Pure functions and FakeEmbedder; no model, no GPU, no key.                                                                               |
| `GOLD_CORPUS=synthetic` model sweep (Task 4)                                                                    | **Local only**                        | `gpt-oss:20b` is 12.8 GiB and cannot run on a GitHub runner (CPU-only, ~14 GB disk). The Gemini row additionally needs a key and egress. |
| `docs/EVAL-ANSWER-QUALITY.md` table                                                                             | **Committed artifact of a local run** | Reproducible _in principle_ only because Task 6 records host, Ollama version, model digests, corpus git SHA and date beside it.          |

## Review Focus

Failure modes this work must not ship with. Each is assigned a test.

1. **Empty content with `finish_reason: "length"` scored as something other than its own class.** Measured: at `max_tokens: 64`, `gpt-oss:20b` spent the whole budget on 339 chars of its separate `reasoning` field and returned `content: ""`. `OpenAIGenerator.answer` (`generator.ts:482-486`) then returns `"" + TRUNCATION_NOTICE`, so today `scoreGoldRun` files it under `truncated` — indistinguishable from a genuinely cut-off long answer — and zero citations makes any per-citation assertion vacuous. With `finish_reason: "stop"` and empty content it is reported as a _successful non-refusal_, which is worse. Test in **Task 2**.
2. **An uncited substantive answer counted as a pass.** Citation fidelity is this plan's most important deliverable: the 6-chunk run cited `[1]`, both 8-chunk runs emitted no `[N]` at all — under a hand-written prompt. Measuring it with the real `ask.ts`/`SYSTEM_PROMPT` is the point. Test in **Task 2**.
3. **A refusal blamed on a model when the fixture caused it.** Test in **Task 3** (retrieval invariance across model rows) and enforced in **Task 4 Step 7**.
4. **Seeding and querying with different embedders**, degrading retrieval to sparse and making recall a keyword artifact. Test in **Task 3**.
5. **A single pass reported as a rate.** ~8% no-token stall rate (5/65) on the local 8b stack means a one-pass number cannot distinguish a stall from a model failure. Handled in **Task 4 Step 5**, with the stall/failure rule stated in the table.
6. **A cold load read as a hang.** 225.6 s cold vs 14.0 s warm; Ollama unloads after `keep_alive` (5 min idle default). Handled in **Task 4 Step 4** (discarded warm-up request + a 300 s warm-up timeout vs 120 s steady-state).
7. **TRI in the corpus silently voiding every model row.** `GeneratorOptions.triPolicy` defaults to `"block"`; an identifying match throws `ComplianceError` regardless of policy. `EVAL_DOCS_CPA` reads clean today (no `$` amounts adjacent to a form number, no SSN/EIN shapes), but nothing asserts it, so one future corpus edit turns every row into an exception. Test in **Task 1**.

---

## Task 1: Synthetic gold set derived from `corpus-cpa.ts`

Mechanical derivation, so the gold set and the corpus cannot drift. No new question text is invented; the only authored content is six `distractorNote`s naming collisions the corpus header already documents.

**Files:**

- Create: `tests/e2e/src/eval/gold-set-synthetic.ts`
- Create: `tests/e2e/src/specs/gold-set-synthetic.spec.ts`

**Interfaces:**

- Consumes: `GoldQuestion` and `validateGoldSet` from `./gold-set.js` (unchanged); `EVAL_DOCS_CPA`, `EVAL_QUESTIONS_CPA`, `EVAL_NEGATIVES_CPA`, `EVAL_KEYWORD_QUESTIONS_CPA`, `EvalQuestion` from `./corpus-cpa.js`.
- Produces: `SYNTHETIC_GOLD_QUESTIONS: readonly GoldQuestion[]` (32 entries) and `SYNTHETIC_CORPUS_DOCS` (re-export of `EVAL_DOCS_CPA`, so the runner takes questions and documents from one import and cannot pair the wrong two).

### Why `corpus-cpa.ts` and not `corpus.ts`, and not a third corpus

Decided, not open:

1. **Committability.** Every `EVAL_DOCS_CPA` title carries a `SYNTHETIC SAMPLE` marker and the file's header states every document is fabricated — no firm SOP, no client identifier, no taxpayer data. That is exactly what success criterion 5 requires and what `run-gold-eval.ts:12-13` cannot provide today.
2. **It is the only corpus that can measure refusal.** `scoreGoldRun`'s `coverage` branch fires only on `relevant.length === 0` (`gold-eval.ts:80-82`). `corpus-cpa.ts` ships 8 such negatives (`EVAL_NEGATIVES_CPA`); `corpus.ts` ships zero. Refusal correctness is the most model-discriminating signal available here, so a corpus without negatives would leave half the harness dark.
3. **`corpus.ts` is saturated by construction.** Its own header calls it a "STARTER set", `gold-set.ts:6-11` records that its weight sweep is flat and unchanged at `dense=0`, and `run-real-eval.ts:45-51` says running only that corpus is "how a real-embedder comparison can look conclusive while measuring nothing". A ceiling of MRR 1.000 cannot separate four models.
4. **`corpus.ts` contains espresso, sailing and tomato-growing documents.** A model answering those from world knowledge without citing would register as a groundedness failure that is really a fixture artifact.
5. **Register match.** The real `SYSTEM_PROMPT` is CPA-shaped — its worked example cites a Karbon work template and `BK-CATCHUP` by name (`generator.ts:~90-98`). Measuring the real prompt against CPA-shaped fixtures measures it where it is tuned to operate.

A third corpus is forbidden: `run-real-eval.ts` already threads `questions` through `runRetrievalEval` and `sweepWeights` for exactly these two, and a third set would need its own ground-truth review for no new signal.

### Why 32 questions

20 `EVAL_QUESTIONS_CPA` positives + 4 `EVAL_KEYWORD_QUESTIONS_CPA` bare-identifier queries (both have non-empty `relevant`, so both land in the answerable branch) + 8 `EVAL_NEGATIVES_CPA` coverage tests = **32: 24 answerable, 8 coverage**.

That is the **entire** existing synthetic corpus, which is the point — taking all of it introduces no selection judgment, and a hand-picked subset would be an authored artifact nobody reviewed. The bare-identifier queries are kept because a lone work code (`BK-CATCHUP`, `ADV-PLAN`) is precisely where a model is most tempted to answer from memory, which is the behavior under test. 32 sits just under `gold-set.ts:90`'s 30–50 target; closing that gap honestly requires more fixture documents, not more questions over seven.

- [ ] **Step 1: Write the failing spec**

Create `tests/e2e/src/specs/gold-set-synthetic.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scanForTRI } from "@rag/core";
import {
  SYNTHETIC_CORPUS_DOCS,
  SYNTHETIC_GOLD_QUESTIONS,
} from "../eval/gold-set-synthetic.js";
import { validateGoldSet } from "../eval/gold-set.js";
import {
  EVAL_KEYWORD_QUESTIONS_CPA,
  EVAL_NEGATIVES_CPA,
  EVAL_QUESTIONS_CPA,
} from "../eval/corpus-cpa.js";

describe("synthetic gold set", () => {
  it("is structurally valid under the shipped validator", () => {
    expect(validateGoldSet(SYNTHETIC_GOLD_QUESTIONS)).toEqual([]);
  });

  it("covers the whole CPA corpus: 24 answerable + 8 coverage = 32", () => {
    const answerable = SYNTHETIC_GOLD_QUESTIONS.filter(
      (q) => q.relevant.length > 0,
    );
    const coverage = SYNTHETIC_GOLD_QUESTIONS.filter(
      (q) => q.relevant.length === 0,
    );
    expect(answerable).toHaveLength(
      EVAL_QUESTIONS_CPA.length + EVAL_KEYWORD_QUESTIONS_CPA.length,
    );
    expect(coverage).toHaveLength(EVAL_NEGATIVES_CPA.length);
    expect(SYNTHETIC_GOLD_QUESTIONS).toHaveLength(32);
  });

  it("claims no CPA verification anywhere — tier1 only, never an expectedAnswer", () => {
    for (const q of SYNTHETIC_GOLD_QUESTIONS) {
      expect(q.tier).toBe("tier1-automatable");
      expect(q.expectedAnswer).toBeUndefined();
      expect(q.verifiedBy).toBeUndefined();
    }
  });

  it("keeps query text byte-identical to the corpus it was derived from", () => {
    const byQuery = new Map(
      SYNTHETIC_GOLD_QUESTIONS.map((q) => [q.id, q.query]),
    );
    for (const q of [
      ...EVAL_QUESTIONS_CPA,
      ...EVAL_KEYWORD_QUESTIONS_CPA,
      ...EVAL_NEGATIVES_CPA,
    ]) {
      expect(byQuery.get(`syn-${q.id}`)).toBe(q.query);
    }
  });

  it("points every relevant id at a document that exists in the corpus", () => {
    const ids = new Set(SYNTHETIC_CORPUS_DOCS.map((d) => d.externalId));
    for (const q of SYNTHETIC_GOLD_QUESTIONS) {
      for (const r of q.relevant) expect(ids.has(r)).toBe(true);
    }
  });

  // Review Focus 7. triPolicy defaults to "block" and an identifying match
  // throws regardless of policy, so TRI in a fixture document would turn every
  // model row into a ComplianceError rather than a score.
  it("contains no TRI, so generation can never be blocked by the fixture", () => {
    for (const doc of SYNTHETIC_CORPUS_DOCS) {
      const scan = scanForTRI(`${doc.title}\n${doc.text}`);
      expect(
        scan.patterns,
        `${doc.externalId}: ${scan.patterns.join(",")}`,
      ).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/e2e test -- gold-set-synthetic`
Expected: FAIL at module resolution — `Cannot find module '../eval/gold-set-synthetic.js'`. That is the correct red: the file does not exist yet.

- [ ] **Step 3: Create `gold-set-synthetic.ts`**

```ts
/**
 * Synthetic answer-quality gold set — the committable counterpart to
 * `gold-set.ts`.
 *
 * `gold-set.ts` holds the REAL firm set: its questions reference production
 * SharePoint documents by connector `externalId`, its answers are
 * firm-confidential, and it is empty by design until a credentialed preparer
 * authors it. Nothing here changes that; `GOLD_QUESTIONS` stays empty.
 *
 * This file exists because success criterion 5 of
 * `docs/specs/local-llm-verification.md` needs a
 * per-model table that can be committed. Every question is derived
 * MECHANICALLY from `corpus-cpa.ts` — same ids (prefixed), byte-identical
 * query text — so the gold set and the documents it is scored against cannot
 * drift apart. Nothing here is a CPA determination: every entry is
 * `tier1-automatable` and no entry carries an `expectedAnswer`.
 *
 * What this measures: retrieval (recall@k, MRR), coverage behaviour (refusing
 * the 8 out-of-corpus negatives, and NOT refusing the 24 answerable ones),
 * citation fidelity, truncation, empty answers, and — if a judge is configured
 * — groundedness. What it does NOT measure: whether an answer is correct as
 * CPA practice. That needs a credentialed reviewer and the real gold set.
 */
import type { GoldQuestion } from "./gold-set.js";
import {
  EVAL_DOCS_CPA,
  EVAL_KEYWORD_QUESTIONS_CPA,
  EVAL_NEGATIVES_CPA,
  EVAL_QUESTIONS_CPA,
} from "./corpus-cpa.js";
import type { EvalQuestion } from "./corpus.js";

/**
 * Re-exported so a caller takes questions and documents from ONE import.
 * `seedEvalCorpus` defaults to `EVAL_DOCS` from `corpus.ts`; pairing these
 * questions with that corpus makes every metric read ~0 while the run still
 * completes successfully.
 */
export const SYNTHETIC_CORPUS_DOCS = EVAL_DOCS_CPA;

/**
 * Distractor notes. The most valuable field in a gold question
 * (`gold-set.ts:76-81`): it names the near-neighbour a keyword search would
 * wrongly return. Only the collisions `corpus-cpa.ts` itself documents are
 * recorded — these are observations about the fixture, not CPA opinions.
 */
const DISTRACTORS: Readonly<Record<string, string>> = {
  "cpa-q04":
    "ADMIN-INT is the trap: `time-coding` says catch-up bookkeeping is never coded ADMIN-INT, and `catchup-bookkeeping` shares every other word of the question while answering none of it.",
  "cpa-q09":
    "`karbon-templates` lists a Catch-Up Bookkeeping template and `time-coding` names BK-CATCHUP; both match on vocabulary and neither gives the steps.",
  "cpa-q11":
    "`karbon-templates` names both Catch-Up Bookkeeping and Monthly Bookkeeping; `catchup-bookkeeping` describes the workflow but never says which template to pick.",
  "cpa-q12":
    "`boi-filing` shares every BOI keyword and says nothing about templates; only `karbon-templates` answers this.",
  "cpa-q13":
    "UPE is expanded in `staff-onboarding` and used in `k1-treatment`. Both are relevant, so a single-document answer is incomplete, not wrong.",
  "cpa-k04":
    "Bare identifier `UPE`: the sparse arm has to carry this one, and two documents hold it. Dense similarity alone must not be what retrieves it.",
};

function toGold(q: EvalQuestion, origin: string): GoldQuestion {
  const distractorNote = DISTRACTORS[q.id];
  return {
    // Prefixed, never renumbered — results are keyed on the id.
    id: `syn-${q.id}`,
    query: q.query,
    relevant: [...q.relevant],
    tier: "tier1-automatable",
    ...(distractorNote ? { distractorNote } : {}),
    note: `Derived from corpus-cpa.ts (${origin}). Synthetic fixture; no CPA verification claimed.${
      q.note ? ` Corpus note: ${q.note}` : ""
    }`,
  };
}

/**
 * 32 questions: 24 answerable (20 positives + 4 bare-identifier queries) and
 * 8 coverage tests with `relevant: []`. The full corpus, so no selection
 * judgement is introduced.
 */
export const SYNTHETIC_GOLD_QUESTIONS: readonly GoldQuestion[] = [
  ...EVAL_QUESTIONS_CPA.map((q) => toGold(q, "positive")),
  ...EVAL_KEYWORD_QUESTIONS_CPA.map((q) => toGold(q, "bare identifier")),
  ...EVAL_NEGATIVES_CPA.map((q) => toGold(q, "out-of-corpus negative")),
];
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `pnpm --filter @rag/e2e test -- gold-set-synthetic`
Expected: PASS, all six tests. If the TRI test fails, **stop** — do not edit the regex or loosen the assertion; a TRI hit in a fixture means the corpus text must change, because `triPolicy: "block"` would otherwise throw on every model row.

Run: `pnpm --filter @rag/e2e typecheck`
Expected: no errors.

- [ ] **Step 5: Confirm the real gold set is untouched**

Run: `pnpm --filter @rag/e2e test -- eval-faithfulness`
Expected: PASS, including `treats the shipped (empty) gold set as unusable`. If that test now fails, `GOLD_QUESTIONS` was edited — revert it.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/src/eval/gold-set-synthetic.ts tests/e2e/src/specs/gold-set-synthetic.spec.ts
git commit -m "test(eval): add synthetic gold set derived from the CPA corpus

Populates a 32-question gold set (24 answerable, 8 coverage) mechanically
derived from corpus-cpa.ts so the two cannot drift: same ids with a syn-
prefix, byte-identical query text. Every entry is tier1-automatable with no
expectedAnswer, so nothing here claims a CPA determination.

GOLD_QUESTIONS in gold-set.ts stays empty — that file is the real firm
SharePoint set and its emptiness is asserted by eval-faithfulness.spec.ts.

Includes a scanForTRI guard over every fixture document: triPolicy defaults
to block and an identifying match throws regardless of policy, so TRI in a
fixture would turn every model row into a ComplianceError instead of a score."
```

---

## Task 2: Two new failure classes in `scoreGoldRun`

`scoreGoldRun` stays the harness — this adds two fields it cannot currently express. No new harness, no second scorer.

**Files:**

- Modify: `tests/e2e/src/eval/gold-eval.ts`
- Modify: `tests/e2e/src/specs/gold-eval.spec.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `GoldReport` gains `emptyAnswers: string[]` and `uncitedAnswers: string[]`; `gold-eval.ts` exports `answerBody(answer: string): string` for the runner's stall classifier (Task 4).

Semantics, fixed here so Task 4 cannot reinterpret them:

- `answerBody(a)` = `a` with a trailing `TRUNCATION_NOTICE` removed, then trimmed.
- `emptyAnswers` — `answerBody` is `""`. This is the H2 class: `OpenAIGenerator.answer` returns `"" + TRUNCATION_NOTICE` when `content` is empty and `finish_reason === "length"` (`generator.ts:482-486`), and plain `""` when `finish_reason === "stop"`. Both are a non-answer with zero citations, and the second currently scores as a _successful non-refusal_. **Hard fail.**
- `uncitedAnswers` — `answerBody` is non-empty, the answer is not a refusal, and `citedExternalIds` is empty. This is the citation-fidelity number and the non-vacuity guard. **Reported, not a hard fail** — a legitimately refused answer has no citations and is already excluded, and hard-failing an uncited substantive answer would make the comparison table unproducible for exactly the model it is meant to characterise.
- `truncated` keeps its existing meaning (`answer.includes(TRUNCATION)`), so the existing test at `gold-eval.spec.ts:81` keeps passing. `emptyAnswers` and `truncated` deliberately overlap for the `finish_reason: "length"` case; the formatter prints both and labels the difference.

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e/src/specs/gold-eval.spec.ts`, inside the existing `describe("scoreGoldRun", ...)`:

```ts
// H2 from the spec's Phase 1b result: gpt-oss:20b spent a 64-token budget on
// its separate `reasoning` field and returned content: "" with
// finish_reason: "length". OpenAIGenerator turns that into the truncation
// notice alone. Zero citations makes any per-citation loop pass vacuously.
it("reports empty content as its own class, not merely as truncated", () => {
  const q: GoldQuestion[] = [
    { id: "e1", query: "q", relevant: ["doc-a"], tier: "tier1-automatable" },
  ];
  const o: GoldObservation[] = [
    {
      id: "e1",
      answer: TRUNCATION_NOTICE,
      retrievedExternalIds: ["doc-a"],
      citedExternalIds: [],
    },
  ];
  const r = scoreGoldRun(q, o);
  expect(r.emptyAnswers).toEqual(["e1"]);
  expect(r.truncated).toEqual(["e1"]);
  expect(r.wrongRefusals).toEqual([]);
});

it("reports empty content with no truncation notice too", () => {
  const q: GoldQuestion[] = [
    { id: "e2", query: "q", relevant: ["doc-a"], tier: "tier1-automatable" },
  ];
  const r = scoreGoldRun(q, [
    {
      id: "e2",
      answer: "   \n  ",
      retrievedExternalIds: ["doc-a"],
      citedExternalIds: [],
    },
  ]);
  expect(r.emptyAnswers).toEqual(["e2"]);
  expect(r.truncated).toEqual([]);
});

it("flags a substantive answer that cited nothing", () => {
  const q: GoldQuestion[] = [
    { id: "u1", query: "q", relevant: ["doc-a"], tier: "tier1-automatable" },
  ];
  const r = scoreGoldRun(q, [
    {
      id: "u1",
      answer: "File the BOIR within 90 days of formation.",
      retrievedExternalIds: ["doc-a"],
      citedExternalIds: [],
    },
  ]);
  expect(r.uncitedAnswers).toEqual(["u1"]);
  expect(r.emptyAnswers).toEqual([]);
});

it("does not flag a correct refusal as uncited — refusals cite nothing by design", () => {
  const q: GoldQuestion[] = [
    { id: "n1", query: "q", relevant: [], tier: "tier1-automatable" },
  ];
  const r = scoreGoldRun(q, [
    {
      id: "n1",
      answer:
        "The available documents do not contain enough information to answer that.",
      retrievedExternalIds: ["doc-a"],
      citedExternalIds: [],
    },
  ]);
  expect(r.uncitedAnswers).toEqual([]);
  expect(r.coverage).toEqual({ total: 1, correctlyRefused: 1 });
});

it("does not flag an answer that cited something", () => {
  const q: GoldQuestion[] = [
    { id: "c1", query: "q", relevant: ["doc-a"], tier: "tier1-automatable" },
  ];
  const r = scoreGoldRun(q, [
    {
      id: "c1",
      answer: "File within 90 days [1].",
      retrievedExternalIds: ["doc-a"],
      citedExternalIds: ["doc-a"],
    },
  ]);
  expect(r.uncitedAnswers).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @rag/e2e test -- gold-eval`
Expected: the three `emptyAnswers`/`uncitedAnswers` assertions FAIL with `expected undefined to deeply equal [ 'e1' ]` (the fields do not exist); the two negative-control tests also fail on `undefined` rather than `[]`. The seven pre-existing `scoreGoldRun` tests must still PASS — if any of them breaks, you changed existing semantics and must stop.

- [ ] **Step 3: Implement**

In `tests/e2e/src/eval/gold-eval.ts`, add to `GoldReport` after `truncated`:

```ts
  /**
   * Answers whose body is empty once the truncation notice is removed.
   *
   * This is its own class, not a kind of truncation. `gpt-oss:20b` returns a
   * separate `reasoning` field that competes with `content` for the output
   * budget; when it wins, `content` is "" and `finish_reason` is "length", and
   * `OpenAIGenerator.answer` returns the truncation notice alone. With
   * finish_reason "stop" it returns "". Both carry zero citations, which is
   * exactly the shape that makes a per-citation assertion pass over nothing.
   * A HARD FAIL: it is a non-answer, and it is not a refusal.
   */
  emptyAnswers: string[];
  /**
   * Non-refused, non-empty answers that cited no document at all — the
   * citation-fidelity number. Reported rather than hard-failed: a correct
   * refusal legitimately cites nothing (and is excluded here), and a model
   * that answers without citing is the finding, not a broken run.
   */
  uncitedAnswers: string[];
```

Add after `isRefusal`:

```ts
/**
 * The answer with any trailing truncation notice removed. Exported because the
 * runner's stall classifier needs exactly this definition of "the model said
 * nothing" — two definitions would drift.
 */
export function answerBody(answer: string): string {
  const cut = answer.indexOf(TRUNCATION);
  return (cut === -1 ? answer : answer.slice(0, cut)).trim();
}
```

In `scoreGoldRun`, declare the accumulators beside `truncated`:

```ts
const emptyAnswers: string[] = [];
const uncitedAnswers: string[] = [];
```

Replace the tail of the per-question loop (currently the two lines from `const retrieved = new Set(...)` through the `truncated.push` line) with:

```ts
const retrieved = new Set(o.retrievedExternalIds);
const fabricated = o.citedExternalIds.filter((id) => !retrieved.has(id));
if (fabricated.length > 0) {
  fabricatedCitations.push({ id: q.id, externalIds: fabricated });
}
if (o.answer.includes(TRUNCATION)) truncated.push(q.id);

const body = answerBody(o.answer);
if (body === "") {
  emptyAnswers.push(q.id);
} else if (!refused && o.citedExternalIds.length === 0) {
  uncitedAnswers.push(q.id);
}
```

Add both to the returned object, and extend the header docblock's "What it can score" list with "empty answers (a model that returned no content at all) and uncited answers".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rag/e2e test -- gold-eval`
Expected: PASS — the five new tests plus all seven pre-existing ones.

Run: `pnpm --filter @rag/e2e typecheck`
Expected: no errors. If `run-gold-eval.ts`'s `formatGoldReport` errors on the new required fields, that is the next step, not a reason to make them optional.

- [ ] **Step 5: Surface both in `formatGoldReport` and the hard-fail gate**

In `run-gold-eval.ts`, add to the `formatGoldReport` array after the `truncated` line:

```ts
    `  empty answers (hard fail): ${r.emptyAnswers.join(", ") || "none"}`,
    `  answered without citing: ${r.uncitedAnswers.join(", ") || "none"}`,
```

and change the gate to:

```ts
const hardFail =
  report.fabricatedCitations.length > 0 ||
  report.missing.length > 0 ||
  report.emptyAnswers.length > 0;
```

Also change the `truncated` label to `truncated (includes empty answers)` so the overlap is not read as double counting.

Run: `pnpm --filter @rag/e2e typecheck` — expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/src/eval/gold-eval.ts tests/e2e/src/eval/run-gold-eval.ts tests/e2e/src/specs/gold-eval.spec.ts
git commit -m "test(eval): score empty and uncited answers as distinct classes

An empty answer was indistinguishable from a truncated one. gpt-oss:20b
returns a separate reasoning field that competes with content for the output
budget; when it wins, content is \"\" with finish_reason \"length\" and
OpenAIGenerator returns the truncation notice alone. With finish_reason
\"stop\" it returns \"\" and scored as a successful non-refusal. Both carry
zero citations, which is the shape that makes a per-citation assertion pass
over nothing.

Adds emptyAnswers (hard fail) and uncitedAnswers (the citation-fidelity
number, reported not failed, since a correct refusal cites nothing by
design). truncated keeps its existing meaning so no existing test changes."
```

---

## Task 3: Pin the embedder and make fixture invariance checkable

Two small enabling changes. Both close a trap that would silently void the table.

**Files:**

- Modify: `tests/e2e/src/helpers/api.ts`
- Create: `tests/e2e/src/eval/fixture-invariance.ts`
- Create: `tests/e2e/src/specs/fixture-invariance.spec.ts`

**Interfaces:**

- Consumes: `GoldObservation` from `./gold-eval.js`.
- Produces: `buildTestApi` accepts `embedder?: EmbeddingProvider`; `fixture-invariance.ts` exports `retrievalDrift(runs: ReadonlyMap<string, readonly GoldObservation[]>): string[]`.

- [ ] **Step 1: Write the failing spec**

Create `tests/e2e/src/specs/fixture-invariance.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { retrievalDrift } from "../eval/fixture-invariance.js";
import type { GoldObservation } from "../eval/gold-eval.js";

const obs = (id: string, retrieved: string[]): GoldObservation => ({
  id,
  answer: "a",
  retrievedExternalIds: retrieved,
  citedExternalIds: [],
});

describe("retrievalDrift", () => {
  it("reports nothing when every model saw the same retrieved set", () => {
    expect(
      retrievalDrift(
        new Map([
          ["model-a", [obs("q1", ["d1", "d2"])]],
          ["model-b", [obs("q1", ["d1", "d2"])]],
        ]),
      ),
    ).toEqual([]);
  });

  it("reports a question whose retrieved set differed between models", () => {
    const drift = retrievalDrift(
      new Map([
        ["model-a", [obs("q1", ["d1", "d2"])]],
        ["model-b", [obs("q1", ["d2", "d1"])]],
      ]),
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("q1");
  });

  it("reports a question one model never observed", () => {
    const drift = retrievalDrift(
      new Map([
        ["model-a", [obs("q1", ["d1"])]],
        ["model-b", []],
      ]),
    );
    expect(drift).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rag/e2e test -- fixture-invariance`
Expected: FAIL — `Cannot find module '../eval/fixture-invariance.js'`.

- [ ] **Step 3: Implement `fixture-invariance.ts`**

```ts
/**
 * Fixture-invariance check for the multi-model gold run.
 *
 * Retrieval happens before generation and does not depend on the generator, so
 * every model row MUST see a byte-identical retrieved set for every question.
 * If it does not, something non-deterministic sits upstream of the model and
 * the whole comparison is void — any difference between rows could be the
 * fixture rather than the model.
 *
 * This exists because the failure it guards against has already happened once:
 * a "model refuses prematurely" diagnosis turned out to be wrong, and
 * rewording a fixture from naming a code to stating its value flipped 5/5
 * refusals into 5/5 correct answers with model and prompt unchanged. No
 * refusal may be attributed to a model until the fixture is ruled out. This
 * makes "ruled out" a check instead of a claim.
 */
import type { GoldObservation } from "./gold-eval.js";

export function retrievalDrift(
  runs: ReadonlyMap<string, readonly GoldObservation[]>,
): string[] {
  const models = [...runs.keys()];
  const first = models[0];
  if (first === undefined) return [];

  const baseline = new Map(
    (runs.get(first) ?? []).map((o) => [
      o.id,
      o.retrievedExternalIds.join("|"),
    ]),
  );
  const problems: string[] = [];

  for (const model of models.slice(1)) {
    const seen = new Map(
      (runs.get(model) ?? []).map((o) => [
        o.id,
        o.retrievedExternalIds.join("|"),
      ]),
    );
    for (const [id, expected] of baseline) {
      const actual = seen.get(id);
      if (actual === undefined) {
        problems.push(
          `${id}: no observation under ${model} (baseline ${first})`,
        );
      } else if (actual !== expected) {
        problems.push(
          `${id}: retrieved set differs — ${first}=[${expected}] vs ${model}=[${actual}]`,
        );
      }
    }
    for (const id of seen.keys()) {
      if (!baseline.has(id)) {
        problems.push(`${id}: observed under ${model} but not under ${first}`);
      }
    }
  }
  return problems;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @rag/e2e test -- fixture-invariance`
Expected: PASS, all three tests.

- [ ] **Step 5: Let `buildTestApi` take an embedder**

`helpers/api.ts:~233` currently constructs `const embedder = new FakeEmbedder();` and uses it for both the `Retriever` and `deps.embedder`. `helpers/ingestion.ts:41` already states in code that "the embedder used here MUST match the one passed to the retriever", and `corpus-cpa.ts:63-66` records the same constraint twice. Seeding with a `FakeEmbedder` and querying with a real one degrades retrieval to the sparse channel, and the run still completes — it just reports nonsense a self-retrieval assertion happily passes on keyword match alone.

Add to the `opts` object type in `buildTestApi`:

```ts
  /**
   * Embedder for BOTH the retriever and `deps.embedder`. Defaults to
   * `FakeEmbedder`. Pass the SAME INSTANCE that seeded the corpus
   * (`seedEvalCorpus`) — a different instance or provider means dense scores
   * compare vectors from two embedding spaces, and the run reports nonsense
   * rather than failing.
   */
  embedder?: EmbeddingProvider;
```

Add `import type { EmbeddingProvider } from "@rag/core";` to the existing `@rag/core` type import, and change the construction line to:

```ts
const embedder = opts.embedder ?? new FakeEmbedder();
```

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm --filter @rag/e2e typecheck`
Expected: no errors — the parameter is optional, so every existing `buildTestApi` caller is unchanged.

Run (requires `pnpm docker:up`): `pnpm --filter @rag/e2e test -- api.spec`
Expected: PASS. This is the broadest existing consumer of `buildTestApi`.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/src/helpers/api.ts tests/e2e/src/eval/fixture-invariance.ts tests/e2e/src/specs/fixture-invariance.spec.ts
git commit -m "test(eval): pin the embedder in buildTestApi, add retrieval-drift check

buildTestApi hardcoded FakeEmbedder for both the retriever and deps.embedder,
so a runner seeding with a real provider would query a different embedding
space — the run completes and reports nonsense. The parameter is optional, so
no existing caller changes.

retrievalDrift asserts every model row saw a byte-identical retrieved set per
question. Retrieval does not depend on the generator, so a difference means
something non-deterministic sits upstream and the comparison is void. A prior
'model refuses prematurely' conclusion was wrong for exactly this reason:
rewording one fixture flipped 5/5 refusals to 5/5 correct answers with model
and prompt unchanged."
```

---

## Task 4: The model dimension

The deliverable. `run-gold-eval.ts` gains a `GOLD_CORPUS=synthetic` mode that seeds the CPA corpus **once** into a local Postgres, then iterates models by rebuilding the in-process Fastify app with a different `Generator` — one process, one seeding, N model rows, 3 passes each.

**Files:**

- Create: `tests/e2e/src/eval/gold-synthetic-run.ts`
- Modify: `tests/e2e/src/eval/run-gold-eval.ts`

**Interfaces:**

- Consumes: `SYNTHETIC_GOLD_QUESTIONS` + `SYNTHETIC_CORPUS_DOCS` (Task 1); `scoreGoldRun`, `answerBody`, `GoldReport`, `GoldObservation` (Task 2); `retrievalDrift` and `buildTestApi({ embedder })` (Task 3); existing `openTestDb`, `truncateAll`, `assertDestructiveTestTarget`, `createCustomSource` from `helpers/db.js`, `seedEvalCorpus` from `./run-eval.js`.
- Produces: `runSyntheticGoldEval(): Promise<number>` (process exit code), called by `run-gold-eval.ts` when `GOLD_CORPUS=synthetic`.

### Why in-process `inject()` and not an HTTP server per model

The spec's objection to web-e2e was that `GENERATION_MODEL` is baked into process launch, so each model is a full suite reboot (~3–6 min each, ~20–40 min for a five-model matrix). Running a real HTTP API per model reproduces that defect exactly: four reboots, four re-seedings, four chances for the fixture to differ between rows.

Fastify `inject()` runs the **same route handler, the same `askQuestion`, the same `buildPrompt` and the same `SYSTEM_PROMPT`** — it skips only the socket. Rebuilding the app per model costs milliseconds and keeps the seeded database fixed, which is what makes `retrievalDrift` a meaningful check rather than a hope. The existing HTTP mode (`GOLD_CORPUS=real`, the default) is untouched: it targets a deployed firm API and must stay that way.

- [ ] **Step 1: Add the mode switch to `run-gold-eval.ts`**

At the top of `main()`, before the `GOLD_QUESTIONS.length === 0` guard:

```ts
// Two corpora, two venues. `real` (default) is the existing HTTP runner
// against the deployed firm API — its answers are firm-confidential and it
// can never produce the committed table. `synthetic` runs the CPA fixture
// corpus in-process across several models and emits a committable one.
if (process.env.GOLD_CORPUS === "synthetic") {
  const { runSyntheticGoldEval } = await import("./gold-synthetic-run.js");
  process.exit(await runSyntheticGoldEval());
}
```

Extend the file's docblock `Usage:` block with:

```
 *   # Committable multi-model table against the SYNTHETIC CPA corpus.
 *   # Local only: gpt-oss:20b is 12.8 GiB and cannot run on a CI runner.
 *   pnpm docker:up
 *   GOLD_CORPUS=synthetic \
 *   E2E_DATABASE_URL=postgres://rag:rag@127.0.0.1:5432/rag_eval \
 *   EGRESS_ALLOWED_HOSTS=127.0.0.1 \
 *   pnpm eval:gold
```

- [ ] **Step 2: Create `gold-synthetic-run.ts` — header, DB safety, env**

```ts
/**
 * `GOLD_CORPUS=synthetic pnpm eval:gold` — the committable per-model
 * answer-quality table.
 *
 * Seeds `corpus-cpa.ts` (entirely synthetic, every title marked SYNTHETIC
 * SAMPLE) into a local Postgres ONCE, then asks all 32 synthetic gold
 * questions through the real /ask route, once per model per pass, and scores
 * every run with the unchanged `scoreGoldRun`.
 *
 * ── Why in-process ─────────────────────────────────────────────────────────
 *
 * Fastify `inject()` runs the same route handler, the same `askQuestion`, the
 * same `buildPrompt` and the same SYSTEM_PROMPT as a bound server — it skips
 * only the socket. That is what lets one process hold the seeded corpus fixed
 * while swapping the generator, so a difference between two rows is the model
 * and nothing else. A server per model would reboot and re-seed four times,
 * which is the defect that disqualified web-e2e.
 *
 * ── This runner TRUNCATES its database ─────────────────────────────────────
 *
 * `truncateAll` wipes chunks, documents, ingestion_jobs and sources. A
 * worktree bind-mount has previously destroyed local DB data this way, so
 * E2E_DATABASE_URL is REQUIRED here even though `env.databaseUrl` has a
 * default — an unset variable must not silently point this at a dev database.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────────
 *
 *   pnpm docker:up                  # Postgres AND the parser: seedEvalCorpus
 *                                   # routes text through HttpParserClient
 *   ollama serve                    # 127.0.0.1:11434
 *   ollama pull gpt-oss:20b qwen3:8b llama3.1:8b
 *   EGRESS_ALLOWED_HOSTS=127.0.0.1  # UNSET MEANS DENY-ALL, not allow-all
 *
 * Add generativelanguage.googleapis.com to that list and set GEMINI_API_KEY to
 * include the hosted baseline row. The list is MERGED here, not replaced —
 * which is precisely what tests/web-e2e/src/env.ts:31 gets wrong, making a
 * Gemini baseline unreachable there by construction.
 */
import { writeFile } from "node:fs/promises";
import {
  EgressPolicy,
  type EmbeddingProvider,
  type Generator,
} from "@rag/core";
import { FakeEmbedder } from "@rag/test-fixtures";
import { GeminiGenerator, OpenAIGenerator } from "@rag/rag";
import { buildTestApi, type TestInject } from "../helpers/api.js";
import {
  assertDestructiveTestTarget,
  createCustomSource,
  openTestDb,
  truncateAll,
} from "../helpers/db.js";
import { seedEvalCorpus } from "./run-eval.js";
import {
  SYNTHETIC_CORPUS_DOCS,
  SYNTHETIC_GOLD_QUESTIONS,
} from "./gold-set-synthetic.js";
import {
  answerBody,
  scoreGoldRun,
  type GoldObservation,
  type GoldReport,
} from "./gold-eval.js";
import { retrievalDrift } from "./fixture-invariance.js";

/** Passes per model. One pass is a point estimate, not a rate — see PASSES. */
const PASSES = Number(process.env.GOLD_PASSES ?? "3");

/**
 * Steady-state per-request timeout. 14.0 s warm was measured for gpt-oss:20b
 * at 5,075 prompt tokens; 120 s leaves generous headroom without turning a
 * hung request into a 4-minute wait.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Warm-up timeout. A cold Ollama load of gpt-oss:20b measured 225.6 s versus
 * 14.0 s warm, and Ollama unloads after keep_alive (5 min idle by default), so
 * the first request after a quiet period takes ~3.75 minutes. A timeout tuned
 * to warm latency fails the first real question of the day and looks like a
 * hang rather than a load.
 */
const WARMUP_TIMEOUT_MS = 300_000;

/**
 * Retries per question inside a pass. ~8% no-token stall rate (5/65) was
 * recorded on the local 8b stack.
 *
 * THE RULE, so a stall is never confused with a model failure: a STALL is an
 * empty-or-errored attempt that a byte-identical retry resolves. A FAILURE is
 * one that survives every retry — and it is recorded as the observation, so
 * `scoreGoldRun` classifies it (emptyAnswers, or `missing` when the request
 * never returned), never as a stall.
 */
const STALL_RETRIES = 1;

function requireEnv(name: string, why: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(
      `eval:gold[synthetic]: ${name} is required — ${why}\n`,
    );
    process.exit(2);
  }
  return v;
}
```

- [ ] **Step 3: Model specs**

```ts
interface ModelSpec {
  /** Row label in the committed table. */
  key: string;
  provider: "openai" | "gemini";
  model: string;
  /** Set for every self-hosted row; absent for the hosted baseline. */
  baseURL?: string;
  /** Env var holding the key. Ollama ignores the value but the option is required. */
  apiKeyEnv?: string;
  hosted: boolean;
}

const OLLAMA_URL = process.env.GOLD_OLLAMA_URL ?? "http://127.0.0.1:11434/v1";

/**
 * The comparison set. `llama3.1:8b` is the floor (already pulled), `qwen3:8b`
 * the declared fallback if gpt-oss:20b fights the citation prompt, and
 * `gpt-oss:20b` the candidate — which this run exists to confirm or reject,
 * since citation fidelity did not survive a larger context under a
 * hand-written prompt and has never been measured with the real ask.ts prompt.
 *
 * The Gemini row is the hosted baseline. It is included ONLY when
 * GEMINI_API_KEY is set, because it needs a key and real egress; when it is
 * absent the table says so rather than leaving a blank that reads as a zero.
 * Note GeminiGenerator refuses a baseURL by design (GEMINI_BASE_URL_REFUSAL),
 * so this row can never be accidentally pointed at a local endpoint.
 */
const ALL_MODELS: ModelSpec[] = [
  {
    key: "gpt-oss:20b",
    provider: "openai",
    model: "gpt-oss:20b",
    baseURL: OLLAMA_URL,
    hosted: false,
  },
  {
    key: "qwen3:8b",
    provider: "openai",
    model: "qwen3:8b",
    baseURL: OLLAMA_URL,
    hosted: false,
  },
  {
    key: "llama3.1:8b",
    provider: "openai",
    model: "llama3.1:8b",
    baseURL: OLLAMA_URL,
    hosted: false,
  },
  {
    key: "gemini-2.5-flash",
    provider: "gemini",
    model: "gemini-2.5-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    hosted: true,
  },
];

function selectedModels(): ModelSpec[] {
  const requested = process.env.GOLD_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const pool = requested
    ? ALL_MODELS.filter((m) => requested.includes(m.key))
    : ALL_MODELS;
  return pool.filter((m) => {
    if (!m.apiKeyEnv) return true;
    if (process.env[m.apiKeyEnv]) return true;
    process.stderr.write(
      `eval:gold[synthetic]: skipping ${m.key} — ${m.apiKeyEnv} is unset. ` +
        "The hosted baseline row will be absent from the table.\n",
    );
    return false;
  });
}

/**
 * Per-request timeout. The OpenAI SDK captures its own fetch, so a timeout has
 * to be injected here; `GeneratorOptions.fetch` exists for exactly this and is
 * COMPOSED with the redirect-refusing wrapper rather than replacing it, so an
 * injected transport cannot become a way around the allow-list.
 */
function timeoutFetch(ms: number): typeof globalThis.fetch {
  return (input, init) =>
    globalThis.fetch(input as Parameters<typeof globalThis.fetch>[0], {
      ...init,
      // Non-streaming /ask passes no signal of its own, so nothing is dropped.
      signal: AbortSignal.timeout(ms),
    });
}

function makeGenerator(spec: ModelSpec, timeoutMs: number): Generator {
  const egressPolicy = EgressPolicy.fromEnv();
  const common = {
    model: spec.model,
    // Defaults to 2048 in config-schema.ts and appeared sufficient in the
    // Phase 1b measurement. Kept explicit: a smaller value is how the
    // empty-content failure was produced in the first place.
    maxOutputTokens: 2048,
    egressPolicy,
    // Left at the default "block". The corpus is asserted TRI-free by
    // gold-set-synthetic.spec.ts, so blocking costs nothing and relaxing it
    // would make a fixture regression invisible.
    fetch: timeoutFetch(timeoutMs),
  };
  if (spec.provider === "gemini") {
    return new GeminiGenerator({
      ...common,
      apiKey: requireEnv(
        spec.apiKeyEnv!,
        "the hosted baseline row needs a key",
      ),
    });
  }
  return new OpenAIGenerator({
    ...common,
    // Ollama's OpenAI emulation ignores the key; the option is required.
    apiKey: process.env[spec.apiKeyEnv ?? ""] ?? "ollama",
    baseURL: spec.baseURL,
  });
}
```

- [ ] **Step 4: Observation collection, warm-up, and the stall rule**

```ts
interface AskBody {
  answer: string;
  citations: Array<{ documentId: string }>;
  retrieved: Array<{ document: { id: string } }>;
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

function toObservation(
  id: string,
  body: AskBody,
  externalIdByDocId: Map<string, string>,
): GoldObservation {
  const ext = (docId: string): string =>
    externalIdByDocId.get(docId) ??
    // Impossible against a freshly truncated+seeded DB. Surfaced rather than
    // dropped: a silent `?? ""` would read as a fabricated citation.
    `UNKNOWN-DOC-${docId}`;
  return {
    id,
    answer: body.answer,
    retrievedExternalIds: unique(body.retrieved.map((r) => ext(r.document.id))),
    citedExternalIds: unique(body.citations.map((c) => ext(c.documentId))),
  };
}

interface PassResult {
  observations: GoldObservation[];
  stalls: number;
  attempts: number;
  elapsedMs: number[];
}

async function runPass(
  inject: TestInject,
  externalIdByDocId: Map<string, string>,
): Promise<PassResult> {
  const observations: GoldObservation[] = [];
  const elapsedMs: number[] = [];
  let stalls = 0;
  let attempts = 0;

  for (const q of SYNTHETIC_GOLD_QUESTIONS) {
    for (let attempt = 0; attempt <= STALL_RETRIES; attempt++) {
      attempts++;
      const started = Date.now();
      let body: AskBody | null = null;
      try {
        const res = await inject({
          method: "POST",
          url: "/ask",
          payload: { question: q.query },
        });
        body = res.statusCode === 200 ? (res.json() as AskBody) : null;
        if (body === null) {
          process.stderr.write(
            `\n  ${q.id}: POST /ask -> ${res.statusCode} ${res.body.slice(0, 200)}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`\n  ${q.id}: ${String(err)}\n`);
      }
      const elapsed = Date.now() - started;

      const nothing = body === null || answerBody(body.answer) === "";
      if (!nothing) {
        if (attempt > 0) stalls++;
        elapsedMs.push(elapsed);
        observations.push(toObservation(q.id, body!, externalIdByDocId));
        process.stdout.write(attempt > 0 ? "r" : ".");
        break;
      }
      if (attempt === STALL_RETRIES) {
        // Survived every retry: a real failure, not a stall. Recorded as the
        // observation so scoreGoldRun classifies it — emptyAnswers when the
        // model returned nothing, `missing` when the request never returned.
        elapsedMs.push(elapsed);
        if (body)
          observations.push(toObservation(q.id, body, externalIdByDocId));
        process.stdout.write(body ? "0" : "x");
      }
    }
  }
  process.stdout.write("\n");
  return { observations, stalls, attempts, elapsedMs };
}

/**
 * One discarded request before the first scored pass. Ollama unloads after
 * keep_alive, so without this the first scored question absorbs a 225.6 s
 * cold load and its latency column is a load time, not a generation time.
 */
async function warmUp(
  spec: ModelSpec,
  db: Parameters<typeof truncateAll>[0],
  embedder: EmbeddingProvider,
): Promise<void> {
  if (spec.hosted) return;
  process.stdout.write(
    `  warming ${spec.key} (cold load can take ~225 s) ... `,
  );
  const api = await buildTestApi({
    db,
    embedder,
    generator: makeGenerator(spec, WARMUP_TIMEOUT_MS),
  });
  try {
    const started = Date.now();
    await api.inject({
      method: "POST",
      url: "/ask",
      payload: { question: SYNTHETIC_GOLD_QUESTIONS[0]!.query },
    });
    process.stdout.write(
      `${((Date.now() - started) / 1000).toFixed(1)} s (discarded)\n`,
    );
  } finally {
    await api.close();
  }
}
```

- [ ] **Step 5: Orchestration — seed once, iterate models, three passes each**

```ts
interface ModelRow {
  spec: ModelSpec;
  reports: GoldReport[];
  stalls: number;
  attempts: number;
  medianSeconds: number;
}

export async function runSyntheticGoldEval(): Promise<number> {
  // REQUIRED even though env.databaseUrl has a default: this truncates.
  requireEnv(
    "E2E_DATABASE_URL",
    "this runner TRUNCATEs chunks/documents/ingestion_jobs/sources; point it at a disposable local database",
  );
  assertDestructiveTestTarget(process.env);

  const models = selectedModels();
  if (models.length === 0) {
    process.stderr.write("eval:gold[synthetic]: no models selected\n");
    return 2;
  }
  if (EgressPolicy.fromEnv().allowedHosts.length === 0) {
    process.stderr.write(
      "eval:gold[synthetic]: EGRESS_ALLOWED_HOSTS is unset, which is DENY-ALL — " +
        "every /ask would fail with EGRESS_BLOCKED. Set it to 127.0.0.1 " +
        "(plus generativelanguage.googleapis.com for the hosted row).\n",
    );
    return 2;
  }

  // ONE instance, used to seed and to query. Two instances compare vectors
  // from two embedding spaces and the run reports nonsense without failing.
  const embedder: EmbeddingProvider = new FakeEmbedder();

  const { db, close } = openTestDb();
  const rows: ModelRow[] = [];
  const firstPassByModel = new Map<string, readonly GoldObservation[]>();
  try {
    await truncateAll(db);
    const sourceId = await createCustomSource(db, "gold-synthetic-cpa");
    const externalIdByDocId = await seedEvalCorpus(
      db,
      sourceId,
      embedder,
      SYNTHETIC_CORPUS_DOCS,
    );
    process.stdout.write(
      `Seeded ${SYNTHETIC_CORPUS_DOCS.length} synthetic documents; ` +
        `${SYNTHETIC_GOLD_QUESTIONS.length} questions x ${PASSES} passes x ${models.length} models\n`,
    );

    for (const spec of models) {
      process.stdout.write(`\n=== ${spec.key} ===\n`);
      await warmUp(spec, db, embedder);

      const reports: GoldReport[] = [];
      const elapsed: number[] = [];
      let stalls = 0;
      let attempts = 0;
      for (let pass = 1; pass <= PASSES; pass++) {
        process.stdout.write(`  pass ${pass}/${PASSES} `);
        const api = await buildTestApi({
          db,
          embedder,
          generator: makeGenerator(spec, REQUEST_TIMEOUT_MS),
        });
        try {
          const result = await runPass(api.inject, externalIdByDocId);
          reports.push(
            scoreGoldRun(SYNTHETIC_GOLD_QUESTIONS, result.observations),
          );
          stalls += result.stalls;
          attempts += result.attempts;
          elapsed.push(...result.elapsedMs);
          if (pass === 1) firstPassByModel.set(spec.key, result.observations);
        } finally {
          await api.close();
        }
      }
      const sorted = [...elapsed].sort((a, b) => a - b);
      rows.push({
        spec,
        reports,
        stalls,
        attempts,
        medianSeconds: (sorted[Math.floor(sorted.length / 2)] ?? 0) / 1000,
      });
    }
  } finally {
    await close();
  }

  const drift = retrievalDrift(firstPassByModel);
  process.stdout.write("\n" + formatModelTable(rows, drift) + "\n");

  const out =
    process.env.GOLD_OUT ?? "tests/e2e/src/eval/answer-quality-result.md";
  await writeFile(out, formatModelTable(rows, drift) + "\n", "utf8");
  process.stdout.write(
    `\nMarkdown written to ${out}. Every answer in this run came from the\n` +
      "SYNTHETIC CPA corpus, so unlike GOLD_CORPUS=real it is safe to commit.\n" +
      "Paste it into docs/EVAL-ANSWER-QUALITY.md under a provenance header.\n",
  );

  // Retrieval cannot depend on the generator. If it drifted, something
  // non-deterministic sits upstream of the model and no row is attributable.
  if (drift.length > 0) {
    for (const d of drift) process.stderr.write(`  drift: ${d}\n`);
    process.stderr.write(
      "eval:gold[synthetic]: retrieval differed between model rows — the table is VOID. " +
        "Do not commit it and do not attribute any difference to a model.\n",
    );
    return 1;
  }
  const hardFail = rows.some((r) =>
    r.reports.some(
      (rep) =>
        rep.fabricatedCitations.length > 0 || rep.emptyAnswers.length > 0,
    ),
  );
  return hardFail ? 1 : 0;
}
```

- [ ] **Step 6: The table formatter**

```ts
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** min–max across passes, or a single value when they agree. */
function range(values: number[], fmt: (n: number) => string): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}

function formatModelTable(rows: ModelRow[], drift: string[]): string {
  const answerable = SYNTHETIC_GOLD_QUESTIONS.filter(
    (q) => q.relevant.length > 0,
  ).length;
  const coverage = SYNTHETIC_GOLD_QUESTIONS.length - answerable;
  const out: string[] = [];

  out.push(
    `Corpus: corpus-cpa.ts — ${SYNTHETIC_CORPUS_DOCS.length} synthetic documents, ` +
      `${SYNTHETIC_GOLD_QUESTIONS.length} questions (${answerable} answerable, ${coverage} coverage). ` +
      `${PASSES} passes per model.`,
  );
  out.push("");
  out.push(
    `Retrieval invariance across model rows: ${drift.length === 0 ? "PASS — identical" : `FAIL (${drift.length} questions) — TABLE VOID`}`,
  );
  out.push("");
  out.push(
    "| model | hosted | recall@5 | MRR | refused correctly | wrong refusals | uncited | empty (hard fail) | truncated | fabricated | stalls | median s/q |",
  );
  out.push(
    "| ----- | ------ | -------- | --- | ----------------- | -------------- | ------- | ----------------- | --------- | ---------- | ------ | ---------- |",
  );
  for (const r of rows) {
    const R = r.reports;
    out.push(
      `| \`${r.spec.key}\` | ${r.spec.hosted ? "yes" : "no"} ` +
        `| ${range(
          R.map((x) => x.recallAtK[5] ?? 0),
          pct,
        )} ` +
        `| ${range(
          R.map((x) => x.mrr),
          (n) => n.toFixed(3),
        )} ` +
        `| ${range(
          R.map((x) => x.coverage.correctlyRefused),
          String,
        )}/${coverage} ` +
        `| ${range(
          R.map((x) => x.wrongRefusals.length),
          String,
        )} ` +
        `| ${range(
          R.map((x) => x.uncitedAnswers.length),
          String,
        )} ` +
        `| ${range(
          R.map((x) => x.emptyAnswers.length),
          String,
        )} ` +
        `| ${range(
          R.map((x) => x.truncated.length),
          String,
        )} ` +
        `| ${range(
          R.map((x) => x.fabricatedCitations.length),
          String,
        )} ` +
        `| ${r.stalls}/${r.attempts} ` +
        `| ${r.medianSeconds.toFixed(1)} |`,
    );
  }
  out.push("");
  out.push("How to read this:");
  out.push("");
  out.push(
    "- Ranges are min–max across passes. **A difference between two models that is smaller than either model's own range is not a difference** — report it as indistinguishable.",
  );
  out.push(
    "- `stalls` counts attempts that returned nothing and were resolved by a byte-identical retry. An attempt that survived every retry is NOT a stall: it is recorded as the observation and lands in `empty` or in failed requests.",
  );
  out.push(
    "- `uncited` is the citation-fidelity number: a substantive, non-refused answer with no `[N]` marker the answer actually referenced. Refusals cite nothing by design and are excluded.",
  );
  out.push(
    "- `empty` is a model that returned no content at all — `gpt-oss:20b`'s separate `reasoning` field winning the output budget is the known cause. It is a hard fail and is counted inside `truncated` too when `finish_reason` was `length`.",
  );
  out.push(
    "- `recall@5`/`MRR` are properties of the FIXTURE, not of the model: retrieval runs before generation with a fixed embedder, so these columns must be identical down every row. They are printed as a cross-check on the invariance line above, not as a model score.",
  );
  out.push(
    "- Every row ran against byte-identical fixtures. No refusal in this table may be attributed to a model without first ruling out the fixture — rewording one fixture has previously flipped 5/5 refusals to 5/5 correct answers with model and prompt unchanged.",
  );
  if (drift.length > 0) {
    out.push("");
    out.push("Drift detail:");
    for (const d of drift) out.push(`- ${d}`);
  }
  return out.join("\n");
}
```

- [ ] **Step 7: Run it and verify each guard, cheapest first**

Run: `pnpm --filter @rag/e2e typecheck`
Expected: no errors.

Run (no DB needed): `GOLD_CORPUS=synthetic pnpm eval:gold`
Expected: exit 2 with `E2E_DATABASE_URL is required — this runner TRUNCATEs …`. This is the DB-safety guard; confirm it before pointing anything at a database.

Run: `GOLD_CORPUS=synthetic E2E_DATABASE_URL=postgres://rag:rag@127.0.0.1:5432/rag_eval pnpm eval:gold`
Expected: exit 2 with the `EGRESS_ALLOWED_HOSTS is unset, which is DENY-ALL` message.

Now the real pass — one 8b model first, one pass, to shake out wiring before spending 20 minutes on `gpt-oss:20b`:

```bash
pnpm docker:up
ollama serve &
GOLD_CORPUS=synthetic \
E2E_DATABASE_URL=postgres://rag:rag@127.0.0.1:5432/rag_eval \
EGRESS_ALLOWED_HOSTS=127.0.0.1 \
GOLD_MODELS=llama3.1:8b GOLD_PASSES=1 \
pnpm eval:gold
```

Expected: a one-row table. Specifically check `recall@5` is **not** 0.0% — a 0 means the questions were scored against the wrong corpus (the `seedEvalCorpus` docs argument) or the embedder differed between seed and query.

Then the full matrix:

```bash
GOLD_CORPUS=synthetic \
E2E_DATABASE_URL=postgres://rag:rag@127.0.0.1:5432/rag_eval \
EGRESS_ALLOWED_HOSTS=127.0.0.1,generativelanguage.googleapis.com \
GEMINI_API_KEY=... \
pnpm eval:gold
```

Expected: four rows (three if no key), `Retrieval invariance … PASS — identical`, and `recall@5`/`MRR` byte-identical down every row. Budget roughly 22 min for `gpt-oss:20b` (96 questions × ~14 s) plus ~8 min per 8b model plus ~5 min for Gemini — about 45 min, plus one ~4-minute cold load.

**If `Retrieval invariance` reports FAIL: stop.** Do not commit the table and do not interpret any row. Investigate the non-determinism upstream of the model first.

**If `gpt-oss:20b`'s `uncited` column is high while the 8b rows are low**, that is the Phase 1b citation-fidelity signal reproducing under the real prompt, and it is the finding this plan exists to produce. Record it; do not tune the prompt in this plan.

- [ ] **Step 8: Gitignore the intermediate artifact**

Add under the existing `gold-*.json` entry in `.gitignore`:

```
# intermediate output of GOLD_CORPUS=synthetic; the reviewed copy lives in
# docs/EVAL-ANSWER-QUALITY.md with its provenance header
tests/e2e/src/eval/answer-quality-result.md
```

- [ ] **Step 9: Commit**

```bash
git add tests/e2e/src/eval/gold-synthetic-run.ts tests/e2e/src/eval/run-gold-eval.ts .gitignore
git commit -m "feat(eval): add a model dimension to eval:gold over the synthetic corpus

GOLD_CORPUS=synthetic seeds corpus-cpa.ts once into a local Postgres, then
iterates models by rebuilding the in-process Fastify app with a different
Generator — one process, one seeding, N rows, 3 passes each. The existing
GOLD_CORPUS=real HTTP runner against the deployed firm API is unchanged and
remains the default.

In-process inject() runs the same route, the same askQuestion, the same
buildPrompt and the same SYSTEM_PROMPT; it skips only the socket. That is what
keeps the seeded corpus fixed across model rows, which is what makes the
retrieval-invariance check meaningful. A server per model would reboot and
re-seed per row, the defect that disqualified web-e2e.

Designed around the measured hazards: a discarded warm-up request with a 300 s
timeout for the 225.6 s cold load; three passes reported as min-max ranges
because a single pass cannot express an ~8% stall rate; one retry per question
with a stall defined as an empty attempt a byte-identical retry resolves, and
anything surviving every retry recorded as the observation so scoreGoldRun
classifies it; EGRESS_ALLOWED_HOSTS merged rather than replaced so a Gemini
baseline is reachable; E2E_DATABASE_URL required because this TRUNCATEs."
```

---

## Task 5 (optional, last): wire the groundedness judge

Skippable. The table is complete and committable without it. Do this only if a groundedness column is wanted, and never to "finish" Task 4.

`faithfulness.ts` is a finished, unit-tested library with no caller: `checkCitations`, `buildJudgePrompt`, `parseJudgeReply` and `aggregateFaithfulness` all have real bodies, and 10 tests in `eval-faithfulness.spec.ts` cover them. The spec's "only groundedness is genuinely absent" is therefore half right — what is missing is the judge **call**, not the scoring. This task is ~60 lines of wiring.

**Files:**

- Modify: `tests/e2e/src/eval/gold-synthetic-run.ts`

- [ ] **Step 1: Decide and record the judge, before writing code**

Constraints, non-negotiable:

- **The judge must never be one of the models under test.** A model grading its own output is not a measurement.
- **The judge must be named in the table.** `gold-set.ts:20-23` warns that a gold artifact nobody qualified produces "confident, meaningless numbers"; an anonymous judge is the same failure one level up.
- **The judge needs the retrieved chunk TEXT**, which `/ask`'s response does not carry (`sanitizeRetrievalResults` strips it, and `FaithfulnessInput.retrieved` is documented as "exactly the chunks shown to the generator — not a re-retrieval"). Re-retrieving would score a different context than the model saw. Obtain the text from the seeded corpus by `externalId` — `SYNTHETIC_CORPUS_DOCS` holds it, and the corpus is synthetic so there is no confidentiality concern.
- `GOLD_JUDGE_MODEL` unset means the column is absent, not zero.

- [ ] **Step 2: Add the judge call**

```ts
import {
  aggregateFaithfulness,
  buildJudgePrompt,
  checkCitations,
  parseJudgeReply,
  type FaithfulnessResult,
  type FaithfulnessSummary,
} from "./faithfulness.js";

/**
 * Groundedness, scored by an LLM judge over the chunks the generator actually
 * saw. Off unless GOLD_JUDGE_MODEL is set — an uncalibrated judge produces
 * exactly the confident, meaningless numbers gold-set.ts warns about, so the
 * column is absent rather than zero when no judge is configured.
 *
 * The judge is NEVER one of the models under test, and its identity is printed
 * beside the column. buildJudgePrompt already scopes it to entailment only and
 * treats abstention as correct behaviour rather than a failure.
 */
async function judgeGroundedness(
  observations: readonly GoldObservation[],
  judge: Generator,
): Promise<FaithfulnessSummary> {
  const textByExternalId = new Map(
    SYNTHETIC_CORPUS_DOCS.map((d) => [d.externalId, d.text]),
  );
  const results: FaithfulnessResult[] = [];

  for (const o of observations) {
    const retrieved = o.retrievedExternalIds.map((id) => ({
      chunkId: id,
      documentExternalId: id,
      text: textByExternalId.get(id) ?? "",
    }));
    const input = {
      question:
        SYNTHETIC_GOLD_QUESTIONS.find((q) => q.id === o.id)?.query ?? o.id,
      answer: o.answer,
      retrieved,
      citedDocumentIds: o.citedExternalIds,
    };
    // Deterministic, no-model check first: a fabricated citation needs no judge.
    const { fabricatedCitations } = checkCitations(input);
    // The judge is reached through the same Generator seam as a model row, so
    // the prompt travels the same egress pre-flight and TRI screen.
    const reply = await judge.answer(buildJudgePrompt(input), []);
    try {
      results.push({ ...parseJudgeReply(reply.answer), fabricatedCitations });
    } catch (err) {
      // parseJudgeReply throws rather than guessing. A judge that returned no
      // JSON is a judge failure, not a groundedness score — skip, loudly.
      process.stderr.write(`\n  judge ${o.id}: ${String(err)}\n`);
    }
  }
  return aggregateFaithfulness(results);
}
```

Wire it into `runSyntheticGoldEval` after each model's **first** pass only (one judged pass per model keeps the cost bounded; the ranges in the other columns already carry the variance story), add a `groundedness` column to `formatModelTable`, and print `Judge: <GOLD_JUDGE_MODEL>` above the table.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @rag/e2e test -- eval-faithfulness`
Expected: PASS — all 10 existing tests, unchanged. This task adds a caller, not behavior.

Run with `GOLD_MODELS=llama3.1:8b GOLD_PASSES=1 GOLD_JUDGE_MODEL=gemini-2.5-flash`.
Expected: a `groundedness` column with a mean over scoreable answers and an abstention count reported separately — **not** abstentions averaged in as zero. If the mean is `null`, nothing was scoreable; report it as such.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/src/eval/gold-synthetic-run.ts
git commit -m "feat(eval): wire the groundedness judge into the synthetic gold run

faithfulness.ts has been a finished, unit-tested library with no caller:
checkCitations, buildJudgePrompt, parseJudgeReply and aggregateFaithfulness
all have real bodies and 10 passing tests, but nothing ever sent a judge
prompt to a model. The spec's 'only groundedness is genuinely absent' was half
right — the scoring existed, the call did not.

Off unless GOLD_JUDGE_MODEL is set, because an uncalibrated judge produces the
confident meaningless numbers gold-set.ts warns about. The judge is never one
of the models under test and is named beside the column. Chunk text comes from
the seeded synthetic corpus rather than a re-retrieval, so the judge scores
the context the generator actually saw."
```

---

## Task 6: Record the run with provenance

**Files:**

- Create: `docs/EVAL-ANSWER-QUALITY.md`
- Modify: `docs/EVAL-GOLD-SET-GUIDE.md`
- Modify: `docs/specs/local-llm-verification.md`

- [ ] **Step 1: Collect the provenance facts**

```bash
sw_vers -productVersion
ollama --version
ollama list | grep -E 'gpt-oss|qwen3|llama3.1'   # NAME, ID (digest prefix), SIZE
git rev-parse --short HEAD
git log -1 --format=%H -- tests/e2e/src/eval/corpus-cpa.ts
```

`gpt-oss:20b` cannot run on a GitHub runner, so this table is a one-machine artifact. Recording host, Ollama version, model digests, corpus SHA and date is what makes it reproducible **in principle** — without them it is an anecdote.

- [ ] **Step 2: Write `docs/EVAL-ANSWER-QUALITY.md`**

Structure, in this order:

1. **What this measures, and what it does not.** Retrieval, coverage/refusal, citation fidelity, truncation, empty answers, optionally groundedness. **Not** substantive CPA correctness — every question is `tier1-automatable` with no `expectedAnswer`, so nothing here is a professional determination.
2. **Provenance block** — host (Apple M5 Pro, 48 GB unified, macOS version), Ollama version, each model's name + digest + on-disk size, `GEMINI_API_KEY` present y/n, embedder (`FakeEmbedder`, pinned on both sides), corpus file + git SHA, repo HEAD, passes, date, wall clock.
3. **Egress state, stated plainly.** This run had `EGRESS_ALLOWED_HOSTS=127.0.0.1[,generativelanguage.googleapis.com]`. It is therefore **not** a zero-egress run, and the Gemini row in particular sent every prompt to a third party. A run that includes the hosted baseline cannot also be the evidence for an air-gap claim. Cross-reference `docs/LOCAL-GENERATION.md`'s self-hosted-vs-air-gapped distinction.
4. **The table**, pasted from the runner.
5. **How to read it** — the "How to read this" block the formatter emits, verbatim.
6. **Verdict on `gpt-oss:20b`.** The spec holds it as "a viable candidate, not a confirmed choice" pending exactly this measurement. State what the `uncited` and `empty` columns show and whether it is adopted, rejected, or still unresolved. If the citation-fidelity problem reproduces under the real `ask.ts` prompt, say so and name the fallback (`qwen3:8b`).
7. **Reproduce it** — the full command block from Task 4 Step 7.
8. **What runs in CI** — the four CI-safe test files, and why the sweep itself cannot.

- [ ] **Step 3: Distinguish the two gold sets in `EVAL-GOLD-SET-GUIDE.md`**

Add a section near the top: `gold-set.ts` is the real firm set (empty by design, CPA-authored, firm-confidential output, `GOLD_CORPUS=real`); `gold-set-synthetic.ts` is the committable fixture set (derived from `corpus-cpa.ts`, tier1 only, `GOLD_CORPUS=synthetic`). State that the synthetic set **does not substitute** for the real one: it measures the pipeline's behaviour, not whether the firm's answers are right, and populating the real set remains outstanding work for a credentialed preparer.

- [ ] **Step 4: Settle Phase 4 and success criterion 5 in the spec**

Append a `## Phase 4 result (measured <date>)` section mirroring the existing "Phase 1b result" style. It must:

- Link `docs/EVAL-ANSWER-QUALITY.md` and mark success criterion 5 satisfied.
- **Correct line 94's claim.** `faithfulness.ts` already implemented groundedness scoring and was unit-tested; what was missing was the judge call and the wiring. The claim as written sent a reader looking for a module that was already there.
- Record the `gpt-oss:20b` verdict.

Do **not** rewrite the Retractions section or the Phase 1b result — they are the past-tense record of what drove this work, and the Phase 0/1 ledger established the standing ruling that such sections are not edited.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @rag/e2e test` and `node scripts/check-file-sizes.mjs`
Expected: PASS; every touched file under 800 lines.

Run: `git diff --stat` and confirm `tests/e2e/src/eval/answer-quality-result.md` is **not** staged and no `gold-*.json` appears.

- [ ] **Step 6: Commit**

```bash
git add docs/EVAL-ANSWER-QUALITY.md docs/EVAL-GOLD-SET-GUIDE.md docs/specs/local-llm-verification.md
git commit -m "docs: record the per-model answer-quality table and settle Phase 4

Satisfies success criterion 5: a pnpm eval:gold run over a synthetic gold set
producing a committable per-model table with no firm-confidential content.

Carries full provenance — host, Ollama version, model digests, corpus git SHA,
embedder, passes, date — because gpt-oss:20b (12.8 GiB) cannot run on a CI
runner, so the table is a one-machine artifact and those facts are the only
thing that makes it reproducible in principle. States the run's egress state
plainly: including the hosted Gemini baseline means this run is not evidence
for an air-gap claim.

Corrects the spec's 'only groundedness is genuinely absent': faithfulness.ts
already implemented and unit-tested the scoring; the judge call and the wiring
were what did not exist."
```

---

## Self-review notes

**Spec coverage.** Phase 4's two named gaps map one-to-one: `gold-set.ts:93` empty → Task 1 (via a new file, because `GOLD_QUESTIONS` must stay empty); `run-gold-eval.ts:1-17` targeting the firm corpus → Task 4 (via a mode switch, because the real HTTP runner must keep working). "Add groundedness there if wanted" → Task 5, optional. Success criterion 5 → Task 6.

**Forbidden items honoured.** No second harness: `scoreGoldRun` scores every run, gains two fields, and loses none — its seven existing tests pass untouched. No `tests/web-e2e/` change: nothing in this plan touches that directory, and the formatter's "How to read this" block records why, so it is not revisited.

**Review Focus coverage.** 1 → Task 2 Step 1 (two `emptyAnswers` tests). 2 → Task 2 Step 1 (`uncitedAnswers` plus a refusal negative control). 3 → Task 3 Steps 1/3 and Task 4 Step 7's invariance gate. 4 → Task 3 Step 5 and Task 4 Step 5's single shared `embedder`. 5 → Task 4 Step 2's `PASSES`/`STALL_RETRIES` and the min–max formatter. 6 → Task 4 Step 4's `warmUp` and the two timeout constants. 7 → Task 1 Step 1's `scanForTRI` guard.

**Type consistency.** `answerBody` is defined in Task 2 Step 3 and consumed in Task 4 Step 4. `GoldReport.emptyAnswers`/`uncitedAnswers` are added in Task 2 and read in Task 2 Step 5's formatter and Task 4 Step 6's. `buildTestApi`'s `embedder` is added in Task 3 Step 5 and passed in Task 4 Steps 4/5. `retrievalDrift`'s `ReadonlyMap<string, readonly GoldObservation[]>` matches `firstPassByModel`'s type exactly.

**Known gap, deliberately out of scope.** 32 questions over 7 fixture documents is below `gold-set.ts:90`'s 30–50 target measured in _difficulty_, not count. Closing it needs more synthetic documents with more near-neighbour collisions, which is a corpus task, not a harness task. The honest consequence: `recall@5` on this corpus will sit high and will not discriminate between retrieval strategies — which is fine here, because retrieval is held constant on purpose and the model dimension is generation. Do not read the retrieval columns as an embedding-quality result; `pnpm eval:real` is the tool for that.

**One unresolved decision, for the owner.** `makeTestConfig()` sets `retrieval.minDenseSimilarity` unset and `rerank.provider: "none"`. The spec's fragility note (`:331-334`) is therefore satisfied — no floor means `ask.ts:419` never short-circuits to `EMPTY_ANSWER` without a model call, so every refusal in the table is a real model refusal. If anyone later sets that floor in the e2e config, every refusal assertion silently becomes model-independent: still green, now meaningless. Worth a guard assertion, but it belongs to whoever owns `env.ts`, not to this plan.
