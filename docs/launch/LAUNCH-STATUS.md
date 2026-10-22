---
title: Launch status
status: living-tracker
last_verified: 2026-10-21
verified_against: db0ceae
answers: What the production index holds, which surfaces are live, and the status, owner and blocker of every launch gate.
read_when: Deciding whether the pilot can widen, picking up launch work, or answering "is gate N done?".
supersedes:
  [
    PILOT-LAUNCH-STATUS.md,
    TEAMS-MVP-REQUIREMENTS.md,
    PROTOTYPE-DELIVERY-OPTIONS.md,
  ]
code:
  [
    packages/core/src/config-schema.ts,
    scripts/check-kb-grounding.mjs,
    tests/e2e/src/eval/gold-set.ts,
    apps/teams-bot/manifest/manifest.json,
  ]
---

# Launch status

This is the single launch tracker. It answers what production holds today and where each launch gate stands. As of
2026-10-21 the system runs as an internal, named-user pilot on the web app. The index is intact (48 documents / 211
chunks) but can't be re-synced, because the Microsoft 365 tenant lost its SharePoint Online licence (gate 3a). Gate 2
(counsel and insurance-carrier sign-off) hasn't started. The Teams bot is blocked on an Azure subscription. Procedures
for every gate live in [`LAUNCH-RUNBOOK.md`](./LAUNCH-RUNBOOK.md), under the same item numbers. Open engineering issues
live in [`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md), not here. Gate numbers, people and classes are defined in
[`GLOSSARY.md`](../GLOSSARY.md).

## Production corpus and surfaces

### Index

| Fact                  | Value                                                                                                                       | Verified                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Size                  | **48 documents / 211 chunks** in 2 sources                                                                                  | Production query, 2026-10-20   |
| SharePoint source     | "Knowledge Base", `dbba75e2-cecb-41be-8998-4f923158f741`: 47 documents. Last good full sync 2026-09-02                      | 2026-10-21 (re-sync failed)    |
| Manual upload source  | "Manual Uploads", `b8e010f3-8b4b-4c6b-bf69-8cc639868fca` (`custom` kind, no connector): 1 document                          | 2026-10-20                     |
| Document class        | All Class A                                                                                                                 | 2026-09-07 (SharePoint docs)   |
| Embedding space       | 100% `gemini` / `gemini-embedding-001`                                                                                      | 2026-09-07                     |
| Ingest screen (09-02) | `ingest_log`: 94 `ingested` (2 runs × 47), 6 `tri-flagged`, 2 `blocked`. Patterns: `1099+amount` ×4, `W2+amount` ×2         | 2026-09-07                     |
| Delta cursor          | 5 drives, all carrying delta tokens                                                                                         | 2026-09-07                     |
| Not in production yet | Anything that changes documents only on re-ingest after 2026-09-02: `CONTENT_PROCESSING_VERSION` 2 (2026-09-16), #116, #142 | Inferred from the sync history |
| Connected systems     | SharePoint only. Nothing is connected to Onvio, the Z drive or QuickBooks                                                   | 2026-08-01                     |

**Do not "fix" the document count.** The earlier 858-document corpus was deliberately purged on 2026-08-03 because it
contained tax return information (TRI). The 47 SharePoint documents are the TRI-screened rebuild: the connector saw about
50 items and the scanner flagged or blocked 8. It is not an under-listing bug.

UNVERIFIED: the class of the manually uploaded 48th document. Its `ingest_log.doc_class` row (source `b8e010f3-…`)
would settle it.

### Deployed surfaces

| Surface         | State                                                                                          | Notes                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Web (`rag-web`) | Live and auth-gated since 2026-08-01 at `https://rag-web-production-1c0a.up.railway.app`       | Entra SSO; `RAG-Admins` group `33cdedd4-61cb-465e-afe2-f37045cf243c`. Registration detail: [FRESH-DEPLOY-GUIDE §A][fdg-a] |
| MCP (`rag-mcp`) | Live (operator use only, not staff-facing)                                                     | Domain in [`DEPLOYMENT.md`](../operations/DEPLOYMENT.md)                                                                  |
| Teams bot       | Code merged (`fe61ad7`, 2026-07-16); **not deployed**. `rag-teams-bot` didn't exist 2026-09-12 | See [Teams bot gate](#teams-bot-gate-item-4)                                                                              |

[fdg-a]: ../operations/FRESH-DEPLOY-GUIDE.md#appendix-a-web-and-teams-entra-and-azure-detail

`WEB_AUTH_MODE=static-fallback` is not set and must not be used to launch. It disables per-user auth and gives every
visitor one shared token.

UNVERIFIED: whether `rag-teams-bot` exists now. `railway status` would settle it.

## Gate status

P0 gates bound what the pilot may become. Until all are closed, the system stays an internal pilot for named users.
P1 items should close before a second real user; P2 items don't block a tightly scoped pilot.

| Gate                                    | Status                                      | Owner (role)                                         | Blocker                                                            | Evidence                                                                                                  | Last verified |
| --------------------------------------- | ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------- |
| P0 0: production TRI policy             | **Done.** `warn` on `rag-api` and `rag-mcp` | Operator (Marcus)                                    | None                                                               | [Gate 0 note](#gate-0-tri-policy-is-warn)                                                                 | 2026-09-07    |
| P0 1: content audit                     | **Verbal sign-off 2026-10-02**              | Tenant admin and partner (Chris)                     | Written per-row sign-off outstanding                               | [`GATE-1-CONTENT-AUDIT.md`](../compliance/GATE-1-CONTENT-AUDIT.md)                                        | 2026-10-02    |
| P0 2: counsel + carrier                 | **Not started**                             | Operator to engage; attorney and carrier decide      | No tax-practice attorney engaged; carrier not called               | [Gate 2 note](#gate-2-counsel-and-carrier)                                                                | 2026-10-21    |
| P0 3: backup and restore                | **Partly closed**                           | Operator; Chris for consent                          | Off-Railway copy needs admin consent; `HEARTBEAT_URL` unset        | [`BACKUP-AND-RECOVERY.md`](../operations/BACKUP-AND-RECOVERY.md)                                          | 2026-10-21    |
| P0 3a: SharePoint licence + re-sync     | **Blocked**                                 | Operator; target-tenant admin (IT)                   | Tenant has no SharePoint Online licence                            | [Gate 3a note](#gate-3a-sharepoint-licence-and-re-sync)                                                   | 2026-10-21    |
| P1 4: staff surfaces                    | **Web done 2026-08-01; Teams bot blocked**  | Chris / purchasing (subscription); operator          | No Azure subscription; tenant custom-app upload policy unknown     | [Teams bot gate](#teams-bot-gate-item-4)                                                                  | 2026-09-12    |
| P1 5: audit-log content privacy         | **Decision needed**                         | Operator, with Chris                                 | Decision: keep `AUDIT_LOG_CONTENT=none` (hash only) or retain text | [Runbook item 5](./LAUNCH-RUNBOOK.md#5-decide-the-audit-log-content-and-docs-gap-digest-privacy-tradeoff) | 2026-10-21    |
| P1 6: baseline diary                    | **Not started**                             | Chris (diary); operator (timing exercise)            | Must finish before Doug's first real use                           | [Runbook item 6](./LAUNCH-RUNBOOK.md#6-run-the-phase-1-baseline-diary)                                    | 2026-10-21    |
| P2 7: gold set                          | **Open.** `GOLD_QUESTIONS` is `[]`          | Domain reviewer (Doug), with operator                | Needs a session with Doug                                          | [Runbook item 7](./LAUNCH-RUNBOOK.md#7-build-the-retrieval-eval-gold-set-with-doug)                       | 2026-10-21    |
| P2 8: audit-log destination + retention | **Decision needed**                         | Operator (destination); firm and counsel (retention) | No destination chosen; retention window undecided                  | [Runbook item 8](./LAUNCH-RUNBOOK.md#8-decide-where-off-host-audit-logs-ship-and-how-long-to-keep-them)   | 2026-10-21    |
| P2 9: classifier build vs buy           | **Deferred**                                | Operator                                             | Nothing depends on it                                              | [Runbook item 9](./LAUNCH-RUNBOOK.md#9-decide-build-vs-buy-for-the-document-classifier)                   | 2026-10-21    |
| P2 10: local dev DB reset               | **Open** (local only)                       | Operator                                             | None                                                               | [Runbook item 10](./LAUNCH-RUNBOOK.md#10-reset-the-shared-local-dev-postgres-container)                   | 2026-07-11    |

"Last verified" is the date the status was checked against production or the record, not the date of this file.
Railway wasn't reachable on 2026-10-21, so production environment values (for example `GENERATION_TRI_POLICY`,
`AUDIT_LOG_CONTENT`, `AUDIT_SINK_PROVIDER`) carry their last recorded date.

UNVERIFIED (item 6): whether any staff member other than the operator has already used the system. An `audit_log`
query grouped by `principal_subject` would settle it. If someone has, the "before" baseline is already lost.

## Gate notes

### Gate 0: TRI policy is warn

`GENERATION_TRI_POLICY=warn` was set on `rag-api` and `rag-mcp` on 2026-09-07, by operator decision. The code default
is `block` on purpose (`packages/core/src/config-schema.ts`, the `triPolicy` comment): `warn` is a §7216 disclosure
decision, so a human has to choose it rather than inherit it. Production had never set the variable, so it ran `block`.

Measured with `scripts/check-kb-grounding.mjs` (51 questions, 0 errors in both runs):

| Measure                        | `block`       | `warn`            |
| ------------------------------ | ------------- | ----------------- |
| Answered                       | 33/51         | **51/51**         |
| Blocked by the TRI guard       | 18            | 0                 |
| Self-retrieval                 | 29/30 (96.7%) | **43/47 (91.5%)** |
| Correct out-of-corpus refusals | 3/3           | 4/4               |
| Invalid citations              | 0             | 0                 |

The self-retrieval rate fell while the result improved. Correct retrievals rose from 29 to 43; the denominator grew
from 30 to 47 because previously blocked questions began to count. Treat 91.5% as a lexical floor, not a quality score.

Why `block` failed a third of the questions: the guard scans the assembled generation input (question plus every
retrieved chunk). Only 3 documents carried a contextual trigger (`1099+amount` ×2, `W2+amount` ×1). The other 14
blocked documents were collateral: a clean document's question failed when a trigger chunk landed in its top-k. The
blocking span was the statutory threshold `"Less than $600"` in the firm's 1099 SOP, with no taxpayer, identifier or
personal amount.

What `warn` doesn't weaken:

- Identifying patterns (SSN, unformatted SSN, EIN; `TRI_IDENTIFYING_LABELS` in `packages/core/src/tri-scanner.ts`)
  throw under every policy (`896170e`, 2026-08-03; tightened by `19a7542`, 2026-08-31). A sweep of all 17 blocked
  documents found none. The sweep read stored, post-redaction markdown, which is what the model can receive, not the
  original SharePoint files.
- `warn` calls `onTriDetected` (`packages/rag/src/generation/generator.ts`), so every contextual hit is logged
  (`marker="generation.tri.warned"`, seen live 2026-09-07).
- `COMPLIANCE_MODE=client-data` forces `block` at wiring time, whatever this variable says.

**To revert:** set `GENERATION_TRI_POLICY=block` (or unset it) on `rag-api` and `rag-mcp`, then redeploy. Whether to
exempt known false positives among the identifying patterns is still undecided; see
[`specs/tri-identifying-pattern-exemptions.md`](../specs/tri-identifying-pattern-exemptions.md).

### Gate 1: content audit

Chris reviewed the 47-row audit worksheet and approved it verbally on 2026-10-02. A `WITHDRAW` verdict is enforced:
retrieval returns only `documents.lifecycle_status = 'active'` rows (`packages/db/src/hybrid-search.ts`). Still open:
the written sign-off, meaning reviewer name and decision per row, stored outside this repo. The procedure and the
record are in [`compliance/GATE-1-CONTENT-AUDIT.md`](../compliance/GATE-1-CONTENT-AUDIT.md). The TRI scanner catches
identifier patterns, not client-confidential content, so this gate stays a firm judgment. After 3a's re-sync, any new
document needs the same review.

### Gate 2: counsel and carrier

Chris's sign-off doesn't satisfy this gate. It needs a tax-practice attorney and the firm's professional-liability
carrier, and neither has reviewed anything. The Gemini DPA status is **billing verified 2026-08-04** (Cloud Billing
Tier 1, so the Cloud DPA's no-training and zero-retention terms apply). Counsel's adequacy review of that DPA and CR-3
data residency are both outstanding; see
[`compliance/vendor-dpa-google-gemini.md`](../compliance/vendor-dpa-google-gemini.md). The engineering evidence
prepared for counsel is [`compliance/scope-conformance-2026-09-30.md`](../compliance/scope-conformance-2026-09-30.md).
Procedure: [runbook item 2](./LAUNCH-RUNBOOK.md#2-get-counsel-review-and-notify-the-carrier).

### Gate 3: backup and restore

A restore is proven: from a scheduled nightly artifact on 2026-10-02, and to a chosen second via pgBackRest on
2026-09-02. What keeps the gate open: every backup layer lives in the same Railway project, the off-Railway copy is
blocked on Chris's admin consent, and `HEARTBEAT_URL` is unset, so nothing alerts if the nightly dump stops. The
`audit_log` retention window belongs to item 8. Layer-by-layer state and procedures:
[`operations/BACKUP-AND-RECOVERY.md`](../operations/BACKUP-AND-RECOVERY.md).

### Gate 3a: SharePoint licence and re-sync

On 2026-10-21 a full sync of `dbba75e2-…` failed at its first Graph call with
`400 BadRequest: Tenant does not have a SPO license.` The tenant in `MS_TENANT_ID` lost SharePoint Online some time
after the last good sync on 2026-09-02. Search and ask still serve the 2026-09-02 index.

Why it gates launch: the index can't reflect current SharePoint content, and the re-ingest-only fixes listed under
[Index](#index) never reach production documents. Closing it also fixes stale access config: principal `chris` is
scoped to three source ids that don't exist, so that principal sees nothing.

Owner split: the operator does the Railway, source and access work. Whoever administers the target tenant (IT) does
the app registration and admin consent. Procedure:
[`operations/SHAREPOINT-RUNBOOK.md`](../operations/SHAREPOINT-RUNBOOK.md#switching-tenants-and-re-syncing).

### Teams bot gate (item 4)

**Definition of done:** a named pilot user messages the bot in Teams with a real firm question and gets a cited answer
scoped to the sources they can access, and the query is recorded in `audit_log` with `channel = 'teams'`. Deployed or
merged doesn't count.

| Blocker                              | Owner (role)              | State                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Azure subscription                   | Chris / purchasing        | **Hard blocker.** An Azure Bot is an Azure resource and needs a subscription with a payment method. The F0 tier is free, so cost isn't the obstacle. `az` found no subscription on 2026-08-01 and 2026-09-12 |
| Azure Bot + Entra bot registration   | Operator, after the above | Produces `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_APP_TENANT_ID`, `BOT_ENTRA_SSO_SCOPE`, `BOT_OAUTH_CONNECTION_NAME`                                                                         |
| Tenant custom-app upload policy      | Tenant admin              | **Unverified.** Could change the plan, not just delay it. Ask early and separately from the subscription                                                                                                     |
| Real icons                           | Whoever owns branding     | `apps/teams-bot/manifest/color.png` (192×192) and `outline.png` (32×32) are still the 2026-07-16 placeholders                                                                                                |
| `rag-teams-bot` service + three URLs | Operator                  | Service not created. Teams validates the website, privacy and terms URLs at upload time                                                                                                                      |

UNVERIFIED: whether no subscription exists or the operator just holds no role on one. Only a tenant admin can tell, and
the answer changes who acts.

The custom-app question has two admin controls: the org-wide setting for custom apps and the per-user app setup
policy. If sideloading is off by policy, an admin can publish the package to the org catalogue scoped to a named group
instead. The manifest requests only `identity` and `messageTeamMembers`, declares `validDomains: []`, and uses scopes
`personal`, `team` and `groupChat` (`apps/teams-bot/manifest/manifest.json`).

**Alternative without a subscription:** wrap the web app as a Teams **personal tab**. A tab is a manifest pointing at
a hosted URL; only the conversational bot needs an Azure Bot resource. It needs the same custom-app permission, and
gives up @mentions and proactive messages. Not built.

Deploy steps, smoke test and day-one traps: [FRESH-DEPLOY-GUIDE Appendix A][fdg-a].

## Pilot scope guardrails

These are what make the current pilot defensible while gate 2 is open:

1. Named pilot users only: no firm-wide rollout, no self-service sign-up.
2. Class A sources only, and only all-staff SharePoint libraries. Per-document SharePoint permissions aren't enforced
   (tracked in [`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md)).
3. A written scope note for users: internal pilot, named users, not for client deliverables or filed positions.
   UNVERIFIED whether this note has been issued.
4. Audit logging on for every query.
5. No tax or accounting judgments. The system answers from documents and cites them.

**What would make it not defensible:** adding Onvio or client folders to the index, opening it past the named pilot
group, or letting output reach a client deliverable or a filed position. Any of those moves the system into §7216
territory, and gate 2 can no longer wait.

## Legal and process track

Firm-side compliance items outside these gates (naming the Qualified Individual, adding the system to the WISP, a staff
AI-limitations note, a breach-runbook reference, the GLBA penetration-test exemption by consumer-record count, and the
vendor register) are tracked in [`compliance/CONTROL-STATUS.md`](../compliance/CONTROL-STATUS.md).

## How we got here

- 2026-08-03: a screen of the 858-document corpus found client identifiers, and it was purged
  ([`PURGE-RECORD-2026-08-03.md`](../compliance/records/PURGE-RECORD-2026-08-03.md)).
- 2026-09-02: the 47-document TRI-screened rebuild synced. 2026-09-07: gate 0 set to `warn`.
- 2026-10-02: gate 1 verbal sign-off; restore from a scheduled artifact proven.
- 2026-10-21: the SharePoint licence loss was found (gate 3a). Earlier status text is in `archive/` and git history.
