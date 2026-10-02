# P0 gate #1 — content audit: how to actually close it

**Written:** 2026-10-02 · **Status:** procedure defined, audit not yet run, **one
code change still required** (§3)

**Gate #1 asks:** is every document in the staff-wide knowledge base one the firm
is willing to expose to every member of staff who can query it?

That is a firm-domain judgment. This document does not make it. It makes the
judgment _executable_ — it says what the reviewer is deciding, what the machine
has already decided for them, where a verdict is recorded, and what currently
stops a verdict from being enforced.

---

## 0. Read first — three things that change how you run this

**0.1 The gate is small now, and that is not a reason to skip it.** The audit was
once an 858-document slog against a corpus known to contain TRI. That corpus was
deliberately destroyed on 2026-08-03 (`PURGE-RECORD-2026-08-03.md`). What remains
is a 47-document, TRI-screened rebuild. Reviewing 47 rows is an afternoon.

**0.2 A recorded verdict is NOT currently enforced.** There is no per-document
approval column anywhere in the schema, and no retrieval path reads one. If Chris
marks a document `WITHDRAW`, nothing in the running system acts on that. §3 is
therefore a blocker on _closing_ the gate, not a nice-to-have — it is the
"closing gate #1 needs code" note in `PILOT-LAUNCH-STATUS.md` made specific.

**0.3 A re-sync silently undoes the audit.** Delta cursors are intact and the
ingest-time content-boundary gates are unbuilt, so one `POST /sources/:id/sync`
re-imports the purged material. Nothing triggers this automatically — the only
pg-boss schedules are the weekly digest and the hourly audit shipper — but
nothing _prevents_ it either. See §4.

---

## 1. What the machine has already decided

Do not spend reviewer attention re-checking these. Measured 2026-10-02 against a
restored copy of the `2026-10-01T080156Z` nightly backup:

| Fact                                                 | Value               |
| ---------------------------------------------------- | ------------------- |
| Documents in the index                               | **47**              |
| Chunks                                               | **210**             |
| Sources                                              | **1**               |
| Documents whose body contains an SSN-shaped string   | **0**               |
| Documents whose body contains an EIN-shaped string   | **0**               |
| Document titles containing an SSN/EIN-shaped string  | **0**               |
| Documents whose body names an IRS form (`Form NNNN`) | **9**               |
| Source `data_class`                                  | `general` (Class A) |
| `documents.lifecycle_status`                         | `active` on all 47  |
| `documents.content_type`                             | **NULL on all 47**  |

Two of those rows deserve comment.

**The 9 IRS-form documents are not a defect.** They are the population that trips
the TRI generation pre-flight (finding C-1 — a prompt naming an IRS form near a
dollar figure used to return a 500). A reviewer should know which rows those are,
which is why the worksheet flags them, but the flag means "this document
interacts with a known guard", not "this document is risky".

**`content_type` is NULL on all 47, so it gates nothing.** It is a
`USER-DEFINED` enum column that no ingested document has ever been given a value
for. Do not mistake its presence in the schema for a working classification.

---

## 2. The audit itself

### 2.1 Generate the worksheet

```bash
# Point this at a RESTORED COPY of a nightly backup, not production.
# docs/BACKUP-SCHEDULE-RUNBOOK.md §"Restore from a scheduled artifact" has the
# restore procedure; doing it this way makes every audit double as a restore drill.
node scripts/gate1-content-audit.mjs --url postgresql://rag:drill@localhost:55433/rag
```

Why a restored copy rather than production: production `DATABASE_URL` resolves
`rag-postgres.railway.internal`, which does not resolve outside Railway's
network, and `rag-postgres` deliberately exposes no public URL. That constraint
is a feature — read-only audit work has no business touching the live database.

⚠ **The worksheet must never be committed.** It holds document titles and
SharePoint paths. The TRI scanner screens document _bodies_; it makes no promise
about a title or a folder name, and whether those carry client-identifying
material is precisely the judgment being asked for. `.gitignore` excludes
`gate1-audit-*.md`, the generator refuses to write to a git-tracked path, and it
prints only aggregate counts — never a title — so a terminal transcript cannot
leak the corpus. PR #43 is the cautionary tale: a commit intended to remove the
client name from the repository, whose verifying gate never executed.

### 2.2 What the reviewer is deciding

For each row, one of:

| Verdict    | Means                                                           |
| ---------- | --------------------------------------------------------------- |
| `OK`       | Appropriate for every member of staff who can query the KB      |
| `WITHDRAW` | Remove from the index — see §3 for what that currently requires |
| `ASK`      | Needs a second opinion before either                            |

The question is **not** "does this contain an SSN" — the scanner answered that.
The question is the one only the firm can answer:

1. Would you be comfortable with any staff member reading this, verbatim, in an
   answer, with the document named as the source?
2. Does it identify a client, or make a client identifiable in context, even
   without a formal identifier? A matter name, an unusual fact pattern, or a
   one-client engagement letter all can.
3. Is it current? A superseded SOP that answers confidently is worse than no SOP.
4. Is it the firm's to expose — not a client's document, not licensed
   third-party material?

**Reviewers:** Chris and Doug. The audit is not closed on one signature; the
worksheet has a Reviewer column per row for that reason.

---

## 3. ⛔ The blocker — a verdict has nowhere to live

This is the part that needs code before the gate can close.

**What exists:**

| Surface                      | Granularity      | Honoured by retrieval?                                      |
| ---------------------------- | ---------------- | ----------------------------------------------------------- |
| `sources.data_class`         | **whole source** | Yes — ingest-time gate (`pipeline.ts`, `ClassBlockedError`) |
| `ingest_log.doc_class`       | per document     | **No** — it is a log, written after the fact                |
| `documents.lifecycle_status` | per document     | **No** — see below                                          |
| `documents.content_type`     | per document     | **No** — NULL on all 47                                     |

`lifecycle_status` is declared at `packages/db/src/schema.ts:164`
(`.notNull().default("active")`) and is referenced **nowhere else in the
codebase** — a grep across `packages/` and `apps/`, excluding tests and `dist/`,
returns that single schema line. It is an inert column.

So today, applying a `WITHDRAW` means deleting the document's rows by hand, and
the next sync brings it back (§4).

**Minimal change that makes the gate closable.** `lifecycle_status` is the right
home precisely because it already exists, already defaults to `active`, and is
read by nothing — so filtering on it is additive and cannot change behaviour for
any existing row:

1. Filter `documents.lifecycle_status = 'active'` in the retrieval join —
   `hybridSearch` in `packages/db/src/hybrid-search.ts`, both the dense and the
   sparse arm, or the sparse arm silently keeps serving withdrawn documents.
2. Give the ingestion pipeline a rule that an existing document already marked
   non-`active` is not resurrected by a re-sync — otherwise §4 defeats §3.
3. Regression test first, per `.claude/rules/tdd.md`: a withdrawn document must
   be absent from both retrieval arms, and must stay absent across a re-ingest of
   unchanged content.

This is deliberately _not_ a new approval table, a review workflow, or a
per-document ACL. Gate #1 needs "this document is not served any more" to be
expressible and enforced. Anything beyond that is a different project.

---

## 4. ⛔ The re-sync landmine

> Cursors are intact and the ingest-time gates are unbuilt, so one
> `POST /sources/:id/sync` undoes the purge.
> — `PILOT-LAUNCH-STATUS.md`

Until §3.2 lands, the audit is only as durable as everyone's memory not to press
sync. That is not a control. Two options, in preference order:

- **Preferred:** implement §3.2, so a withdrawn document stays withdrawn through
  a sync. The audit then survives the thing most likely to undo it.
- **Interim, if the pilot must proceed first:** make the sync route refuse for
  this source unless an explicit override is passed, and say why in the refusal.
  A guard that names its own reason is worth more than a comment in a runbook.

Either way this is a **precondition of the audit being meaningful**, not
follow-up work. An audit whose result one API call erases has not closed a gate.

---

## 5. Definition of done

Gate #1 is closed when all of:

- [ ] Every one of the 47 rows carries a Decision and a named Reviewer
- [ ] Every `ASK` has been resolved to `OK` or `WITHDRAW`
- [ ] §3.1 shipped — retrieval filters on `lifecycle_status`, with tests
- [ ] §3.2 (or §4's interim guard) shipped — a re-sync cannot resurrect a
      withdrawn document
- [ ] Every `WITHDRAW` applied **and** confirmed absent from a fresh query
      against the deployed system, not just from the database
- [ ] The sign-off block in the worksheet is complete, and the worksheet is
      stored wherever the firm keeps compliance records — **not in this repo**

The last two matter most. A verdict recorded but not applied, or applied but not
verified against the deployed system, is the failure mode this project has
already hit once: `check-file-sizes.mjs` reported "300 file(s) checked" and exit 0
while inspecting nothing, which is how the client name survived PR #43 for four
weeks. Confirm the absence; do not infer it.

---

## 6. What is measured here versus asserted

**Measured** (restored copy of the 2026-10-01 nightly backup, 2026-10-02): every
figure in §1, and the claim that `lifecycle_status` has no reader, which is a
grep result over `packages/` and `apps/`.

**Asserted from other documents, not re-verified here:** the 858-document purge
and its reasoning (`PURGE-RECORD-2026-08-03.md`); that `audit_log` shows no user
other than the operator ever queried the system; the C-1 TRI pre-flight finding.

**Not established:** whether any of the 47 documents actually warrants
withdrawal. Nobody has looked yet. The aggregate screens in §1 are evidence about
_identifier patterns_, and say nothing about client-confidential content — which
is the whole reason this gate is a human one.
