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

Add to `ScoringTier` in `twk-gold-set.ts`:

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
