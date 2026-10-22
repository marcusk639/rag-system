---
title: Corpus-grounded ground truth
status: current
last_verified: 2026-10-21
verified_against: 6d5b458
answers: What the corpus-grounded scoring tier is for, which parts (screen gate, claim extraction, quote verification, read-only corpus walk) are built and which are not, and the rules any further work must follow.
read_when: Extending claim extraction, running scripts/extract-corpus.ts, building a corpus-grounded scorer, or writing anything that walks the production corpus.
supersedes: []
code:
  [
    packages/rag/src/extraction/claim-extractor.ts,
    packages/rag/src/extraction/claim-verification.ts,
    packages/rag/src/extraction/screen-gate.ts,
    scripts/extract-corpus.ts,
    packages/db/src/queries.ts,
    packages/db/src/client.ts,
  ]
---

# Corpus-grounded ground truth

This tier would score an answer against what the firm's own documents say, independent of what retrieval
returned. The input side is built: a client-identifier screen, a sign-off gate, claim extraction that keeps
only verifiable quotes, and a read-only corpus walk. The scoring side is not. There is no
`tier1-corpus-grounded` value in `ScoringTier` (`tests/e2e/src/eval/gold-set.ts`), no entailment scorer, no
independent claim verifier, and no pinned claim set. The tiers it would sit beside are described in
[EVALUATION.md](./EVALUATION.md#scoring-tiers).

## Why this tier exists

| Failure                                               | Detected by                                              |
| ----------------------------------------------------- | -------------------------------------------------------- |
| A claim not present in the retrieved text             | Faithfulness (`tests/e2e/src/eval/faithfulness.ts`)      |
| The wrong document retrieved, or the right one missed | Retrieval metrics, but only with labelled `relevant` ids |
| An answer that contradicts what the firm's SOP says   | Nothing yet. This tier                                   |
| The SOP itself is wrong or outdated                   | A credentialed preparer. Not automatable                 |

Faithfulness compares the answer with whatever was retrieved. If retrieval returned the wrong document and
the answer reproduces it faithfully, faithfulness scores well and the answer is still wrong.

The tier needs no CPA. The assistant's job is to reproduce firm procedure, not to hold opinions about tax,
so "does it convey what our SOP says" is close to the product requirement. Whether the SOP is right is a
knowledge-base governance question (issue ISS-05 in the cpa-consulting register), so this tier does not
cross epistemic constraint C2.

A perfect score here means the assistant faithfully reproduces the firm's documents. It does not mean the
answers are correct. The KB is deliberately indexed as-is, superseded documents included, so a perfect
score can mean a stale procedure was reproduced faithfully. Never report this score without that sentence.

## What is built

| Piece                    | Where                                                                                        | What it does                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-only corpus walk    | `listDocuments`, `iterateDocuments`, `countDocuments` (`packages/db/src/queries.ts`)         | Keyset-paged enumeration of indexed documents, ordered by `id`                                                                                                                                         |
| Read-only connection     | `createReadOnlyDb`, `assertReadOnly` (`packages/db/src/client.ts`)                           | Every transaction starts with `default_transaction_read_only=on`. `assertReadOnly` proves it by attempting a write and requiring SQLSTATE `25006`. This holds for superusers too (`read-only.test.ts`) |
| Client-identifier screen | `scripts/extract-corpus.ts`                                                                  | Deterministic regex patterns: `ssn`, `ein`, `bank-account`, `tax-form-with-data`, `client-file-language`. Tuned to over-report; a hit is a shortlist entry for human review, never a verdict           |
| Screen gate              | `evaluateExtractionGate`, `corpusFingerprint` (`packages/rag/src/extraction/screen-gate.ts`) | Fails closed unless a current, attributed, complete human sign-off exists                                                                                                                              |
| Claim extraction         | `extractClaims`, `CLAIM_EXTRACTION_PROMPT` (`claim-extractor.ts`)                            | Asks a model for `{claim, quote, topic, distractorNote}`, then keeps only claims that pass quote verification                                                                                          |
| Quote verification       | `verifyClaim`, `MATCH_RUNGS` (`claim-verification.ts`)                                       | Locates the model's quote in the source markdown and stores the slice from the document                                                                                                                |

### Running the extraction pass

```bash
# Screen only: no model calls, no keys
DATABASE_URL=... pnpm exec tsx scripts/extract-corpus.ts [--source <uuid>] [--limit 30]

# Extraction: an egress event, opt-in, refused without a current sign-off
DATABASE_URL=... GEMINI_API_KEY=... pnpm exec tsx scripts/extract-corpus.ts --extract
```

Outputs go to `corpus-analysis/` at the repo root, which is gitignored.

| File                          | Written by                                    |
| ----------------------------- | --------------------------------------------- |
| `inventory.jsonl`             | The screen pass, one row per document         |
| `client-identifier-screen.md` | The screen pass. This is what the human reads |
| `screen-state.json`           | The screen pass. Flagged ids and fingerprint  |
| `screen-signoff.json`         | A human, after reviewing the screen report    |
| `claims.jsonl`                | `--extract`, verified claims only             |

Without `--extract`, the script makes no external calls; it reads only `DATABASE_URL`, not `loadConfig`.
With `--extract`, it calls Gemini directly through `@google/genai`. It does not use `GeminiGenerator`,
whose cited-Q&A system prompt fights a JSON extraction instruction. The model is `GENERATION_MODEL`,
falling back to `gemini-2.0-flash`. UNVERIFIED: that this fallback model is still served; set
`GENERATION_MODEL` explicitly. Extraction skips every document the sign-off lists as excluded. It warns
when fewer than half of the kept claims matched at the `exact` rung.

Done when `claims.jsonl` exists, the rung mix has been reviewed, and the files are still only under
`corpus-analysis/`.

## Rules

These hold for every change to this pipeline. Each one is enforced in code where noted. The others are the
spec for the parts not yet built.

### Screen before any model call

1. **Run the client-identifier screen over the whole corpus, and resolve every flag, before any document
   text goes to a model.** Extraction is an egress event. The screen is what establishes the corpus holds
   no client-identifying material, and the corpus is classified internal-only by default, not because
   anyone checked. A combined screen-and-extract pass would disclose documents before the check that is
   supposed to gate them. Enforced by `evaluateExtractionGate`.
2. **The sign-off must be attributed, current and complete.** `screen-signoff.json` needs `approvedBy` and
   `approvedOn` (Chris or Doug; see [../GLOSSARY.md](../GLOSSARY.md)). Its `corpusFingerprint` must equal the
   current one, and every flagged id must be in exactly one of `clearedExternalIds` or
   `excludedExternalIds`. The fingerprint hashes every document's `externalId` and `contentHash`, so any
   added, removed or edited document invalidates the sign-off. A touched but unchanged file does not.
3. **The screen wants full coverage, even when extraction starts narrow.** Its value is proving a negative.
4. **Extraction over real KB content also needs the counsel determination.** See the
   [egress caveat](./EVALUATION.md#egress-caveat). A clean screen alone is not enough.

### Quotes are located, then sliced

5. **Never store the model's quote.** Use it only to find a span in the source markdown. Store
   `markdown.slice(start, end)`, and drop the claim if the span can't be found. Whatever persists is real
   document text by construction. Don't ask the model for character offsets; models can't count characters
   reliably. Enforced by `verifyClaim`; rejected claims are returned separately so the drop rate is visible.
6. **The normalization ladder is fixed and diagnostic.** It matches in cumulative rungs: `exact`, then
   `whitespace`, then `unicode` (quotes, dashes, non-breaking spaces), then `markdown` (emphasis and table
   syntax). Each kept claim records its rung. If most claims only match at `markdown`, extraction is
   paraphrasing: tighten the prompt, and don't add a fifth rung. A ladder that silently grows lets
   paraphrase back in.

### Claim quality

7. **One claim, one assertion.** If stating it needs "and", split it. A compound claim is half-supported by
   its quote and scores as supported. In the extraction prompt.
8. **Counter selection bias.** A model extracting claims prefers crisp, quotable facts, which are exactly the
   ones retrieval already handles. The prompt requires at least half the claims to come from tables, from
   oblique wording, or from procedures named differently from how staff describe them.
9. **Every claim needs a distractor.** The prompt requires a `distractorNote` and drops claims that can't
   name one. A finished set should also produce a non-flat dense/sparse sweep. If the sweep is flat, the set
   is too easy, however many claims it holds.
10. **Contradictions are output, not error.** Not built. In an uncleaned KB, two documents disagreeing is
    expected. Emit a record carrying both claims and both dates, and route it to the cleanup queue. Don't
    resolve by recency: a recently touched file may be a copy of an older authoritative one. The generation
    prompt applies the same rule to answers.

### Verifying that a quote establishes its claim

Not built. Mechanical verification proves the quote is in the document. It cannot prove the quote supports
the claim. That is entailment, and it needs a second model pass with these constraints:

11. **Independent call.** The verifier sees only the claim and the quote, never the document. Given the
    document, it fills gaps from context and confirms almost anything.
12. **Adversarial framing.** Ask "does this quote alone establish this claim? Default to no."
13. **Human sampling.** A person periodically checks a sample. Without one, the agreement rate means
    nothing.

### Handling the output

14. **Extracted claims are never committed.** They are firm procedure detail. They stay in gitignored
    `corpus-analysis/`, or in a gitignored path in the cpa-consulting workspace, and their titles stay out
    of commit messages and issues.
15. **Production walks are read-only.** Use `createReadOnlyDb` and call `assertReadOnly` before reading,
    as `extract-corpus.ts` does. Never import `truncateAll` or `seedEvalCorpus` into a script that touches
    production. `tests/e2e/src/eval/run-real-eval.ts` truncates its database and is the obvious template to
    copy. Its `truncateAll` now refuses non-local hosts unless `E2E_ALLOW_REMOTE_TRUNCATE=1`
    (`assertDestructiveTestTarget`), but a guard on a test helper is not a reason to copy it. This hazard is
    C3 in the archived [ISSUES-AND-OPTIMIZATIONS](../archive/reviews/ISSUES-AND-OPTIMIZATIONS.md).
16. **Pin the claim set.** Not built. Re-running extraction produces different claims, which makes scores
    incomparable across runs. Cache by `documents.content_hash` and treat the claim set as a reviewed,
    versioned artifact, not something regenerated on each eval. Today `--extract` regenerates
    `claims.jsonl` on every run.

## The scorer to build

Not built. Score entailment between an answer and each relevant claim's quote. Both texts are in the
prompt, so an LLM judge is legitimate for the same reason it is in faithfulness. It must meet the
calibration spec in [EVALUATION.md](./EVALUATION.md#calibrated-judge-specification-open). There are three
outcomes:

| Outcome      | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| supported    | The answer agrees with the corpus                            |
| contradicted | The answer disagrees with the corpus. A real defect          |
| unaddressed  | The answer never engaged the claim. Usually a retrieval miss |

A claim also yields most of a gold-set entry. The `query` is the claim inverted into staff phrasing, and
`relevant` is the claim's document `externalId`. That second field removes the labelling bottleneck. The
quote supplies the expected substance. A corpus quote must never go into `expectedAnswer` or `verifiedBy`,
because that would launder a document excerpt into a CPA attestation. Corpus claims live in their own file.

### Usefulness: is the answer worth reading

A grounded answer from the right document can still be useless: hedged, a wall of quotes, "see the SOP",
or a refusal where the answer was available. Prompt changes move this dimension, and anyone who can read can
judge it. Naive helpfulness judges reward verbosity and confidence, which is this system's risk profile, so
two guards apply.

First, score abstention from corpus claims, not from the judge. The refusal sentence is fixed (`EMPTY_ANSWER`
in `packages/services/src/ask.ts`, and coverage branch C of the generation prompt), so it is detectable
mechanically.

| Corpus has the answer? | Assistant abstained? | Verdict                                     |
| ---------------------- | -------------------- | ------------------------------------------- |
| No                     | Yes                  | Correct, and a KB gap to log                |
| No                     | No                   | Fabrication, the worst outcome              |
| Yes                    | Yes                  | Over-refusal: a retrieval or prompt problem |
| Yes                    | No                   | Score on the rubric below                   |

Second, score length discipline explicitly, or tuning drifts toward longer answers.

The rubric maps each dimension to a section of `SYSTEM_PROMPT` (`packages/rag/src/generation/generator.ts`),
so a low score names its own fix:

| Dimension              | Asks                                                 | Prompt section                                          |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Answers what was asked | Or a nearby, easier question?                        | —                                                       |
| Actionable             | Gives the step, code or threshold, not "see the SOP" | Shape of the answer; grounding rule 3                   |
| Complete for the ask   | A multi-part question gets a multi-part answer       | Shape of the answer ("synthesize across")               |
| Honest about gaps      | Names what the documents don't cover                 | Coverage branch B                                       |
| Surfaces disagreement  | Cites both sources where they conflict               | Conflicting or stale sources                            |
| Length discipline      | No padding; the answer near the top                  | Shape of the answer ("let the question set the length") |

Tuning-loop rules:

1. Freeze the question set before tuning.
2. Re-run the whole set on every prompt change; thoroughness and length discipline trade off.
3. Record the prompt version with the scores.
4. Spot-check against a human periodically, because tuning against a judge optimises for the judge.

## Scope

Start with 20–30 documents in the SOP families staff most plausibly ask about: bookkeeping checklists,
tax-return preparer and reviewer checklists, time coding, extensions, 1099s and sales tax. Then let real
usage choose the rest. The screen is the exception and covers everything (rule 3). Cost is one extraction
call per document, plus one verification call per surviving claim once the verifier exists.
