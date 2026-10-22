---
title: Launch runbook
status: current
last_verified: 2026-10-21
verified_against: db0ceae
answers: How to carry out each human, legal and infrastructure launch item, by stable item number.
read_when: Working a launch gate or item, or following a code comment that cites "LAUNCH-RUNBOOK.md item N".
supersedes: [PILOT-MANUAL-RUNBOOK.md]
code:
  [
    packages/core/src/config-schema.ts,
    env.example,
    tests/e2e/src/eval/gold-set.ts,
    apps/worker/src/handlers/docs-gap-digest.ts,
    packages/db/drizzle/meta/_journal.json,
  ]
---

# Launch runbook

This runbook holds the procedures for launch items that need a person: a business or legal decision, production
access, or someone else's domain expertise (Chris's, Doug's, counsel's). Code can't close any of them, and an agent
shouldn't decide them for the operator. Status, owners and blockers live in [`LAUNCH-STATUS.md`](./LAUNCH-STATUS.md).
This file says how to do the work. Item numbers are stable: code cites items 5 and 8 (`env.example`,
`packages/core/src/config-schema.ts`). Completed items are short outcome notes. People and gate numbers are defined
in [`GLOSSARY.md`](../GLOSSARY.md). Nothing here is legal advice; item 2 exists because the firm needs real legal
advice.

## P0: hard gates

Until these close, the system stays an internal pilot for named users.

### 1. Audit what is indexed

**Outcome:** Chris gave verbal sign-off on 2026-10-02 after reviewing the 47-row worksheet. Withdrawal verdicts are
enforced in retrieval. The procedure and record are in
[`compliance/GATE-1-CONTENT-AUDIT.md`](../compliance/GATE-1-CONTENT-AUDIT.md).

**Remaining step:** get the written sign-off (reviewer name and decision per row) and store it outside this repo, as
`GATE-1-CONTENT-AUDIT.md` describes. Repeat the audit for any new documents after item 3a's re-sync.

Done when: the written per-row sign-off exists outside the repo, and gate 1 in `LAUNCH-STATUS.md` says so.

### 2. Get counsel review and notify the carrier

**Why:** §7216 carries criminal penalties, Circular 230 violations can mean suspension from IRS practice, and GLBA
violations bring FTC enforcement. Chris's content sign-off doesn't cover this. The Gemini DPA is **billing verified
2026-08-04** (Cloud DPA terms apply). Counsel hasn't reviewed whether that standard, non-negotiated DPA is adequate for
this practice, and CR-3 data residency is unconfirmed
([`compliance/vendor-dpa-google-gemini.md`](../compliance/vendor-dpa-google-gemini.md)).

**Steps:**

1. Find a tax-practice attorney. Ask Chris who the firm uses. A §7216 and Circular 230 specialist is better than
   general business counsel.
2. Send them the scope contract (`~/dev/cpa-consulting/docs/rag/compliance-scope.md`), the partner review
   (`~/dev/cpa-consulting/deliverables/kb-bot-partner-review.md`), the engineering conformance record
   ([`compliance/scope-conformance-2026-09-30.md`](../compliance/scope-conformance-2026-09-30.md)) and the DPA record.
   Ask in writing:
   - Is the standard Google Cloud DPA adequate for this practice's §7216 and GLBA risk profile, or is a negotiated
     agreement needed?
   - Does CR-3 (where Gemini processes data) need a regional endpoint?
   - Does anything in the architecture need to change to be defensible?
   - What retention window should the query audit log have (feeds item 8)?
   - Will they sign off, in an email or short memo rather than a call?
3. Call the firm's professional-liability carrier. Describe the system accurately: an internal assistant answering
   staff questions from firm SOPs, with every query audit-logged. Say that an earlier corpus was found to contain
   client identifiers and was purged on 2026-08-03, and that the current index is TRI-screened at ingest. Ask whether
   the policy requires disclosure, and get the answer in writing (a follow-up email restating the call is enough).
4. Record the outcome. `vendor-dpa-google-gemini.md` is an evidence record, so don't edit its status line. Append a
   `## Amendment YYYY-MM-DD` block naming the attorney, the date and the conclusion. Then update gate 2 in
   `LAUNCH-STATUS.md`.

Done when: written answers from both counsel and the carrier exist, and the DPA record carries the amendment.

### 3. Verify the database backup and restore path

**Outcome:** done for the restore leg. A restore was proven from a scheduled nightly artifact on 2026-10-02, and to a
chosen second via pgBackRest on 2026-09-02. The remaining work (the off-Railway copy, which needs Chris's admin
consent, and the `HEARTBEAT_URL` dead-man's switch) has its procedures in
[`operations/BACKUP-AND-RECOVERY.md`](../operations/BACKUP-AND-RECOVERY.md#open-items).

Done when: both open items there are closed.

### 3a. Point the Microsoft 365 credentials at a SharePoint-licensed tenant, then re-sync

The procedure is in
[`operations/SHAREPOINT-RUNBOOK.md` → Switching tenants and re-syncing](../operations/SHAREPOINT-RUNBOOK.md#switching-tenants-and-re-syncing).
Why it gates launch, and its owners, are in [`LAUNCH-STATUS.md`](./LAUNCH-STATUS.md#gate-3a-sharepoint-licence-and-re-sync).

## P1: close before a second real user

### 4. Deploy the staff surfaces

**Outcome:** the web app has been live and auth-gated since 2026-08-01. The Teams bot is blocked on an Azure
subscription; its blockers and owners are in
[`LAUNCH-STATUS.md`](./LAUNCH-STATUS.md#teams-bot-gate-item-4). The deploy procedure for both surfaces, including the
Teams package, smoke test and day-one traps, is
[`operations/FRESH-DEPLOY-GUIDE.md` Appendix A](../operations/FRESH-DEPLOY-GUIDE.md#appendix-a-web-and-teams-entra-and-azure-detail).

Ask the tenant admin about the custom-app upload policy now, separately from the subscription. It has different
owners and urgency, and it is the one answer that could change the plan.

Done when: the Teams definition of done in `LAUNCH-STATUS.md` is met.

### 5. Decide the audit-log content and docs-gap digest privacy tradeoff

**Why:** by default the audit log keeps only a one-way `question_hash` of each question
(`AUDIT_LOG_CONTENT=none`; `auditLogContent` in `packages/core/src/config-schema.ts`). Nobody, even with full
database access, can recover what was asked. The weekly docs-gap digest (`apps/worker/src/handlers/docs-gap-digest.ts`,
shown at `/admin/docs-gap-digest`) is aggregate-only: it counts weak-result queries by endpoint and source group and
never reads the hash. The version promised to Chris ("top unanswered question was X") needs the question text, which
reverses a deliberate privacy decision.

`AUDIT_LOG_CONTENT=full` keeps question and answer text in `audit_log`. It governs retention only. Text is never
shipped to the audit sink, because disclosing it to a third-party collector is a separate §7216 decision.

**Steps:**

1. Weigh whether keeping question text is acceptable for firm-internal SOP questions. Middle grounds: keep text only
   for weak-result questions, use a shorter retention window for text, or require staff to opt in before their
   unanswered question is shown.
2. Decide, and write the decision into gate 5 in `LAUNCH-STATUS.md`.
3. If the answer is to keep text: set `AUDIT_LOG_CONTENT=full` on `rag-api` and `rag-mcp` (both write audit rows from
   their search and ask paths), and scope the
   digest change (surfacing text for weak-result events only) as its own engineering item in
   [`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md). Decide item 8's retention window at the same time.
4. If the answer is no: the aggregate digest is the permanent design. Recalibrate how the "Friday digest" is described
   to the partners so it matches what ships.

Done when: the decision is recorded and, if it is "keep text", the follow-up is filed.

### 6. Run the Phase 1 baseline diary

**Why:** the $20–30K/yr value estimate quoted to Chris is labelled `[NEW — UNVALIDATED]` in the firm's planning docs.
Only a before-and-after measurement can test it. Once anyone uses the bot instead of interrupting Chris, the "before"
can't be reconstructed. That makes this a P0-timing constraint even though it is filed under P1.

**Steps:**

1. Before Doug's first real session, have Chris keep a diary for one full week. He logs every staff interruption with a
   question an SOP could answer. A rough count is enough, in whatever form is least effort for him.
2. Separately, time 3 to 5 staff on a "find the BOI SOP" exercise (or similar) without the bot.
3. After a few weeks of pilot use, repeat both measurements and compare.

Done when: one week of baseline data exists, and that week ended before Doug's first real use.

## P2: worth doing, not blocking a tightly scoped pilot

### 7. Build the retrieval-eval gold set with Doug

**Why:** every retrieval-tuning decision (the reranker on/off call, RRF weights, chunk size) and any faithfulness check
on real questions waits on this. The existing eval corpora (`tests/e2e/src/eval/corpus.ts`, 17 questions, and
`corpus-cpa.ts`, 20 questions) are synthetic. The 2026-08-01 real-embedder run on them showed a flat weight sweep;
see [`evaluation/EVALUATION.md`](../evaluation/EVALUATION.md). The gold set (`GOLD_QUESTIONS` in
`tests/e2e/src/eval/gold-set.ts`) is still empty, and `pnpm eval:gold` refuses to run until it isn't. Treat this as
P1 in practice.

**Steps:**

1. Schedule the session with Doug. Prefer a date after item 3a's re-sync, so the set scores the current parse.
2. Run it, record the questions in `GOLD_QUESTIONS`, and score them with `pnpm eval:gold`, all as described in
   [`evaluation/EVAL-GOLD-SET-GUIDE.md`](../evaluation/EVAL-GOLD-SET-GUIDE.md). Keep the set free of client names,
   identifiers and real client tax positions.
3. Only then revisit the reranker decision and weight tuning with the numbers (tracked in
   [`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md)).

Done when: `GOLD_QUESTIONS` holds the reviewed set and `pnpm eval:gold` has produced a recorded result.

### 8. Decide where off-host audit logs ship and how long to keep them

**Why:** the shipping mechanism exists, but "off-host" means nothing until a destination is chosen. Separately, the
`audit_log` table grows without bound until a retention window is set.

**Steps:**

1. Pick a destination, or explicitly choose "not yet". In rough order of effort: a log aggregator that accepts a
   webhook; a private Teams or Slack channel via incoming webhook, for a human-readable stream; or nothing for now, if
   the pilot is small enough that the database plus backups (item 3) cover "don't lose it".
2. If you pick one, set `AUDIT_SINK_PROVIDER`, `AUDIT_SINK_WEBHOOK_URL` and optionally `AUDIT_SINK_WEBHOOK_TOKEN`.
   `AUDIT_SINK_CRON` and `AUDIT_SINK_TZ` set the schedule (hourly UTC by default). Add the webhook's host to
   `EGRESS_ALLOWED_HOSTS`, or every ship attempt throws. Rows carry real Entra object ids. See the annotations in
   `env.example`.
3. Decide the retention window. §7216 and Circular 230 don't set a minimum for an internal tool-usage log the way they
   do for return records, so this is a firm-policy call; ask counsel during item 2. Backup retention is set separately
   ([`BACKUP-AND-RECOVERY.md`](../operations/BACKUP-AND-RECOVERY.md#retention)) and doesn't answer this question.
4. Record both decisions in gate 8 in `LAUNCH-STATUS.md`. A scheduled purge of rows older than the window is a small
   engineering follow-up; file it in [`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md) once the window is chosen.

Done when: a destination (or "not yet") is chosen and configured, and a retention window is recorded, even if it is
"keep everything; revisit at N months".

### 9. Decide build-vs-buy for the document classifier

**Why:** a classifier for document type (SOP, template, research memo) with a confidence-gated approval queue is a
multi-day ML build. The firm's evaluation
(`~/dev/cpa-consulting/docs/rag/evaluations/document-classification-automation.md`) frames it as Slice A (build)
versus Slice B (buy SurePrep or GruntWorx). Those products classify and extract client tax documents, a bigger
problem than document type, so the comparison may be lopsided. A cross-repo `DocumentClassifier` design was explored
on 2026-07-11 and deferred as not required for launch. UNVERIFIED: its spec is no longer at
`cpa-consulting/docs/superpowers/specs/2026-07-11-classifier-migration-design.md` as of 2026-10-21.

**Steps:**

1. Re-read the evaluation, and confirm both options solve the problem actually needed here.
2. If "build", schedule a separate design and planning pass; don't fold it into unrelated work.
3. If "buy" or "defer", record that in gate 9 in `LAUNCH-STATUS.md` so it reads as deferred, not dropped.

Done when: a decision is recorded.

### 10. Reset the shared local dev Postgres container

This is local-dev hygiene only. It doesn't touch production.

**Why:** on 2026-07-11, `pnpm --filter @rag/db test` and e2e runs against the local `rag-postgres` container reported
missing tables that the migration journal claimed were applied. The root cause is how Drizzle decides what to apply.
It reads one watermark, the highest `created_at` in `drizzle.__drizzle_migrations`, and applies only migrations whose
journal `when` is greater (`PgDialect.migrate` in `drizzle-orm`). It never checks per-migration hashes. A migration
whose `when` sits below the watermark is skipped forever, even if it never ran. This container's watermark sat above
the `when` of `0012_staff_source_assignments` and `0013_docs_gap_digest_runs`, both missing. Its lineage was also mixed
with an unmerged branch (`feat/kb-governance-phase5-staleness-archive`) migrated against the same container.

Re-running `pnpm db:migrate` doesn't fix it. `0015_add_git_markdown_source_kind.sql` adds an enum value with no
`IF NOT EXISTS`, the value already exists under the mixed lineage, and Drizzle runs every pending migration in one
transaction, so the failure rolls the whole run back.

The journal-ordering half of the follow-up is done: `packages/db/src/migration-guard.test.ts` fails when a journal
`when` isn't strictly greater than the previous entry's. Why the journal is gated this way is recorded in
[`architecture/DECISIONS.md`](../architecture/DECISIONS.md).

**Steps:**

1. Confirm nobody sharing this machine's Docker state needs the container. On 2026-07-11 it held only dev noise
   (1 source, 1 document, 1 chunk, 275 audit rows). That is your call, not an agent's.
2. Wipe it: `pnpm docker:down`, remove the Postgres volume, `pnpm docker:up`. Or drop and recreate the `rag` database
   inside the container.
3. Run `pnpm db:migrate` against the empty database.
4. Optional: use `ADD VALUE IF NOT EXISTS` in future enum-extending migrations.

Done when: `\dt` lists every expected table and `pnpm e2e` passes against this container.

UNVERIFIED: whether the reset has already been done since 2026-07-11. Running `\dt` on the container would settle it.
