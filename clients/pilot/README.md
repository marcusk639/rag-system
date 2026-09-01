# clients/<tenant>/ — pilot tenant work product

**Owner: the operating tenant.** Foreground work product under the pre-employment IP
instrument — configuration, data, named analysis, and anything derived from
the firm's corpus.

## The one rule, restated from the other side

> **Flow is one-way: `methodology/` → here. Never the reverse.**

Nothing in this directory may be lifted back into `methodology/` without explicit
de-identification **and** written permission. Not the corpus statistics, not the
SOP titles, not the gold-set questions, not the tenant configuration.

## What belongs here

- the tenant's SharePoint index configuration and connection scope
- The gold set once the CPA session populates it
- Corpus statistics measured against the firm material
- Deployment runbooks and launch status for this tenant
- Anything naming the firm staff, clients, or systems

## Data-class boundary — the load-bearing one

The KB assistant connects to **SharePoint only**. Client files live in **Onvio**
and QuickBooks Desktop files on the **Z Drive**; neither is ever wired in. That
makes the Class A/B safe lane a **connection-scope fact** rather than a
per-document classification promise — far cheaper to prove and far harder to
violate by accident.

**Do not connect any retrieval or AI layer to Onvio or the Z Drive.**

## Note on migration

Existing the firm-specific material still sits at the repository root — the six
`docs/the firm-*.md` files and `tests/e2e/src/eval/gold-set.ts`. Those are already
enumerated as foreground in Schedule A §3, so the split is recorded correctly
even before the files physically move. **Moving them here is housekeeping, not a
legal fix** — do it when convenient, and do not let the move break the runbook
links that point at them.
