# KB Content Boundary — keeping the corpus to "how TWK does things"

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the indexed corpus contain **only firm-procedure content** — how to
perform TWK tasks — and keep client-identifying material out of it, out of
citations, and out of anything sent to a third-party model.

> ## ⛔ Read this first: it is not hypothetical any more
>
> The client-identifier screen ran against the **full 858-document production
> corpus** on 2026-08-01 (`corpus-analysis/`). It found:
>
> - **`Client List & Priorities for Sending Out` — 522 SSN-shaped and 518
>   EIN-shaped values in a single indexed document.** That is a client roster.
>   It is Class D material sitting in a source declared `data_class = general`,
>   retrievable by every pilot user.
> - **150 documents under 12 client-named folders** (all of the form
>   `Surname, Firstname & Spouse`), and **189 under `Client Service Package Files/`**
>   — per-client billing and production analyses, not procedures.
> - **~30 document titles carry a personal name** in `Surname, Firstname` form
>   (9 of those in `(YYYY Package)` form), plus a firm-wide customer phone list.
>   Reproduce with a regex over `corpus-analysis/inventory.jsonl` — and note the
>   count is a **ceiling, not a client count**: the firm's own legal name matches
>   the same pattern, which is precisely why Task 3.3 rejects a name scrubber.
> - 17 documents carry SSN/EIN/bank-account hits; 355 of 858 carry some hit.
>
> ⚠ **Client names are deliberately not reproduced in this file.** It lives under
> `docs/`, which is tracked and pushes to the git remote; `corpus-analysis/` is
> gitignored and is where the actual identifiers belong. Work from
> `corpus-analysis/inventory.jsonl` when you need specific `externalId`s — do not
> copy them here.
>
> **`docs/TWK-LAUNCH-STATUS.md` stated the opposite until 2026-08-03** — _"no
> client files… §7216 attaches to taxpayer data; this corpus has none, which is
> why a scoped pilot is defensible without counsel sign-off."_ ✅ **That file has
> since been corrected** (see its "⛔ Read first" block and P0 gate #1); the quote
> is retained here because it is what this plan was written against. That sentence is
> now falsified by the firm's own screen. The doc correctly hedged that `general`
> was "the ingestion default, not a verified judgment"; the judgment has now been
> made and it came back the other way.
>
> ### And the consequence is larger than a dirty corpus
>
> The firm's whole compliance posture rests on one structural claim. POL-01
> §3, lines 84–91 (`cpa-consulting/docs/issue-synthesis/policies/data-classification-and-ai-use-policy.md`):
>
> > _"Because client files live in Onvio and the Z Drive while firm-internal SOPs
> > live in SharePoint, the safe lane for an internal AI assistant can be enforced
> > as a **connection scope** — 'it is connected to SharePoint and nothing else' —
> > rather than as a promise to classify each document correctly. A connection
> > scope is auditable, hard to violate by accident, and far easier to defend.
> > **Preserve that separation. Putting client files into SharePoint would destroy
> > the firm's cleanest compliance advantage.**"_
>
> **Client files are already in SharePoint.** 189 documents under `Client Service
Package Files/`, 150 under client-named folders, and a 522-SSN roster. The
> separation POL-01 tells the firm to preserve has already been breached — inside
> the very library the assistant indexes — and nobody knew, because the check had
> never been run.
>
> So this plan is not KB hygiene. **It is the remediation of the assumption the
> pilot's defensibility was built on.** That is why Phase 1 corrects the record
> before any code is written, and why Task 5.2 is a partner conversation rather
> than an engineering decision.
>
> ⚠ **POL-01 is `DRAFT v0.1 — NOT YET ADOPTED and NOT LEGAL ADVICE`** (line 8),
> with all three signature rows empty and §9 stating _"This policy is not in force
> until Chris adopts it in writing."_ That status must travel with every quote
> from it. It is nonetheless the firm's stated working practice (POL-01:22-23),
> and it is the only classification standard on record.

**Architecture:** Filtering happens at **four** points, and they are not
interchangeable. In descending order of reliability: **(1) source scope** — never
sync it; **(2) ingest gate** — refuse the document; **(3) citation/metadata
boundary** — never display it; **(4) prompt instruction** — ask the model not to
repeat it. Today only (4) exists for client names, and it is the weakest of the
four _and_ does not cover the path where names actually escape.

**Tech Stack:** TypeScript, Drizzle/Postgres, Microsoft Graph (SharePoint delta),
Python/FastAPI parser, vitest.

---

## Global Constraints

- **Never hard-delete to implement exclusion.** `PLAN-CPA-COMPLIANCE.md:208-209`: _"Do not hard-delete anything (documents, sources, audit rows) to implement 'archive' — status-flip only."_ §7216 requires grant/È history be reconstructible; the same reasoning applies here.
- **`content_type` is NOT a compliance control.** `schema.ts:60-64` and `PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md:200-202`: _"gating logic must never read one where it means the other."_ Use `data_class`/`DocumentClass` for sensitivity; `content_type` is a librarian taxonomy only.
- **No product-specific rules in `rag-system`.** The classification-engine design (`specs/2026-07-11-generic-document-classification-engine-design.md:13`) is explicit: _"`rag-system`'s own repository must contain zero product-specific classification rules, keyword lists, or business logic… violating it defeats the purpose."_ TWK folder names and client names belong in injected config, never in a committed source file.
- All DB access via `@rag/db`; production walks use `createReadOnlyDb` + `assertReadOnly`.
- Bound new client-supplied inputs with zod caps.
- Commit format `<type>: <description>`. Pre-commit runs prettier + secret scan + 800-line cap — never `--no-verify`.
- ⚠ `pnpm typecheck` is RED on `main` (5 pre-existing `eval-faithfulness.spec.ts` errors). Not your regression.

---

# Phase 0 — Discovery (COMPLETE)

## 0a. Root cause: classification is per-SOURCE and human-declared, never per-document

This is why a 522-SSN roster was indexed without anything objecting.

| #   | Finding                                                                                                                                                                                    | Evidence                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `docClass` is stamped from the **source**, not the document: `const docClass = deps.sourceDocClass ?? "A"`. Every document in a `general` source is Class A **regardless of its content**. | `packages/ingestion/src/pipeline.ts:148`; `classify-source.ts:24-42` (`general`→A).                                                 |
| 2   | All 3 TWK sources are `data_class = general`. So all 858 documents are stamped Class A.                                                                                                    | `docs/TWK-LAUNCH-STATUS.md:142-143`.                                                                                                |
| 3   | The ingest-time TRI scan **deliberately never blocks** — it logs `action:"tri-flagged"` and continues.                                                                                     | `pipeline.ts:306-323`: _"Ingestion is NOT blocked — these are client tax documents and storing them is the purpose of the system."_ |
| 4   | So there is **no per-document sensitivity gate anywhere in ingest.** The only gate (`ClassBlockedError`) fires on a source-level declaration nobody set.                                   | `pipeline.ts:245`.                                                                                                                  |

## 0b. The citation leak — the sharpest technical finding

The system prompt says _"Do not repeat client names that appear in retrieved
text. Say 'the client' instead"_ (`generator.ts` SYSTEM_PROMPT rule 4). **That
governs the model's prose only.** Citations bypass the model entirely:

- `buildCitations()` maps `title: r.document.title` straight through, unfiltered.
- `EXPOSABLE_METADATA_FIELDS` (`metadata-policy.ts:44-55`) explicitly **allows `title` and `path`** across the API/MCP boundary.
- Therefore a document titled `Surname, Firstname & Spouse (YYYY Package)` renders as a citation pill in the web UI, a line on the Teams Adaptive Card, and a `Sources:` entry in the MCP tool response — **no matter what the model does.**

**35 titles and 150 paths carry client names today.** The one control that exists
for client names cannot reach the surface where they actually escape.

## 0c. What already exists (reuse, don't rebuild)

| Asset                                                          | Where                                        | State                                                                            |
| -------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| Deterministic client-identifier screen (5 patterns)            | `scripts/extract-corpus.ts:84-112`           | ✅ Built, **run against all 858 docs**                                           |
| Fail-closed human sign-off gate w/ corpus fingerprint          | `packages/rag/src/extraction/screen-gate.ts` | ✅ Built + tested; **no sign-off file exists yet**                               |
| Shape-preserving redaction (`123-45-6789`→`1XX-XX-XXX9`)       | `extract-corpus.ts:121-125`                  | ✅ Built                                                                         |
| Identifying-vs-contextual TRI split                            | `packages/core/src/tri-scanner.ts:95-131`    | ✅ Built 2026-08-02; `SSN`/`EIN` block regardless of policy                      |
| Generic rule-based classification engine                       | `specs/2026-07-11-…-design.md`               | ❌ **Design only, zero implementation** (grep for `DocumentClassifier` → 0 hits) |
| `content_type` / `lifecycle_status` / `owner_id` columns       | `schema.ts:156-164`, migration `0008`        | ⚠ Schema landed, **nothing reads or writes them**                                |
| Retrieval-time filter (`WHERE lifecycle_status != 'archived'`) | `PLAN-KB-GOVERNANCE…:507-510`                | ❌ Designed, unbuilt — this is the mechanism a sensitivity filter needs          |
| Retrieval-time redaction / quarantine                          | —                                            | ❌ **No prior art. Open ground.**                                                |

## 0d. The decisive sizing result

Structural folder exclusion does most of the work, and it collapses the human
review from "indefinite blocker" to "one afternoon":

```
flagged by the screen                                    355 / 858
  of which ONLY tax-form-with-data (bulk-clearable SOPs)     279
  of which carry SSN / EIN / bank-account                     17

already inside a structurally-excludable folder             258   (73%)
  → residual requiring genuine human review                  97
```

Excludable folders, by document count: `TWK_KB_SANDBOX` **320**, `Draft Working
Procedures` **226**, `Client Service Package Files` **189**, `**/Archive/` **51**.

**This is the plan's central argument: an inclusion rule over folder structure
beats a denylist over content patterns.** The firm's own folder hierarchy already
encodes "approved procedure" vs "someone's draft" vs "a client's billing file" —
it is a curation signal that is high-precision, needs no NLP, and cannot
mis-classify a staff name as a client name.

## 0e. The inclusion criterion already exists, in the firm's own words

You asked for a corpus containing "only data regarding how to perform TWK
tasks." **POL-01 §2 line 63 states that as a one-sentence test**, and it is a
better criterion than anything an engineer would invent:

> **Class A — Firm internal, how-we-work.** _"SOPs, procedure docs, checklists,
> engagement-letter **templates**, training material, time-coding guides, Karbon
> template definitions."_
> **Plain-language test: _"Would this be equally true if we had no clients at
> all?"_**

Two more lines from the same section make it operable:

- **The tie-breaker (POL-01:68-69):** _"**When you cannot tell, it is the higher
  class.** A memo that mentions one client by name is not Class B. A spreadsheet
  with a single K-1 figure in it is Class D."_
- **The desk-level instinct (POL-01:148-149):** _"if a client's name, numbers, or
  documents are in what you are about to paste, stop."_

Apply the Class A test to §0d's numbers and the answer is immediate:
`Client Service Package Files/<client name>/Billing & Production Analysis/`
would **not** be equally true if the firm had no clients. Neither would
`Client List & Priorities for Sending Out`. Both fail on the first question,
without any pattern matching at all.

**Use this test — quoted verbatim — as the review instrument in Task 5.2.** It is
the firm's language, it is already partner-facing, and it converts an open-ended
"is this sensitive?" judgment into one question a reviewer can answer in seconds.

⚠ Class B (`firm research, de-identified`) carries an extra obligation nobody has
built: POL-01:109-115 requires that _"a human confirms de-identification before
the document is indexed"_ and that Class B be _"**summarized**, not quoted
verbatim, in output."_ The current system does neither. Since the SYSTEM_PROMPT
deliberately instructs **near-verbatim** reproduction of procedures, a Class B
document in the corpus is in direct conflict with policy. **Simplest resolution
for the pilot: index Class A only.** Flag it; do not resolve it unilaterally.

## 0f. PII tooling — the crux question, answered honestly

**Can NER distinguish a CLIENT name from a STAFF name? No — and no tool claims
to.** This is a structural limitation, not a tuning problem: span-level NER
classifies a token as `PERSON` or not; **none of Presidio, spaCy, or GLiNER
encodes entity _role_.** Doing so requires relation extraction or entity linking
against a reference set. No benchmark for "client name vs. employee name" was
found to exist.

Supporting evidence, all relevant to design choices below:

- **Presidio** is alive and MIT-licensed but moved to community governance under
  Data Privacy Stack in **June 2026** (2.2.363) — pin a version, don't track
  `main`. It runs fully offline (satisfying "the corpus must not leave the
  machine") **only if** you keep the default local NER backend.
- **Presidio's `PERSON` precision is domain-dependent and weak on business
  documents** — F1 0.78 on real annotated news data, but 0.18–0.37 on synthetic
  business-style data in the one practitioner benchmark found (author's own
  caveat: "a practical comparison to pick a direction, not a rigorous
  evaluation"). There is no `US_EIN` recognizer out of the box; it is a trivial
  custom `PatternRecognizer`.
- **Redaction measurably damages the task this system performs.** Amazon Science
  (arXiv 2411.05978) found sanitization costs ~1–5% on sentiment/entailment but
  **>25% on comprehension Q&A** — which is exactly what a KB assistant does.
- **AWS's own RAG reference architecture does not trust single-pass redaction** —
  it pairs redaction with a second independent detector plus a human-review
  quarantine, and disclaims completeness.
- **NIST SP 800-188:** de-identification reduces residual risk, never eliminates
  it; residual risk must be evaluated explicitly, not assumed away.
- **LLM-as-classifier** for "procedure vs. client deliverable" is viable only as a
  recall-optimized triage gate — the closest comparable study (arXiv 2605.10211,
  local LLM, deliberative-privilege classification) got **recall 0.80 / precision
  0.54**, and adding a "critic" agent made results **worse**.

**What this means for the plan:** exclusion beats redaction here, and the
evidence is specific rather than aesthetic. The documents being removed are
client files that should never have been in a procedures corpus — they do not
need to be retained in redacted form, so the >25% comprehension cost buys
nothing. Redaction stays a fallback for a document that is overwhelmingly
procedure with a stray reference, and even then needs a second pass.

**The one genuinely promising technique** is **roster cross-matching**: use NER
purely for recall (find every `PERSON` span), then match against the firm's
**closed, enumerable staff list** — Chris Klein, Doug Theriot, Amy Hartley,
Chandi Gremillion, Preston Blanchard, Thao, Sarah, Samantha, Morgan, Joycelyn,
Callie, Didi, Autumn, Carol, Amanda, JD, Avalynn, Hailey. Any `PERSON` **not** on
the roster is a client candidate. This converts an unsolved role-disambiguation
problem into list matching, which is the one thing pattern matching does
reliably. Note this is a synthesis from the research, not a sourced vendor
pattern — and the staff roster is firm data, so under the Global Constraints it
belongs in injected config, never in a committed file.

---

# Phase 1 — Contain, and correct the record (do today)

Nothing else in this plan matters if a 522-SSN roster stays retrievable while it
is being executed.

- [ ] **Task 1.1 — Remove the roster from the index.** Identify `Client List & Priorities for Sending Out` by `externalId` from `corpus-analysis/inventory.jsonl`, then delete the document + its chunks via `deleteDocumentByExternalId` (`queries.ts:390`, FK-cascades to chunks). This is removal from an **index**, not destruction of a firm record — the file stays in SharePoint. Note it explicitly in the commit message so it is not mistaken for the banned "hard-delete as archive."
- [ ] **Task 1.2 — Triage the other 16 identifying hits** from `corpus-analysis/`. `PERSONAL STATEMENT IN SUPPORT OF CLAIM` (×6 duplicates), `EIN Ltr`, `Pay.gov - Confirmation` read as client documents; `Auction Letter - Sample`, `Sponsor Letter - Sample`, `Sample SBA EIDL … - Redacted` read as templates and are probably fine. **Do not decide this alone — it is a firm judgment.** Produce the list; Chris or Doug rules.
- [ ] **Task 1.3 — Correct `docs/TWK-LAUNCH-STATUS.md:142-147`.** Replace "this corpus has none" with what the screen actually found, and mark P0 gate #1 as **in progress with a finding**, not merely open. This project has a documented history of stale "resolved" claims creating false confidence; this is the highest-stakes instance of it.
- [ ] **Task 1.4 — Re-verify after removal.** Re-run `scripts/extract-corpus.ts` (screen only, no `--extract`) and confirm the identifying-pattern counts drop to the expected residual. The corpus fingerprint will change — that is correct, and it invalidates any sign-off, by design (`screen-gate.ts:23-28`).

**Verify:** `ssn`/`ein`/`bank-account` document counts in the regenerated
`client-identifier-screen.md` match the post-triage expectation, and the roster's
`externalId` no longer appears in `inventory.jsonl`.

---

# Phase 2 — Structural exclusion (the highest-leverage change)

**What to implement:** path-based include/exclude for the SharePoint connector,
so whole subtrees never enter the corpus.

**Current capability, verified:** `SharePointConfigSchema`
(`connectors/src/sharepoint/config.ts:8-30`) supports exactly one optional
`folderPath` **include**, and its own comment says _"Only honored for initial
(cursor-less) sync. Delta sync inherits the prior scope."_ There is **no exclude
list and no glob support**. `**/Client Service Package Files/**` is not
expressible today.

- [ ] **Task 2.1 — Failing tests first.** Extend `connectors/src/sharepoint/index.test.ts` (198 lines — read it for the `GraphReader` fake pattern). Assert: a `DriveItem` whose `parentReference.path` matches an exclude pattern is **not** returned by `list()`, and is not counted as a document; and that an excluded item still surfaces its **tombstone** if deleted (deletions are collected independently of the document budget at `sharepoint/index.ts:159-162` — don't break that).
- [ ] **Task 2.2 — Add `excludePaths: string[]` to `SharePointConfigSchema`**, matched against the same `path` the connector already builds at `sharepoint/index.ts:315-321`. Use simple case-insensitive substring/prefix matching, **not** a regex from config — a regex in a JSONB config column is an injection and ReDoS surface for no benefit here.
- [ ] **Task 2.3 — Apply the filter in `fetchPage`** alongside the existing folder/oversize skips (`index.ts:163-185`), and **count skips** the way `skippedOversize` already is, so exclusion is observable in the run summary rather than silent.
- [ ] **Task 2.4 — Configure TWK's sources.** Exclude `Client Service Package Files`, `TWK_KB_SANDBOX`, `Draft Working Procedures`, `Archive`. **These strings go in the source's `config` JSONB — never in a committed `.ts` file** (Global Constraints; the classification design's zero-product-rules requirement).
- [ ] **Task 2.5 — Full resync** so exclusions take effect. Delta sync will not retroactively remove already-indexed documents; reconcile explicitly (Task 6.2).

**Anti-pattern guards:** do not put client names in an exclude list — exclude
_containers_, not identities; the list must stay stable as clients change. Do not
implement this as a post-retrieval filter — the point is that the bytes never
enter the corpus, are never embedded, and never reach a third-party model.

**Open question for Chris/Doug, not for engineering:** `TWK_KB_SANDBOX` (320) and
`Draft Working Procedures` (226) are 64% of the corpus. Excluding both is
defensible for a "how do we do things" assistant — a draft in a staff member's
folder is not firm procedure — but it is a **content decision with a large
retrieval-coverage cost**, and it must be theirs. Present the numbers; do not
decide.

---

# Phase 3 — Close the citation leak

Titles and paths reach every surface regardless of the prompt (§0b). Even a
perfectly filtered corpus should not re-open this the first time a client-named
file is added.

- [ ] **Task 3.1 — Decide the `path` exposure.** `path` is on `EXPOSABLE_METADATA_FIELDS` for display/filtering, but the TWK corpus proves paths carry client identity. Options: drop `path` from the allowlist; or expose only the leading N segments. **Preferred: drop it.** Nothing in the web or Teams UI renders `path` today — grep before deciding, and if nothing consumes it, this costs nothing.
- [ ] **Task 3.2 — Failing test in `metadata-policy.test.ts`** (155 lines, existing allowlist tests) pinning the new shape.
- [ ] **Task 3.3 — Title is harder and must not be silently mangled.** A citation with no title is useless. Do **not** regex-scrub names out of titles — `Terranova Williams Klein CPA's, LLC_Customer Phone List` shows the firm's own name matches any person-name pattern. The correct control is Phase 2 (the document should not be in the corpus) plus Phase 4 (it should not have been ingested). **Record this as a deliberate non-fix**, with the reasoning, so nobody "improves" it later with a name scrubber.

---

# Phase 4 — Ingest-time gate for identifying patterns

Phase 2 handles containers; this handles the file that lands in the _right_
folder carrying the _wrong_ content.

- [ ] **Task 4.1 — Failing tests** in `packages/ingestion/src/pipeline.test.ts` (618 lines — read first): a document whose parsed markdown trips an **identifying** pattern (`SSN`/`EIN`) is **not** chunked or embedded, is recorded in `ingest_log`, and does **not** fail the whole run (`Promise.allSettled` at `pipeline.ts:150-164` already isolates per-document failures).
- [ ] **Task 4.2 — Reuse `identifyingTRIPatterns`** (`tri-scanner.ts:128`) — do not write a second scanner. Its doc comment already carries the corpus evidence for why `SSN`/`EIN` are treated differently from the contextual patterns.
- [ ] **Task 4.3 — Quarantine, don't drop silently.** Add an `ingest_log` action (the column is free text — `schema.ts:465`) so a refused document is auditable and re-reviewable. **Do not** invent a new table; `ingest_log` exists for exactly this.
- [ ] **Task 4.4 — Keep contextual patterns non-blocking.** `tax-form-with-data` hits **316 of 858** documents and the inspected hits were SOPs. Blocking on it would delete the tax-procedure content the assistant exists to serve. Add a test that pins this — a doc tripping only contextual patterns must still ingest.
- [ ] **Task 4.5 — Do NOT add an ML/NER PII detector in this phase.** The research (§0f) settles it: **NER cannot distinguish a client name from a staff name** — no surveyed tool encodes entity role, and no benchmark for the task exists. Presidio's `PERSON` precision on business-style documents (0.18–0.37 in the one benchmark found) is well below what an unattended gate needs. `PLAN-CPA-COMPLIANCE.md:451-453` already defers this as growth-triggered: _"expand beyond regex/proximity matching… **if false negatives become a real observed problem**."_ Structural exclusion (Phase 2) plus the identifying-pattern gate (4.2) plus human review (Phase 5) covers the observed corpus without it.
- [ ] **Task 4.6 (optional, only if 4.1-4.4 prove insufficient) — Roster cross-matching, not better NER.** If a later screen shows client names slipping through in documents that pass every structural filter, the tractable design is: NER for **recall only** (find all `PERSON` spans), then match against the firm's closed staff roster; anything unmatched is a client candidate routed to review. Run fully on-prem (Presidio with the local backend — **pin the version**, it moved to community governance in June 2026). Treat any model verdict as triage, never as a decision: the closest comparable study got 0.54 precision, and adding a critic agent made it worse. The staff roster is firm data → injected config, never committed.

---

# Phase 5 — Human review of the residual, and the sign-off

- [ ] **Task 5.1 — Generate a review packet** for the **97 flagged documents not covered by structural exclusion** (§0d). Group by pattern; put the 279 `tax-form-with-data`-only documents in a separate bulk-clear list with a one-line explanation of why they are expected false positives.
- [ ] **Task 5.2 — Run the session with Chris/Doug**, using POL-01's own Class A test as the instrument (§0e): _"Would this be equally true if we had no clients at all?"_ plus the tie-breaker _"when you cannot tell, it is the higher class."_ This is P0 gate #1 and needs firm judgment, not an attorney (`TWK-LAUNCH-STATUS.md:146-147`). Two decisions belong to them, not to engineering: **(a)** whether to exclude `TWK_KB_SANDBOX` and `Draft Working Procedures` (64% of the corpus — Phase 2's open question); **(b)** whether the pilot indexes **Class A only**, which is the simplest resolution to the unbuilt Class B de-identification obligation (§0e).
- [ ] **Task 5.3 — Record the sign-off** at `corpus-analysis/screen-signoff.json` in the exact shape `evaluateExtractionGate` requires (`screen-gate.ts:42-52`): `approvedBy`, `approvedOn`, `corpusFingerprint`, `clearedExternalIds`, `excludedExternalIds`. **Every flagged id must appear in one list or the other** — the gate rejects partial sign-off (`:134-146`), and _"silence is not a clearance."_
- [ ] **Task 5.4** — Feed `excludedExternalIds` back into Phase 2's exclusion config and Phase 4's quarantine list.

---

# Phase 6 — Keep it that way

One-time cleanup that decays is worse than none, because it converts "we know
this is dirty" into "we believe this is clean."

- [ ] **Task 6.1 — Re-screen after every sync.** Wire the screen as a worker job (copy the `docs-gap-digest` scheduled-job pattern, `worker/src/handlers/docs-gap-digest.ts` + `queue.ts:127-144`) so new identifying hits surface within a day. Alert on identifying patterns only — a weekly mail saying "316 documents mention Form 1040" trains everyone to ignore it.
- [ ] **Task 6.2 — Reconcile deletions on exclusion changes.** Delta sync never retroactively removes already-indexed documents when an exclude rule is added. Provide an explicit reconcile path (full resync, or a targeted purge from the screen output) and document which one is expected.
- [ ] **Task 6.3 — Make the sign-off expire.** The fingerprint already invalidates on any content change (`screen-gate.ts:23-28`). Surface that state — an admin view or a startup log line reading "screen sign-off is stale: N documents changed since approval."

---

# Final Phase — Verification

- [ ] `pnpm -r build` · `pnpm lint` 0 errors · full unit suite green.
- [ ] `pnpm typecheck` shows **only** the 5 pre-existing `eval-faithfulness.spec.ts` errors.
- [ ] Re-run the screen: **zero** documents match `ssn`, `ein`, or `bank-account`.
- [ ] `grep -c "Client Service Package Files" corpus-analysis/inventory.jsonl` → 0 after resync.
- [ ] `node -e` over `inventory.jsonl`: no document **title** matches `/[A-Z][a-z]+,\s*[A-Z][a-z]+/` except known firm entities.
- [ ] `corpus-analysis/screen-signoff.json` exists, and `evaluateExtractionGate(state, signoff)` returns `allowed: true` against the **current** fingerprint.
- [ ] **Manual, and the real test:** ask the assistant a question that used to retrieve a client billing file (e.g. "what's our package pricing?") and confirm no client name appears in the answer **or in any citation title**.
- [ ] `docs/TWK-LAUNCH-STATUS.md` no longer claims the corpus contains no client data, and P0 gate #1 reflects the finding and its resolution.
- [ ] Update `docs/PROTOTYPE-READINESS-REVIEW-2026-08-01.md`'s closing "note on the corpus" — it flagged one client identifier in an SOP; the screen found substantially more.
