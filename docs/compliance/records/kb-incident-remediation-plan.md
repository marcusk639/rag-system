# Prompt — KB incident: remediation and prevention plan

**Purpose:** produce a plan for (a) containing the 2026-08-01/03 client-data
incident and (b) preventing recurrence. **Run in:** a fresh session with access
to `~/dev/rag-system` and `~/dev/cpa-consulting`. **Produces:** a plan document,
not changes.

> **Why this is a prompt and not a task list.** The facts below were established
> under time pressure across one long session, and at least three confident
> claims made during it turned out to be wrong. A plan built by re-reading the
> assertions would inherit the errors. This prompt is written to make the next
> agent **re-verify before planning**.

---

## The prompt

```text
You are the remediation lead for a data-handling incident in a small CPA firm's
internal knowledge-base system. You are an engineer, not a lawyer. Your job is to
produce a plan — not to execute it, and not to decide questions that belong to
counsel or to the firm's partner.

<context>
A retrieval system indexes a CPA firm's internal SharePoint knowledge base so
staff can ask it questions. In August 2026 a screen found client-identifying
material in the indexed corpus. What follows is what was believed true at the end
of the session that discovered it. TREAT EVERY LINE AS A CLAIM TO BE VERIFIED,
NOT AS FACT — several claims made during that session were later falsified by
checking.

Incident:
- 858 documents were indexed from SharePoint into Postgres (documents + chunks).
- A pattern screen flagged 355 of them. 316 of those merely NAME a tax form,
  which a tax SOP legitimately does. The serious subset was 17 documents with
  Social-Security-, employer-ID- or bank-account-shaped values, including one
  spreadsheet reported to hold 522 SSN-shaped values.
- All 858 documents were sent to a third-party embedding API (Google Gemini)
  before anyone screened them. COMPLIANCE_MODE was "none".
- Compliance regime in play: IRC §7216, Circular 230, GLBA. The firm's data
  classes are A/B (internal) and C/D (client-confidential).

Actions already taken (verify each — do not assume any of it held):
- Postgres `documents` and `chunks` were purged. `audit_log`, access grants and
  source config were deliberately preserved as evidence.
- A pre-purge manifest of all 858 documents was written to a gitignored path,
  recording per-document pattern hits and a severity ranking.
- Three ingestion guards were built: path-based structural exclusion, pattern
  redaction placed before the embedding call, and a per-document classification
  gate that fails closed.

Copies believed to still exist:
- Object storage holding original document files, under MORE THAN ONE source
  prefix — including at least one prefix whose source id no longer exists in the
  database, so a cleanup keyed off current sources would miss it.
- Several database dumps in the same bucket, taken before the purge.
- Provider-side volume backups on daily and weekly schedules.
- The third-party embedding provider's own systems.
</context>

<constraints>
These are binding. Violating any of them makes the plan worse than useless.

1. VERIFY BEFORE ASSERTING. Every factual claim in your plan must rest on a
   command you actually ran, and you must show that command. A check that finds
   nothing because the pattern was wrong looks identical to a clean result.

2. DO NOT DELETE ANYTHING. This is a planning task. Deletion is irreversible,
   the remaining copies are currently the only evidence of scope, and a
   disclosure question is open. Recommend; do not act.

3. SEPARATE "our copy is gone" FROM "the disclosure is undone". They are not the
   same, and conflating them is the single most likely way this plan misleads
   someone. Data sent to a third party cannot be retracted by deleting a local
   copy.

4. COUNSEL QUESTIONS ARE NOT ENGINEERING TASKS. Whether the disclosure is
   reportable, what retention applies, and whether notification is owed are for
   a lawyer. Identify them, frame them precisely, and stop. Do not estimate
   legal risk or reassure.

5. NO CLIENT NAMES IN TRACKED FILES. File paths in the source material contain
   real client names. Describe findings by pattern, count, and folder TYPE.
   Anything with a name in it stays in a gitignored location.

6. DO NOT INVENT NUMBERS. If a count is not something you measured, say it is
   unmeasured. Carry an explicit flag on anything you could not verify.

7. DISTINGUISH EVIDENCE FROM INFERENCE. "The bucket contains N objects" is
   evidence. "Therefore the originals are still exposed" is inference. Label
   which is which.
</constraints>

<method>
Work in phases. REPORT AT THE END OF EACH PHASE BEFORE CONTINUING — do not run
the whole thing silently.

Phase 1 — Inventory what exists, by measurement.
  Enumerate every location that may hold incident data: the database, object
  storage (every prefix, not just current sources), every backup artifact,
  provider-side snapshots, local development copies, and any exported analysis
  files. For each: what it holds, how much, and how you determined that.
  If you cannot reach a location, say so plainly rather than omitting it.

Phase 2 — Establish what is recoverable and what is not.
  Sort every item from Phase 1 into: (a) removable by us, (b) removable only by
  someone else, (c) not removable at all. Item (c) is the one that matters most
  and is the easiest to under-state.

Phase 3 — Identify the decisions, and who owns each.
  Some decisions are engineering. Some belong to the firm's partner. Some belong
  to counsel. Assign each explicitly. A plan that routes a legal question to an
  engineer, or a partner's decision to a lawyer, will stall.

Phase 4 — Prevention: what would have caught this earlier.
  Assess the guards already built against the real manifest, not against
  intentions — replay them over the recorded data and report how many of the
  serious documents each layer actually stops. Then identify what is still
  missing. Be specific about which failures each control does and does not
  address.

Phase 5 — Write the plan.
</method>

<output_format>
Produce a single markdown document with these sections:

## What is verified
Evidence only, each line with the command that produced it.

## What is still unknown
Anything you could not measure, and why. This section being empty is a red flag.

## Copies that still exist
A table: location | what it holds | measured size/count | removable by whom.

## What cannot be undone
Explicit and unhedged. If the answer is "the third-party disclosure", say it.

## Decisions required
A table: decision | owner (engineering / partner / counsel) | what it blocks |
what happens if it is deferred.

## Remediation steps
Ordered. Each step: what, who, how it is verified as done, and what it does NOT
achieve. Steps that destroy evidence must be marked as such and sequenced after
the counsel decision, not before.

## Prevention
What is already built and measured, what is missing, and — separately — what
process failure allowed an unverified assumption ("the corpus is internal-only")
to be published as fact. The technical controls are the easier half.

## Open risks
Ranked. Include anything you believe but could not prove.
</output_format>

<quality_controls>
- If you do not know something, say "unknown" and explain what would settle it.
  Do not fill gaps with plausible reasoning.
- Before finalising, re-read your own plan and remove any sentence you cannot
  point to a command or a quoted source for.
- If your verification contradicts anything in <context>, the verification wins.
  Say so explicitly and prominently — the context was written by someone working
  fast, and correcting it is the most valuable thing you can do.
- Do not reassure. A plan that reads as "this is under control" when the
  disclosure question is open is actively harmful to the person relying on it.
</quality_controls>

Begin with Phase 1. Show your commands.
```

---

## Techniques used, and why

| Technique                                                       | Why it is here                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Role + explicit non-role** ("engineer, not a lawyer")         | The dominant failure mode is an engineer answering a legal question with confident-sounding reassurance                         |
| **XML tags**                                                    | Keeps constraints from being read as background prose — they are the load-bearing part                                          |
| **Source limitation, inverted**                                 | Context is framed as _claims to verify_, not facts. Several confident claims in the original session were falsified by checking |
| **Show-the-command requirement**                                | A failed check and a clean result are indistinguishable without it                                                              |
| **Phased with reporting between** (prompt chaining)             | Prevents a silent sweep that reaches a conclusion nobody can audit                                                              |
| **Permission to say "unknown"** + "empty section is a red flag" | Makes admitting a gap the expected behaviour rather than a failure                                                              |
| **"Verification wins over context"**                            | Explicitly authorises contradicting the prompt author, which is the highest-value output available                              |
| **"Do not reassure"**                                           | Counteracts the strong pull toward a comforting summary on an incident with an open legal question                              |
| **Structural output spec**                                      | Forces the _cannot be undone_ and _decisions by owner_ sections to exist, since both are easy to omit                           |

## What this prompt deliberately does not do

**It does not authorise deletion.** Every remaining copy is currently evidence of
scope, and a disclosure question is open. The prompt plans; a human decides.

**It does not pre-judge the legal question.** It requires that the question be
framed precisely and handed to counsel — not estimated.

**It does not assume its own context is correct.** That is the main design
choice. The incident was discovered and partly mis-described in the same
session; a prompt that presented those descriptions as settled would propagate
the errors it exists to correct.
