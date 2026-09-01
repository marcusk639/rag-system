# Sensitive-Content Discovery and Pack-Declared Scanners — Design

**Status:** Design — 2026-08-31. Approved in brainstorming.
**Builds on:** [`2026-08-03-multi-vertical-rag-platform-design.md`](./2026-08-03-multi-vertical-rag-platform-design.md) — implements the `scanners:` slice of its pack format (§3.2, §3.4, §3.6, §3.7).
**Supersedes in practice:** the ad-hoc screen in `scripts/extract-corpus.ts`, which reads the index rather than the source and cannot run at all now that the corpus is purged.
**Blocks:** re-ingestion of the TWK corpus — and is the input that lets re-ingestion be precise rather than destructive.

---

## 1. Why this exists

On 2026-08-03 the entire indexed corpus was purged because it contained taxpayer
return information. The screen that found it (`extract-corpus.ts`) reads
**Postgres**, so it cannot be re-run: there is nothing indexed to read. Re-ingesting
in order to screen would re-import the material the purge removed.

That gap is what this design fills. It also resolves a second problem found while
scoping: the repository contains **three** overlapping pattern implementations that
disagree with one another.

| Implementation                                 | Role                         | Tuned for | Notable gaps                                   |
| ---------------------------------------------- | ---------------------------- | --------- | ---------------------------------------------- |
| `packages/core/src/tri-scanner.ts`             | runtime ingest + egress gate | balance   | no bank-account or client-deliverable patterns |
| `scripts/extract-corpus.ts` → `screenDocument` | the 2026-08-01 audit         | recall    | lives in `scripts/`, not a module              |
| `packages/core/src/content-safety.ts` (PR #41) | ingest redaction             | precision | bare 9-digit runs deliberately not SSNs        |

Adding a fourth for discovery is the obvious move and the wrong one. This design
collapses all of them onto one pack-declared set.

## 2. Decisions taken in brainstorming

| #   | Decision                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Scope is **discovery + inventory**: a read-only pass producing evidence. No automated remediation.                                                                                                    |
| D2  | **Raw identifier values are never stored — including inside stored context.** Findings carry a locator and shape-preserving masks; context windows are themselves redacted before persistence. The true value is resolved on demand from the source under the reviewer's own permissions. |
| D3  | Patterns are **pack data**, not code. The scanner engine is generic; TRI-ness lives in `packs/cpa/`.                                                                                                  |
| D4  | The registry and its API live in **`apps/api` with their own tables**; the scan runs as a job independent of ingestion. Designed for later extraction into a separate app.                            |
| D5  | Where PR #41 and the multi-vertical spec conflict, **the spec governs**: disposition is pack-declared with `exclude` as the default for `identifying`. PR #41 is the engine, not the policy.          |

## 3. The pack scanner slice

`packs/cpa/pack.yaml` declares scanners as data:

```yaml
pack:
  id: cpa
  version: 1.0.0
  requiresCore: "^1.0.0" # semver range against the PACK CONTRACT version, per §3.6

scanners:
  - id: ssn
    kind: identifying
    disposition: exclude
    pattern: '\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b'

  - id: card
    kind: identifying
    disposition: exclude
    pattern: '\b(?:\d[ -]?){12,18}\d\b'
    validator: luhn

  - id: account
    kind: identifying
    disposition: exclude
    pattern: '\b\d{6,17}\b'
    context: account-vocab

  - id: tax-form-with-amount
    kind: contextual
    disposition: flag
```

The engine lives in `@rag/core` and knows nothing about tax. It loads a pack,
validates it against a zod schema, **fails closed** on version incompatibility
(§3.6), and resolves `validator` / `context` through a registry of names compiled
into the image (§3.4 — no dynamic loading; the supply chain stays auditable).

### 3.1 One pass, two consumers, ranked by confidence

The alternative — two pattern sets, or one set with two profiles — makes
"the audit never misses what the redactor catches" a convention someone must
maintain. Instead, a single pass emits **every** match with a confidence:

- satisfies its `validator` and `context` gate → `high`
- fails **only** the context gate → `low`

Consumers differ solely in what they act on:

| Consumer                  | Acts on                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| Ingest (redact / exclude) | `high` only — preserves the precision `content-safety.ts` was built for |
| Discovery (audit)         | everything, including `low`, surfaced for triage                        |

The superset property becomes structural rather than conventional, and is
assertable in one test. The recall-versus-precision conflict dissolves: nothing is
dropped, it is ranked.

Concretely — in an SOP, `123456789` with no account vocabulary nearby is `low`.
The redactor ignores it (no over-redaction); the audit lists it (no silent miss).

### 3.2 Scope of this slice

Only `scanners:`. Not `classification.yaml`, not `prompt.md`, not the conformance
suite — those arrive with the rest of the pack format. Patterns move out of
`tri-scanner.ts` and `content-safety.ts` into pack data, and
`CLASS_D_IDENTIFIERS` in `classify-document.ts` becomes `kind: identifying` in
YAML.

## 4. Disposition — protecting the corpus without hollowing it out

Disposition is a function of **`(scanner kind, document class)`**, not scanner
alone. A stray SSN in a genuine SOP and an SSN in a client roster are the same
match and warrant opposite treatment.

| Document class                                 | `identifying` hit                       | `contextual` hit       |
| ---------------------------------------------- | --------------------------------------- | ---------------------- |
| Client file (Layer 2 path, or Layer 3 class D) | **exclude**                             | exclude                |
| Procedure / SOP                                | **redact** the span, index the document | **flag**, index intact |
| Unclassified                                   | exclude (fail-closed)                   | flag                   |

### 4.1 Why this preserves knowledge-base value

From the 2026-08-01 screen of 858 documents:

- **355 carried at least one hit.** Excluding on _any_ hit costs **41% of the
  corpus** and would gut the KB. This matrix never does that.
- **316 matched `tax-form+amount`, and every inspected hit was a legitimate SOP.**
  These are `flag` → indexed intact, nothing masked, full value retained.
- **17–24 carried SSN/EIN/bank-account hits** (counts differ between the purge
  record and §3.2 of the platform spec — different pattern sets and dates). One
  held 522 SSN-shaped values: a client roster. These are `exclude` → roughly
  **2–3% of the corpus**, and it is the portion that is not firm procedure.

"Exclude by default" is safe _because_ it is scoped to `identifying`, which is
rare. Redaction survives as the middle path: an SOP naming one real identifier
stays indexed and readable with that span masked. The measured >25% comprehension
cost of sanitization (Amazon Science, arXiv 2411.05978, cited in §3.7) applies only
to spans actually masked — a small number of documents, not all 355.

### 4.2 Why discovery is the prerequisite

This matrix cannot be applied without knowing which documents are which.
Discovery produces that evidence. Without it the only safe policy is the blunt one
that costs 41% of the corpus. Discovery is therefore not merely a compliance
inventory — it is what lets ingestion be precise instead of destructive.

## 5. The discovery service

### 5.1 Flow

A pg-boss job, also invocable as a CLI, entirely outside the ingestion pipeline:

```
connector.list()  →  connector.fetch()  →  parser.parse()  →  scanner engine  →  registry
   (Graph delta)      (bytes, not stored)   (→ markdown)      (pack, audit)      (findings)
```

It writes nothing to the corpus tables — no documents, no chunks, no embeddings.
Nothing reaches an embedding provider, so **a scan has no egress path.**

### 5.2 Schema

```sql
scan_run        id, pack_id, pack_version, source_id, started_at, finished_at,
                status, docs_listed, docs_scanned, docs_failed, findings_total

scan_document   run_id, external_id, path, title, mime, size_bytes, modified_at,
                scan_status,        -- 'scanned' | 'skipped' | 'failed'
                reason,             -- why skipped or failed
                content_sha256      -- of parsed text, for run-over-run diffing

scan_finding    run_id, external_id, scanner_id,
                kind,               -- 'identifying' | 'contextual'
                confidence,         -- 'high' | 'low'
                match_count,
                masked_sample,      -- e.g. '1XX-XX-XXX9'
                parsed_offset,      -- into the PARSED markdown, not the source file
                locator_hint,       -- sheet name, or nearest markdown heading
                masked_context_before,   -- redacted before persistence
                masked_context_after     -- redacted before persistence
```

**There is no column for the raw value, and that absence is the design** (D2).
Remediation needs _where_ and _what kind_; it does not need a second permanent copy
of the identifier.

#### The context columns are themselves redacted, and that is not optional

Storing a raw window around each match would break D2 precisely where it matters
most. The worst document in the 2026-08-01 screen held **522 SSN-shaped and 518
EIN-shaped values** — parsed, that is a table of identifiers. A raw context window
around match #1 contains matches #2 and #3 in the clear, and `scan_finding` becomes
a curated extract of exactly the material the purge removed.

Both context columns are therefore passed through the same redactor before they are
persisted: `masked_context_before` and `masked_context_after` are stored already
masked, never raw. This costs nothing — the engine is already in the call path — and
it keeps a finding locatable without carrying the values.

#### Why `parsed_offset` alone cannot be the locator

The offset is into the **parsed markdown**, which a reviewer never sees; they open a
`.docx` or `.xlsx` in SharePoint. There is no general mapping from a markdown offset
back to a page or cell, and the parser does not supply one — `ParsedDocument` carries
`markdown`, `tables[]` (with `sheetName`), and freeform `metadata`, but no page index.

The locator is therefore three fields working together:

- `locator_hint` — the parser's `sheetName` for tabular sources, otherwise the
  nearest preceding markdown heading. Structural, human-usable, and derivable from
  what the parser already returns.
- `masked_context_*` — enough surrounding prose to find the spot by eye or by search,
  with any identifiers inside it masked.
- `parsed_offset` — exact, but only meaningful against the parsed text whose hash is
  recorded on `scan_document.content_sha256`. **If that hash does not match a fresh
  parse, the offset is stale and must be treated as advisory.**

`scan_document` carries a row for **every document enumerated**, not only those
with hits. A `.pdf` that failed to parse is `scan_status='failed'` with a reason,
never silently absent. Without this, "no findings" and "never read" are
indistinguishable — which is precisely how a corpus gets certified clean while it
is not.

Table names are `scan_*`, not `tri_*`. TRI-ness lives in the pack.

### 5.3 API

Read-only, and gated on `Principal.kind === "admin"` — the same mechanism the
existing routes use, with `ADMIN_SCOPE` (`packages/core/src/access-control.ts:63`)
as the resolved authorization scope. A `scoped` principal is refused outright: a
map of where client identifiers live is itself sensitive, even without values, and
is not something a per-user KB token should reach.

| Endpoint                                     | Returns                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `GET /admin/scans`                           | run history                                             |
| `GET /admin/scans/:id`                       | summary with real denominators                          |
| `GET /admin/scans/:id/documents`             | paginated; filters: `scan_status`, `kind`, `confidence` |
| `GET /admin/scans/:id/documents/:externalId` | one document with its findings                          |

Findings are logged masked only, never raw.

### 5.4 Error handling and scale

858+ documents, one parser round-trip each. A parse failure records `failed` and the
run continues — one bad `.pdf` must not abort a scan. Microsoft Graph 429s use the
connector's existing backoff. Runs resume via the connector cursor plus
`(run_id, external_id)` idempotency, so an interrupted scan continues rather than
restarting.

**Budget.** Parser round-trips dominate; the scan is IO-bound, not CPU-bound. Default
to **4 concurrent parses**, bounded so a scan cannot starve ingestion of the same
sidecar, and expect a full pass over ~858 documents to run in tens of minutes rather
than seconds. The concurrency is configurable because the right value depends on how
the parser is deployed, and a scan competing with a live sync is the failure mode
worth avoiding. `CLAUDE.md` already warns that SharePoint and Outlook share one Graph
quota, so a scan running beside a bulk re-sync will throttle both.

**A scan is safe to run against production**, because it writes only `scan_*` tables
and never touches the corpus — but it is not free, and it should be scheduled rather
than fired during an ingestion window.

### 5.5 Migration and rollback

Three new tables mean a Drizzle migration, and this repo has a specific contract for
that which the rest of this design must respect:

- `rag-worker` is the **single migration owner** via its `preDeployCommand`
  (`pnpm --filter @rag/db migrate`). Do not add that command to `api` or `mcp` —
  concurrent bootstrap contends. See `docs/DEPLOYMENT.md`.
- On a schema-changing release, **deploy `rag-worker` first**, then `api`/`mcp`. The
  new read endpoints in `apps/api` must not ship ahead of the tables they read.
- Rollback is a plain `DROP` of the three tables. They are **append-only evidence
  with no foreign keys into the corpus tables**, so dropping them cannot cascade into
  documents or chunks — which is the main reason to keep the registry structurally
  separate rather than hanging it off `documents`.

### 5.6 Extractability

The service depends only on `Connector`, the parser client, and the pack engine —
all existing interfaces. Extracting it later means moving `packages/content-scan/`
plus these tables and routes into a new app pointed at the same pack. There is no
RAG-internal coupling to unpick.

## 6. Testing

- **Fixture-driven**, using the pack's `fixtures/` (§6.2 of the platform spec):
  synthetic documents with known plants, asserting exact counts by `kind` and
  `confidence`. Fixtures are synthetic — no real identifiers enter the repo.
- **The superset property**: no `high` finding exists that discovery would not
  report. One test, derived structurally from §3.1.
- **The honesty property**: a parse failure produces a `scan_document` row with
  `scan_status='failed'`, not a missing row.
- **Value-freeness**: no raw match text reaches any `scan_finding` column or any log
  line. The decisive case is a fixture shaped like the real one that caused the purge —
  a table of adjacent synthetic identifiers — asserting that a finding's
  `masked_context_before` / `masked_context_after` contain no unmasked neighbour. A
  test that only checks the matched span would pass while the design leaks.

### 6.1 Two properties the API must not quietly violate

- **Runs are only comparable within a pack version.** `scan_run` records `pack_id`
  and `pack_version`; a diff across differing versions compares two definitions of
  "finding" and must be refused or clearly labelled, not silently rendered.
- **A scan is a point-in-time artifact of a live corpus.** `GET /admin/scans/:id`
  returns `finished_at`; consumers should treat an old run as evidence of what was
  true then, not what is true now.

## 7. Out of scope

- `classification.yaml`, `prompt.md`, the pack conformance suite, and pack
  compatibility beyond the `scanners:` slice.
- Automated remediation. Discovery reports; humans decide.
- Scheduled or continuous re-scanning. The output is an artifact on disk and in
  Postgres; re-running later is nearly free, so building for it now is speculation.
- Blocking at sync time (the "continuous gate" option). That changes the ingestion
  contract, which today flags rather than blocks.

## 8. Consequences to accept

- **PR #41 cannot merge as-is.** Its unconditional `redactOrThrow` is the `redact`
  path applied globally; under D5 it becomes the engine behind pack-declared
  disposition. The redaction code and its 25 tests are sound and are kept.
- **§4's matrix depends on PR #41 landing.** Layer 2 (structural path exclusion)
  and Layer 3 (document classification) are what supply the `document class` axis;
  neither is on `main`. Discovery itself does not depend on them — it classifies
  nothing and indexes nothing — so the two can be built in parallel, but the
  disposition matrix cannot be enforced until #41 merges in its reworked form.
- **Requirement A depends on the pack slice**, which does not exist. That is the
  cost of not creating a fourth scanner.
- The counts in §4.1 come from a screen run against a corpus that has since been
  purged. They justify the design's shape; they are not a current inventory.
  Producing a current one is what this builds.
