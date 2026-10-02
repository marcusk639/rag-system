# P0 gate #1 — content audit: how to actually close it

**Written:** 2026-10-02 · **Status:** procedure defined, **enforcement shipped**
(§3), audit not yet run — it is now a review task with no code blocking it

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

**0.2 A recorded verdict IS now enforced** (changed 2026-10-02; this read "is NOT" when written hours earlier). There is no per-document
approval column anywhere in the schema, and no retrieval path reads one. If Chris
marks a document `WITHDRAW`, nothing in the running system acts on that. §3 is
therefore a blocker on _closing_ the gate, not a nice-to-have — it is the
"closing gate #1 needs code" note in `PILOT-LAUNCH-STATUS.md` made specific.

**0.3 A re-sync no longer undoes a withdrawal** (changed 2026-10-02), though it still re-imports purged _other_ material. Delta cursors are intact and the
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

## 3. ✅ Enforcement — shipped 2026-10-02

When this document was first written hours earlier, §3 was a blocker: a verdict
had nowhere to live and nothing would honour it. That is now built.

**What was true then.** `sources.data_class` gates whole sources at ingest;
`ingest_log.doc_class` is a log written after the fact; `documents.content_type`
is NULL on all 47; and `documents.lifecycle_status` — declared at
`packages/db/src/schema.ts:164` with `.default("active")` — was referenced
nowhere else in `packages/` or `apps/`. An inert column.

**3.1 Retrieval now filters it.** `hybridSearch` carries a mandatory, non
caller-overridable `AND doc.lifecycle_status = 'active'`
(`packages/db/src/hybrid-search.ts`). There is deliberately no option to disable
it.

> **Correction to what this section said earlier.** It claimed the filter had to
> be applied to "both arms, or the sparse arm silently keeps serving withdrawn
> documents." That was wrong, and reading the query is what corrected it: the
> filter sits in the **final SELECT, after the RRF merge**, where the dense and
> sparse CTEs have already been fused and `documents` is joined — so one
> fragment covers both arms. Putting it inside the CTEs would instead defeat the
> HNSW index, which is why every other filter here is a post-filter too. The
> spec asserts the sparse path explicitly rather than trusting this reasoning.

**3.2 A re-sync cannot resurrect a withdrawal — by construction.** The
`upsertDocument` ON CONFLICT ... DO UPDATE SET list (`packages/db/src/queries.ts`)
is explicit and omits `lifecycle_status`, so neither an unchanged re-ingest nor an
edited document resets it. No new code was needed; what was needed was making the
invariant deliberate instead of incidental, so it now carries a comment saying
why the column must stay out of that list.

**3.3 Tests.** `tests/e2e/src/specs/lifecycle-withdrawn.spec.ts`, 5 specs against
a real Postgres. They live in e2e, not `packages/db`, because that package's unit
tests have no database — as `queries.access-control.test.ts` says of the sibling
source-id filter, the SQL enforcement "needs Postgres" and was otherwise
"verified by reading + typecheck". For a compliance gate, a unit test asserting a
SQL fragment is _present_ would pass whether or not it works.

Every spec asserts in both directions, so none can pass by retrieving nothing:

| Spec                                  | Guards                             |
| ------------------------------------- | ---------------------------------- |
| both retrievable while active         | the harness itself — the control   |
| withdrawn omitted, active kept        | §3.1                               |
| withdrawn omitted from the sparse arm | the one-fragment-covers-both claim |
| re-sync of **unchanged** content      | §3.2, no-op path                   |
| re-sync of **changed** content        | §3.2, ON CONFLICT UPDATE path      |

Verified by mutation, not just by passing: adding `lifecycle_status` to the
upsert SET list turns both re-sync specs red, and reverting turns them green
again. The tests are load-bearing.

**Eval:** `pnpm eval` after the change — recall@5 100%, MRR 1.000, nDCG@5 99.1%,
unchanged from baseline. Expected, since the eval corpus withdraws nothing; it
confirms the filter is a no-op when it should be, rather than quietly excluding
everything.

**Known tradeoff, deliberately taken.** The filter is NOT counted in the
`filtered` flag that triggers a retry at maximum candidate pool. Counting it
would make that flag always true, so every query returning fewer than `topK`
rows would retry — including the ordinary case of a corpus with fewer than
`topK` matches, which is exactly what the "unfiltered queries never retry" rule
exists to avoid. The cost: if a **large fraction** of a source is ever withdrawn,
withdrawn chunks can crowd the candidate pool and quietly reduce recall with no
retry. Acceptable while withdrawals are a handful of documents out of 47. If
withdrawals ever become bulk, count it and accept the retry cost.

---

## 4. The remaining re-sync exposure — narrower, not gone

§3.2 means a **withdrawn** document stays withdrawn. It does **not** mean a
re-sync is safe in general: the ingest-time content-boundary gates are still
unbuilt, so a sync can still re-import material from the 2026-08-03 purge that
was never in the index to be withdrawn in the first place.

> Cursors are intact and the ingest-time gates are unbuilt, so one
> `POST /sources/:id/sync` undoes the purge.
> — `PILOT-LAUNCH-STATUS.md`

So the standing instruction is unchanged — **do not re-sync until the
content-boundary phases land** — but the reason has narrowed. The audit's own
verdicts now survive a sync; what does not survive is the purge of everything
that was deliberately never re-ingested.

---

## 5. Definition of done

Gate #1 is closed when all of:

- [ ] Every one of the 47 rows carries a Decision and a named Reviewer
- [ ] Every `ASK` has been resolved to `OK` or `WITHDRAW`
- [x] §3.1 shipped — retrieval filters on `lifecycle_status`, with tests
- [x] §3.2 — a re-sync cannot resurrect a withdrawn document (held by
      construction + two specs + a mutation check)
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
