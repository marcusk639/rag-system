# Production index purge — 2026-08-03

**Status:** Complete and verified · **Recorded:** 2026-08-04 (retrospectively)
**What happened:** the entire indexed corpus was deliberately removed from the
production database because it contained taxpayer return information (TRI).

> **Why this file exists.** The purge was intentional and correct, but it left no
> trace in `ingest_log`, no `screen-signoff.json`, and no changelog entry. The
> only artifact was a manifest filename. `TWK-MANUAL-RUNBOOK.md` item 1 asks for
> exactly this: _"Write down, in one page, exactly what you found… it's the honest
> record you'd want to have if this question ever comes up later."_ Reconstructed
> from the pre-purge manifest and a read-only query of production on 2026-08-04.

---

## The decision

The corpus was purged **because it contained TRI** — operator's decision, not an
accident and not a system fault.

The 2026-08-01 client-identifier screen over all 858 indexed documents found
client-identifying material in a corpus everyone had believed was Class A/B
firm-internal SOPs. 355 of 858 documents carried at least one pattern hit;
17 carried SSN / EIN / bank-account hits; one indexed spreadsheet held 522
SSN-shaped and 518 EIN-shaped values. Full screen: `corpus-analysis/`
(gitignored — it holds the actual identifiers and must stay local).

Rather than remove the flagged subset, **everything was removed.** For a corpus
whose classification could not be trusted, that is the defensible call: it does
not depend on the screen having found every case, and scanner false-negatives are
unbounded (see `superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md` §10).

## Before and after

|             | Before | After                            |
| ----------- | ------ | -------------------------------- |
| `documents` | 858    | **0**                            |
| `chunks`    | ~6,175 | **0**                            |
| `sources`   | 3      | **3 — retained, cursors intact** |

Corroborating evidence, read from production 2026-08-04:

- `pg_stat_user_tables` lifetime deletes: **2,546** documents, **18,659** chunks
- `PRE-PURGE-MANIFEST-2026-08-03.jsonl` — full 858-document snapshot taken 17:10, 2026-08-03 (gitignored)
- `BACKUP-RESTORE-DRILL.md` confirms 858 docs / 6,175 chunks present on 2026-07-31
- `ingest_log` retains the original ingest: **844 `ingested`, 49 `tri-flagged`**, last 2026-07-04 17:37
- Last ingestion job: 2026-07-04 17:27, `completed`, 811 processed / 89 failed

## What was NOT deleted

Deliberately or otherwise, these survived and should not be assumed gone:

- **`sources`** — all three, **with delta cursors intact.** See the re-sync warning below.
- **`ingest_log`** — 893 rows, including per-document ingest records
- **`audit_log`** — 3 rows (see below)
- **Object storage** — not audited by this record. If originals were uploaded to the object store, they were not covered by a `documents`/`chunks` delete. **Open item.**

## Exposure assessment

**Internal disclosure: none.** `audit_log` holds three rows, all 2026-07-04, all
`channel=api`, all `gemini-2.5-flash`, all by the operator. **No other user ever
queried the system.** No staff member ever saw a citation, client-named or
otherwise. The staff one-pager was never distributed.

**External disclosure: occurred, under DPA terms.** Embedding text is sent to the
vendor **at ingest**, so the 2026-07-04 ingest of 844 documents was a disclosure
event independent of who later queried it. Per `CPA-COMPLIANCE-REQUIREMENTS.md`,
that is the moment §7216 attaches.

The governing question was whether the Gemini key was free-tier (no DPA, human
review permitted, vendor warns against sensitive data) or paid. **Verified
2026-08-04: the backing GCP project is on Cloud Billing Tier 1 (prepay)** — so
the Cloud DPA applied, with no-train and zero-retention in force. See
[`compliance/vendor-dpa-google-gemini.md`](./compliance/vendor-dpa-google-gemini.md).

⚠ **Recordkeeping gap.** `audit_log.embedding_provider` / `embedding_model` are
**NULL** for all three July rows — those columns were added 2026-07-09, after the
ingest. The conclusion that Gemini embedded the July corpus rests on the
configured default plus `ingest_log`, **not on an audit row.** Under Circular 230
§10.22 that is an inference, not a record.

**The purge stops further exposure. It does not reach the July event.**

## ⛔ Re-sync would undo all of this

The sources still hold their delta cursors, and **no ingest-time gate exists yet**:

- Phase 2 of the content-boundary plan (SharePoint `excludePaths`) — **unbuilt**
- Phase 4 (ingest-time gate on identifying patterns) — **unbuilt**
- Classification is still per-**source** and human-declared; all three sources are
  `data_class = general`, so every document is stamped Class A regardless of content

**A single `POST /sources/:id/sync` restores the exact state that was just
deliberately cleared**, roster included.

✅ **Nothing will trigger that on its own** — verified 2026-08-04. The only
pg-boss schedules are `rag.docs_gap_digest` (weekly) and `rag.ship_audit_log`
(hourly); neither ingests. No jobs queued or in flight.

**Do not re-sync until Phase 2 and Phase 4 have landed.** If a re-sync is needed
sooner, scope the source to an audited subtree first.

## Current state of the pilot

`rag-web` is deployed and auth-gated but the index is empty, so every question
retrieves zero chunks and short-circuits to _"The available documents do not
contain enough information to answer that."_ **A working screen returning no
answers is indistinguishable from a broken system** — worth knowing before anyone
is invited to try it.

## Open items this record does not close

1. **Object storage** — never audited for surviving originals.
2. **CR-3 data residency** — unverified; billing status does not establish region.
3. **[COUNSEL] §7216/GLBA adequacy** of the standard Cloud DPA — never reviewed. This is P0 gate #2 and is unchanged.
4. **`screen-signoff.json`** — still does not exist. The screen-gate fails closed without it, so any future extraction remains blocked by design.
5. **No purge action was written to `ingest_log`.** If a future purge happens, log it there — the column is free text and exists for this.
