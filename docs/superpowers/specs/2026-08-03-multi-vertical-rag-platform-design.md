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

This distinction is load-bearing and was learned expensively. Screening TWK's
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

---

## 4. Pack vs. database: the configuration split

**The test: does changing this require review?**

| Item                                                    | Where    | Rationale                                                |
| ------------------------------------------------------- | -------- | -------------------------------------------------------- |
| Tier definitions and `indexable`                        | Pack     | Widening changes what is legally allowed in the index    |
| Scanner patterns and `kind`                             | Pack     | Weakening a scanner is a compliance change               |
| System prompt                                           | Pack     | It is the grounding contract                             |
| Disclaimer                                              | Pack     | Often a regulatory requirement                           |
| Classification rule _shapes_ — what a rule may match on | Pack     | Defines what classification can express at all           |
| Sources to index                                        | DB       | Deployment fact                                          |
| Classification _patterns_ — this client's folder names  | DB       | Client-specific instances of a pack-defined shape (§3.3) |
| Folder exclusions                                       | DB       | Client-specific; changes during engagement               |
| Staff roster                                            | DB       | Changes with hiring                                      |
| Retrieval knobs (`topK`, weights, rerank on/off)        | DB       | Tuning, no policy content                                |
| Vocabulary additions                                    | DB       | Additive, harmless                                       |
| Branding (`APP_NAME`)                                   | DB / env | Cosmetic                                                 |

### 4.1 The safety property

**Database configuration can narrow, never widen.** You may add a folder
exclusion; you may not remove the tier gate. You may lower `topK`; you may not
mark a blocked tier indexable.

This is not a new invention. `effectiveSourceFilter`
(`packages/core/src/access-control.ts:262`) already lets a caller's filter narrow
_within_ their enforced scope but never beyond it. The same rule, applied to
configuration.

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
- the pack's prompt, run against the fixture corpus with a deterministic fake generator, produces a cited answer **and** abstains on an out-of-corpus question

The last assertion is what stops a rewritten prompt from quietly losing the
grounding contract.

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
concrete: TWK's own titles include entries like `Miller, Patrick & Breanna (2026 Package)`.

**Design:** a differential test needing **no ground truth**. Run the same N
questions before and after an upgrade against the same corpus, and report only
_"top-3 retrieved documents changed for 12 of 40 questions."_ Counts and hashed
document ids — never titles, never text.

Zero drift means the upgrade was inert for them. High drift means look before
rolling forward. Runs only at the client, only on demand, read-only via
`createReadOnlyDb` + `assertReadOnly` (`packages/db/src/client.ts:103,153`).

---

## 7. Out of scope

- **Publishing `@rag/*` to npm.** There is no external developer consuming libraries; the delivery unit is an image set plus a pack plus an env file. Publishing would also place TWK corpus findings currently embedded in `tri-scanner.ts` and `config.ts` comments on a public registry for no benefit.
- **A multi-tenant control plane or hosted service.** Contradicts the per-client isolation model.
- **Query rewriting, HyDE, multi-query, parent-document retrieval.** Measured as neutral-to-negative for these corpora.
- **Dynamic plugin loading.** Static, in-image extensions only.

---

## 8. Implementation slices

This design is larger than one plan. It decomposes into four, in dependency
order. Each gets its own implementation plan.

1. **Domain extraction from core.** Neutral default prompt; tiers open (schema migration); scanners and disclaimer moved behind pack-supplied policy; the CPA pack created as the first pack. _Largest and riskiest — it touches the ingestion gate and the compliance machinery._ **The tier migration inside this slice needs its own design pass before implementation** (see §10) — the rest of the slice does not.
2. **Local generation.** `baseURL` on `GeneratorOptions` plus config and docs. _Hours, independent of everything else, unblocks two verticals._
3. **Settings catalog + DB-resident config + admin surface.** Catalog with types and `protected` flags; per-request read with short-TTL cache; generic admin UI; audited writes.
4. **Verification framework.** Pack validation, conformance suite, acceptance run, drift check.

**Sequencing note:** slice 2 is independent and can ship first. Slice 1 should
not begin until the TWK content-boundary work
([`../plans/2026-08-03-kb-content-boundary.md`](../plans/2026-08-03-kb-content-boundary.md)
Phase 1) has removed confirmed Class D data from the live index — refactoring the
sensitivity machinery while a client roster is retrievable is the wrong order.

---

## 9. Documentation deliverables

Documentation is a first-class requirement of this design, not a follow-up. Each
slice ships its docs with it.

| Document                         | Answers                                                             | Audience                    |
| -------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| `docs/ARCHITECTURE.md` (revised) | How the system works, and where the domain boundary is              | Engineer arriving fresh     |
| `docs/PACK-AUTHORING.md`         | How to write a vertical pack, field by field, with a worked example | You, starting engagement #2 |
| `docs/DEPLOYING.md`              | How a client stands it up, configures it, and verifies it           | Client's IT                 |
| `docs/UPGRADING.md`              | How to pull a new image, run acceptance, interpret drift            | Client's IT                 |
| `docs/SETTINGS.md`               | Every catalog setting: type, range, effect, protected or not        | You and the client admin    |
| `packs/<vertical>/README.md`     | What this pack asserts and blocks                                   | Compliance reviewer         |

---

## 10. Open risks

- **The tier migration is the highest-risk change in this design.** `dataClass` gates ingestion, and the current enum collapses Class C and D into one value — so, per `cpa-consulting/docs/rag/findings/r5-compliance-gate.md`, _"any change that lets C through lets D through."_ This warrants its own spec before implementation, not just a task.
- **Generic admin UIs are a support surface.** Every exposed setting is something a client can set badly. Start with the smallest `adminEditable` list that works and widen on demand.
- **The drift check depends on a stable question set per client.** Without one it cannot run. For TWK that set does not exist yet and is blocked on the same gold-set session as retrieval tuning.
