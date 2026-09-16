# Multi-Vertical RAG Platform — Design

**Status:** Design — 2026-08-03. Approved in brainstorming.
**Supersedes in part:** [`2026-07-17-platform-tenancy-and-plugin-boundary.md`](./2026-07-17-platform-tenancy-and-plugin-boundary.md) (keeps its three-layer model and security rule; replaces its code-plugin-first mechanism with data-first packs).
**Absorbs:** [`2026-07-11-generic-document-classification-engine-design.md`](./2026-07-11-generic-document-classification-engine-design.md) (its declarative `ClassificationRuleSet` becomes part of the pack format).

---

## 1. Goal and operating model

`rag-system` is the reusable foundation for a **consulting practice**. When a client
business needs a RAG solution, the same core is deployed and configured for that
business — no fork, no per-client codebase.

Target verticals are largely **regulated and each differently**: CPA firms
(IRC §7216, GLBA), insurance, banking (GLBA, SOX), hospitals (HIPAA), and
behavioral-health / treatment centers (HIPAA **plus 42 CFR Part 2**, which is
stricter). The consumer is the consultant, not a third-party developer.

**Each client runs their own deployment, in their own environment, against their
own database.** No shared control plane, no commingled tenancy, no hosted
service. This matches decision D5 in the tenancy spec and is a selling point in
these verticals: the client's data never leaves their infrastructure.

Two consequences shape everything below:

- **Updates are pull-based.** You cannot push a fix; the client redeploys an image tag. Upgrade safety and version reporting are product features, not afterthoughts.
- **You have no access when something breaks.** The system must produce diagnostics the client can run and send back — without sending client data.

### What this design does _not_ change

The retrieval pipeline is sound and is out of scope. Measured against standard
practice: 800-token chunks with 15% overlap (both in the recommended band),
hybrid dense + sparse with RRF, heading path baked into chunk text, per-chunk
provenance, citations as an audit trail, and an eval harness computing
recall/precision/nDCG/MRR plus faithfulness. Known gaps are _enablement_ —
reranking is built and egress-gated but switched off, and the eval corpus cannot
discriminate — not architecture.

Deliberately excluded: multi-query retrieval, HyDE, and parent-document
retrieval. The `cpa-consulting` research (`docs/rag/findings/r2-domain-answer-quality.md:470-477`)
measured query rewriting as neutral-to-negative for single-document procedural
corpora, which is the shape most of these verticals have.

> **Notes (2026-09-16).** (1) That exclusion covers _single-turn_ rewriting.
> Conversational follow-up condensation — a different problem — was adopted
> (decision B0; `packages/rag/src/retrieval/contextualize.ts`). (2) The eval
> harness's faithfulness scorer is unit-tested but does not yet score real
> answers: the gold set is empty, and `pnpm eval:gold` scores retrieval,
> refusals and citations only. (3) Enabling reranking is more than switching it
> on: the A2–A5 prerequisites (done on `fix/rag-review-findings`) plus a
> vendor/DPA decision and a measured gain. See `docs/RAG-REVIEW-2026-09-16.md`.

---

## 2. The three layers

| Layer                                  | Contains                                                                                                              | Varies by | Never contains                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------- |
| **Core** (`rag-system`)                | Ingest → retrieve → cited answer; per-user source scoping; fail-closed sensitivity gate; audit log; egress allow-list | nothing   | any domain knowledge                  |
| **Vertical pack** (data, in git)       | Tier definitions, scanner patterns, system prompt, disclaimer, vocabulary, classification rule shapes                 | industry  | client secrets, client-specific paths |
| **Client deployment** (their DB + env) | Sources, folder exclusions, roster, retrieval knobs, branding                                                         | client    | any code                              |

**The load-bearing rule** (carried forward from the tenancy spec §1): core owns
_"there is a sensitivity gate, it fails closed, and every answer is scoped and
audited."_ A pack owns _"here is what trips it and what the tiers mean."_ **A pack
supplies policy, never enforcement.** It can never widen or reimplement the
security boundary.

### Why core must not accumulate domains

Today `@rag/core` contains `scanForTRI` with IRS-form regexes, a Class A/B/C/D
taxonomy citing §7216 (`types.ts:30-35`), and `@rag/services` stamps a Circular
230 §10.37 disclaimer on every answer (`ask.ts:51-59`). Following that pattern
across five verticals yields a core holding a TRI scanner **and** a PHI scanner
**and** a PAN scanner, and a taxonomy that is the union of five regulatory
schemes. That is the failure mode this design exists to prevent.

---

## 3. The vertical pack

A directory of data:

```
packs/cpa/
  pack.yaml           # identity, tiers, scanners, disclaimer, adminEditable
  prompt.md           # the system prompt
  classification.yaml # rule shapes mapping documents to tiers
  fixtures/           # synthetic corpus + positive/clean scanner fixtures
  README.md           # what this pack asserts — for a compliance reviewer
```

### 3.1 Tiers are open, not a fixed enum

```yaml
tiers:
  - id: firm-internal
    label: "Class A — firm-internal, how-we-work"
    indexable: true
  - id: client-tax
    label: "Class D — client tax-return data"
    indexable: false
    reason: "requires §7216 consent workflow"
```

A behavioral-health pack declares `org-internal` / `phi` with
`reason: "HIPAA; 42 CFR Part 2 for SUD records"`. Core never interprets the
labels — it enforces _"tier X is not indexable, so refuse and log."_

> **Schema change required.** `dataClassEnum` (`packages/db/src/schema.ts:52-57`)
> is a Postgres enum with four fixed values, and `DocumentClass`
> (`packages/core/src/types.ts:30-35`) is a zod enum of `A|B|C|D`. Open tiers
> require the column to become text with the pack supplying the vocabulary. This
> is a real migration and it touches the ingestion gate at
> `packages/ingestion/src/pipeline.ts:245`.

### 3.2 Scanners carry severity as a first-class field

```yaml
scanners:
  - id: ssn
    kind: identifying # a match is a hard stop regardless of policy
  - id: tax-form-with-amount
    kind: contextual # a signal for review, never a verdict
```

This distinction is load-bearing and was learned expensively. Screening the firm's
858-document corpus, the contextual pattern `tax-form+amount` matched **316
documents** and every inspected hit was a legitimate SOP, while `ssn`/`ein`
matched **24**, one of which held 522 SSN-shaped values — a real client roster.
A pack with a single severity level either blocks everything or catches nothing.
The split already exists in code (`packages/core/src/tri-scanner.ts:95-131`); the
pack format promotes it from a CPA-specific constant to a required field.

### 3.3 Classification rules: shape in the pack, patterns in the DB

"Documents under `/Clients/` are tier `client-business`" is policy expressed over
client-specific paths, so it splits:

- **Pack** declares what a rule may match on (path, mime type, content pattern) and which tier it assigns.
- **DB** holds this client's actual patterns — their folder happens to be called `Client Service Package Files`.

### 3.4 The escape hatch is a registered name

A pack may declare `extensions: { classifier: "cpa-ml-classifier" }`. The name
must resolve to an implementation compiled into the image. Unusual verticals get
real code; adding it still requires an image rebuild. No dynamic loading of
arbitrary modules — the supply chain stays auditable, which matters when
deploying into a bank.

### 3.5 The pack is the compliance artifact

`packs/behavioral-health/README.md` states what the pack asserts and what it
blocks, in prose a compliance officer reads without touching TypeScript. In these
verticals that review is part of the sale.

### 3.6 Pack ↔ core compatibility is explicit and fails closed

Because updates are **pull-based**, a client can end up running any combination
of image tag and pack version. "Silently ran an incompatible pack" is exactly the
failure that cannot be debugged remotely, so compatibility is declared, checked
at boot, and refused rather than guessed.

Every pack declares the core contract it targets:

```yaml
pack:
  id: cpa
  version: 2.1.0
  requiresCore: "^3.0.0" # semver range against the PACK CONTRACT version
```

**`requiresCore` is a version of the pack contract, not of the product.** Core
exposes `PACK_CONTRACT_VERSION` — bumped only when the pack format's meaning
changes (a new required field, changed semantics for an existing one, a removed
capability). Shipping a patched retriever does not bump it; adding a mandatory
`kind` to scanners does.

At boot, core resolves the pack, checks `requiresCore` against its own
`PACK_CONTRACT_VERSION`, and **refuses to start on a mismatch** — the same
fail-fast posture as `assertEmbeddingDimensions` and `assertRequiredIndexes`. The
error names both versions and which direction is stale, because the operator
reading it is a client's IT staff, not you:

```
Pack "cpa" 2.1.0 requires core pack-contract ^3.0.0; this image provides 2.4.0.
The pack is newer than the image — pull a newer image tag, or check out an
older pack.
```

Two rules follow:

- **Unknown fields in a pack are an error, not a warning.** A pack written against a newer contract will contain fields this core silently ignores otherwise — and silently ignoring a _scanner_ is a compliance failure, not a cosmetic one.
- **Both versions appear in the acceptance-run output (§6.3) and in the health endpoint**, so "what is this client actually running" is answerable from a screenshot.

### 3.7 Sensitive-content disposition at ingest

Scanning is only half a control; what happens **on a match** is the other half,
and it must be declared rather than implied. Scanners gain a `disposition`, whose
default derives from the `kind` they already carry:

```yaml
scanners:
  - id: ssn
    kind: identifying
    disposition: exclude # default for identifying
  - id: tax-form-with-amount
    kind: contextual
    disposition: flag # default for contextual
```

| Disposition | Effect                                         | When it is right                                                       |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `exclude`   | Document is never indexed; the event is logged | The document is a client file, not firm procedure. **The default.**    |
| `redact`    | Indexed with matched spans masked              | Overwhelmingly procedure, stray reference, and the concern is _egress_ |
| `flag`      | Indexed as-is; recorded for review             | Advisory signal — a procedure that merely names a regulated form       |

#### Exclusion is the default; redaction is the exception

Two independent lines of evidence, and one structural fact, put the default at
exclusion:

- **Redaction degrades exactly this workload.** Amazon Science (arXiv 2411.05978) measured sanitization at ~1–5% cost on sentiment and entailment but **>25% on comprehension Q&A** — which is what a knowledge-base assistant does.
- **NIST SP 800-188** frames de-identification as reducing residual risk, never eliminating it; residual risk must be evaluated explicitly rather than assumed away.
- **A document that fails an identifying scanner usually should not be in a procedures corpus at all.** Redacting it keeps a client file in the index with holes in it, which serves no one.

#### ⚠ Redaction protects the model, not the user

**Redacting an indexed chunk does not redact the source.** `metadata.url` points
at the original in the client's SharePoint or Drive, and users have access to it —
that is the point of a citation. Redact a chunk and the citation still links to
the unredacted file.

So redaction's value is narrow and specific: **it stops text reaching a
third-party model.** It does nothing about internal access. That makes it a
legitimate _egress_ control and an invalid _confidentiality_ control, and the
distinction must not blur — a deployment that redacts and believes it has
protected against internal disclosure has protected against nothing.

Two rules follow, both mirroring AWS's own RAG reference architecture, which does
not trust single-pass redaction either:

- **Re-scan after redacting.** A document still tripping an identifying scanner post-redaction is **excluded**, not indexed.
- **Record the redaction** in `ingest_log`: scanner id and match count, **never the matched value**.

#### What is tunable, and what is not

Per §4.1's sensitivity axis, disabling a scanner that would have excluded a
document **widens the sensitivity boundary** — so a deployment-level
"scrubbing: off" switch is the tier gate disabled under another name.

- **Identifying scanners are not disableable from configuration.** Their definitions and dispositions are pack-resident and `protected` (§4.2).
- **Contextual scanners are DB-tunable** — a deployment may quiet them. They are advisory by construction, and on the firm's corpus the contextual patterns produced **316 flags, all false positives**, so tuning them is a genuine operational need. The half that caught the 522-SSN roster stays on.

#### ⚠ This reorders the pipeline's most sensitive section

`scanForTRI` currently runs at `packages/ingestion/src/pipeline.ts:309` — **after**
`upsertDocument` has already persisted the row including full markdown. That is
adequate for `flag`, which is all it does today. **It cannot support `exclude`:**
by the time the scan runs, the sensitive text is already in the database.

Supporting exclusion requires moving the scan **between parse and persist**. The
change is small and the blast radius is not — slice 1b must treat it as a
first-class task with its own tests, not as a tweak.

### 3.8 The scrub toggle — `ingest.scrubBeforeIndex`

The consumer can turn removal of sensitive spans on or off per deployment.

**Catalog entry:** `ingest.scrubBeforeIndex`, boolean, default `true`,
**unprotected** — a pack may expose it via `adminEditable`. It is operational,
not policy: it does not change what counts as sensitive, only whether this
deployment applies removal.

**Scope — it governs `redact` and nothing else:**

| Disposition | Toggle on              | Toggle off          |
| ----------- | ---------------------- | ------------------- |
| `redact`    | spans masked pre-chunk | ingested unmodified |
| `exclude`   | excluded               | **still excluded**  |
| `flag`      | logged                 | **still logged**    |

A deployment that would rather keep raw text and rely on exclusion can say so.
It cannot use this switch to admit material the sensitivity gate rejects — that
would be §4.1's boundary widened under a friendlier name.

#### Downside 1 — the switch is not symmetric, and people will assume it is

Scrubbing rewrites the text that gets chunked and embedded. The index keeps no
memory of what was removed. **Turning it off later affects only documents
ingested afterward**; making it retroactive requires re-ingestion. A toggle that
looks reversible and isn't will be flipped by someone expecting the corpus to
change, and it won't.

**Mitigations:**

- **Record processing provenance per document.** Store which ruleset version and scrub setting produced each row. This makes "which documents were indexed under scrubbing?" a query rather than a guess.
- **Targeted re-ingest, not full re-sync.** With that record, re-processing hits only affected documents. The pipeline already has the precedent — `documentHasChunks` (`packages/db/src/queries.ts:346`) re-derives work the connector cursor will not re-offer.
- **Say it at the point of change.** The admin UI must state, on toggle, that it applies to future ingestion and name how many documents were indexed under the previous setting. A warning in a spec nobody reads is not a mitigation.

#### Downside 2 — it perturbs change detection

The pipeline keys idempotency on `sha256(parsed.markdown)`. Fold scrubbing into
that hash and flipping the toggle — or editing one scanner pattern — makes every
affected document look content-changed, forcing re-chunk and re-embed. Leave it
out and a ruleset change **silently fails to propagate**, which is worse: the
policy was updated and the corpus quietly wasn't.

**Resolution: hash the source pre-scrub, and version the processing separately.**

`contentHash` keeps its current meaning — the source document's content. Add a
`processingVersion` capturing `(scrubEnabled, scannerRulesetVersion)`.
Re-processing triggers when **either** changes:

| Source  | Ruleset | Action                               |
| ------- | ------- | ------------------------------------ |
| same    | same    | skip — correct and fast              |
| same    | changed | re-process — new patterns must apply |
| changed | any     | re-process                           |

This is better than one combined hash on two counts: `contentHash` keeps meaning
one thing, and ruleset drift becomes explicitly queryable — which is also the
mechanism Downside 1's mitigations depend on. One column, two problems.

#### Downside 3 — scrubbing degrades retrieval invisibly

Masking spans changes chunk text, so embeddings shift and BM25 loses tokens. A
heavily-scrubbed document can become effectively unretrievable, with no signal
anywhere.

**Mitigations:**

- **Record redaction density** (matches per document) at ingest.
- **Surface high-density documents to the operator.** A document needing heavy redaction is evidence it should have been `exclude`d instead — the density report is how that judgment gets made from data rather than intuition.

#### Downside 4 — redaction still protects the model, not the user

Carried from §3.7 and repeated because this toggle is where someone will believe
otherwise: scrubbing controls what reaches a third-party model. `metadata.url`
still opens the unredacted original, and users have access.

**Mitigations:**

- **Suppress the download for scrubbed documents.** `citations[].downloadable` and the object-store path are ours to control; set `hasOriginal = false` so `/documents/:id/download` 404s. This does not close the source link, which is the client's system, but it closes the one we own.
- **Label the citation as redacted.** Without it, a user reads an answer built from masked text, opens the source, and sees content the answer omitted — with no explanation. The label is what makes that difference legible instead of looking like a bug.
- **The admin UI copy must state the limitation** where the toggle lives, not only in this document.

#### Deliberately not built

**Per-source scrub settings.** Plausible — one source scrubbed, another not — but
no engagement has needed it. Deployment-wide now; the catalog key is namespaced
`ingest.*` so a per-source override can be added without renaming.

---

## 4. Pack vs. database: the configuration split

**The test: does changing this require review?**

| Item                                                    | Where    | Rationale                                                                        |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| Tier definitions and `indexable`                        | Pack     | Widening changes what is legally allowed in the index                            |
| Scanner patterns and `kind`                             | Pack     | Weakening a scanner is a compliance change                                       |
| Scanner `disposition` (exclude/redact/flag)             | Pack     | Determines whether a match keeps material out (§3.7)                             |
| Whether an _identifying_ scanner runs at all            | Pack     | Disabling one widens the sensitivity boundary                                    |
| Whether a _contextual_ scanner flags                    | DB       | Advisory only; 316 false positives on the firm made this a real operational need |
| `ingest.scrubBeforeIndex` (redaction on/off)            | DB       | Applies removal; does not change what counts as sensitive (§3.8)                 |
| System prompt                                           | Pack     | It is the grounding contract                                                     |
| Disclaimer                                              | Pack     | Often a regulatory requirement                                                   |
| Classification rule _shapes_ — what a rule may match on | Pack     | Defines what classification can express at all                                   |
| Sources to index                                        | DB       | Deployment fact                                                                  |
| Classification _patterns_ — this client's folder names  | DB       | Client-specific instances of a pack-defined shape (§3.3)                         |
| Folder exclusions                                       | DB       | Client-specific; changes during engagement                                       |
| Staff roster                                            | DB       | Changes with hiring                                                              |
| Retrieval knobs (`topK`, weights, rerank on/off)        | DB       | Tuning, no policy content                                                        |
| Vocabulary additions                                    | DB       | Additive, harmless                                                               |
| Branding (`APP_NAME`)                                   | DB / env | Cosmetic                                                                         |

### 4.1 The safety property — two axes, not one

An earlier draft stated this as _"database configuration can narrow, never
widen."_ **That is wrong**, and the table above contradicts it: `sources` is
DB-editable, and adding a source widens the corpus. So does removing a folder
exclusion. Configuration that could only ever narrow would be useless.

The property holds on one axis and not the other, and they need separate names
because they get enforced differently:

| Axis                     | Question it answers                                          | Can DB config change it?                                                          |
| ------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Sensitivity boundary** | _What is permitted to be indexed at all?_                    | **No — never, in either direction.** Pack-only.                                   |
| **Retrieval scope**      | _Which permitted material is actually indexed and returned?_ | **Yes, freely — widen or narrow.** Add a source, drop an exclusion, raise `topK`. |

Concretely: an admin may add a SharePoint site, remove a folder exclusion, and
raise `topK` — all widening, all fine, because every document that arrives still
passes the same sensitivity gate. An admin may **not** mark a blocked tier
indexable, weaken a scanner, or edit the prompt, because those change what the
gate itself permits.

The two are enforced by different mechanisms:

- **Sensitivity boundary:** structurally unreachable from config. Tier and scanner definitions are pack-resident, and `adminEditable` cannot name a protected setting (§4.2) — a pack that tries fails validation at boot.
- **Retrieval scope:** validated against the settings catalog's types and ranges on every write, and audited. Widening is legitimate but must be attributable.

There is an existing precedent for the sensitivity axis: `effectiveSourceFilter`
(`packages/core/src/access-control.ts:262`) lets a caller's filter narrow _within_
their enforced scope but never beyond it. Note the analogy is to the **enforced
scope**, not to the caller filter — the caller filter is exactly the
freely-adjustable retrieval-scope axis.

### 4.2 The admin surface is pack-declared, with a core-enforced floor

The set of admin-editable settings is itself per-vertical:

```yaml
adminEditable:
  - sources
  - folderExclusions
  - vocabulary
  - retrieval.topK
  - retrieval.rerankEnabled
```

Three-way ownership:

| Layer    | Owns                                                                                                 | Example                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Core** | The **settings catalog**: what settings exist, their types and validation, and which are `protected` | `tiers` → protected. `retrieval.topK` → integer 1–100, not protected |
| **Pack** | Which unprotected settings this vertical exposes                                                     | `adminEditable: [retrieval.topK, …]`                                 |
| **DB**   | Current values, plus who changed them and when                                                       | `topK = 15`, set by a named principal, timestamped                   |

A pack listing a protected setting **fails validation at boot**, not at first
edit. "No pack can expose a protected setting" is a single conformance test — the
boundary is enforced mechanically rather than by remembering.

The admin UI renders generically from the catalog's types, so exposing a new
setting is one pack line and no frontend work. Every write is validated
server-side against the catalog; the UI is never trusted.

### 4.3 Implementation wrinkle: config is currently load-once

`loadConfig()` runs once at startup and `buildCoreDeps` builds everything from
it. DB-resident settings that take effect without a restart need a read path.

**Decision: read from the DB per request behind a short-TTL cache.** One trivial
query, effect within seconds. Rejected: a reload signal (more machinery) and
restart-on-change (poor UX at a client site you cannot reach).

---

## 5. Local generation — required, and nearly free

`createGenerator` supports `gemini | openai` only. For a treatment center under
42 CFR Part 2 or a hospital under HIPAA, sending record text to a third-party API
may be unavailable — meaning the system can index their corpus but not answer
from it. This blocks two of the named verticals outright.

**The fix:** the installed OpenAI SDK (`openai@4.104.0`) accepts `baseURL` in
`ClientOptions` (verified at `node_modules/openai/index.d.ts:44`). Ollama, vLLM,
LM Studio, and llama.cpp all expose OpenAI-compatible endpoints. Adding
`baseURL?: string` to `GeneratorOptions` and threading it into
`new OpenAI({ apiKey, baseURL })` (`generator.ts:372`) turns the existing
`OpenAIGenerator` into a client for any self-hosted model.

Combined with `EMBEDDING_PROVIDER=local` (ONNX, on-process, already present),
this yields a **fully air-gapped deployment** — nothing leaves the client's
network. The egress allow-list still applies and should be set to the local
endpoint's host.

### 5.1 This change is not purely additive — it opens a hole that must be closed

`OpenAIGenerator.preFlight` passes a **hardcoded literal** to the egress check:

```
generator.ts:372   this.client = new OpenAI({ apiKey: opts.apiKey });   // no baseURL
generator.ts:380   runPreFlight(prompt, "https://api.openai.com", ...)  // hardcoded
generator.ts:294   egressPolicy.assertAllowed(endpoint);
```

Adding `baseURL` without threading it into `runPreFlight` would make the
allow-list validate `api.openai.com` while the request goes somewhere else —
silently defeating the boundary that gates the reranker. The endpoint argument
must become `this.opts.baseURL ?? "https://api.openai.com"`, and a test must
pin that the check sees the **effective** host. This is a live correctness gap
independent of the feature; the feature is what makes it exploitable.

### 5.2 Do not auto-relax the TRI gate for local endpoints

With a fully local model the TRI gate guards nothing — its purpose is
preventing third-party egress — so inferring "local, therefore relax
`triPolicy`" is tempting. Don't. "Looks local" is not a security property:
`localhost:11434` can be an SSH tunnel to anywhere. Keep `triPolicy` explicit
and document that an air-gapped deployment may relax it **deliberately**.

---

## 6. Verification

### 6.1 Pack validation — static, at build and at boot

Schema-validate the pack. Malformed tiers, a scanner with no `kind`, a blocked
tier with no `reason`, a protected setting in `adminEditable` — all refuse to
start. This follows the existing fail-fast pattern (`assertEmbeddingDimensions`,
`assertRequiredIndexes`): a bad pack fails at boot, never at first query.

> **Risk introduced by data-driven packs: user-authored regexes.** A pathological
> scanner pattern can hang the ingest worker (ReDoS). Validation must compile and
> time-box every pattern against a fixture at load. This would not arise if packs
> were code reviewed as code; it is the cost of the chosen format.

### 6.2 Pack conformance suite — CI, shared across all packs

One suite, parameterized by pack, asserting invariants that hold regardless of
vertical:

- every scanner compiles and terminates within budget
- each `identifying` scanner matches its own positive fixture and does **not** match the pack's clean fixture
- at least one tier is indexable; every non-indexable tier states a reason
- no `adminEditable` entry names a protected setting
- the prompt satisfies **structural** requirements (below)

#### What the prompt check can and cannot do

An earlier draft specified running the pack's prompt "against the fixture corpus
with a deterministic fake generator" to prove it "produces a cited answer and
abstains." **That test cannot work.** `FakeGenerator`
(`packages/test-fixtures/src/fake-generator.ts`) receives `(question, context)`
only — the system prompt is a constructor concern of the real generators and
never reaches it. A fake ignores the prompt entirely, so the assertion would
prove nothing about prompt quality while appearing to.

Split into two checks with honest scopes:

**Structural, in PR CI (fast, deterministic, no model).** Assert the prompt text
contains the grounding contract's required elements: an instruction to cite with
`[N]`, an instruction to answer only from supplied documents, an explicit
abstention instruction, and an untrusted-content clause. This is a lint, not a
behavioral proof — it catches a prompt rewritten without the contract, which is
the realistic failure. It cannot catch a prompt that contains the words and still
behaves badly.

**Behavioral, nightly, against a real local model.** Boot with
`GENERATION_PROVIDER` pointed at a local endpoint (§5), run the pack's fixture
questions, and assert a cited answer plus abstention on an out-of-corpus
question. Non-deterministic and slower, so it does not gate a PR — it gates a
release. This is the only check that actually tests behavior, and it is
affordable precisely because §5 makes local generation available.

**Do not claim the structural check proves the grounding contract holds.** It
proves the contract was not deleted.

### 6.3 Image acceptance run — the same command in CI and at the client

One entry point that boots against a **throwaway database**, ingests the pack's
synthetic fixtures, and asserts end to end:

- migrations apply; required HNSW and GIN indexes exist
- a document in a blocked tier is refused at ingest
- a question returns a non-empty answer with at least one citation
- an out-of-corpus question abstains
- the running core version and pack version are reported

In CI this gates the image tag. At the client it runs after a pull and produces a
report they send back. It never touches their real corpus or database.

### 6.4 Drift check — real corpus, aggregates only

Synthetic fixtures prove the image works; they cannot prove it works on _their_
documents. An upgrade that degrades retrieval on a specific corpus passes every
synthetic test.

**But the report must never carry client data.** If it included document titles
or chunk text and the client emailed it, that would be a disclosure — for a HIPAA
or 42 CFR Part 2 client, a reportable one, caused by diagnostic tooling. This is
concrete: ~30 of the firm's own document titles carry a personal name in `Surname, Firstname` form, 9 of them as `(YYYY Package)` client deliverables.

**Design:** a differential test needing **no ground truth**. Run the same N
questions before and after an upgrade against the same corpus, and report only
_"top-3 retrieved documents changed for 12 of 40 questions."_ Counts and hashed
document ids — never titles, never text.

Zero drift means the upgrade was inert for them. High drift means look before
rolling forward. Runs only at the client, only on demand, read-only via
`createReadOnlyDb` + `assertReadOnly` (`packages/db/src/client.ts:103,153`).

---

## 7. Out of scope

- **Publishing `@rag/*` to npm.** There is no external developer consuming libraries; the delivery unit is an image set plus a pack plus an env file. Publishing would also place the firm corpus findings currently embedded in `tri-scanner.ts` and `config.ts` comments on a public registry for no benefit.
- **A multi-tenant control plane or hosted service.** Contradicts the per-client isolation model.
- **Query rewriting, HyDE, multi-query, parent-document retrieval.** Measured as neutral-to-negative for these corpora. (Single-turn only: conversational follow-up condensation was adopted as decision B0.)
- **Dynamic plugin loading.** Static, in-image extensions only.

---

## 8. Implementation slices

This design is larger than one plan. It decomposes into five, in dependency
order. Each gets its own implementation plan.

Slice 1 was originally one unit. It is split here because its parts do not share
a risk profile: two-thirds of it is file moves with no migration, and one-third
is two migrations plus a reorder of the most sensitive stretch of the ingestion
pipeline. Bundling them would gate the safe work on the dangerous work for no
reason.

**Slice 1a — Domain extraction (the safe two-thirds).**
Neutral default prompt with the CPA prompt moved into the first pack; the
disclaimer (`ask.ts:51-59`) made pack-supplied; the CPA pack skeleton created.
No schema migration, no pipeline change. This is what delivers "core is not
opinionated about any domain." _Days._

The one real hazard is behavioural, not structural: the live the firm pilot's answers
change the moment the default prompt goes neutral, so the core change and the
pack that restores its prompt must land in a single deploy.

**Slice 1b — The sensitivity machinery (the dangerous third).**
Tiers opened (`dataClassEnum` → text, `DocumentClass` open — migration #1);
scanners moved behind pack policy; the §3.7 pipeline reorder; the §3.8
`processingVersion` column (migration #2). _Weeks._ Gated on two things:

- **the tier migration's own design pass** (§10) — `dataClass` gates ingestion at `pipeline.ts:245`, and the current enum collapses Class C and D, so any change that lets C through lets D through;
- **the firm content-boundary work** ([`../plans/2026-08-03-kb-content-boundary.md`](../plans/2026-08-03-kb-content-boundary.md) Phase 1) having removed confirmed Class D data from the live index. Refactoring the sensitivity machinery while a client roster is retrievable is the wrong order.

The pipeline reorder deserves its own tests regardless of the migrations:
today's ordering means a document that _should_ be excluded is already in the
database, markdown and all, before anything looks at it. `processingVersion`
ships here rather than with the toggle in slice 3 because retrofitting
provenance onto an already-ingested corpus means a full re-sync at every client
— cheap now, expensive later.

**Slice 2 — Local generation.**
`baseURL` on `GeneratorOptions`, threaded through config and `buildCoreDeps`,
plus the §5.1 egress fix and the §5.2 non-decision, plus docs. _Half a day to a
day; independent of everything else; unblocks two verticals._

**Slice 3 — Settings catalog + DB-resident config + admin surface.**
Catalog with types and `protected` flags; per-request read with short-TTL cache;
generic admin UI; audited writes. **Includes `ingest.scrubBeforeIndex` (§3.8)**
with its on-toggle warning, the targeted re-ingest path, and the
redaction-density report — the toggle without those is a switch whose
consequences are invisible.

**Slice 4 — Verification framework.**
Pack validation (incl. the §3.6 contract check and RE2-based scanner bounding),
the structural conformance suite in PR CI, the nightly behavioral check against
a local model, the acceptance run, and the drift check. _Depends on slice 2 —
the nightly behavioral check needs local generation to be affordable._

### 8.1 Recommended order: 2 → 1a → (containment) → 1b → 3 → 4

**Start with slice 2**, for four reasons in ascending order of importance:

1. It is the only slice with no gate in front of it.
2. It unblocks the healthcare and treatment-center verticals, and makes slice 4's nightly behavioral check affordable.
3. It forces the §5.1 egress fix, which is worth doing whether or not local generation ever ships.
4. **It is a walking skeleton for the plumbing slice 1a needs.** `GeneratorOptions` → config → `buildCoreDeps` → `createGenerator` is the identical path the externalized prompt travels. If that threading is awkward, slice 2 surfaces it in a day, on a change whose blast radius is one optional field — rather than mid-way through a change that alters what the live pilot says.

Then **1a**, which is the actual deliverable of a domain-neutral core. Then
**1b**, once containment has landed and the tier migration has its design pass.

---

## 9. Documentation deliverables

Documentation is a first-class requirement of this design, not a follow-up. Each
slice ships its docs with it.

| Document                         | Answers                                                                                                                                         | Audience                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `docs/ARCHITECTURE.md` (revised) | How the system works, and where the domain boundary is                                                                                          | Engineer arriving fresh     |
| `docs/PACK-AUTHORING.md`         | How to write a vertical pack, field by field, with a worked example                                                                             | You, starting engagement #2 |
| `docs/DEPLOYING.md`              | How a client stands it up, configures it, and verifies it                                                                                       | Client's IT                 |
| `docs/UPGRADING.md`              | How to pull a new image, run acceptance, interpret drift                                                                                        | Client's IT                 |
| `docs/SETTINGS.md`               | Every catalog setting: type, range, effect, protected or not — and for any setting that is not reversible, that fact stated at the entry (§3.8) | You and the client admin    |
| `packs/<vertical>/README.md`     | What this pack asserts and blocks                                                                                                               | Compliance reviewer         |

---

## 10. Open risks

- **The tier migration is the highest-risk change in this design.** `dataClass` gates ingestion, and the current enum collapses Class C and D into one value — so, per `cpa-consulting/docs/rag/findings/r5-compliance-gate.md`, _"any change that lets C through lets D through."_ This warrants its own spec before implementation, not just a task.
- **Generic admin UIs are a support surface.** Every exposed setting is something a client can set badly. Start with the smallest `adminEditable` list that works and widen on demand.
- **The drift check depends on a stable question set per client.** Without one it cannot run. For the firm that set does not exist yet and is blocked on the same gold-set session as retrieval tuning.
- **Exclusion at ingest is silent by construction, and silence is the failure mode.** A document excluded by §3.7 leaves an `ingest_log` row and nothing else — no chunks, no search hit, no answer citing it. To a user it is indistinguishable from a document that was never synced. This is correct behaviour and a poor experience: "the KB doesn't know about our onboarding SOP" is a support call whose answer lives only in a log table. An operator-visible view of what was excluded and why should ship with slice 1b — alongside the exclusion behaviour itself, not after the first confused user.
- **Scanner false-negatives are unbounded and unmeasurable.** The design treats an identifying-scanner match as authoritative, but nothing establishes what the scanners _miss_. the firm's screen found a 522-SSN roster because SSNs are formatted; a client name in prose trips nothing. Exclusion is therefore a floor, not a guarantee, and the human review in the content-boundary plan remains load-bearing rather than a formality this replaces.
