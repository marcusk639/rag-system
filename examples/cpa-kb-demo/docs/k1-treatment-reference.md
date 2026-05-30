# Schedule K-1 Treatment Reference

> **SYNTHETIC SAMPLE.** This document is fabricated for demo purposes. Replace with Chris's actual research notes.

**Document type:** Research / Reference
**Owner:** Chris
**Last reviewed:** 2026-03-15
**Classification:** Class B (firm-internal research, no client identifiers)

## Purpose

When a 1040 client receives a Schedule K-1 from a partnership or S-corp, certain boxes require attention beyond a straightforward import. This document summarizes the firm's position on the boxes we see most often.

## Form 1065 K-1 — Boxes worth a second look

### Box 1 — Ordinary business income/loss

Standard pass-through; flows to Schedule E. Watch for **at-risk and passive activity loss limitations** — if box 1 is a loss and the client is a limited partner, run the basis worksheet before allowing the loss on the return.

### Box 13 — Other deductions (multiple codes)

This is the box that catches preparers off-guard. Codes seen most often:

- **Code W — Section 199A unadjusted basis information.** Carries to the QBI deduction calculation on Form 8995. Required for the deduction; missing W codes block the QBI claim. We've had cases where partnerships failed to report W; on those, contact the partnership for revised K-1s before filing.
- **Code A — Cash contributions (50%).** Charitable contributions through the partnership. Flow to Schedule A as itemized deductions.
- **Code H — Investment interest expense.** Subject to Form 4952 limits.
- **Code V — Section 743(b) negative adjustment.** Watch the partnership's prior-year basis worksheets.

### Box 13 Code W from MLPs (Master Limited Partnerships)

MLPs are a special case for code W:

- Most MLP investments are publicly-traded and held through a brokerage; clients often forget they have one until the K-1 arrives in April.
- The QBI deduction for MLPs is computed at the partnership level and reported per Form 8995-A. The MLP-source QBI does NOT combine with other QBI for aggregation purposes by default.
- State-source income from MLPs frequently triggers nonresident state returns we'd otherwise not file. Run the multi-state matrix when first seeing an MLP K-1.

The position the firm has historically taken: file the nonresident states even when below filing thresholds, because:

1. The states track the K-1 income separately and will issue notices regardless of threshold.
2. Composite-return elections (when available) are usually MORE expensive than filing individual nonresident returns for our client demographics.

Document the multi-state filing approach in the engagement letter so the client understands the additional state-return preparation cost upfront.

### Box 20 — Other information (multiple codes)

- **Code Z — Section 199A information.** Same QBI flow as 13W; sometimes both appear.
- **Code AC — Gross receipts for §59A(e).** Base Erosion and Anti-Abuse Tax; rarely affects our client mix but flag if you see it.

## Form 1120-S K-1 — Boxes worth a second look

### Box 17 — Other information (S-corp version)

- **Code V — Section 199A information.** S-corp QBI flow.
- **Code AC — Excess net passive income.** Triggers the §1375 tax — we route these to Chris for review.

## Internal escalation triggers

Send to Chris for review if you see any of:

- A Box 13 code we haven't covered above
- A K-1 from a foreign partnership (Form 8865 considerations)
- A negative §743(b) adjustment greater than the partner's outside basis
- A K-1 reporting losses while the client's basis is at zero (loss is suspended; document carryforward)
- A K-1 with Box 20 Code N (Business interest expense — §163(j) limit considerations for partnerships >$30M gross receipts)

## Related firm documents

- [BOI Filing SOP] — When a partnership client forms a new entity
- [1040 Intake Checklist] — K-1 expected vs. K-1 received reconciliation
