# Corpus-grounded ground truth — a third scoring tier

**Status:** design, 2026-08-01. Not built. Prerequisites and hazards below.
**Fills:** the one assistant failure mode nothing currently detects.

---

## Why this exists

Four ways the KB assistant can fail. Three have a check; one does not.

| Failure                                                      | Detected by                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| Hallucinates a claim not present in the retrieved text       | `faithfulness.ts` (Tier 1)                                      |
| Retrieves the wrong document, or misses the right one        | `metrics.ts` — **but only with labelled `relevant` ids**        |
| **Answer contradicts what the firm's own SOP actually says** | **Nothing. This is the gap.**                                   |
| The SOP itself is wrong or outdated                          | A credentialed preparer. Not automatable, and not trying to be. |

Faithfulness compares the answer to **whatever happened to be retrieved**. If
retrieval returned the wrong document and the answer faithfully reproduces it,
faithfulness scores well. The answer is still wrong.

Corpus-grounded truth closes that: it compares the answer to **what the corpus
actually says**, independent of what retrieval returned.

## The reframing that makes this legitimate without a CPA

For a knowledge-base assistant, _"does it accurately convey what our SOP says"_
is very nearly the product requirement. **The assistant's job is to reproduce
firm procedure, not to hold opinions about tax.** Whether the SOP is _right_ is a
**KB-governance** question — ISS-05's ~80% — not an assistant question.

So this tier tests the assistant correctly and does **not** cross epistemic
constraint C2. It is not a substitute for the Tier 2 CPA verdict; it is a
different question, and one that happens to be the one most staff usage depends
on.

> ### ⚠ What a perfect score would and would not mean
>
> A 100% corpus-grounded score means **the assistant faithfully reproduces the
> firm's documents.** It does **not** mean the answers are correct. If an SOP is
> stale, a perfect score means the assistant faithfully reproduced a stale
> procedure — and we **deliberately indexed the KB as-is**, so superseded
> documents are present by design. Never report this score without that sentence
> attached.

---

## Design

### 1. Extract claims, not summaries

The unit is an **atomic, checkable assertion** with provenance:

```ts
interface CorpusClaim {
  id: string;
  /** The assertion, in one sentence. */
  claim: string;
  /** Production connector externalId — doubles as the `relevant` label. */
  documentExternalId: string;
  documentTitle: string;
  /** documents.source_modified_at — the staleness signal. */
  sourceModifiedAt: string | null;
  /** ⚠ VERBATIM span from the document. Mandatory. See below. */
  quote: string;
  topic: string;
}
```

> **The `quote` is the whole design, and it is non-negotiable.** Without a
> verbatim span, "ground truth" is itself an LLM summary — and you have built a
> second artefact to distrust rather than a reference to check against. Every
> claim must be traceable to text a human can read in the source document in
> seconds. **Any claim whose quote does not literally contain the assertion is
> dropped, not rewritten.**

### 2. Contradictions are output, not error

In an uncleaned KB, two documents giving different answers is **expected**.
Cluster claims by topic; where two conflict, emit a record carrying **both**
claims and **both** dates.

**Do not silently resolve by recency.** Newer is a strong prior, not a fact — a
recently-touched file may be a copy, and the authoritative version may be older.
Emit the conflict, let it route to the cleanup queue, and let a human decide.

This is the highest-value byproduct: it is precisely the wrong-version risk the
index-as-is decision accepted, now **measured rather than assumed**, and it
generates cleanup work ranked by evidence.

### 3. Claims generate questions nearly for free

A claim yields all three expensive parts of a gold-set entry at once:

| Gold-set field     | Comes from                                                  |
| ------------------ | ----------------------------------------------------------- |
| `query`            | The claim, inverted into how staff would phrase it          |
| `relevant`         | `documentExternalId` — **the labelling bottleneck, solved** |
| expected substance | The `quote`                                                 |

That second row is the point. Labelling which documents should answer which
question is the tedious half of gold-set authoring, and this derives it.

### 4. A third tier

Add to `ScoringTier` in `gold-set.ts`:

```ts
/** Answer vs. what the corpus says. Automatable; does NOT establish correctness. */
| "tier1-corpus-grounded"
```

It sits between the existing two and must not be conflated with either:

| Tier                    | Question it answers                      | Needs a CPA? |
| ----------------------- | ---------------------------------------- | ------------ |
| `tier1-automatable`     | Did the right document come back?        | No           |
| `tier1-corpus-grounded` | Does the answer match what the SOP says? | No           |
| `tier2-cpa-verified`    | Is the answer right as tax practice?     | **Yes**      |

⚠ **`expectedAnswer`/`verifiedBy` stay untouched by this tier.** A corpus quote is
not a verified gold answer, and writing one into those fields would launder a
document excerpt into a CPA attestation. Corpus claims live in their own file.

### 5. Scoring

Entailment between the answer and the claim's `quote`. Both texts are in the
prompt, so an LLM judge is legitimate here for the same reason it is in
`faithfulness.ts` — it compares, it does not recall.

Three outcomes, and the third matters most:

- **supported** — the answer agrees with the corpus
- **contradicted** — the answer disagrees with the corpus → a real defect
- **unaddressed** — the answer never engaged the claim → usually a retrieval miss,
  which sorts it into ISS-05's pile 2

---

---

## Claim extraction — the hard half, and where it goes wrong

The walk is built (`scripts/extract-corpus.ts`, `listDocuments`). Turning document
text into claims is the remaining piece, and it is harder than "prompt a model
for `{claim, quote}`" for reasons worth writing down before anyone tries.

### ⚠ First, a sequencing error in this document's own design

The sections above describe extraction and the client-identifier screen as **one
pass over the corpus**, on the reasoning that you are reading every document
anyway. **That ordering is wrong, and the reason is egress.**

Extraction sends document text to a model. The screen is the thing that
establishes the corpus is Class A/B — and it **has not run yet**. Running them
together discloses every document to a third-party model _before_ anything has
checked whether some of them are client files. ISS-05 flags exactly this: the
corpus is classified internal-only **by default, not because anyone checked.**

**Correct order: screen the whole corpus, resolve the flags with Chris or Doug,
then extract.** The shipped script already happens to do the safe half — it makes
**zero model calls**, computing the inventory and screen locally — so nothing has
leaked. But the combined-pass framing above would have led the next person to
wire a generator into it, which is why this is recorded rather than quietly
fixed. The "read every document once" efficiency argument is real but it is worth
less than the ordering.

### The two failure modes, and only one is mechanical

Ask a model for `{claim, quote}` and you get two distinct failures:

|       | Failure                                                         | Mechanically checkable?                           |
| ----- | --------------------------------------------------------------- | ------------------------------------------------- |
| **A** | The quote is not actually in the document                       | **Yes** — and this is the whole point of the rule |
| **B** | The quote _is_ in the document but does not establish the claim | **No** — this is entailment                       |

They need completely different treatment. Conflating them is how "verified
against the source" quietly becomes "the model said so."

### A — why this is harder than `document.includes(quote)`

An honest model, not hallucinating, routinely returns a quote that is _nearly_
verbatim:

- **Whitespace.** Parsed markdown wraps at odd points; the model returns the
  sentence with the newline collapsed to a space.
- **Unicode.** Smart quotes → straight quotes, en-dash → hyphen, non-breaking
  space → space. Common when the source came out of Word.
- **Punctuation edges.** A trailing period added or dropped.
- **Markdown artefacts.** The source reads `**BK-CATCHUP**`; the model strips the
  asterisks.
- **Tables.** The source is `| Code | BK-CATCHUP |` and the model quotes
  `Code: BK-CATCHUP` — a faithful reading, not a verbatim span.

Every normalization you add to accept these is **a licence to differ**, and
normalization is where the rigour leaks. Too strict and the yield collapses; too
lenient and paraphrase walks back in through the door the rule exists to close.

#### The move that dissolves the problem: never store the model's quote

Do not verify the model's string and keep it. **Use the model's string only to
locate a span, then store the span taken from the document.**

```
model returns quote text
  → code locates it in the source markdown
  → code stores markdown.slice(start, end)   ← this is what persists
  → if it cannot be located, the claim is DROPPED
```

What ends up in the artefact is then, by construction, **always real document
text**. The model's job is reduced from _reproduce the text_ to _point at the
text_, and pointing is something you can check.

> Asking the model for character offsets directly would be cleaner still, and it
> does not work — models cannot count characters reliably. Locate-then-slice gets
> the same guarantee without depending on the model to do arithmetic.

#### Make the normalization ladder explicit, and watch it

Match in rungs, recording which rung succeeded:

1. exact
2. - whitespace collapsed
3. - unicode folded (quotes, dashes, nbsp)
4. - markdown stripped

**The rung distribution is a diagnostic, not bookkeeping.** If most claims only
match at rung 4, extraction is paraphrasing — and the fix is to tighten the
prompt, **not** to add rung 5. A ladder that silently grows is the failure this
whole design is trying to avoid, reintroduced as configuration.

### B — quote real, claim overreaching

The subtler failure: the model pulls a genuine sentence and hangs a claim on it
that the sentence does not carry. Nothing mechanical catches this. A second model
pass is legitimate — the same argument as `faithfulness.ts`, both texts are in the
prompt — but only if it is set up not to cheat:

- **Independent call.** The verifier sees the claim and the quote, **not the
  document**. Given the document it will use document knowledge to fill the gap
  and confirm almost anything.
- **Adversarially framed.** _"Does this quote **alone** establish this claim?
  Default to no."_ Verifiers asked to confirm, confirm.
- **Sampled by a human periodically.** This is a model checking a model; without a
  sample you have no idea what the agreement rate means.

### The atomicity trap

_"The catch-up bookkeeping code is BK-CATCHUP and it bills at the standard
rate"_ is **two** claims. Compound claims are where support gets slippery: half
the claim is in the quote, half is not, and the pair scores as supported.

**Rule: one claim, one assertion.** If covering the claim requires a conjunction,
split it. Splitting is cheap; a half-true gold entry poisons everything computed
from it.

### ⭐ The selection bias that quietly ruins the gold set

This is the failure most likely to happen and least likely to be noticed.

**A model extracting claims will preferentially pick the crisp, quotable,
unambiguous ones** — a code, a threshold, a deadline stated in a single sentence.
Those are exactly the facts retrieval already handles well. The questions that
_discriminate_ between retrieval strategies come from the opposite material:
things stated obliquely, facts spread across two sections, values living in a
table cell, procedures described without naming the thing you would search for.

So naive extraction yields an **easy** gold set — and this repo has already paid
for that lesson once. `corpus.ts` produces a flat weight sweep that scores
**identically at `dense=0`**, with embeddings contributing nothing, at MRR 1.000.
**A gold set that cannot tell dense retrieval from sparse measures nothing**, and
it will look like a healthy green dashboard while doing it.

Mitigations, and they must be in the extraction prompt rather than bolted on
after:

- **Quota the hard categories** — require a share of claims drawn from tables,
  from multi-section synthesis, and from obliquely-stated procedure.
- **Require a `distractorNote` per claim**, and **drop claims that cannot name a
  plausible near-neighbour.** A question with no distractor cannot discriminate
  and is dead weight.
- **Sanity-check the finished set the same way**: run the weight sweep. If it is
  flat, the set is too easy — regardless of how many claims it holds.

### Determinism, or the metric moves under you

Re-running extraction produces different claims, so scores stop being comparable
across runs and every regression is ambiguous. **Cache by `content_hash`** — the
column already exists and already means "the parsed markdown changed" — and treat
the claim set as a **versioned artefact that is reviewed and pinned**, not
something regenerated on each eval.

### What this costs

~858 documents × one extraction call, plus a verification call per surviving
claim. Not prohibitive, but not free either — and it is the argument for the
**narrow start** recommended above: 20–30 documents in the families staff
actually ask about, then let the retrieval log choose the rest.

---

## The fourth dimension: is the answer any use?

Everything above checks whether the answer is **true to the corpus**. None of it
checks whether the answer is **worth reading**. An answer can be perfectly
grounded, drawn from exactly the right document, and still useless — hedged into
mush, a wall of quotes, "consult the SOP" when the SOP is right there, the actual
step buried under preamble, or a refusal where the answer was plainly available.

**This is the dimension that prompt changes actually move**, which makes it the
one with a fast, safe iteration loop attached:

| Failure                            | The lever that fixes it          |
| ---------------------------------- | -------------------------------- |
| Wrong/missing document retrieved   | chunking, RRF weights, reranking |
| The document itself is wrong/stale | KB cleanup and governance        |
| **Correct but useless answer**     | **the generation prompt**        |

It also needs no CPA. _"Is this a useful answer to this question"_ is judgeable by
anyone who can read.

### ⚠ The trap: naive helpfulness scoring rewards exactly the wrong things

LLM judges reliably reward **verbosity, fluency, and confidence**. In this system
those are the risk profile, not the goal: confident-and-wrong over an uncleaned
corpus is the failure mode the whole index-as-is decision accepted. A helpfulness
metric that rewards assured prose will happily tune the assistant toward it.

Two guards, and the first is the important one:

**1. Abstention is correct behaviour, and must be scored as such.** The prompt's
rule 3 emits a fixed string — _"The available documents do not contain enough
information to answer that."_ That makes abstention **detectable mechanically, no
judge involved.** Then the corpus claims decide whether it was right:

| Corpus has the answer? | Assistant abstained? | Verdict                               |
| ---------------------- | -------------------- | ------------------------------------- |
| No                     | Yes                  | ✅ **Correct** — and a KB gap to log  |
| No                     | No                   | 🔴 Fabrication — the worst outcome    |
| Yes                    | Yes                  | 🟠 Over-refusal — retrieval or prompt |
| Yes                    | No                   | → score on the rubric below           |

This composition is the payoff of doing corpus extraction first: **it is what
lets you tell a good abstention from a bad one**, which no answer-only metric can.

**2. Cap and penalise padding.** Score length discipline explicitly, or the loop
drifts toward longer answers because the judge likes them.

### Rubric — each line maps to a prompt rule, so a bad score names its own fix

| Dimension                  | Asks                                                           | Prompt rule |
| -------------------------- | -------------------------------------------------------------- | ----------- |
| **Answers what was asked** | Or a nearby question it found easier?                          | —           |
| **Actionable**             | Gives the step, code, threshold — not "see the SOP"            | 4           |
| **Complete for the ask**   | Multi-part question → multi-part answer                        | 7           |
| **Honest about gaps**      | States what the documents don't cover instead of over-claiming | 8           |
| **Surfaces disagreement**  | Where sources conflict, says so and cites both                 | 5           |
| **Length discipline**      | No padding, no preamble, answer near the top                   | 4           |

That last column is the design goal: **a low score points at a specific rule to
change**, rather than at a vague sense that answers feel weak.

The disagreement row is newly testable — corpus extraction finds contradictions
in the KB, so you can ask a question you _know_ has two conflicting sources and
check whether the assistant surfaces both or silently picks one. That is the
wrong-version risk, measured directly.

### Running the tune loop without fooling yourself

1. **Freeze the question set before tuning.** A metric computed over questions
   that change with the prompt measures nothing.
2. **Re-run the whole set on every prompt change.** Prompt edits trade off —
   pushing thoroughness (rule 7) against length discipline (rule 4) is a real
   tension, and a fix for one commonly regresses the other.
3. **Record the prompt version alongside the scores.** Without it no change is
   attributable and the history is noise.
4. **Spot-check against a human periodically.** Tuning against an LLM judge
   optimises for the judge — that is not a reason to avoid the loop, it is a
   reason to keep a human sample in it. This is the step that gets skipped.

**None of this establishes correctness**, and it does not need to. It establishes
that the assistant **finds what the KB has and says something useful about it** —
which is the part you can fix this month, and the precondition for the CPA
verdict being worth anyone's time. Judging a system that retrieves badly tells
you about the retrieval, not the idea.

---

## Prerequisites and hazards

1. **🔴 Read-only, always.** See `ISSUES-AND-OPTIMIZATIONS.md` **C3**:
   `run-real-eval.ts` calls `truncateAll`, which `TRUNCATE`s
   `chunks, documents, ingestion_jobs, sources CASCADE`. It is the only existing
   real-embedder runner and therefore the obvious template. **Copying it and
   pointing it at production destroys the index.** An extraction pass must open a
   read-only connection and must contain no `truncateAll`/`seedEvalCorpus`.
2. **No corpus enumeration exists.** There is no `listDocuments` helper in
   `packages/db/src/queries.ts`. A small read-only query over `documents`
   (`external_id, title, source_modified_at, content`) is needed. Small, but it
   does not exist today.
3. **🔒 The extracted set is firm procedure detail and must never be committed to
   a tracked path.** It belongs in a gitignored location — `docs/firm/` or
   `firm-operations/` in the `cpa-consulting` workspace. This file (design only,
   no firm content) is tracked; the output is not.
4. **Class A/B only**, which the corpus already is by connection scope — the
   assistant connects to SharePoint and only SharePoint, while client files live
   in Onvio and on the Z Drive.

> ### ⭐ A side effect worth more than the eval
>
> ISS-05 flags this as **the real gate**: the corpus is _classified_ internal-only
> **by default, not because anyone checked** — confirming none of the ~858 indexed
> documents carries client-identifying material is "a document-list review by
> Chris or Doug, not a legal task."
>
> **An extraction pass reads every document.** Done with a client-identifier
> screen running alongside, it produces exactly that review as a byproduct — and
> converts a chore nobody has scheduled into the output of a job being run anyway.
> **Build the screen into the first pass**; retrofitting it means a second full
> read.

## Scope — start narrow

**Do not extract all ~858 documents first.** Start with the SOP families ISS-05
names and staff most plausibly ask about — bookkeeping checklists, tax-return
preparer/reviewer checklists, time coding, extensions, 1099s, sales tax — roughly
20–30 documents.

**Then let usage choose the rest.** The index-as-is decision made the retrieval
log the prioritisation signal: once the assistant has real usage, the documents
people actually reach for are the ones worth grounding. Extracting everything now
front-loads work on documents that may never be queried.

The exception is the client-identifier screen above — **that one wants full
coverage**, because its value is proving a negative.
