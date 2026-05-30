# BOI Filing SOP — Internal

> **SYNTHETIC SAMPLE.** This document is fabricated for demo purposes. It is NOT the firm's real BOI procedure. Replace with the actual SOP from SharePoint before any production use.

**Document type:** SOP
**Owner:** Doug
**Last reviewed:** 2026-04-12

## Scope

This SOP covers the firm's process for filing Beneficial Ownership Information (BOI) reports under the Corporate Transparency Act (FinCEN reporting). Covers initial reports, updates, and corrections.

## When BOI applies

A BOI report is required for:

- Domestic reporting companies (LLCs, corporations, certain other entities) created by filing with a Secretary of State
- Foreign reporting companies registered to do business in the U.S.
- Filing deadlines depend on the entity formation date — see table below

## Filing deadline table

| Entity formed                                 | Initial BOI due                |
| --------------------------------------------- | ------------------------------ |
| Before 2024-01-01                             | 2025-01-01 (transitional rule) |
| In 2024                                       | Within 90 days of formation    |
| In 2025 or later                              | Within 30 days of formation    |
| Any update (ownership change, address change) | Within 30 days                 |

## Process — new entity formed in 2024 or later

1. **Trigger.** Engagement letter calls out BOI as a deliverable, OR client notifies us of formation. Front-desk admin opens a Karbon work item from the **BOI Filing** template.
2. **Information gathering.** Send the client our BOI intake questionnaire (Karbon Client Request template `boi-intake-v3`). We need full legal names, dates of birth, residential addresses, and an acceptable identifying document (passport, driver's license, state ID) for every beneficial owner and company applicant.
3. **Document scan.** Beneficial-owner ID documents are uploaded to SharePoint under `clients/{client_id}/boi/` — folder must NOT be in the firm-wide search index per the firm's GLBA program.
4. **Filing.** Submit through FinCEN's BOI E-Filing portal. The firm has FinCEN Identifiers on file for our preparers; use Doug's FinCEN ID for the preparer field unless otherwise specified.
5. **Confirmation.** Save the BOI ID and confirmation receipt to SharePoint; record the BOI ID on the client's Karbon "Entities" custom field for future updates.
6. **Time coding.** Use Karbon code **`BOI-FILE`** for initial reports, **`BOI-UPDATE`** for updates. Do NOT use the generic "Compliance" code.

## Process — update or correction

1. Open the existing BOI work item OR create a new one from the **BOI Update** template (`boi-update-v2`).
2. Pull the prior filing from SharePoint to see what's changing.
3. Submit the update through the FinCEN portal — note that updates require the prior BOI ID.
4. Update the Karbon "Entities" custom field with the new submission date.

## Common questions

- **Q: Does a single-member LLC need to file?** Yes, unless it qualifies for one of the 23 exemptions (most don't). Default position: file.
- **Q: What if the client refuses to provide owner ID documents?** Escalate to the engagement partner. We will not file without acceptable documentation; we will issue a disengagement letter if the client persists.
- **Q: What about trusts as beneficial owners?** Look through to the trust's beneficiaries who meet the >25% ownership or substantial-control threshold. See Doug's research note `boi-trust-ownership-2025.md` in firm-research.

## Billing

Flat fee of $350 per initial filing; $150 per update. See the firm's pricing matrix for volume discounts.

## Compliance notes

This SOP is internal-only and does NOT contain client identifiers. Any work-product associated with a specific client lives in `clients/{client_id}/` and is excluded from the firm-wide index per GLBA scope.
