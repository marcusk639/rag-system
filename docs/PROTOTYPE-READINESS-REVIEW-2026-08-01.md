# Prototype Readiness Review — CPA Firm Knowledge Base

**Date:** 2026-08-01
**Scope:** End-to-end review of `rag-system` against one question — _will 15–20 CPA
staff asking questions in MS Teams get substantive, accurate, properly cited
answers about firm processes, SOPs, and general knowledge?_
**Method:** Code read of the full path (SharePoint → parse → chunk → embed →
hybrid retrieve → generate → surface), plus **measurement against the firm's real
SOP corpus** (112 documents / 321 chunks extracted from `~/dev/cpa-consulting/docs/TWK SOPs`)
and against the live evaluation harness.
**Companion docs:** [`TWK-LAUNCH-STATUS.md`](./TWK-LAUNCH-STATUS.md) (what is
deployed), [`EVAL-BASELINE.md`](./EVAL-BASELINE.md) (retrieval numbers),
[`ISSUES-AND-OPTIMIZATIONS.md`](./ISSUES-AND-OPTIMIZATIONS.md) (standing backlog).

---

## The verdict in one paragraph

**The architecture is sound and the engineering quality is high — but as it stood
this morning, the system would have failed its most important users on its most
important questions.** Two defects, both measured rather than inferred, sat
directly on the path between a staff member's question and a useful answer: a
compliance pre-flight that converted routine tax-procedure questions into HTTP
500s, and a full-text query construction that silently disabled half of "hybrid"
search on a third of natural questions. **Both are now fixed, with tests and
before/after measurements.** What remains is a smaller set of gaps — the largest
being that neither surface supports follow-up questions — plus one uncomfortable
correction to a conclusion this project has been building on for weeks.

---

## Severity scale

Severity is scored against **usefulness as a working knowledge base**, not
against generic code quality. A defect is Critical if it makes correct answers
unobtainable for a normal question a staff member would actually ask.

| Band            | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| 🔴 **Critical** | A normal, in-scope question returns an error or a wrong answer. Blocks pilot.                                 |
| 🟠 **High**     | Materially degrades answer quality or usability for a common class of question. Pilot proceeds; users notice. |
| 🟡 **Medium**   | Real defect with a workaround, or a gap that blunts the improvement loop rather than the answers.             |
| 🟢 **Low**      | Hygiene, operability, or latent risk. No user-visible impact today.                                           |

---

## Findings at a glance

| ID       | Severity | Finding                                                                              | Status             |
| -------- | -------- | ------------------------------------------------------------------------------------ | ------------------ |
| **C-1**  | 🔴       | TRI pre-flight turns routine tax-SOP questions into `500 Internal server error`      | ✅ **Fixed**       |
| **H-1**  | 🟠       | Sparse retrieval is dead on 33% of natural questions (`plainto_tsquery` ANDs)        | ✅ **Fixed**       |
| **H-1b** | 🟠       | The "flat weight sweep → corpus is too easy" conclusion is partly wrong              | ✅ **Corrected**   |
| **H-2**  | 🟠       | No conversation memory — follow-up questions fail on both surfaces                   | Documented; spec'd |
| **H-3**  | 🟠       | A parser or embedding failure permanently drops a document from the index            | Documented         |
| **H-4**  | 🟠       | Tables inside `.docx`/`.pdf` get no table-aware chunking                             | Documented         |
| **H-5**  | 🟠       | Reranking is implemented but disabled — on a corpus with confirmed near-duplicates   | Documented         |
| **H-6**  | 🟠       | Superseded/duplicate documents are retrieved with equal confidence                   | Documented         |
| **H-7**  | 🟠       | Grouped citations (`[1, 2]`, `[1-3]`) silently render an answer with zero sources    | ✅ **Fixed**       |
| **M-1**  | 🟡       | The Teams bot captures no feedback — the primary surface yields zero quality signal  | Documented         |
| **M-2**  | 🟡       | Web BFF has no upstream timeout — a hung API spins forever                           | Documented         |
| **M-3**  | 🟡       | No Anthropic/Claude generator despite being a stated requirement                     | Documented         |
| **M-4**  | 🟡       | Relevance scores are relative — the top hit is always 1.0, even when irrelevant      | Documented         |
| **M-5**  | 🟡       | Screenshots and diagrams inside SOPs are silently dropped                            | Documented         |
| **M-6**  | 🟡       | `source_modified_at` is dead; supersession depends on a silent-failure metadata path | Documented         |
| **M-7**  | 🟡       | `pnpm typecheck` is red on `main`; the launch doc claims the gate is green           | Documented         |
| **M-8**  | 🟡       | Teams collapses every non-2xx into one undifferentiated message                      | Documented         |
| **M-9**  | 🟡       | ~40 calculator spreadsheets chunk into meaningless rows                              | Documented         |
| **M-10** | 🟡       | `pnpm eval:twk` documented but absent; `run-real-eval.ts` truncates the DB           | Documented         |
| **L-1**  | 🟢       | Teams bot logs via `console.*`, against repo convention                              | Documented         |
| **L-2**  | 🟢       | `WEB_AUTH_MODE=static-fallback` has no expiry or alert                               | Documented         |
| **L-3**  | 🟢       | Teams bot is single-instance only (`MemoryStorage`)                                  | Documented         |
| **L-4**  | 🟢       | `ts_rank_cd` runs unnormalized — mildly favors long chunks                           | Documented         |
| **L-5**  | 🟢       | Metadata merge order lets a future parser change clobber `modifiedAt`/`title`/`url`  | Documented         |

---

# 🔴 Critical

## C-1 — The compliance pre-flight turns the firm's core content into 500 errors

**Where:** `packages/rag/src/generation/generator.ts` (pre-flight), `packages/core/src/tri-scanner.ts` (patterns), `apps/api/src/error-handler.ts` (status mapping).

### What was happening

Before generation, the assembled prompt — question **plus every retrieved chunk** —
was scanned for Taxpayer Return Information patterns. Any hit threw
`ComplianceError` unconditionally. `COMPLIANCE_VIOLATION` was **not in the error
handler's status map**, so it fell through to the catch-all:

```
500  {"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}
```

On the streaming path it surfaced as `event: error → "Generation failed."` In
Teams it became "The knowledge base is temporarily unavailable."

### Why this was fatal rather than annoying

The scanner's patterns are **contextual, not identifying**. Four of the seven
match an IRS form or the word "taxpayer" within ~30–50 characters of a dollar
figure:

```
tax-form+amount   /\b(Form\s+)?(1040|1065|1041|1120)[A-Z-]*.{0,50}\$[\d,]+/is
W2+amount         /\bW\s*[-–—]?\s*2\b.{0,50}\$[\d,]+/is
taxpayer+amount   /taxpayer.{0,30}\$[\d,]+/is
```

That is a precise description of **a procedure explaining how to prepare that
form**. It is what the firm's most valuable documents look like.

### Measurement against the firm's real corpus

I extracted text from all 112 parseable documents under
`~/dev/cpa-consulting/docs/TWK SOPs` and ran the actual scanner:

| Metric                                         | Result              |
| ---------------------------------------------- | ------------------- |
| Documents matching ≥1 TRI pattern              | **9 / 112 (8.0%)**  |
| Chunks matching (at ~3.2 kB/chunk)             | **12 / 321 (3.7%)** |
| P(a 12-chunk prompt contains ≥1 match), random | **≈ 37%**           |

**Every one of the nine was a false positive.** The list is the firm's tax
practice:

```
Tax Returns/Review - Individual & Business Tax Returns Process.docx
Tax Returns/Review Checklists & Misc Calcs for Individual & Business Returns.xlsx
Tax Returns/Business Returns/Entity Preparer Checklists - Finalized.xlsx
1099's/1099 SOP Excel Master Workbook.xlsx
Tax Planning/Strategies/Kids on Payroll/Family on Payroll.docx
Tax Planning/Strategies/LA Passthrough Entity Tax (PTET)/…
```

The 37% figure **understates** the real impact, because retrieval is not random —
it is topically clustered. A question like _"what's our process for reviewing an
individual return?"_ retrieves chunks from precisely the documents that trip the
scan. For that entire question class the practical failure rate approaches 100%.

The asymmetry made it worse: ingestion deliberately **does not** block on TRI
(`pipeline.ts:306-323` — it only logs). So the documents were indexed, visible,
and returned by `/search` — and only `/ask` failed. A user would see the document
exists, then be told the system is broken when they asked about it.

### The fix

1. **`triPolicy: "block" | "warn" | "off"`** on the generation config
   (`GENERATION_TRI_POLICY`), **defaulting to `warn`**. Under `warn` the scan
   still runs and still reports — via a new `onTriDetected` hook wired to the
   pino logger with marker `generation.tri.warned` — but does not refuse. A
   permissive policy that produced no signal would silently become `off`; this
   one does not.
2. **`complianceMode=client-data` forces `block`** at wiring time
   (`packages/runtime/src/index.ts`), and logs that it did. A deployment that has
   declared real client data in scope can never inherit the permissive default by
   omission. This couples the behavior to an existing, deliberate switch rather
   than inventing a second one people set carelessly.
3. **`COMPLIANCE_VIOLATION → 422`** and `EGRESS_BLOCKED → 503` in the error
   handler. When the guard does fire it is now a truthful, distinguishable
   response rather than an indistinguishable-from-a-crash 500.
4. The two providers' byte-identical `preFlight` copies were factored into one
   `runPreFlight` so they cannot drift.

**The egress allow-list is deliberately NOT policy-tunable.** Turning the TRI
scan off must not also open the network; a test asserts this.

**Tests:** 14 new cases in `packages/rag/src/generation/generator.test.ts` cover
block/warn/off × both providers, the audit hook firing exactly on hits, the
omitted-policy default, and the egress boundary holding under `triPolicy=off`.
The fixture is the real false-positive shape, not a synthetic SSN.

---

# 🟠 High

## H-1 — Hybrid search was running on one arm for a third of real questions

**Where:** `packages/db/src/queries.ts`, `hybridSearch`.

### What was happening

The sparse arm built its query with `plainto_tsquery('english', query)`. That
function **ANDs every lexeme**:

```sql
plainto_tsquery('english', 'How do I set up a new bookkeeping client')
→ 'set' & 'new' & 'bookkeep' & 'client' & 'karbon'
```

A single chunk had to contain **every** content word of the question to match at
all. On conversational questions that bar is rarely cleared.

### Measurement

I loaded the 321 real SOP chunks into Postgres and ran 15 questions written to
match the firm's actual documented pain points:

| Result                              | Before         | After    |
| ----------------------------------- | -------------- | -------- |
| Questions with **zero** sparse hits | **5/15 (33%)** | **0/15** |

The five that matched nothing included:

- _"How do I set up a new bookkeeping client"_ — which is the worked example in the system prompt itself
- _"How do I add 2% shareholder health insurance in QuickBooks"_ — which has a dedicated SOP: `Bookkeeping/QB Payroll Procedures for Adding 2% Shareholder Health Ins.docx`
- _"How does Karbon timekeeping work"_ — SOP: `Miscellaneous/SOP - Karbon Timekeeping.docx`
- _"How do we respond to a tax notice from the IRS"_
- _"What is the occupational license renewal process"_

For those, "hybrid" search was dense-only — losing exactly the exact-token recall
the sparse arm exists to provide: form numbers, work codes like `BK-CATCHUP`,
product names, template names. That vocabulary is dense in this corpus and is
precisely what staff type.

### ⚠ The fix recorded in the docs would not have worked

[`TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md:77`](./TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md)
flags this at **LOW/MEDIUM** and prescribes `websearch_to_tsquery` as "the
standard, low-effort fix." It is not a fix — `websearch_to_tsquery` also ANDs:

```
websearch: 'set' & 'new' & 'bookkeep' & 'client'
plainto:   'set' & 'new' & 'bookkeep' & 'client'
```

Someone would have implemented it, measured no change, and concluded the issue
was cosmetic. Both the severity and the remedy in that document are wrong; this
review supersedes it.

### The fix

Build an OR-semantics tsquery from the lexemes, with each lexeme
`quote_literal`-wrapped:

```sql
COALESCE(
  to_tsquery('english', NULLIF((
    SELECT string_agg(quote_literal(lex), ' | ')
    FROM unnest(tsvector_to_array(to_tsvector('english', $query))) AS lex
  ), '')),
  to_tsquery('english', 'zzzznomatchzzzz')
) AS q_tsquery
```

Three decisions worth stating, because each guards a real failure:

- **`to_tsvector` first**, rather than splitting the raw string, so stop words
  and stemming come from the same dictionary that built the indexed `chunks.tsv`.
- **`quote_literal` per lexeme.** `to_tsquery` parses its argument as tsquery
  _syntax_. An unquoted lexeme carrying `&`, `|`, `!`, `(`, `:` or a phrase
  operator is read as an operator, and a raw-concatenation build raises a syntax
  error on inputs as ordinary as a pasted URL. This input is untrusted end-user
  text from a Teams message. Verified against pasted URLs, email addresses,
  punctuation-heavy text, and a pure operator-soup string.
- **`NULLIF` + `COALESCE`.** An all-stop-word question ("how do I do it") yields
  an empty aggregate, and `to_tsquery('')` raises. This degrades to a deliberate
  no-match, leaving dense retrieval to answer, rather than failing the search.

Precision is then the ranking layer's job — which is how BM25-style retrieval is
meant to work. `ts_rank_cd` orders the matches, the pool is truncated to
`topK × candidatePoolMultiplier`, and **RRF fuses by rank position, not raw
score**, so a broad match set cannot swamp the dense arm.

**Verification:** all 14 e2e retrieval/metadata specs pass against a real
Postgres; full workspace build, typecheck, lint, and 124 `@rag/rag` unit tests
green.

---

## H-1b — The "flat weight sweep" conclusion was partly an artifact of H-1

This one matters beyond the code, because a project decision was built on it.

[`EVAL-BASELINE.md`](./EVAL-BASELINE.md) records that the dense/sparse weight
sweep is completely flat, and reasons:

> Read that last configuration again: at `dense=0`, embeddings contribute nothing
> to the ranking at all … **On this corpus, the embedding model is not doing
> measurable work.** … which rules out the harness and the model and leaves only
> one explanation: the corpus is too easy.

From that: _"Until the gold set exists, retrieval tuning is unfalsifiable and
should not be attempted."_ That conclusion has been gating retrieval work.

**The elimination was incomplete.** A third explanation was never considered: the
sparse arm was broken, so varying its weight was a no-op. I measured the same
sweep before and after the H-1 fix, same corpus, same harness:

**Before** — all five configurations byte-identical:

```
dense=1   sparse=0   | recall@5=97.1%  nDCG@5=97.3%  MRR=1.000
dense=0.7 sparse=0.3 | recall@5=97.1%  nDCG@5=97.3%  MRR=1.000
dense=0.5 sparse=0.5 | recall@5=97.1%  nDCG@5=97.3%  MRR=1.000
dense=0.3 sparse=0.7 | recall@5=97.1%  nDCG@5=97.3%  MRR=1.000
dense=0   sparse=1   | recall@5=97.1%  nDCG@5=97.3%  MRR=1.000
```

**After** — the sweep responds, and recall improves:

```
dense=1   sparse=0   | recall@5=97.1%   nDCG@5=97.3%  MRR=1.000
dense=0.7 sparse=0.3 | recall@5=100.0%  nDCG@5=99.1%  MRR=1.000
dense=0.5 sparse=0.5 | recall@5=100.0%  nDCG@5=99.5%  MRR=1.000   ← peak
dense=0.3 sparse=0.7 | recall@5=100.0%  nDCG@5=97.4%  MRR=0.971
dense=0   sparse=1   | recall@5=100.0%  nDCG@5=97.4%  MRR=0.971
```

**What this does and does not change.** It does **not** mean the corpus is now
adequate — MRR is still 1.000 at the top and the corpus is still 14 synthetic
vocabulary-disjoint documents. The gold set is still the right priority and is
still blocked on the same conversation. What it changes is the _reasoning_: the
flat sweep was evidence of **a bug plus an easy corpus**, and it was read as
evidence of the corpus alone. The general lesson is worth keeping — **a
degenerate metric is a reason to suspect the instrument, not only the data.**

---

## H-2 — No conversation memory; follow-up questions fail on both surfaces

**Where:** `AskInput` (`packages/services/src/ask.ts:42-48`), `AskBody`
(`apps/api/src/routes/ask.ts:17-23`), `AskKbInput`
(`apps/teams-bot/src/rag-client.ts:28-31`), `useChatSessions`
(`apps/web/src/hooks/use-chat-sessions.tsx:14-16`).

Every layer carries exactly one `question` string. No history field exists
anywhere in the stack, and the web app's session store is documented as
"Ephemeral, in-memory … No persistence, no backend."

**Why this is High for this specific product.** The delivery surface is a Teams
chat. Chat sets an expectation of dialogue, and the natural way to use a
knowledge base is to narrow: _"What's the SOP for reviewing an individual
return?"_ → _"What about for partnerships?"_ → _"Who signs off on that?"_ Turns
two and three are retrieved and answered as isolated fragments. "What about for
partnerships?" embeds to nothing useful and retrieves noise.

This is not a bug — nothing is broken — but it is the gap users will hit first
and describe as "it doesn't really understand me."

**Recommended shape (not yet built).** The cheap, high-value version is
**query contextualization**, not full conversational generation: carry the last
N turns, and before retrieval make one small-model call that rewrites the
follow-up into a standalone question ("What about for partnerships?" + prior turn
→ "What is the SOP for reviewing a partnership return?"). Retrieval and the
grounding prompt stay exactly as they are. This preserves every property of the
current answer contract — citations, the A/B/C coverage rule, the abstention
behavior — while fixing the failure. Full history-in-the-prompt generation is the
wrong first step: it invites the model to answer from conversation rather than
from documents, which is the one thing this prompt is carefully built to prevent.

---

## H-3 — A transient failure permanently drops a document from the index

**Where:** `packages/ingestion/src/pipeline.ts`, `packages/connectors/src/sharepoint/index.ts`.

Two paths, one consequence:

1. **Parser failure.** `HttpParserClient.parse` throws on any 4xx/5xx. That
   happens _before_ `upsertDocument`, so a failed document leaves **no row at all**
   — not even a failed-attempt marker. `Promise.allSettled` counts it and the run
   continues.
2. **Embedding failure mid-batch.** A non-rate-limit error on batch 2 of 3 rejects
   the whole `embedBatch`; batch 1's vectors are discarded. By then
   `upsertDocument` has already run, leaving a document row with **zero chunks**.

In both cases **the SharePoint delta cursor still advances**. Graph's delta API
never re-surfaces an unchanged item, so the document is invisible until someone
edits it in SharePoint or an operator runs a full resync. The zero-chunk case has
a recovery guard (`documentHasChunks`), but that guard only runs if the connector
re-enumerates the document — which delta sync will not do.

**Why High:** the failure is silent and permanent from a user's perspective. The
KB simply does not know about a document, and nothing surfaces that. For a 858-
document corpus synced incrementally, drift accumulates invisibly.

**Recommended fix:** persist a failed-document record keyed by
`(source_id, external_id)` and retry it on the next sync regardless of cursor
position — the pipeline already has `documentHasChunks` as the precedent for
"re-derive work the cursor won't re-offer." Ship a periodic full resync in the
meantime; it is cheap at this corpus size.

---

## H-4 — Tables inside Word and PDF documents get no table-aware chunking

**Where:** `packages/rag/src/chunking/composite-chunker.ts:42-49`,
`markdown-chunker.ts:187-219`, `services/parser-py/app/main.py:653-674`.

`CompositeChunker` routes to the good `TableChunker` — which repeats the header
row on every chunk and overlaps by 2 rows — **only when a sheet carries
`sheetType`**, which the parser sets only for genuine spreadsheets. For a table
embedded in a `.docx` or `.pdf`, `_extract_tables_from_markdown` populates
`markdown` but never `headers`/`rows`/`sheetType`, so the whole document takes the
`MarkdownChunker` path, which has **no table logic at all**.

A GFM table with no blank lines is one "paragraph." If it exceeds 800 tokens it
falls to `hardSplit`, which splits on sentence punctuation and — tables having
little — falls through to a **raw character slice**. That cuts rows and cells in
half, and **no header is repeated in the continuation chunks**.

**Why this matters here specifically:** CPA checklists are the highest-value
content in this corpus and they live in Word documents. A retrieved fragment of a
review checklist with no header row and a cell split mid-value is worse than
useless — it is confidently mis-citable. The code documents this as a known v1
gap; the corpus makes it a High.

---

## H-5 — Reranking is built, tested, and switched off

`RERANK_PROVIDER` defaults to `none` (`packages/core/src/config.ts:613`). The
`Retriever` supports it cleanly: over-fetch `poolMultiplier × topK`, rerank, and
degrade to RRF order on error without failing the query. `HttpCrossEncoderReranker`
speaks the Cohere/Jina shape and has 7 passing tests.

This has been deferred on the grounds that its benefit is unmeasurable (see
H-1b). That reasoning is weaker than it looked, and independent of measurement
there is a structural argument: **this corpus has confirmed near-duplicates,
draft-vs-finalized pairs, and year-versioned twins** — `2024 HSA Requirements`
beside `2025 HSA Requirements`, `DRAFT-2024 CK Review Checklists` beside
`Entity Reviewer Checklist - Finalized`, the same file under two names. Choosing
between near-identical candidates is exactly the job a cross-encoder does and
that RRF over lexical+dense rank cannot.

**Recommendation:** enable it for the pilot behind the existing flag. It is one
env var, it fails soft by design, and it targets the corpus's specific pathology.

---

## H-6 — Superseded and duplicate documents are retrieved with equal confidence

The firm made a deliberate, correct decision to **index the SharePoint KB as-is**
rather than block the pilot on Doug's cleanup. The system's answer to the
resulting risk is the system prompt's "Conflicting or stale sources" section,
which instructs the model to present both, cite both, and use `modified=` as
evidence rather than verdict. That prompt is well-designed.

**The prompt is only as good as the dates reaching it**, and that path is thin
(see M-6). Beyond that, retrieval itself is entirely recency-blind: nothing in
ranking prefers a recently-modified document, and nothing detects that two
retrieved chunks are near-duplicates of each other. Two copies of the same
procedure can occupy two of the twelve context slots, crowding out a genuinely
different source.

**Recommendations, in order of cost:**

1. Verify `modified=` is actually populated on live production answers. It is one
   query; the prompt's whole supersession mechanism depends on it.
2. Add a near-duplicate guard to the retrieved set — the per-document cap
   (`maxChunksPerDocument`, default 3) handles one file, not two copies of it.
3. Consider a mild recency prior in fusion, kept small: recency is evidence, not
   truth, and the prompt is deliberately built on that distinction.

---

## H-7 — Grouped citations silently produced answers with no sources at all

**Where:** `filterCitationsToAnswer`, `packages/rag/src/generation/generator.ts`.

`filterCitationsToAnswer` narrows the citation list to what the answer actually
referenced — the right design, since showing a citation the answer never used
makes "cited" indistinguishable from "merely retrieved." But it collected indices
with `/\[(\d+)\]/g`, which matches **only a single number in its own brackets**.

Reproduced before fixing:

```
"Do X [1]."                 -> 1
"Do X [1][2]."              -> 1,2
"Do X [1, 2]."              -> NO CITATIONS RENDERED
"Do X [1,2]."               -> NO CITATIONS RENDERED
"Do X [1-3]."               -> NO CITATIONS RENDERED
"Do X [1][2] then [3, 4]."  -> 1,2        (3 and 4 silently dropped)
```

`[1, 2]` is a citation style models emit routinely regardless of prompt
instruction. When they do, **every citation on the answer disappears** — the
staff member sees a confident, detailed procedure with no sources at all. The
mixed case is worse: a partial list looks complete, so nothing signals that half
the audit trail is missing.

**Why High.** This system's entire safety story is "the answer is a draft; verify
it against the cited sources." An answer with no citations, delivered with no
error, defeats that story silently — and it degrades exactly on the multi-source
synthesis answers the prompt works hardest to produce.

**Credit where due:** this was correctly identified as MEDIUM in
[`TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md`](./TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md)
on 2026-07-08 and sat open for three weeks. Confirming an old finding is still
live is cheaper than finding it, and worth doing routinely.

**Fix:** match the whole bracket group, then parse its interior — handling
comma-separated lists and hyphen/en-dash/em-dash ranges. A `MAX_RANGE_SPAN` guard
stops a prose year range (`[2019-2024]`) from inflating the set; out-of-range
indices were already dropped by the existing filter, so over-collection is
harmless by construction. **10 regression tests**, one per form plus the mixed
case and the fabricated-index case.

---

# 🟡 Medium

**M-1 — The Teams bot captures no feedback.** `grep -r feedback apps/teams-bot/src`
returns nothing. The backend (`POST /feedback`), the DB (migration 0018), and the
web UI are all built and wired; `feedback.ts` even documents the
`X-RAG-Channel: teams` value the bot is meant to send. But **Teams is the surface
the firm actually asked for** ("AI bot in Teams for knowledge base" is Doug's top
item), which means the primary channel will generate **zero** quality signal.
[`EVAL-AND-FEEDBACK.md`](./EVAL-AND-FEEDBACK.md) makes the 👍/👎 sort — "KB
doesn't have it" vs "KB has it, didn't find it" — the engine of the improvement
loop. On the main surface that engine is not connected. Fix: an `Action.Submit`
on the answer card mirroring the web component. Small, and it unblocks the loop
the rest of the design depends on.

**M-2 — No upstream timeout in the web BFF.** `apps/web/src/app/api/chat/route.ts:42-51`
fetches `/ask/stream` with no `AbortSignal`. A hung API leaves the browser
spinning indefinitely with nothing surfaced. The Teams client already has the
pattern to copy (`AbortSignal.timeout`, `rag-client.ts:64`).

**M-3 — No Anthropic/Claude generator.** `createGenerator` and the config enum
cover `gemini | openai` only. Supporting Claude and GPT is a stated requirement.
The refactor in C-1 makes this cheap — providers now share `GeneratorOptions` and
`runPreFlight`, so a third provider is one class plus one enum entry plus an
`EGRESS_ALLOWED_HOSTS` line. **Deliberately not implemented in this pass:** I was
unable to consult the current Anthropic SDK reference, and writing provider code
against a remembered API is exactly how a subtle streaming or token-parameter bug
gets shipped. This should be a small, well-scoped follow-up done with the SDK
docs open.

**M-4 — Relevance scores are relative, not absolute.** `hybridSearch` normalizes
RRF by dividing by the max in the result set, so **the top hit always scores
1.0** — including when nothing relevant was found. There is no absolute
"nothing here matched" signal; the empty short-circuit only fires when the DB
returns literally zero rows, which dense ANN essentially never does. The model is
left to carry the whole burden of refusing via prompt rule C, and any UI
displaying the score as a match percentage is misleading users.

**M-5 — Images inside documents are silently dropped.** MarkItDown is
instantiated with no `llm_client` (`main.py:74`), so it has no vision. A `.docx`
SOP whose procedure is carried by screenshots parses "successfully" — non-empty
surrounding text means the Unstructured/OCR fallback **never triggers** (it fires
only on empty markdown). Nothing anywhere records that content was lost. The
corpus survey found ~13 procedures whose real content sits behind ScreenPal video
links, plus screenshot-driven Karbon walkthroughs. Those documents will retrieve
and answer thinly, with no indication why.

**M-6 — The typed `source_modified_at` column is dead.** `pipeline.ts:281` writes
it; nothing reads it. `hybridSearch` selects `doc.metadata` and `doc.title` only,
and the generator reads `metadata?.modifiedAt`. So the supersession mechanism
depends entirely on a free-form JSONB path, and `formatModifiedAttribute`
**silently renders nothing** for any value that isn't a leading `YYYY-MM-DD`.
That silent-drop is a correct security choice in isolation, but combined with the
dead typed column it means a connector regression that stopped populating
`modifiedAt` would produce zero errors and quietly disable H-6's only mitigation.
Read the typed column instead, and assert it is present.

**M-7 — `pnpm typecheck` is red on `main`.** Five errors in
`tests/e2e/src/specs/eval-faithfulness.spec.ts` (missing `.js` extensions under
`nodenext`, three implicit `any`). Verified pre-existing by stashing my changes.
[`TWK-LAUNCH-STATUS.md`](./TWK-LAUNCH-STATUS.md) records the engineering go-live
gate as **"Green — build + typecheck + lint + unit all pass on `main`."** That is
now stale, in a document whose stated purpose is to be the one place that is not.

**M-8 — Teams collapses every non-2xx to one message.** `rag-client.ts:67-69`
maps a 400, a 422 (now reachable via C-1's `block` mode), a 429, and a 503 all to
"temporarily unavailable." During a pilot that is the difference between
diagnosing an issue in a minute and in an afternoon.

**M-9 — Calculator spreadsheets pollute the index.** ~40 of the corpus's `.xlsx`
files are templates and calculators (`Tax Estimate Template.xlsx`,
`QBI_W2_Wage_Optimizer.xlsx`, `S-Corp Election Savings Calculator.xlsx`). These
chunk into rows of formula output with no procedural content — retrievable noise
that competes for context slots. A metadata-driven exclusion (or a folder-level
source filter) is a cheap, large win for precision.

**M-10 — Eval-harness hazards.** `pnpm eval:twk` is referenced by
`twk-gold-set.ts` but defined in no `package.json`. More seriously,
`run-real-eval.ts` calls `truncateAll` — `TRUNCATE TABLE chunks, documents,
ingestion_jobs, sources RESTART IDENTITY CASCADE`. It is the natural file to copy
when building a TWK gold-set runner, and pointing that copy at production would
destroy the index. Both are already recorded as C3/C4 in
[`ISSUES-AND-OPTIMIZATIONS.md`](./ISSUES-AND-OPTIMIZATIONS.md); repeated here
because the gold-set work that would trigger it is the next thing scheduled.

---

# 🟢 Low

- **L-1** — The Teams bot logs via `console.*` throughout, against the repo's own pino convention. The code self-notes it.
- **L-2** — `WEB_AUTH_MODE=static-fallback` disables per-user auth and issues one shared token. It warns when active but nothing enforces that it is turned back off. An expiry timestamp or a startup-refusal in production would close it.
- **L-3** — The Teams bot must run single-instance (`MemoryStorage` for the SSO exchange). Correct for 20 users; will silently break the sign-in flow if anyone scales it out.
- **L-4** — `ts_rank_cd` runs with default normalization (0), so it does not divide by document length and mildly favors long chunks. Now that the sparse arm actually contributes (H-1), normalization flag `32` (`rank/(rank+1)`) is worth a measurement.
- **L-5** — `pipeline.ts:287-293` spreads parser metadata _after_ connector metadata, so a future parser that emitted `modifiedAt`/`title`/`url` would silently clobber the connector's authoritative values. No live collision today.

---

## What I changed

| File                                            | Change                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/config.ts`                   | `generation.triPolicy` enum + `GENERATION_TRI_POLICY` wiring                                                 |
| `packages/rag/src/generation/generator.ts`      | Shared `GeneratorOptions`/`runPreFlight` (C-1); grouped-citation parsing (H-7)                               |
| `packages/rag/src/generation/generator.test.ts` | +24 tests: TRI policy × 2 providers + audit hook + egress boundary (C-1); 10 citation-form regressions (H-7) |
| `packages/runtime/src/index.ts`                 | Wire policy; force `block` under `client-data`; log the override + hits                                      |
| `apps/api/src/error-handler.ts`                 | `COMPLIANCE_VIOLATION → 422`, `EGRESS_BLOCKED → 503`                                                         |
| `packages/db/src/queries.ts`                    | OR-semantics, injection-safe tsquery construction                                                            |
| `env.example`                                   | Document `GENERATION_TRI_POLICY` and the measurement behind its default                                      |

**Verification:** `pnpm -r build` ✅ · `pnpm lint` ✅ (0 errors, 28 pre-existing
warnings) · **147** `@rag/rag` unit tests ✅ · 49 `apps/api` tests ✅ · 14 e2e
retrieval/eval/metadata specs against real Postgres ✅ · `pnpm typecheck` shows
the 5 pre-existing failures of M-7 and no new ones.

**Not changed:** everything else in this document. H-2 through H-6 and all
Medium/Low findings are documented for scheduling, not silently deferred.

---

## Recommended sequence

**Before the pilot opens to staff** — small, and each targets a defect users will hit:

1. ✅ C-1 and H-1 (done).
2. Enable reranking (**H-5**) — one env var, fails soft.
3. Teams feedback buttons (**M-1**) — without them the pilot generates no signal.
4. Web BFF timeout (**M-2**) and Teams error differentiation (**M-8**).
5. Verify `modified=` is populated on live answers (**H-6** #1) — one query.
6. Exclude calculator spreadsheets (**M-9**).

**During the pilot:**

7. Query contextualization for follow-ups (**H-2**) — the largest usability win.
8. Failed-document retry (**H-3**); schedule a periodic full resync immediately as the stopgap.
9. Table-aware chunking for Word/PDF (**H-4**).
10. The Doug gold-set session — still the right priority, still blocked on the same conversation. **Note H-1b:** run the sweep again once real questions exist; the instrument now responds, so the session's output will be more informative than previously expected.

**Follow-up:**

11. Anthropic/Claude provider (**M-3**), done with the SDK reference open.
12. M-4 through M-7, L-1 through L-5.

---

## Is this generic enough for other domains?

Largely yes, and the architecture deserves credit for it. Contracts live in
`@rag/core`, business logic is transport-agnostic in `@rag/services`, the
dependency graph is built once in `@rag/runtime`, and adding a connector,
embedder, or reranker is "implement the interface, register it in the factory."
Nothing about the retrieval or ingestion path is CPA-specific.

Three things are domain-coupled, and only one is a problem:

- **The system prompt is explicitly CPA-firm-shaped** — right down to a
  `BK-CATCHUP` worked example. This is correct: a generic grounding prompt would
  be worse for this firm. But it is a hardcoded module constant, so adapting to a
  second domain means editing source. Making it configurable (with the current
  text as the default) is the single change that would make this genuinely
  multi-domain.
- **The TRI scanner is US-tax-specific.** After C-1 it is policy-gated and
  defaults to non-blocking, so a non-tax deployment is unaffected — but it is
  still running regexes for IRS forms against, say, a hospital's SOPs. It belongs
  behind the same plugin boundary the connectors use.
- **`docClass` / Class A–D taxonomy** is a CPA compliance concept threaded
  through ingestion and retrieval. It generalizes fine as "sensitivity tier."

The pre-existing `ISSUES-AND-OPTIMIZATIONS.md` §5 (OPT-A: connector registry
instead of a factory `switch`) and the platform-tenancy spec both point the same
direction. Nothing found in this review contradicts that plan.

---

## A note on the corpus itself

Retrieval quality is bounded by content quality, and two findings from the corpus
survey are worth carrying into the pilot conversation because **no engineering
fixes them**:

- **A named client identifier exists inside a Class-A SOP.** `Tax Returns/Individual Returns/Preparation - Individual Tax Return.docx` uses a real client name, entity, and tax year as a worked file-naming example. This does not break the §7216 argument — it is not return data — but it **falsifies the "internal-only by default" assumption** and turns P0 gate #1 (the Chris/Doug document review) from a formality into a live finding.
- **The corpus is knowingly dirty**: confirmed duplicates across folders, draft-vs-finalized pairs, year-versioned twins with no supersession markers, and ~13 procedures whose content is behind video links the parser cannot read. Indexing as-is was the right call for pilot speed. H-5, H-6, M-5 and M-9 are the engineering half of managing that decision; the other half is Doug's cleanup queue, which the feedback loop (M-1) is supposed to prioritize — which is why M-1 is worth more than its severity band suggests.
