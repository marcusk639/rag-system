# Building the gold set — a working session with Doug

**Purpose:** produce the question set that makes "is the KB assistant any good?"
a measurable question instead of an opinion. **Time:** ~90 minutes.
**Who:** Doug (or another credentialed preparer) + Marcus. **Output:** entries in
`tests/e2e/src/eval/gold-set.ts`.

> **Why this cannot be done without a CPA.** Marcus can write questions. He
> cannot verify that an answer is correct tax or accounting practice — and a gold
> set whose answers nobody qualified has checked produces confident, meaningless
> scores. Verified correctness is the entire value of the artifact.

---

## What this unblocks

The 2026-08-01 evaluation established that the current test corpus **cannot
measure retrieval quality**: every dense/sparse configuration scores identically,
including the one where embeddings are switched off entirely. The corpus is too
easy to tell any two approaches apart.

Consequence: **every tuning decision is currently unfalsifiable.** Reranking,
chunk sizing, embedding models, hybrid weights — each will report "no
difference," because on that corpus there genuinely isn't one. This session is
what makes those decisions possible. It is also the input for open register item
**P2 #7** and the evidence behind **ISS-05**.

---

## Before the session (Marcus, 15 min)

1. Have the assistant open: **https://rag-web-production-1c0a.up.railway.app**
2. **Confirm Doug has a source grant** — without one he sees a working screen and
   zero results, which looks identical to a broken system. Grant it _before_ he
   sits down.
3. Bring a document list from the indexed SharePoint KB so `relevant` ids can be
   filled in without hunting.

---

## The session

### Step 1 — Questions first, answers never in view (30 min)

Ask Doug for **real questions staff actually ask him** — ideally ones he answers
more than once a month. Interruptions he resents are perfect candidates.

⚠ **Write all questions down before running a single one through the assistant.**
Seeing an answer first contaminates the question: people unconsciously reshape it
toward what the system did well, and the set stops being a test.

Target **30–50**. Fewer is fine if they are hard — see Step 3.

### Step 2 — Label the source documents (20 min)

For each question, record the `externalId` of the document(s) that _should_
answer it.

**An empty `relevant: []` is a valid and valuable answer.** It asserts the KB
genuinely does not cover this — turning the question into a **coverage test**
rather than a retrieval test. Those entries feed the authoring queue directly.
Do not force a label to avoid a blank.

### Step 3 — Name the distractors (20 min) ⭐ the highest-value step

For each question ask Doug: **"what's a document that sounds like the right
answer but isn't?"** Record it in `distractorNote`.

This is the step that fixes the diagnosed failure. Two similar-sounding tax
topics that only a real embedding model can distinguish are worth more than
twenty questions about obviously distinct subjects.

> **Ten questions with genuine distractors beat fifty without.** If time runs
> short, cut the count and keep the distractors.

### Step 4 — Expected answers, for the ones that matter (20 min)

For questions where correctness is load-bearing, Doug states what a correct
answer **must contain** — substance, not wording — and it is recorded with
`tier: "tier2-cpa-verified"`, `verifiedBy`, and `verifiedOn`.

`validateGoldSet()` **rejects an `expectedAnswer` without attribution.** This is
deliberate: an unattributed gold answer looks authoritative while being
untraceable, which is worse than having none.

Everything else stays `tier: "tier1-automatable"` — still scored for retrieval
and faithfulness, just not for professional correctness.

---

## Recording it

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

⚠ **The example above is illustrative formatting, not a real entry.** Its
content has not been verified by anyone and must not be copied into the gold set.

**Never renumber ids** — results are keyed on them, and renumbering silently
invalidates every historical comparison.

---

## Afterwards

```bash
npx vitest run --root tests/e2e src/specs/eval-faithfulness.spec.ts   # validates structure
pnpm eval:real                                                        # scores against real embedder
```

Record the numbers in [`EVAL-BASELINE.md`](./EVAL-BASELINE.md) as the **first
real quality baseline**. Everything before it measured plumbing.

Then the previously-unfalsifiable questions become answerable: does reranking
help, are the hybrid weights right, is chunking sensible.

---

## What good looks like

- **30–50 questions**, a substantial share carrying a `distractorNote`
- **Several with `relevant: []`** — honest coverage gaps, not padding
- **Every `expectedAnswer` attributed** to a named verifier and date
- Questions Doug recognises as things he is **actually asked**, not plausible
  inventions

If the resulting scores are near-perfect on the first run, **suspect the question
set before believing the system.** That is precisely how the starter corpus
misled — 100% recall and MRR 1.000 on a corpus that could not discriminate
anything at all.

---

## Running `pnpm eval:gold`

After questions are added to `tests/e2e/src/eval/gold-set.ts`:

```bash
GOLD_API_URL=https://<your-rag-api-host> \
GOLD_API_TOKEN=<API token scoped to the sources the questions cover> \
GOLD_OUT=gold-2026-09-16.json \  # optional
pnpm eval:gold
```

- Calls the deployed `POST /ask` for each question (read-only) and resolves
  retrieved and cited documents to connector `externalId`s via
  `GET /documents/:id`. Paced to the `/ask` rate limit (~10/min).
- Reports recall@1/3/5 and MRR for questions with non-empty `relevant`;
  correct refusals for out-of-coverage questions (`relevant: []`); answerable
  questions that were refused; fabricated citations; truncated answers.
- Does **not** score claim-level faithfulness or tier-2 CPA correctness —
  those still need a calibrated judge or a credentialed reviewer.
- `GOLD_API_URL` must be https (http only for localhost).
- `GOLD_OUT` is a file path; it contains **real knowledge-base answers**.
  `gold-*.json` is gitignored, but treat the file as firm-confidential.
- Exit codes: 2 — gold set empty/invalid or bad configuration; 1 — a
  fabricated citation or a failed request; 0 — otherwise.
