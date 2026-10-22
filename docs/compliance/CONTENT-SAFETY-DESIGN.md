---
title: Content safety design
status: current
last_verified: 2026-10-21
verified_against: db0ceae
answers: How the ingestion pipeline keeps client-identifying material out of the index and away from third-party models, which layers are built, why they are built that way, and what is still open.
read_when: Changing anything in packages/core/src/content-safety.ts, the ingest gates, the scanner pack, metadata exposure or the TRI pre-flight; or judging whether a corpus is safe to index.
supersedes:
  [
    superpowers/plans/2026-08-03-pii-redaction-before-index.md,
    superpowers/plans/2026-08-03-kb-content-boundary.md (rationale),
  ]
code:
  [
    packages/core/src/content-safety.ts,
    packages/core/src/pack/scan.ts,
    packs/cpa/pack.yaml,
    packages/ingestion/src/pipeline.ts,
    packages/ingestion/src/ingest-gates.ts,
    packages/ingestion/src/classify-document.ts,
    packages/ingestion/src/classify-source.ts,
    packages/core/src/metadata-policy.ts,
    packages/core/src/tri-scanner.ts,
    packages/rag/src/generation/generator.ts,
    packages/connectors/src/sharepoint/config.ts,
  ]
---

# Content safety design

This is the permanent design for keeping client data out of the index: what runs at ingest and at generation, in
what order, and why. `packages/core/src/content-safety.ts` and `env.example` cite it. **The constraint everything
follows from: redaction must happen before the embedding call, not merely before storage.** Production embeds with
a third-party API (`gemini-embedding-001`). A pipeline that redacts on the way into Postgres but embeds the raw text
has protected the database and disclosed the document. That is how client data reached the vendor in July 2026
([EXCEPTIONS-LOG.md](EXCEPTIONS-LOG.md#2026-07-04-the-phase-a-gate-was-not-followed)).

All the layers below are built. Their production status, such as whether the optional Layer 1.5 is on, is in
[CONTROL-STATUS.md](CONTROL-STATUS.md). Classes A–D and the people named here are defined in
[GLOSSARY.md](../GLOSSARY.md).

## The order of operations

`ingestOne` in `packages/ingestion/src/pipeline.ts` runs the gates in this order for each document:

```text
source data_class gate ─▶ Layer 2 path exclusion ─▶ parse ─▶ Layer 1 redact ─▶ Layer 1.5 semantic scan
   ─▶ Layer 3 classify (quarantine C/D) ─▶ hash + upsert ─▶ TRI flag (log only) ─▶ chunk ─▶ embed (egress) ─▶ store
```

Every gate that can refuse a document runs before the first byte reaches the embedder. The SharePoint connector's
own `excludePaths` runs earlier still, before the file is downloaded.

**The redactor makes no network calls.** Layers 1, 2 and 3 are deterministic and run on-process. A redactor that
needed a network call would itself be an egress path. Layer 1.5 is the one deliberate exception: it calls a
`ContentScanner`, which must be self-hosted on-process or on the firm's own network, never a third-party API. Asking
an external LLM "is this sensitive?" would be the very disclosure the layer exists to prevent.

## The layers as built

| Layer                         | What it does                                                                                                                                                                                                                                                                                      | Where                                                                                                           | On failure                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Source class gate             | Maps `sources.data_class` to a document class. An undeclared source is treated as D. C and D throw.                                                                                                                                                                                               | `classify-source.ts` `mapDataClassToDocumentClass`; `pipeline.ts` `ingestOne` (`ClassBlockedError`)             | Logged `blocked` in `ingest_log`; throws                                   |
| Layer 2: path exclusion       | Skips any document whose path contains a denylisted fragment, before parsing.                                                                                                                                                                                                                     | `content-safety.ts` `isExcludedPath`, `DEFAULT_EXCLUDED_PATH_FRAGMENTS`                                         | Skipped; logged `ingest.excluded_path`                                     |
| Layer 2: SharePoint exclusion | Per-source `excludePaths`, applied on top of the built-in list, before download.                                                                                                                                                                                                                  | `connectors/src/sharepoint/config.ts` `excludePaths`                                                            | Not fetched. A newly excluded, already-indexed item is reported as deleted |
| Layer 1: pattern redaction    | Masks structured identifiers in the body, tables and title, using the vertical's scanner pack.                                                                                                                                                                                                    | `content-safety.ts` `redactOrThrow`, `redactParsedDocument`; `packs/cpa/pack.yaml`                              | `ContentSafetyError`; document quarantined, never indexed raw              |
| Layer 1.5: semantic scan      | Detects client-identifying context a pattern can't see, such as a client named in prose. Detects; doesn't redact.                                                                                                                                                                                 | `content-safety.ts` `scanForClientContextOrThrow`; `ingest-gates.ts` `runSemanticScan`; `CONTENT_SCAN_PROVIDER` | A scanner that throws quarantines the document                             |
| Layer 3: classification       | Per-document class. The source's class is a ceiling, not a verdict: evidence can only make it stricter.                                                                                                                                                                                           | `classify-document.ts` `classifyDocument`                                                                       | C or D is quarantined, purged from the index and logged                    |
| Ingest TRI flag               | Scans the stored markdown for TRI and records a compliance event. Never blocks.                                                                                                                                                                                                                   | `pipeline.ts` `ingestOne` → `scanForTRI`                                                                        | Logged `tri-flagged` (`ingest.tri.flagged`)                                |
| Generation pre-flight         | Scans the question and each retrieved chunk (`screenGenerationContext`). A question that matches throws. A matching chunk is dropped: identifying matches always, contextual matches only under `block` (under `warn` they are kept and logged). The answer fails only if every chunk is dropped. | `generator.ts` `runPreFlight`; `screen-context.ts` `screenGenerationContext`                                    | `ComplianceError` (HTTP 422)                                               |
| Citation boundary             | Strips `path` and other PII fields from anything exposed; exposes the source URL for Class A only.                                                                                                                                                                                                | `metadata-policy.ts` `EXPOSABLE_METADATA_FIELDS`, `isSourceUrlExposable`                                        | Default-deny for unknown fields                                            |

Details that matter when changing these:

- **Layer 1 pack.** `packs/cpa/pack.yaml` declares `ssn` (delimiter-anchored, dash or space), `ssn-unformatted` (a
  bare 9-digit run only when an SSN/TIN/ITIN label is nearby), `ein`, `routing` (ABA checksum plus account
  vocabulary) and `card` (Luhn). All are `identifying`. `redactText` adds a density-gated tabular sweep for a roster
  column of bare 9-digit values, which no adjacent-label rule reaches. The pack holds the patterns; core holds the
  engine (`packages/core/src/pack/scan.ts`).
- **A missing or empty pack is a configuration gap, not a clean run.** `ingestOne` refuses to run without a pack, and
  `redactOrThrow` refuses a pack with no scanners. An empty pack would otherwise let every document through
  unredacted while every guard reported a healthy run.
- **Two kinds of quarantine.** `gate-failure` means the gate couldn't reach a verdict (scanner unreachable, redaction
  threw, pack missing). `policy` means the gate worked and refused the document. Only `gate-failure` rows carry the
  `GATE_FAILURE_REASON_PREFIX` on `ingest_log.rejection_reason`, and a caller must escalate them
  (`ingest-gates.ts` `QuarantineCause`).
- **Redaction is not absolution.** `isSafeAfterRedaction` returns false for any document that tripped an identifier.
  `CLASS_D_IDENTIFIERS` (`ssn`, `ein`, `routing`, `card`) escalate a document to D even after masking, because
  masking can't prove every value was found.
- **Layer 2 works only where the connector supplies a path.** Today only SharePoint sets `metadata.path`. For every
  other connector the check can't run, and `ingestOne` logs `ingest.path_unavailable` rather than staying silent.
- **A redacted document keeps no stored original**, so `/documents/:id/download` can't hand back the unredacted file
  (`pipeline.ts` `ingestOne`).
- **Layer 1.5 is off by default** (`CONTENT_SCAN_PROVIDER=none`). "Off" and "configured but broken" are kept apart:
  a provider that is set but can't be built fails at boot, a provider that throws mid-run quarantines the document,
  and `COMPLIANCE_MODE=client-data` refuses `none` ([README.md](README.md#everything-compliance_modeclient-data-requires-at-boot)).

## Filtering hierarchy

Client-identifying material can be stopped at four points. They aren't interchangeable. From most to least reliable:

1. **Source scope:** never sync it. Folder exclusion at the connector, plus the class of the source itself.
2. **Ingest gate:** refuse the document. Layers 1, 1.5 and 3.
3. **Citation and metadata boundary:** never display it. The metadata allowlist.
4. **Prompt instruction:** ask the model not to repeat it. The system prompt's "say 'the client' instead" rule.

Before August 2026 only level 4 existed for client names, and it was the weakest of the four. It also doesn't cover
the path where names actually escaped (next section). Design new controls as high in this list as they can go.

## Citations bypass the model

The system prompt governs the model's prose, not the citations. `buildCitations` passed each document's `title`
straight through, and `path` was on the exposable-metadata allowlist. So a document stored under a client-named folder,
or titled with a client's name, appeared in the web citation chip, the Teams card and the MCP `Sources:` footer
whatever the model wrote. In the August 2026 corpus, 35 titles and 150 paths carried client names.

What changed:

- **`path` is stripped** from `EXPOSABLE_METADATA_FIELDS`. It is kept internally for structural exclusion only.
- **The source URL is gated by class.** SharePoint's `webUrl` embeds the same folder path, so `isSourceUrlExposable`
  allows it for Class A only. An absent class counts as stricter than A. The URL has three carriers (`metadata.url`,
  `document.url`, `Citation.url`), and any change to URL exposure must cover all three
  (`metadata-policy.ts` header comment).
- **`title` is deliberately still exposed, and must not get a name scrubber.** A citation with no title is useless,
  and a person-name pattern can't tell a client from anyone else: the firm's own legal name matches the same
  `Surname, Firstname` shape. The right control is upstream: the document shouldn't be in the corpus (Layer 2) or
  should have been refused at ingest (Layers 1.5 and 3). Titles are pattern-redacted for structured identifiers
  (Layer 1, `f09bb3c`), but a client name in a title still passes. This reasoning isn't recorded in the code; this
  section is its home.

## Identifying versus contextual patterns

Every scanner carries a `kind`, and the two kinds are handled differently:

| Kind        | Examples                                   | At ingest                                      | At generation                                                                                                                                                                                          |
| ----------- | ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| identifying | SSN (formatted or not), EIN, routing, card | Redacted, and the document is quarantined as D | A match in the question always throws; a matching context chunk is dropped (`screenGenerationContext`), and the answer fails only if no chunk survives. Applies whatever `GENERATION_TRI_POLICY` says. |
| contextual  | A form number near a dollar amount         | Flag only (`tri-flagged`)                      | Follows `GENERATION_TRI_POLICY` (`block`, `warn`, `off`)                                                                                                                                               |

The split was learned expensively. The 2026-08-01 screen of the 858-document corpus matched the contextual
`tax-form+amount` pattern on 316 documents (36.8%), and every inspected hit was a legitimate SOP. The identifying
SSN/EIN patterns matched 24 documents, one of which held 522 SSN-shaped values: a real client roster. (The purge
record counts 17 documents with SSN, EIN or bank-account hits; the two counts come from different screen passes and
no record reconciles them.) A scanner with a single severity either blocks everything or catches nothing. `TRI_IDENTIFYING_LABELS` in
`packages/core/src/tri-scanner.ts` holds the generation-side set.

The generation-side `tri-scanner.ts` and the ingest-side `packs/cpa/pack.yaml` both define SSN and EIN patterns. They
must agree: when the pack's SSN rule accepted only dashes, a space-separated SSN passed redaction, was embedded and
sent to the vendor, and was blocked only at generation, after the disclosure. The open question of exempting a
false-positive identifying match is in
[specs/tri-identifying-pattern-exemptions.md](../specs/tri-identifying-pattern-exemptions.md).

## Exclusion beats redaction

**An inclusion rule over folder structure beats a denylist over content patterns.** The firm's folder tree already
encodes "approved procedure" versus "someone's draft" versus "a client's billing file". It is high-precision, needs no
NLP, and can't mistake a staff name for a client name. A document that is never fetched can't leak.

The sizing that settled it, from the 2026-08-01 screen:

| Measure                                         | Documents  |
| ----------------------------------------------- | ---------- |
| Flagged by any pattern                          | 355 of 858 |
| …only for a tax form with data (bulk-clearable) | 279        |
| …carrying SSN, EIN or bank-account hits         | 17         |
| Already inside a structurally excludable folder | 258 (73%)  |
| Residual needing human review                   | 97         |

Per-client billing and pricing files were found by **folder, not content**. Names are the most common identifier in
the corpus and no pattern detects them.

Where the documents being removed are client files, excluding them costs nothing worth keeping. Redaction stays a
fallback for a document that is mostly procedure with a stray reference.

### Redaction is an egress control, not a confidentiality control

Redacting an indexed chunk doesn't redact the source. The citation's URL opens the original in SharePoint, and staff
have access to it. So redaction does one narrow thing: **it stops text reaching a third-party model.** It does
nothing about internal access. A deployment that redacts and believes it has prevented internal disclosure has
prevented nothing. Internal exposure is governed by what is indexed at all (Layer 2, Layer 3, the Gate 1 content
audit) and by the citation boundary.

What redaction can't do:

- **It doesn't replace the content audit.** It is a net, not a guarantee. Gate 1 still needs a human
  ([GATE-1-CONTENT-AUDIT.md](GATE-1-CONTENT-AUDIT.md)).
- **It can't un-disclose what was already sent.** The July 2026 disclosure is a counsel question.
- **It must fail closed.** A redactor that errors quarantines the document. One that silently passes text through
  manufactures confidence, which is worse than none.

### Over-redaction is the failure that looks like success

A redactor aggressive enough to strip every number turns a tax SOP into unusable prose. Of the 355 documents flagged
in August 2026, 316 merely named a form. Precision matters as much as recall. That is why `ssn-unformatted` needs a
nearby label, why a bare 9-digit run is masked only under the density-gated roster sweep, and why contextual patterns
never block ingestion. Redaction also costs retrieval: an Amazon Science study (arXiv 2411.05978) measured
sanitisation at about 1–5% on sentiment and entailment tasks but **more than 25% on comprehension Q&A**, which is
what this system does.

## Why there is no NER or Presidio gate

**Named-entity recognition can't tell a client's name from a staff member's.** Span-level NER labels a token as
`PERSON` or not. None of Presidio, spaCy or GLiNER encodes the entity's role, and no benchmark for "client name versus
employee name" was found. The research from 2026-08-03:

- **Presidio** is MIT-licensed and moved to community governance under Data Privacy Stack in June 2026 (2.2.363), so
  pin a version rather than tracking `main`. It runs fully offline only with its default local NER backend.
- **Presidio's `PERSON` accuracy is weak on business documents:** F1 0.78 on annotated news, but 0.18–0.37 on
  synthetic business-style data in the one practitioner benchmark found (its author called it a direction-finding
  comparison, not a rigorous evaluation). It has no `US_EIN` recognizer out of the box.
- **An LLM as classifier** is viable only as a recall-oriented triage gate. The closest comparable study (arXiv
  2605.10211, a local LLM classifying deliberative privilege) got recall 0.80 and precision 0.54, and adding a
  "critic" agent made results worse.
- **AWS's RAG reference architecture** doesn't trust single-pass redaction either. It pairs redaction with a second,
  independent detector and a human-review quarantine.
- **NIST SP 800-188:** de-identification reduces residual risk and never eliminates it, so residual risk must be
  evaluated explicitly.

Layer 1.5 is the shipped answer to the gap. It detects, routes to Layer 3 and quarantines for human review, and it
never decides alone. If names still slip through later, the tractable next step is **roster cross-matching**: use NER
only for recall, then match each `PERSON` span against the firm's closed staff list, so anything not on the list
becomes a client candidate for review. The roster is firm data and belongs in deployment config, never in this repo.

## Class B carries an unbuilt obligation

The firm's draft data-classification policy (POL-01, not yet adopted) defines Class A with a one-line test: _"Would
this be equally true if we had no clients at all?"_ Its tie-breaker is _"when you cannot tell, it is the higher
class."_ Use both, verbatim, as the review instrument for any content audit.

The same policy says Class B (firm research, de-identified) needs a human to confirm de-identification before
indexing, and must be _"summarized, not quoted verbatim, in output."_ **The system does neither.** The system prompt
asks for near-verbatim reproduction of procedures, so a Class B document in the corpus conflicts with the policy. The
simplest resolution is to index Class A only. That is a partner decision, and it is not yet decided.

## Anti-pattern guards

- **Exclude containers, not identities.** Never put a client name in an exclusion list. The list has to stay stable as
  clients change.
- **Exclude before fetch, not after retrieval.** A post-retrieval filter still lets the bytes be embedded and sent.
- **No regexes in database config.** `excludePaths` entries are case-insensitive substrings, because a regex in a JSONB
  column is an injection and ReDoS surface for no benefit.
- **Never add a title name-scrubber** (see [Citations bypass the model](#citations-bypass-the-model)).
- **Keep firm-specific folder names in source config, not in code.** One exception exists today; see the open items.
- **Pass security-relevant values unconditionally.** A gate that runs only when a field is present reads as protection
  it didn't provide. Layer 2's `ingest.path_unavailable` warning exists for this reason.

## Verification

- Unit and integration tests sit beside the code: `content-safety.test.ts`, `content-safety-parsed.test.ts`,
  `classify-document.test.ts`, `ingest-gates.test.ts`, and the `pipeline.*.test.ts` files for redaction,
  quarantine cause, empty pack, the semantic scan and Layer 2 observability. Golden tests should assert both that
  identifiers are removed and that the surrounding text survives.
- **Replaying the pre-purge manifest** (`corpus-analysis/PRE-PURGE-MANIFEST-2026-08-03.jsonl`, gitignored: 17 high, 338
  review and 503 clean of 858) through the current pipeline is the objective test: the flagged count should drop to
  zero. UNVERIFIED: no record shows the replay was run. Settle by running it and recording the result.
- Retrieval-affecting changes here also need the eval harness ([EVALUATION.md](../evaluation/EVALUATION.md)).

## Open items

| Item                                            | State                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-screen after every sync                      | Not built. Planned as a worker job like the docs-gap digest, alerting on identifying patterns only. Worker jobs today: `sync_source`, `docs_gap_digest`, `ship_audit_log`.                                                                                                              |
| Surface a stale screen sign-off                 | Not built. `packages/rag/src/extraction/screen-gate.ts` invalidates a sign-off when the corpus fingerprint changes, but nothing reports that state.                                                                                                                                     |
| `DEFAULT_EXCLUDED_PATH_FRAGMENTS` lives in core | **Decision needed.** The list in `content-safety.ts` holds folder names taken from this firm's corpus, which contradicts the rule that firm folder names stay out of committed code. Option: move it into the vertical pack or the source config, and leave core with an empty default. |
| Class B and the Class-A-only decision           | Not yet decided (previous section).                                                                                                                                                                                                                                                     |
| Excluding sandbox and draft folders             | Partner decision. In the August 2026 corpus these were 64% of documents, so excluding them is a content decision with a large coverage cost.                                                                                                                                            |
| Name and address detection                      | Not built at the pattern level; the scope contract's de-identification claim needs narrowing ([scope-conformance-2026-09-30.md](scope-conformance-2026-09-30.md) §0.6).                                                                                                                 |
| Scanner ids hardcoded outside the pack          | A new identifying scanner also needs `kindFor` in `content-safety.ts` and `CLASS_D_IDENTIFIERS` in `classify-document.ts`, or it masks text without recording or escalating anything (`packs/cpa/pack.yaml` header). Not closed at the type level.                                      |
| Layer 2 for non-SharePoint connectors           | Not built; those connectors supply no path.                                                                                                                                                                                                                                             |
| Manifest replay evidence                        | UNVERIFIED (see Verification).                                                                                                                                                                                                                                                          |

## History

- **2026-08-01:** a client-identifier screen of the 858-document production corpus found client files, a 522-SSN roster
  and client-named folders in a source declared `general`. The root cause was that class was stamped per source,
  never per document, and an unknown class defaulted to the most permissive one.
- **2026-08-03:** the whole index was purged ([records/PURGE-RECORD-2026-08-03.md](records/PURGE-RECORD-2026-08-03.md)).
  Pattern redaction and structural exclusion (`36774de`) and the Layer 3 classifier (`f13f707`) landed the same day,
  as did the identifying/contextual split at generation (`896170e`).
- **2026-08-31 to 2026-09-16:** unformatted identifiers blocked (`19a7542`), redaction moved onto the pack engine
  (`54ec25b`) with overlapping spans coalesced (`e8d1681`), tables and titles redacted (`f09bb3c`), and per-source
  SharePoint `excludePaths` applied before download (`70c936f`).
- **2026-10-02:** the rebuilt 47-document, Class A corpus passed Gate 1 on a verbal sign-off.
