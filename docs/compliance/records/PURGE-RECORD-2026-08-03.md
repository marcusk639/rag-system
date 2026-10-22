# Production index purge — 2026-08-03

**Status:** Database purge complete 2026-08-03 · **object storage not closed
until 2026-09-01** — see the amendment at the end of this file
**Recorded:** 2026-08-04 (retrospectively) · **Amended:** 2026-09-01
**What happened:** the entire indexed corpus was deliberately removed from the
production database because it contained taxpayer return information (TRI).

> **Why this file exists.** The purge was intentional and correct, but it left no
> trace in `ingest_log`, no `screen-signoff.json`, and no changelog entry. The
> only artifact was a manifest filename. `PILOT-MANUAL-RUNBOOK.md` item 1 asks for
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
- **Object storage** — not audited by this record. If originals were uploaded to the object store, they were not covered by a `documents`/`chunks` delete. **Open item.** → **Audited 2026-09-01: they were there. 1,747 objects, 476 MB. Closed — see the amendment.**
- **Database backups** — not considered by this record at all. Five nightly dumps taken 2026-08-01 → 2026-08-03 each held the complete pre-purge corpus. **Deleted 2026-09-01 — see the amendment.**

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

1. ~~**Object storage** — never audited for surviving originals.~~ **CLOSED 2026-09-01** (see amendment). The audit found the originals had survived, along with five full database dumps.
2. **CR-3 data residency** — unverified; billing status does not establish region.
3. **[COUNSEL] §7216/GLBA adequacy** of the standard Cloud DPA — never reviewed. This is P0 gate #2 and is unchanged.
4. **`screen-signoff.json`** — still does not exist. The screen-gate fails closed without it, so any future extraction remains blocked by design.
5. **No purge action was written to `ingest_log`.** If a future purge happens, log it there — the column is free text and exists for this.

---

# Amendment — 2026-09-01: object storage and backups

**Recorded same-day, not retrospectively.** Open item 1 above is now closed. The
finding is that this record's central claim was true of the database and not of
the system: the corpus was removed from Postgres on 2026-08-03 and remained in
object storage for **29 days**.

## What was found

Audited 2026-09-01 by listing the bucket (`rag-documents-yivrrpkniny`) and
comparing every `sources/<uuid>/` prefix against the live `sources` table.

| prefix       | objects   | size         | written    |
| ------------ | --------- | ------------ | ---------- |
| `770e4016-…` | 844       | 235.4 MB     | 2026-07-04 |
| `44ad7a50-…` | 844       | 235.4 MB     | 2026-07-04 |
| `7a98177d-…` | 49        | 4.8 MB       | 2026-08-31 |
| `b54dbd7b-…` | 10        | 0.4 MB       | 2026-07-02 |
| **total**    | **1,747** | **476.1 MB** |            |

The two 844-object sets are the original bytes of the corpus this record was
written about — the same documents the 2026-08-01 screen flagged, including the
spreadsheet holding 522 SSN-shaped values. Unredacted, in their delivered
format.

**Additionally, and not contemplated anywhere in the original record:** five
nightly database dumps in `backups/`, taken 2026-08-01 → 2026-08-03, ~35.5 MB
each (177.8 MB total). Each is a complete snapshot of the pre-purge database —
every chunk, every embedding, every row the purge deleted. The purge removed the
live copy while five point-in-time copies of it sat in the same bucket.

## Root cause

Not a mistake in the purge. `ObjectStore` has always exposed a `delete()`
method and **nothing ever called it**. `purgeSource` cascaded in Postgres only,
and `documents`/`chunks` have no relationship the bucket can observe. So _every_
source deletion in the system's history orphaned its originals; the 2026-08-03
purge behaved exactly as deletion behaved everywhere else.

That is why the original record could flag object storage as unaudited and still
reasonably describe the purge as complete — the gap was in the deletion
primitive, not in the operation performed on 2026-08-03.

## What was done

1. **Five pre-purge dumps deleted** (177.8 MB). Verified afterwards that only the
   post-purge dump of 2026-09-01 remains.
2. **1,747 orphaned objects deleted** (476.1 MB) via
   `scripts/sweep-orphaned-objects.sh`.
3. **`purgeSource` now clears object storage.** The DB layer returns the storage
   keys it removed — read _before_ the cascade, since afterwards the rows are
   gone and the keys are unrecoverable, which is precisely why the existing
   orphans could not be attributed. `apps/mcp` was also threading no
   `objectStore`, so the `purge_source` tool would have kept orphaning after the
   API was fixed.
4. **`scripts/sweep-orphaned-objects.sh`** added as a recurring drift check
   between bucket and database. It refuses to run if the live-source list cannot
   be read, or reads as empty, because either would make every prefix look
   orphaned.

**Bucket after:** 50 objects, 6.4 MB — 49 originals belonging to the one live
source, plus the current backup. Every remaining object maps to something that
exists.

## Exposure, restated

The original **Exposure assessment** section assessed disclosure from the
database and the audit log. It did not consider the bucket, so its conclusion
should be read as scoped to Postgres.

For the 29 days between 2026-08-03 and 2026-09-01, the TRI this record describes
as removed was present in a third-party object store with:

- no DPA on file (`docs/compliance/` covers the Gemini vendor; there is no
  equivalent for the storage provider)
- no documented retention window
- no access logging reviewed

No evidence of access was sought and none is claimed either way. The honest
statement is that the data was retained longer than intended and that whether it
was read is not established.

## Consequence to carry forward

Deleting the pre-purge dumps leaves **exactly one backup** — the 2026-09-01
dump, which predates the re-ingest of the reworked knowledge base. It is the
only restore point. Take a fresh dump deliberately after the next successful
sync rather than waiting for the 08:00 UTC cron.
