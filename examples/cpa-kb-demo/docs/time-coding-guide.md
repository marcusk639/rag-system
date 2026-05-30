# Time Coding Guide — Internal

> **SYNTHETIC SAMPLE.** This document is fabricated for demo purposes. Replace with the actual time-code list from Karbon before production use.

**Document type:** SOP
**Owner:** Doug
**Last reviewed:** 2026-05-10

## Why this matters

Time codes drive WIP calculations, billing, and capacity reports. The "Front Desk" code is for admin-front-desk work ONLY. If you are billing 8+ hours per week to "Front Desk" and you are not an admin, your timesheet is miscoded — and the partner reports show garbage.

Common miscoding patterns we've seen this year:

- Andrew choosing "Accounting" when working on tax returns
- Tax-return prep going into "Compliance" instead of the engagement code
- Catch-up bookkeeping being logged as "Bookkeeping" instead of "BK-Catchup" (these have different billing rates)

## Time code catalog

### Tax engagements

| Code           | Use for                                           |
| -------------- | ------------------------------------------------- |
| `1040-PREP`    | Individual return prep, all federal + state forms |
| `1040-REVIEW`  | Reviewer time on individual returns               |
| `1065-PREP`    | Partnership return prep (Form 1065 + K-1s)        |
| `1120-PREP`    | C-corp return prep (Form 1120)                    |
| `1120S-PREP`   | S-corp return prep (Form 1120-S)                  |
| `1041-PREP`    | Trust/estate income tax (Form 1041)               |
| `709-PREP`     | Gift tax (Form 709)                               |
| `EXT-FILE`     | Extension filings (Form 4868 / 7004)              |
| `AMENDED-PREP` | Amended return prep (any form)                    |

### Bookkeeping engagements

| Code          | Use for                                                   |
| ------------- | --------------------------------------------------------- |
| `BK-MONTHLY`  | Recurring monthly close work                              |
| `BK-CATCHUP`  | Catch-up bookkeeping (prior-period work) — DIFFERENT rate |
| `BK-REVIEW`   | Reviewer time on books                                    |
| `RECON`       | Bank/credit-card reconciliations                          |
| `ADJ-ENTRIES` | Adjusting entries / journal entries                       |

### Compliance & advisory

| Code         | Use for                                          |
| ------------ | ------------------------------------------------ |
| `BOI-FILE`   | Initial BOI report — see [BOI Filing SOP]        |
| `BOI-UPDATE` | BOI update or correction                         |
| `1099-PREP`  | 1099-NEC / 1099-MISC preparation                 |
| `W2-PREP`    | W-2 preparation                                  |
| `TAX-PLAN`   | Tax planning sessions and projections            |
| `IRS-NOTICE` | Responding to IRS / state notices                |
| `RESEARCH`   | Tax research — note the topic in the description |

### Internal

| Code         | Use for                                      |
| ------------ | -------------------------------------------- |
| `ADMIN`      | Internal admin work — NOT client billable    |
| `FRONT-DESK` | Reception / mail / phone — ADMIN ROLE ONLY   |
| `TRAINING`   | Training, CPE, internal learning             |
| `MEETING`    | Internal firm meetings                       |
| `SUPPORT`    | IT / system support work                     |
| `KB-WRITE`   | Writing or updating firm SOPs and KB content |

## Rules

1. **Always include a description.** Karbon enforces this technically as of the 2026 update. "Working on Smith file" is too vague — describe what work, not whose file.
2. **One engagement per time entry.** Don't combine prep time across two clients in a single line.
3. **Switching mid-session.** If you switch from prep to research on the same engagement, log two entries — the rates may differ.
4. **The FRONT-DESK code is restricted.** Only Andrea, Pat, and the partners may log time to FRONT-DESK. If you're logging here and you're not in that list, your manager will reclassify your entry next Friday.

## What the partner report flags every Friday

- Entries with missing descriptions
- Entries to FRONT-DESK by non-front-desk staff
- Entries logged to the wrong engagement type (e.g., 1040-PREP on an engagement marked as 1065)
- Entries logged >7 days after the work was performed

## Common questions

- **Q: I'm doing catch-up bookkeeping for a tax client — which code?** `BK-CATCHUP`. Catch-up is billed at a different rate than monthly. Don't use `1040-PREP`.
- **Q: I'm waiting for client information — how do I log that?** Don't. Logging idle time as billable is fraud. Use `ADMIN` if you genuinely have nothing else to do, OR pick up something from the parked-work list.
- **Q: I'm in a meeting about a client. Billable or non-billable?** Internal meeting about an engagement = MEETING (non-billable). Meeting WITH the client = the engagement code, with a meeting description.
