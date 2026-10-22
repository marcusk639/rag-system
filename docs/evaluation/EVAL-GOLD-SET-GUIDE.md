---
title: Building the gold set
status: current
last_verified: 2026-10-21
verified_against: 6d5b458
answers: How to run the working session with a credentialed CPA that fills tests/e2e/src/eval/gold-set.ts, how to record entries, and how to score them with pnpm eval:gold.
read_when: Preparing or running the gold-set session, adding gold questions, or running pnpm eval:gold.
supersedes: []
code:
  [
    tests/e2e/src/eval/gold-set.ts,
    tests/e2e/src/eval/gold-eval.ts,
    tests/e2e/src/eval/run-gold-eval.ts,
  ]
---

# Building the gold set

This is the procedure for a working session of about 90 minutes. Doug, the firm's credentialed preparer,
and Marcus, the engineer, produce entries in `tests/e2e/src/eval/gold-set.ts`; see
[../GLOSSARY.md](../GLOSSARY.md) for both roles. The gold set is empty today, by design. It is the input
that turns "is the KB assistant any good?" into a measurement. Until it exists, no number in
[EVALUATION.md](./EVALUATION.md) speaks to the firm's own documents, and no answer is checked for
correctness.

It needs a CPA. An engineer can write questions but cannot verify that an answer is correct tax or
accounting practice. A gold set whose answers nobody qualified has checked produces confident, meaningless
scores. The tier rules are in [EVALUATION.md](./EVALUATION.md#scoring-tiers).

## What this unblocks

The eval corpora in `pnpm eval` are synthetic. The sparse-arm fix showed the dense/sparse sweep does
respond (see [EVALUATION.md](./EVALUATION.md#current-results)). But a synthetic corpus can't say whether a
weight, chunk size, embedding model or reranker is right for the firm's documents. A gold set with real
near-neighbour distractors can, so it is the input for those decisions. It is item 7 in
[../launch/LAUNCH-RUNBOOK.md](../launch/LAUNCH-RUNBOOK.md), at P2 priority.

## Before the session

Marcus does these, about 15 minutes ahead.

1. Open the web assistant. Its production URL is in
   [../operations/DEPLOYMENT.md](../operations/DEPLOYMENT.md).
2. Confirm Doug has a source grant ([../operations/ACCESS-CONTROL.md](../operations/ACCESS-CONTROL.md)).
   Without one he sees a working screen and zero results, which looks exactly like a broken system. Grant it
   before he sits down.
3. Bring a document list from the indexed SharePoint KB, so `relevant` ids can be filled in without
   searching. The list holds real titles: keep it out of tracked files.

Done when Doug can sign in and get a cited answer to any question.

## The session

### Step 1: questions first, answers never in view (30 min)

Ask Doug for real questions staff actually ask him, ideally ones he answers more than once a month.
Interruptions he resents are good candidates.

Write every question down before running any through the assistant. Seeing an answer first contaminates the
question: people reshape it toward what the system did well, and the set stops being a test.

Target 30–50 questions. Fewer is fine if they are hard (step 3).

### Step 2: label the source documents (20 min)

For each question, record the `externalId` of each document that should answer it.

An empty `relevant: []` is a valid and valuable answer. It asserts the KB does not cover the question,
which turns it into a coverage test instead of a retrieval test. These entries feed the authoring queue
directly. Don't force a label to avoid a blank.

### Step 3: name the distractors (20 min)

This is the highest-value step. For each question, ask Doug: "what's a document that sounds like the right
answer but isn't?" Record it in `distractorNote`.

Two similar-sounding topics that only a real embedding model can tell apart are worth more than twenty
questions about obviously distinct subjects. Ten questions with real distractors beat fifty without. If
time runs short, cut the count and keep the distractors.

### Step 4: expected answers, for the ones that matter (20 min)

Where correctness is load-bearing, Doug states what a correct answer must contain: substance, not wording.
Record it with `tier: "tier2-cpa-verified"`, `verifiedBy` and `verifiedOn`. `validateGoldSet()` rejects an
`expectedAnswer` without attribution, because an unattributed gold answer looks authoritative while being
untraceable.

Everything else stays `tier: "tier1-automatable"`. Those questions are still scored for retrieval and
refusals, just not for professional correctness.

Done when every question has `relevant` (possibly empty) and a tier, and every `expectedAnswer` is
attributed.

## Recording entries

The shape is `GoldQuestion` in `gold-set.ts`. The entry below is illustrative formatting only. Nobody has
verified its content; don't copy it into the gold set.

```ts
export const GOLD_QUESTIONS: GoldQuestion[] = [
  {
    id: "gold-q-001",
    query: "How do we handle a client who missed their estimated payment?",
    relevant: ["sharepoint:.../estimated-payments-sop"],
    tier: "tier2-cpa-verified",
    expectedAnswer:
      "Must mention the safe-harbor test and that the penalty is computed " +
      "per quarter rather than annually.",
    verifiedBy: "Doug",
    verifiedOn: "2026-08-15",
    distractorNote:
      "The late-FILING SOP uses nearly identical vocabulary. Keyword search " +
      "returns it first; only a semantic match separates payment from filing.",
  },
];
```

Rules:

- **Never renumber ids.** Results are keyed on them, and renumbering silently breaks every historical
  comparison.
- **Keep real and seeded questions apart.** This file holds only real, CPA-sourced questions. Fictional
  seeded questions belong in a separate, clearly labelled file.

## Afterwards

1. Validate the structure:

   ```bash
   npx vitest run --root tests/e2e src/specs/eval-faithfulness.spec.ts
   ```

2. Score the set against the deployed KB with `pnpm eval:gold`, as described in the next section.
   `pnpm eval:real` does not read the gold set; it measures the synthetic corpora.
3. Record the first gold-set numbers in [EVALUATION.md](./EVALUATION.md#current-results), dated, as the
   first measurement on the firm's own documents.
4. Re-run the dense/sparse sweep and any reranker comparison against this set. Those decisions become
   measurable once it exists.

Done when `pnpm eval:gold` exits 0 and the dated numbers are recorded.

## What good looks like

- 30–50 questions, with a substantial share carrying a `distractorNote`.
- Several with `relevant: []`. These are honest coverage gaps, not padding.
- Every `expectedAnswer` attributed to a named verifier and a date.
- Questions Doug recognises as things he is actually asked, not plausible inventions.

If the first scores are near-perfect, suspect the question set before believing the system. A
vocabulary-disjoint corpus already produced 100% recall and MRR 1.000 while discriminating nothing.

## Running `pnpm eval:gold`

```bash
GOLD_API_URL=https://<rag-api-host> \
GOLD_API_TOKEN=<token scoped to the sources the questions cover> \
GOLD_OUT=gold-2026-10-21.json \
  pnpm eval:gold
```

`GOLD_OUT` is optional; drop that line to skip the JSON report.

What it does:

- **Reads only.** It calls the deployed `POST /ask` for each question. It resolves retrieved and cited
  documents to connector `externalId`s through `GET /documents/:id`. Requests are paced to the `/ask` limit
  of 10 per minute.
- **Reports retrieval.** It gives recall@1/3/5 and MRR for questions with a non-empty `relevant`.
- **Reports refusals.** It counts correct refusals on `relevant: []` questions, answerable questions that
  were refused, fabricated citations, and truncated answers.
- **Does not score faithfulness or correctness.** Claim-level faithfulness needs the calibrated judge in
  [EVALUATION.md](./EVALUATION.md#calibrated-judge-specification-open). Tier-2 correctness needs the
  credentialed reviewer.

Constraints:

- `GOLD_API_URL` must be https. http is allowed only for localhost, because the token goes with every
  request.
- `GOLD_OUT` contains real knowledge-base answers. `gold-*.json` is gitignored. Treat the file as
  firm-confidential and keep it out of commits and issues.

| Exit code | Meaning                                         |
| --------- | ----------------------------------------------- |
| 2         | Gold set empty or invalid, or bad configuration |
| 1         | A fabricated citation, or a failed request      |
| 0         | Otherwise                                       |
