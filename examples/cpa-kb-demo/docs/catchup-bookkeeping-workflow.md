# Catch-up Bookkeeping Workflow

> **SYNTHETIC SAMPLE.** Fabricated for demo purposes.

**Document type:** SOP
**Owner:** Doug
**Last reviewed:** 2026-02-22

## When this SOP applies

The client comes to us with N months (often >12) of unrecorded transactions, requesting that we bring the books current. "I haven't done my books since [date]" is the canonical opener.

This is DIFFERENT from monthly recurring bookkeeping. The pricing is different, the workflow is different, and the time code is different — see [Time Coding Guide].

## Engagement scope

Before agreeing to any catch-up engagement, scope:

1. **Period covered.** Start month, end month, exact number of months.
2. **Number of accounts.** Bank accounts, credit cards, loans, merchant accounts. Each adds reconciliation work.
3. **Transaction volume estimate.** Pull a recent statement and count transactions × number of months. >2,000 transactions/month signals "needs the bookkeeping pod, not solo."
4. **Source documents available.** Bank statements only (we can work with this); bank PLUS receipts (faster, cleaner); receipts only (red flag — we can't reconcile).
5. **Tax-return tie-in.** If the catch-up is for a tax-return filing, the engagement letter must explicitly cover both.

## Pricing

Use the catch-up pricing matrix (separate document, `pricing-bookkeeping-2026.xlsx`). Quick estimates:

| Transaction volume | $/month-of-catchup         |
| ------------------ | -------------------------- |
| <200 tx/mo         | $250–$400                  |
| 200–500 tx/mo      | $400–$700                  |
| 500–1500 tx/mo     | $700–$1,400                |
| >1500 tx/mo        | Custom quote — engage Doug |

Catch-up is priced PER MONTH OF CATCHUP, not per month of work, even though we'll do it concurrently. This is a billing rule. Clients who push back: explain that we're recreating a year of decisions, not just running closes.

## Process

1. **Engagement letter signed.** Standard catch-up template with the scope items above.
2. **Document gather (Karbon Client Request `bk-catchup-docs-v4`).** Bank statements for every account, every month in scope. Credit-card statements same. Loan statements. Merchant statements (Stripe, Square). Prior-year tax return.
3. **QBO setup or import.**
   - If client has an active QBO: connect bank feeds, set the categorization rules document up.
   - If client has no QBO: create a fresh file, set the chart of accounts using our standard template (`coa-standard-2026.xlsx`).
4. **Categorize and reconcile, month by month.** Do NOT skip months. Do NOT batch-categorize across periods — the AJEs at month-end will be wrong.
5. **Reconcile every account every month.** Bank, credit card, every loan. If a balance doesn't tie, find the discrepancy before moving to the next month.
6. **Quarterly review checkpoints.** At the end of each calendar quarter in the catch-up range, do a mini-close: P&L review, balance-sheet sanity check, owner-equity tie-out.
7. **Final review by Doug.** Catch-up engagements are higher-risk for missed transactions; Doug reviews before declaring "current."
8. **Hand-off conversation.** Schedule a 30-min call with the client to walk through the cleaned books and recommend monthly recurring service going forward.

## Time coding

`BK-CATCHUP` for ALL hours on this engagement. Do NOT mix in `BK-MONTHLY` even if you're doing a monthly close for the most recent month — the entire engagement is catch-up until we close it out and convert.

## Common pitfalls

- **Owner draws miscategorized as expenses.** Always confirm with the client before booking any uncategorized cash withdrawal.
- **Personal expenses on business cards.** Pull these out as owner draws; flag in the engagement notes for the tax preparer.
- **Inter-account transfers booked as income.** Bank feeds often present a transfer as a deposit. Verify against the matching withdrawal on the other account before categorizing.
- **Loan principal vs. interest.** A loan payment is part principal (balance-sheet) and part interest (P&L). Get the loan amortization schedule.

## When to escalate

- Client cannot produce bank statements for >2 months in scope → DISENGAGE; we can't reconstruct what isn't documented.
- Client disputes our categorization in writing → STOP, escalate to Doug. We are documenting our position; we are not arguing.
- Discovery of unreported revenue or expenses with tax implications → STOP, escalate to engagement partner. This may trigger amended-return obligations.

## Related documents

- [Time Coding Guide]
- [1040 Intake Checklist] — when catch-up is tied to a 1040 engagement
