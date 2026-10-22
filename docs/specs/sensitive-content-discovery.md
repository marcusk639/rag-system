---
title: Sensitive-content discovery
status: current
last_verified: 2026-10-21
verified_against: ae08541
answers: What the pack-declared scanner engine already does, and the design for the unbuilt read-only discovery service that inventories where identifiers live in a source without indexing it.
read_when: Building the discovery service or its scan_* tables, changing pack scanners or their confidence rule, or wiring scanner disposition into the ingest gate.
supersedes:
  [
    superpowers/specs/2026-08-31-sensitive-content-discovery-design.md,
    archive/plans/superpowers/2026-09-01-pack-scanner-slice.md (open items),
  ]
code:
  [
    packages/core/src/pack/scan.ts,
    packages/core/src/pack/registry.ts,
    packages/core/src/pack/load.ts,
    packages/core/src/content-safety.ts,
    packs/cpa/pack.yaml,
    packages/ingestion/src/classify-document.ts,
    scripts/extract-corpus.ts,
  ]
---

# Sensitive-content discovery

This spec answers how to find where client identifiers live in a source **before** anything from it is indexed. It
uses a read-only scan that records where each finding is and what kind it is, never its value. **Status on
2026-10-21:** the pack scanner slice (§3 of the 2026-08-31 design) shipped through
[the pack-scanner plan](../archive/plans/superpowers/2026-09-01-pack-scanner-slice.md). Patterns are pack data in
`packs/cpa/pack.yaml`, run by a generic engine in `@rag/core`. The discovery service is **not built**: there are no
`scan_run`, `scan_document` or `scan_finding` tables, no `/admin/scans` routes, and no plan has been written. The
disposition matrix below is a target and is **not safe to enforce** until the `data_class` → matrix-row mapping is
defined.

The content-safety layers that run at ingest today are described in
[../compliance/CONTENT-SAFETY-DESIGN.md](../compliance/CONTENT-SAFETY-DESIGN.md). The pack format and its open slices
are in [multi-vertical-platform.md](multi-vertical-platform.md).

## Status

| Part                                           | Status      | Where                                                                                          |
| ---------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| Pack scanner format, loader and contract check | Shipped     | `packages/core/src/pack/{schema,registry,load}.ts`; `packs/cpa/pack.yaml`                      |
| One-pass engine with `high`/`low` confidence   | Shipped     | `packages/core/src/pack/scan.ts` `scanText`, `maskValue`                                       |
| Ingest redaction on the engine                 | Shipped     | `packages/core/src/content-safety.ts` `redactText`, `applyRedaction`, `redactParsedDocument`   |
| Generation-side TRI scanner on the engine      | Not done    | `packages/core/src/tri-scanner.ts` keeps its own patterns                                      |
| Disposition wired to the pack                  | Not done    | Nothing branches on `disposition` ([KI-SAFE-8](../KNOWN-ISSUES.md#data-safety-and-compliance)) |
| `data_class` → matrix-row mapping              | Not defined | Blocks enforcing the [disposition matrix](#disposition-target-not-enforced)                    |
| Discovery service, `scan_*` tables, admin API  | Not built   | [The discovery service](#the-discovery-service-not-built)                                      |

## Why discovery exists

`scripts/extract-corpus.ts` is the only corpus screen. It reads the **index**, opening Postgres read-only through
`createReadOnlyDb` and checking with `assertReadOnly`, and it runs its own `screenDocument` patterns. It can screen
only what has already been ingested, so it can't tell you whether a source is safe to ingest. Ingesting a source in
order to screen it would import exactly the material the screen is looking for. That is how the August 2026 corpus
came to be purged ([records/PURGE-RECORD-2026-08-03.md](../compliance/records/PURGE-RECORD-2026-08-03.md)).

There were also three overlapping pattern sets that disagreed. One has since been moved onto the pack engine. Two
remain separate:

| Implementation                               | Role                        | State                                                  |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `packages/core/src/content-safety.ts`        | Ingest redaction            | On the pack engine since `54ec25b`                     |
| `packages/core/src/tri-scanner.ts`           | Generation-time egress gate | Separate TypeScript patterns; must agree with the pack |
| `scripts/extract-corpus.ts` `screenDocument` | Index screen (recall-tuned) | Separate; reads the index, not the source              |

Adding a fourth set for discovery is the obvious move, and the wrong one. Discovery runs on the pack engine.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Scope is **discovery and inventory**: a read-only pass that produces evidence. There is no automated remediation.                                                                                                                                                              |
| D2  | **Raw identifier values are never stored, including inside stored context.** Findings carry a locator and shape-preserving masks, and context windows are redacted before they are persisted. A reviewer resolves the true value from the source, under their own permissions. |
| D3  | Patterns are **pack data**, not code. The engine is generic, and what counts as TRI (taxpayer return information) lives in `packs/cpa/`.                                                                                                                                       |
| D4  | The registry and its API live in **`apps/api` with their own tables**. The scan runs as a job independent of ingestion, designed so it can later be extracted into a separate app.                                                                                             |
| D5  | Disposition is pack-declared, with `exclude` as the default for `identifying`. The redactor is the engine, not the policy.                                                                                                                                                     |

## The pack scanner slice (shipped)

Each scanner in `packs/cpa/pack.yaml` has an `id`, a `kind` (`identifying` or `contextual`), a `disposition`
(`exclude`, `redact` or `flag`, defaulting to `exclude` for identifying and `flag` for contextual) and a `pattern`.
It may also have a `validator`, a `context` gate and a `contextWindow`. The pack declares five identifying scanners:
`ssn`, `ssn-unformatted`, `ein`, `routing` (ABA checksum plus account vocabulary) and `card` (Luhn). It declares no
contextual scanners. The file itself is the authority on the patterns; don't copy them into docs.

`validator` and `context` are names resolved against a registry compiled into the image
(`packages/core/src/pack/registry.ts`: validators `luhn` and `aba`, context `account-vocab`). An unknown name fails
the load. Nothing is loaded dynamically.

### One pass, ranked by confidence: the total rule

`scanText` emits **every** match a pattern produces, with offsets into the input and a confidence:

- `high`: it satisfies every gate it declares (its `validator` and its `context`);
- `low`: it fails **any** gate it declares.

**No match is ever discarded.** Gates decide the label, never whether a finding exists. An earlier draft defined
`low` as "fails only the context gate". That left a Luhn-failing `card` candidate in neither bucket, because `card`
has a validator and no context, and a single pass would have dropped it with no second implementation left to catch
it. One OCR-lost digit on a real card number is enough to trigger that. A test asserts that a Luhn-invalid
card-shaped string comes out as `low`.

The consumers differ only in what they act on:

| Consumer                    | Acts on                                          |
| --------------------------- | ------------------------------------------------ |
| Ingest (redact, quarantine) | `high` only, which preserves redaction precision |
| Discovery (audit)           | Everything, `low` included, surfaced for triage  |

So "the audit never misses what the redactor catches" is structural and testable in one assertion. **It holds within
one scan only.** Ingest redaction runs continuously on live syncs, while discovery is a point-in-time pass, so a
document added after a scan's `finished_at` can be redacted before any audit has seen it.

### What the slice deliberately left undone

These items from the pack-scanner plan's non-scope list are still open:

- **`tri-scanner.ts` was not migrated.** It serves the generation-time egress gate, its identifying/contextual split is
  correct, and its exemption question is open in
  [tri-identifying-pattern-exemptions.md](tri-identifying-pattern-exemptions.md). The SSN and EIN patterns are
  therefore defined twice and must agree.
- **No `classification.yaml`, `prompt.md` or conformance suite.** These belong to the rest of the pack format
  ([multi-vertical-platform.md](multi-vertical-platform.md)).
- **Disposition was not wired.** `classify-document.ts` keeps its own `CLASS_D_IDENTIFIERS`. Wiring disposition to the
  pack waits until discovery exists to validate it.
- **No discovery.** That was plan 2, which would consume `scanText`. It hasn't been written.

### Gap: a new scanner id is not code-free

Contrary to D3, adding a scanner `id` to the pack also requires two code edits. One is `kindFor` in
`packages/core/src/content-safety.ts`, which maps an id onto an audit `RedactionKind`. The other is
`CLASS_D_IDENTIFIERS` in `packages/ingestion/src/classify-document.ts`, which decides whether a hit escalates the
document to Class D. Miss either one and the new pattern still masks text, but it records no finding, emits no
`ingest.redacted` log line and never escalates the document. The header of `packs/cpa/pack.yaml` records this as a
tracked type-safety gap. The density-gated tabular sweep for bare 9-digit runs is a further pattern that lives in
`content-safety.ts` rather than in the pack.

## Disposition (target, not enforced)

> **Warning: nothing may be enforced from this matrix yet.** It needs a mapping from `sources.data_class` to the
> matrix's rows, and none is defined. Today `mapDataClassToDocumentClass` maps `general` and `sop` to Class A. If
> Class A meant "Procedure / SOP", a client roster in a source declared `general` would get **redact and index**
> instead of exclude. Write that mapping down, and test it, before any code reads this table.

Disposition is a function of **(scanner kind × document class)**, not of the scanner alone. A stray SSN in a genuine
SOP and an SSN in a client roster are the same match and warrant opposite treatment.

| Document class                         | `identifying` hit                       | `contextual` hit       |
| -------------------------------------- | --------------------------------------- | ---------------------- |
| Client file (Layer 2 path, or Class D) | **exclude**                             | exclude                |
| Procedure / SOP                        | **redact** the span, index the document | **flag**, index intact |
| Unclassified                           | exclude                                 | flag (see below)       |

**Current behaviour is stricter than the matrix.** `classifyDocument` escalates any document with a
`CLASS_D_IDENTIFIERS` hit to Class D and quarantines it, so today every identifying hit is excluded, SOP or not
([CONTENT-SAFETY-DESIGN](../compliance/CONTENT-SAFETY-DESIGN.md#identifying-versus-contextual-patterns)). The matrix's
middle row is what would let an SOP naming one real identifier stay indexed with that span masked. It earns nothing
until the class axis and the mapping exist.

**`Unclassified` + contextual → `flag` is not fail-closed.** A known client file with only a contextual hit is
excluded, while an unknown document with the same signature is indexed. The single basis for `flag` is empirical: in
the one corpus ever screened, all 316 contextual-only hits were inspected and every one was a legitimate SOP. That is
a calibration, not a safety property. Re-validate it on each new corpus's first discovery run, and if contextual hits
land on client files there, change the cell to `exclude`.

**Why the matrix preserves knowledge-base value.** In the 2026-08-01 screen of 858 documents, 355 had at least one
hit. Excluding on any hit would cost 41% of the corpus. The identifying hits that warrant exclusion were roughly 2–3%
of documents, and they are the part that isn't firm procedure. These counts come from a corpus that has since been
purged. They justify the design's shape, not a current inventory, and producing a current inventory is what discovery
is for. Without discovery the only safe policy is the blunt one.

## The discovery service (not built)

### Flow

A pg-boss job, also invocable as a CLI, entirely outside the ingestion pipeline:

```text
connector.list() → connector.fetch() → parser.parse() → scanText (pack) → scan_* tables
 (delta cursor)     (bytes, not kept)   (→ markdown)      (all matches)     (findings)
```

It writes nothing to the corpus tables (no documents, chunks or embeddings) and calls no embedding provider, so a scan
has **no egress path**.

### Schema

```sql
scan_run        id, pack_id, pack_version, source_id, started_at, finished_at,
                status, docs_listed, docs_scanned, docs_failed, findings_total

scan_document   run_id, external_id, path, title, mime, size_bytes, modified_at,
                scan_status,        -- 'scanned' | 'skipped' | 'failed'
                reason,             -- why skipped or failed
                content_sha256      -- of the parsed text, for run-over-run diffs

scan_finding    run_id, external_id, scanner_id,
                kind,               -- 'identifying' | 'contextual'
                confidence,         -- 'high' | 'low'
                match_count,
                masked_sample,      -- maskValue output, e.g. '1XXXXXXXXX9'
                parsed_offset,      -- into the PARSED markdown, not the source file
                locator_hint,       -- sheet name, nearest heading, title, or null
                masked_context_before,   -- redacted before persistence
                masked_context_after     -- redacted before persistence
```

- **There is no column for the raw value, and that absence is the design** (D2). Remediation needs to know where and
  what kind, not a second permanent copy of the identifier.
- **The context columns are redacted before they are stored.** The worst document in the 2026-08-01 screen held 522
  SSN-shaped and 518 EIN-shaped values. A raw window around one match contains its neighbours in the clear, and
  `scan_finding` would become a curated extract of the purged material. Masking costs nothing extra, because the engine
  is already in the call path.
- **`scan_document` has a row for every enumerated document**, not only those with hits. A file that fails to parse is
  `scan_status = 'failed'` with a reason. Otherwise "no findings" and "never read" look the same, and that is how a
  corpus gets certified clean when it isn't.
- **The tables are `scan_*`, not `tri_*`.** TRI-ness lives in the pack.

### The locator problem

A reviewer opens a `.docx` or `.xlsx` in SharePoint, never the parsed markdown, so `parsed_offset` alone can't locate
a finding. The parser contract carries `markdown`, `tables[]` (each with a nullable `sheetName` and a `sheetType` of
`tabular`, `narrative`, `financial_model` or `freeform`) and freeform `metadata`. It has no page index.

The locator is therefore three fields used together:

- **`locator_hint`**, from a fallback chain: the table's `sheetName` when the match maps to a table and the name is
  non-null; else the nearest preceding markdown heading; else the document title; else `null`. `null` is a legal
  value. A scanned PDF can have no headings, and a match can precede the first heading.
- **`masked_context_*`**, enough surrounding prose to find the spot by eye or search. In a dense-identifier document
  the context is other masked identifiers, which can't tell row 47 from row 200. For the highest-risk documents, then,
  `locator_hint` and `parsed_offset` do the whole job. Masking stays correct anyway: an unusable locator is
  recoverable and a leaked roster is not.
- **`parsed_offset`**, exact, but only against the parsed text whose hash is `scan_document.content_sha256`. If a
  fresh parse hashes differently, treat the offset as advisory.

**Open, and it must be settled before implementation:** `ScanMatch` carries `start` and `end` into the flat markdown
string, while tables arrive separately in `tables[]`. Nothing maps an offset back to the table, and so to the
`sheetName`, it came from. Redaction doesn't need that mapping. Discovery does, most of all in the dense-identifier
spreadsheets where the sheet name is the only useful hint.

### API

The API is read-only and admin-only. Gate it on `Principal.kind === "admin"` (`packages/core/src/access-control.ts`;
the resolved scope is `ADMIN_SCOPE`), the same check `apps/api/src/routes/sources.ts` uses. A `scoped` principal is
refused outright: a map of where client identifiers live is sensitive even without the values.

| Endpoint                                     | Returns                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `GET /admin/scans`                           | Run history                                             |
| `GET /admin/scans/:id`                       | Summary with real denominators, including `finished_at` |
| `GET /admin/scans/:id/documents`             | Paginated; filters `scan_status`, `kind`, `confidence`  |
| `GET /admin/scans/:id/documents/:externalId` | One document with its findings                          |

Two properties the API must not quietly violate:

- **Runs are comparable only within a pack version.** A diff across `pack_version`s compares two definitions of
  "finding". Refuse it or label it clearly.
- **A run is a point-in-time artifact.** Treat an old run as evidence of what was true at `finished_at`, not now.

Log findings masked only, never raw.

### Errors, scale and scheduling

- A parse failure records `failed`, and the run continues. One bad PDF must not abort a scan.
- Graph 429s use the connector's existing backoff. SharePoint and Outlook share one Graph quota, so a scan beside a
  bulk re-sync throttles both.
- Runs resume through the connector cursor plus `(run_id, external_id)` idempotency.
- Parser round-trips dominate, so the scan is IO-bound. Default to 4 concurrent parses, configurable, and bounded so a
  scan can't starve ingestion of the same parser sidecar. Expect tens of minutes for about 850 documents.
- A scan is safe against production, because it writes only `scan_*` tables, but it isn't free. Schedule it outside
  ingestion windows.

### Migration and rollback

The three tables are one forward-only Drizzle migration. Follow the single-migration-owner and deploy-order rules in
the root `CLAUDE.md` and [../operations/DEPLOYMENT.md](../operations/DEPLOYMENT.md). The new `apps/api` read routes
must not ship ahead of the tables they read. Rollback is a plain `DROP` of the three tables. They are append-only
evidence with **no foreign keys into the corpus tables**, so dropping them can't cascade into documents or chunks.
That is the main reason to keep the registry structurally separate.

### Extractability

The service depends only on `Connector`, the parser client and the pack engine, all of them existing interfaces.
Extracting it later means moving its package, tables and routes into a new app pointed at the same pack.

### Testing

- **Fixture-driven:** synthetic documents with known plants, asserting exact counts by `kind` and `confidence`. No
  real identifiers enter the repo.
- **Superset property:** no `high` finding exists that discovery wouldn't report.
- **Honesty property:** a parse failure produces a `failed` row, not a missing row.
- **Value-freeness:** no raw match text reaches any `scan_finding` column or log line. The decisive fixture is a table
  of adjacent synthetic identifiers, shaped like the document behind the purge, asserting that `masked_context_*`
  holds no unmasked neighbour. A test that checks only the matched span would pass while the design leaks.

## Out of scope

- `classification.yaml`, `prompt.md`, the pack conformance suite, and pack compatibility beyond the `scanners:` slice.
- Automated remediation. Discovery reports, and humans decide.
- Scheduled or continuous re-scanning. Re-running is nearly free, so building for it now is speculation. (A post-sync
  re-screen job is tracked separately in
  [CONTENT-SAFETY-DESIGN](../compliance/CONTENT-SAFETY-DESIGN.md#open-items).)
- Blocking at sync time. That would change the ingestion contract.

## Open items

| Item                                                            | State                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Write plan 2 (discovery service)                                | Not started; listed in [KNOWN-ISSUES](../KNOWN-ISSUES.md#designed-not-built) |
| Offset → `ParsedTable.sheetName` mapping                        | Undesigned; must be settled before plan 2                                    |
| `data_class` → disposition-row mapping                          | Undefined; blocks the matrix                                                 |
| Wire `disposition` into the ingest gate                         | Not done ([KI-SAFE-8](../KNOWN-ISSUES.md#data-safety-and-compliance))        |
| Move `tri-scanner.ts` patterns onto the pack                    | Not done; the SSN and EIN patterns are duplicated meanwhile                  |
| Remove hardcoded scanner ids (`kindFor`, `CLASS_D_IDENTIFIERS`) | Not done; tracked type-safety gap                                            |
| Retire `screenDocument` in `scripts/extract-corpus.ts`          | Not done; the script still exists and is the only index screen               |
