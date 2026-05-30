# Karbon Template Catalog

> **SYNTHETIC SAMPLE.** Fabricated for demo purposes; replace with the actual Karbon export.

**Document type:** Reference
**Owner:** Marcus (Karbon admin during engagement)
**Last reviewed:** 2026-05-15

## Purpose

The firm uses Karbon templates to standardize work-item creation. When you open a new engagement, you should be selecting from this catalog — not building a one-off work item from scratch.

## Tax engagement templates

| Template name                  | When to use                     | Default sub-items                                      |
| ------------------------------ | ------------------------------- | ------------------------------------------------------ |
| `1040-individual-v8`           | Individual tax return           | Intake → Prep → Review → Client review → E-file        |
| `1040-individual-extension-v3` | 1040 extension only (file 4868) | Intake → File extension → Reminder for Sept 15         |
| `1065-partnership-v6`          | Partnership return              | Intake → Prep → K-1 distribution → Final return        |
| `1120-ccorp-v4`                | C-corp return                   | Same skeleton as 1065 with C-corp-specific intake      |
| `1120s-scorp-v5`               | S-corp return                   | Same skeleton, S-corp-specific intake                  |
| `1041-trust-v3`                | Trust/estate income tax         | Intake → Prep → K-1 distribution                       |
| `amended-return-v2`            | Any amended return              | Reason documentation → Prep → Review → Client sign-off |

## Bookkeeping templates

| Template name             | When to use                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `bk-monthly-recurring-v7` | Monthly recurring bookkeeping engagement                                      |
| `bk-catchup-v4`           | Catch-up engagement (see [Catch-up Bookkeeping Workflow])                     |
| `bk-cleanup-onetime-v2`   | One-time cleanup of an existing QBO (not catch-up; current period correction) |

## Compliance / one-off templates

| Template name             | When to use                               |
| ------------------------- | ----------------------------------------- |
| `boi-initial-filing-v3`   | Initial BOI report (see [BOI Filing SOP]) |
| `boi-update-v2`           | BOI ownership/address update              |
| `1099-prep-batch-v4`      | Annual 1099 prep (run in January)         |
| `w2-prep-batch-v3`        | Annual W-2 prep (run in January)          |
| `irs-notice-response-v5`  | Responding to IRS / state notices         |
| `tax-planning-session-v2` | Q4 tax planning meetings                  |

## Client request templates (sub-templates referenced inside the engagements above)

| Template name          | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `1040-intake-v6`       | Annual 1040 intake; see [1040 Intake Checklist] |
| `boi-intake-v3`        | BOI beneficial-owner information request        |
| `bk-catchup-docs-v4`   | Catch-up bookkeeping document gather            |
| `1099-payee-info-v2`   | 1099 vendor W-9 collection                      |
| `engagement-letter-v9` | Generic engagement letter — current year        |

## Rules

1. **Use the template, don't build from scratch.** One-off work items skip the audit-trail and metric capture we depend on. If the template doesn't fit, change the template — don't bypass it.
2. **Version numbers in the template name are intentional.** A `1040-intake-v5` vs `v6` look the same to staff but have different validation rules. Always pick the highest-versioned active template.
3. **Karbon-template changes go through Doug.** If you think a template needs updating, write up the change and Slack Doug. Doug owns this catalog.
4. **Removed templates.** If a template is missing here that you see in Karbon, it's deprecated — DO NOT USE IT. Active templates only.

## Karbon API access

Marcus has a read-only API key for the Karbon admin endpoints. This is used by the firm's KB bot to keep this catalog in sync with the actual Karbon template definitions. The sync runs nightly; if you see a divergence, refresh the catalog from Karbon first before reporting.

## Related documents

- [Time Coding Guide] — codes referenced inside template work items
- [BOI Filing SOP]
- [1040 Intake Checklist]
- [Catch-up Bookkeeping Workflow]
