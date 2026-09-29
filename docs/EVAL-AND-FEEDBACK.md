# Measuring answer quality — how it works and what it can prove

**Written 2026-08-01.** Companion to [`EVAL-BASELINE.md`](./EVAL-BASELINE.md)
(numbers) — this is the design and the honest limits.

> **The one thing to take away.** Quality scoring here is split into two tiers,
> and the split is not bureaucratic. **Tier 1 is fully automatable and needs no
> CPA. Tier 2 requires a credentialed reviewer and cannot be automated at all.**
> Blurring them is how a system ends up confidently grading its own tax advice.

---

## The four mechanisms

| #   | Mechanism                                                  | Answers                                     | State                       |
| --- | ---------------------------------------------------------- | ------------------------------------------- | --------------------------- |
| 1   | **Retrieval metrics** — recall@k, precision@k, nDCG@k, MRR | Did the right _document_ come back?         | ✅ Built. Corpus inadequate |
| 2   | **Faithfulness scoring**                                   | Is the _answer_ grounded in what came back? | ✅ **New 2026-08-01**       |
| 3   | **In-product feedback** — 👍/👎 + comment                  | What do real users think?                   | ✅ **New 2026-08-01**       |
| 4   | **`docs-gap-digest`**                                      | What did the KB fail to cover?              | ✅ Built, weekly            |

Together: 1 and 2 are offline and run in CI; 3 and 4 are online and accumulate
from real use.

> **Correction (2026-09-16).** What runs in CI for 2 is the faithfulness
> _scorer's_ unit tests; no real answer is scored yet, because the gold set is
> empty. `pnpm eval` now also gates on the harder CPA corpus
> (`tests/e2e/src/specs/retrieval-eval-cpa.spec.ts`), and `pnpm eval:gold`
> scores the deployed knowledge base against the gold set once it exists —
> retrieval, refusals, fabricated citations and truncation, not claim-level
> faithfulness. See `EVAL-GOLD-SET-GUIDE.md`.

---

## Tier 1 — automatable, no CPA required

### Retrieval metrics

`pnpm eval` (regression guard, `FakeEmbedder`, CI) and `pnpm eval:real` (real
embedder). Needs question → relevant-document labels.

⚠ **The current corpus cannot measure quality, and this is now proven rather
than suspected.** The 2026-08-01 real-embedder run showed a **completely flat**
dense/sparse weight sweep — at `dense=0`, with embeddings contributing nothing,
the score is identical. The corpus (espresso, sailing, gardening) is decided by
keyword overlap alone. It detects catastrophic regressions and nothing else.

### Faithfulness (`tests/e2e/src/eval/faithfulness.ts`)

Retrieval metrics say nothing about the answer. Faithfulness scores
**groundedness**: is every claim supported by the retrieved chunks, and does
each citation actually contain what it's cited for?

An LLM is a legitimate judge here because **the ground truth is in the prompt** —
it compares two texts rather than consulting knowledge it may not have.

Two design decisions worth defending:

**Fabricated citations are a hard failure, not a low score.** If the answer cites
a document that was never retrieved, `checkCitations()` catches it with **no
model call at all** — pure set membership. Inventing a source is the most
damaging failure mode in a professional setting, and it should fail a run
outright rather than average away.

**Abstention scores `null`, never `0`.** When the system says "the knowledge base
doesn't cover this," that is _correct behaviour_ and a coverage finding — which
mechanism 4 already treats as one. Scoring it as a faithfulness failure would
train the system to guess confidently rather than decline honestly, and in a CPA
firm that trade is strictly the wrong direction. `aggregateFaithfulness()`
reports abstentions as their own count.

---

## Tier 2 — requires a credentialed reviewer

**Whether the answer is substantively correct as CPA practice.**

This is not automatable and must not be faked:

- It is a tax/accounting determination, which **epistemic constraint C2** places
  outside what AI decides — and that applies with double force to the artifact
  used to _score_ the system.
- **Faithfulness ≠ correctness.** An answer can be perfectly grounded in a
  retrieved document and still be wrong, because the _document_ is outdated or
  wrong. Faithfulness catches hallucination. It cannot catch a bad source.

`GoldQuestion.expectedAnswer` carries `verifiedBy` + `verifiedOn`, and
`validateGoldSet()` **rejects an expected answer without them**. An unattributed
gold answer is not a gold answer — it is a guess wearing authority.

---

## The gold set — the actual bottleneck

`tests/e2e/src/eval/gold-set.ts` is **deliberately empty**. Questions
reference real production documents by `externalId`, so no synthetic corpus is
needed. See [`EVAL-GOLD-SET-GUIDE.md`](./EVAL-GOLD-SET-GUIDE.md) for authoring.

**Why empty and not seeded with plausible-looking questions:** inventing them
would manufacture evidence. Worse, invented questions tend to be _easy_ — which
reproduces exactly the flat-sweep failure already diagnosed.

**The most valuable field is `distractorNote`** — naming the near-neighbour a
keyword search would wrongly return. That is precisely what the starter corpus
lacks. **Ten questions with real distractors are worth more than fifty without.**

---

## Feedback loop — how findings become fixes

```
 user asks ──▶ answer + 👍/👎  ──▶ answer_feedback
                    │
                    ├─ 👎 + comment ─▶ sorted into:
                    │     • "KB doesn't contain it"  ─▶ authoring queue (ISS-05)
                    │     • "KB has it, not found"   ─▶ retrieval work
                    │
 weak results ──────┴──▶ docs-gap-digest (weekly) ──▶ same two queues
                                     │
 real questions accumulate in audit_log ──▶ candidates for the gold set
```

**That sort is the whole point.** The two failure classes need different fixes
and different owners — one is Doug writing a document, the other is engineering
work on retrieval. A raw satisfaction score tells you neither.

The comment box appears **only on thumbs-down**, because that is where the sort
comes from; asking why something worked yields little.

**Growing the gold set honestly:** mine `audit_log` for what staff _actually_
asked rather than inventing questions. That requires real usage first — which is
why the seed set from Doug matters, and why it is a seed rather than the target.

---

## Running it

```bash
docker compose up -d

# regression guard (CI, FakeEmbedder)
pnpm eval

# real embedder — three gates block this and are easy to miss:
#   API_TOKENS must be non-empty · AUTH_PROVIDER must be `static-token`
#   (not `static`) · EGRESS_ALLOWED_HOSTS must include the provider host
EMBEDDING_PROVIDER=gemini GEMINI_API_KEY=... \
EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com \
API_TOKENS=<non-empty> AUTH_PROVIDER=static-token \
E2E_DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
  pnpm eval:real

# gold set against the deployed API (see EVAL-GOLD-SET-GUIDE.md)
GOLD_API_URL=https://<api-host> GOLD_API_TOKEN=... pnpm eval:gold

# faithfulness + gold-set validation unit tests
npx vitest run --root tests/e2e src/specs/eval-faithfulness.spec.ts
```

> ⚠ **The egress guard blocks provider calls by default and that is correct.**
> It was overridden for `eval:real` only because **that corpus is synthetic — no
> firm content left the machine.** Running an eval against real KB content is a
> different act and needs the P0 #2 counsel determination, still open.

---

## What this can and cannot prove today

| Claim                                              | Supported?                                     |
| -------------------------------------------------- | ---------------------------------------------- |
| The pipeline works end to end with a real embedder | ✅ Yes (2026-08-01)                            |
| The system does not fabricate citations            | ✅ Yes, once faithfulness runs on real answers |
| Retrieval quality on the firm's knowledge base     | ❌ **No** — needs the gold set                 |
| Dense/sparse weighting is tuned correctly          | ❌ **No** — corpus cannot distinguish settings |
| Reranking would help                               | ❌ **No** — unmeasurable at MRR 1.000          |
| Answers are correct CPA practice                   | ❌ **No** — Tier 2, needs Doug                 |

**Until the gold set exists, retrieval tuning is unfalsifiable and should not be
attempted** — every change will read as "no difference," because on this corpus
it genuinely is.
