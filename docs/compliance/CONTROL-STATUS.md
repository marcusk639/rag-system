---
title: Compliance control status
status: living-tracker
last_verified: 2026-10-21
verified_against: db0ceae
answers: Where each control CR-1..CR-20 stands today (enforced in code, production config, org process, or not built), the production values that matter, the open legal and process items, and known errors in the evidence records.
read_when: Before claiming a control is met, preparing a counsel or carrier packet, changing a compliance-relevant setting, or picking up compliance work.
supersedes:
  [
    PLAN-CPA-COMPLIANCE.md §0.1,
    CPA-READINESS-ASSESSMENT-2026-07-08.md §5 tracker,
  ]
code:
  [
    packages/core/src/config.ts,
    packages/runtime/src/index.ts,
    packages/rag/src/generation/generator.ts,
    packages/ingestion/src/pipeline.ts,
    packages/db/src/hybrid-search.ts,
    packages/services/src/ask.ts,
  ]
---

# Compliance control status

This register says, for each control in [REQUIREMENTS.md](REQUIREMENTS.md), whether it is enforced in code, set in
production config, left to firm process, or not built. **Bottom line as of 2026-10-21:** production runs
`COMPLIANCE_MODE=none`, so the code-enforced §7216 controls (local embeddings, DPA boot check, forced TRI `block`,
mandatory content scan) are **built but not active**. Document text goes to Google's Gemini API for embedding and
generation. That is covered by the standard Cloud DPA (billing verified 2026-08-04), whose adequacy counsel has not
reviewed. Protection rests on that DPA, the egress allow-list, a rebuilt corpus that is all Class A, the ingest
content-safety gates ([CONTENT-SAFETY-DESIGN.md](CONTENT-SAFETY-DESIGN.md)), and the generation TRI pre-flight
running under `warn`. Most org-process controls (QI, WISP, training, breach runbook, vendor register, retention) have
no evidence anywhere.

The latest verified record of production is
[scope-conformance-2026-09-30.md](scope-conformance-2026-09-30.md), amended 2026-10-02. Railway was not reachable on
2026-10-21, so production values below come from that record unless marked otherwise.

## Status values

| Status            | Meaning                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| enforced-in-code  | The code refuses the unsafe state; a test or a boot failure guards it. |
| production-config | Met by how production is configured. A config change can undo it.      |
| org-process       | A firm or operator obligation outside the codebase.                    |
| not-built         | Required and absent.                                                   |
| …, inactive       | Built, but not in effect in production because `COMPLIANCE_MODE=none`. |

## Production configuration that matters

| Setting                                  | Production value                                                                                            | Source                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `COMPLIANCE_MODE`                        | `none`                                                                                                      | scope-conformance §6, 2026-10-01                           |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | `gemini` / `gemini-embedding-001`                                                                           | scope-conformance §6, 2026-10-01                           |
| `GENERATION_MODEL`                       | `gemini-flash-latest` (a floating alias)                                                                    | scope-conformance §0.5 and §6; UNVERIFIED since 2026-10-01 |
| `EGRESS_ALLOWED_HOSTS`                   | `generativelanguage.googleapis.com`                                                                         | scope-conformance §6, 2026-10-01                           |
| `GENERATION_TRI_POLICY`                  | `warn` on `rag-api` and `rag-mcp` (code default `block`)                                                    | [EXCEPTIONS-LOG.md](EXCEPTIONS-LOG.md), 2026-09-07         |
| `API_ENFORCE_SCOPING`                    | `true` on `rag-api` and `rag-mcp`                                                                           | scope-conformance §0.4, 2026-10-02                         |
| `AUTH_PROVIDER`                          | `composite`; OIDC unset; `rag-api` verifiers `static-token` + `internal-scope`; `rag-mcp` static-token only | scope-conformance §0.4, 2026-10-02                         |
| `AUDIT_SINK_PROVIDER`                    | unset → `none`; audit rows never leave Railway                                                              | scope-conformance row 5, 2026-10-01                        |
| `CONTENT_SCAN_PROVIDER`                  | UNVERIFIED; the code default is `none`. Settle with `railway variables --service rag-worker`.               | not recorded                                               |
| Postgres TLS                             | `sslmode=no-verify` on all services: encrypted, server certificate not verified                             | PR #59, 2026-09-07                                         |
| `PARSER_SECRET`                          | set and enforced                                                                                            | scope-conformance row 6.1e                                 |
| Index size                               | 48 documents / 211 chunks (47 SharePoint, 1 manual upload)                                                  | production query 2026-10-20 (session record, not re-run)   |

## Control register

"Code" means verified against the code on 2026-10-21. "Prod" means the production value above.

| CR    | Control                 | Status                                              | Evidence and gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Verified               |
| ----- | ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| CR-1  | No TRI disclosure       | enforced-in-code, inactive                          | Client-data mode forces local embeddings (`packages/rag/src/embeddings/factory.ts` `createEmbeddingProvider`) and bans a hosted reranker (`reranker.ts` `createReranker`). Always on: ingest gates (redact before embed, quarantine) and generation pre-flight (`generator.ts` `runPreFlight`; identifying patterns throw under any policy). Prod embeds with Gemini.                                                                                                              | code 10-21; prod 10-01 |
| CR-2  | §7216 vendor notice     | enforced-in-code, inactive; content check not-built | `config.ts` `defaultCheckDpa` checks that a `vendor-dpa-*.md` file exists, nothing more. Parsing its fields (no-train, expiry) was planned and not built. **[COUNSEL]** whether the standard DPA amounts to §7216 notice.                                                                                                                                                                                                                                                          | code 10-21             |
| CR-3  | U.S.-located vendor     | org-process, open                                   | Data residency unconfirmed ([vendor-dpa-google-gemini.md](vendor-dpa-google-gemini.md)). Settle through DPA language, or by moving to Vertex AI regional endpoints; not with a network check.                                                                                                                                                                                                                                                                                      | DPA record 08-04       |
| CR-4  | No vendor training      | production-config                                   | Cloud Billing Tier 1 (prepay) means the Cloud DPA applies: no-train and zero-retention in force (verified 2026-08-04). Counsel adequacy not reviewed.                                                                                                                                                                                                                                                                                                                              | DPA record 08-04       |
| CR-5  | Least privilege         | enforced-in-code + production-config                | `hybridSearch` requires `enforcedSourceIds`; an empty list returns zero rows (`packages/db/src/hybrid-search.ts`). Per-user grants in `staff_source_assignments`, resolved by `resolveSourceIdsForUser` for web and Teams. Prod `API_ENFORCE_SCOPING=true` since 2026-10-02. Gaps: grants are per source, not per role; SharePoint per-document ACLs aren't enforced (finding S-5); the operator holds an `isAdmin` principal, so "no production TRI access by default" isn't met. | code 10-21; prod 10-02 |
| CR-6  | Encryption at rest      | not-built / UNVERIFIED                              | No in-repo evidence that the Railway volume is encrypted; settle with Railway's written platform guarantee. Nightly dumps are unencrypted by a reasoned deferral ([BACKUP-AND-RECOVERY.md](../operations/BACKUP-AND-RECOVERY.md#encryption)). No server-side transcripts exist, so transcript encryption has nothing to apply to yet.                                                                                                                                              | record 10-02           |
| CR-7  | Encryption in transit   | production-config, partial                          | Postgres `sslmode=no-verify` (PR #59, 2026-09-07, verified 7/7 backends on TLSv1.3): encrypted but not server-authenticated. `PARSER_SECRET` enforced. Rejecting `http://` service URLs in production: not-built. No TLS scan of public endpoints on record.                                                                                                                                                                                                                       | prod 09-07             |
| CR-8  | MFA                     | org-process                                         | Web sign-in is Microsoft Entra ID (`apps/web/src/lib/auth.ts`). Whether conditional access requires MFA: UNVERIFIED (Entra admin console). Static API tokens carry no MFA; they are meant for service principals.                                                                                                                                                                                                                                                                  | code 10-21             |
| CR-9  | Vendor register         | not-built                                           | No `VENDOR-REGISTER.md` exists. It should cover Google (Gemini), Railway, Microsoft Graph/SharePoint, the object-storage provider, and Sentry if enabled.                                                                                                                                                                                                                                                                                                                          | 10-21                  |
| CR-10 | Monitoring and logging  | enforced-in-code, partial                           | `audit_log` rows on `/ask` and `/search` (API and MCP) store a question hash, not text, unless `AUDIT_LOG_CONTENT=full`. Off-host shipper built (`AUDIT_SINK_PROVIDER=webhook`, `apps/worker/src/handlers/ship-audit-log.ts`) but unset in prod. No ≥3-year retention; no anomaly or bulk-export alerting.                                                                                                                                                                         | code 10-21; prod 10-01 |
| CR-11 | Qualified Individual    | org-process, no evidence                            | No QI designation on record.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 10-21                  |
| CR-12 | WISP names the system   | org-process, no evidence                            | No WISP reference on record. Pub 5708 is the template ([REQUIREMENTS.md](REQUIREMENTS.md#regulatory-updates-researched-2026-07-03)).                                                                                                                                                                                                                                                                                                                                               | 10-21                  |
| CR-13 | Human-in-the-loop       | enforced-in-code                                    | Every answer carries `reviewStatus` and `disclaimer` (`packages/services/src/ask.ts` `REVIEW_STATUS`, `ANSWER_DISCLAIMER`), rendered non-dismissibly in `apps/web/src/components/chat-interface/chat-interface.tsx`. No "reviewed by [CPA]" record, which is acceptable while no client-send path exists.                                                                                                                                                                          | code 10-21             |
| CR-14 | Review queue            | not-built (not yet required)                        | Answers return directly. Required with any send or export feature, from its first release.                                                                                                                                                                                                                                                                                                                                                                                         | code 10-21             |
| CR-15 | Staff training          | org-process, no evidence                            | No training record or staff AI-limitations note on record. Should cover OPR Alert 2026-19.                                                                                                                                                                                                                                                                                                                                                                                         | 10-21                  |
| CR-16 | Breach notification     | not-built                                           | No breach runbook. Detection is limited to Sentry error capture (`SENTRY_DSN`).                                                                                                                                                                                                                                                                                                                                                                                                    | 10-21                  |
| CR-17 | IRS Stakeholder Liaison | not-built                                           | Would be a step in the CR-16 runbook.                                                                                                                                                                                                                                                                                                                                                                                                                                              | 10-21                  |
| CR-18 | Retention and disposal  | enforced-in-code, partial                           | On-demand whole-source purge: `purgeSource` (`packages/services/src/sources.ts`), `DELETE /sources/:id`, MCP `purge_source`; FK cascades remove chunks and vectors. No retention policy, no scheduled purge, no retention on backups. Whether purges are written to the audit trail: UNVERIFIED.                                                                                                                                                                                   | code 10-21             |
| CR-19 | Media disposal          | org-process, no evidence                            | No decommission checklist or deletion certificates on record.                                                                                                                                                                                                                                                                                                                                                                                                                      | 10-21                  |
| CR-20 | Backup testing          | production-config                                   | Restores proven 2026-07-31 (inside Railway) and 2026-10-02 (scheduled artifact), plus pgBackRest point-in-time restore by the manual procedure ([BACKUP-AND-RECOVERY.md](../operations/BACKUP-AND-RECOVERY.md#evidence)).                                                                                                                                                                                                                                                          | 10-02                  |

The 2026-10-02 restore drill handled production data outside Railway; see
[EXCEPTIONS-LOG.md](EXCEPTIONS-LOG.md#2026-10-02-restore-drill-copied-an-unencrypted-production-dump-to-a-workstation).

## Functional and non-functional requirements

| ID    | Status  | Notes                                                                                                                                                                                       |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | built   | SharePoint, Google Drive, Gmail and Outlook connectors, plus the eCFR and git-markdown connectors.                                                                                          |
| FR-2  | built   | Python parser sidecar.                                                                                                                                                                      |
| FR-3  | built   | Reranking ships but is off by default (`RERANK_PROVIDER=none`).                                                                                                                             |
| FR-4  | built   | `/ask`, `/ask/stream` and the MCP tools.                                                                                                                                                    |
| FR-5  | partial | Web and Teams built. SMS not built.                                                                                                                                                         |
| FR-6  | partial | Sessions are in-browser only (`apps/web/src/hooks/use-chat-sessions.tsx`). History is sent to the model for follow-up rewriting (PR #71), a data flow not in the 2026-08-31 counsel packet. |
| FR-7  | partial | The web admin area has access and docs-gap-digest pages; sources are created through the API or scripts.                                                                                    |
| FR-8  | built   | Web and Teams call the API through a BFF; agents use MCP.                                                                                                                                   |
| NFR-1 | built   | One Postgres. Original files sit in object storage, which is a blob store rather than a second datastore.                                                                                   |
| NFR-2 | built   | Strict TypeScript; the pre-push hook runs the unit suite.                                                                                                                                   |
| NFR-3 | built   | See [EVALUATION.md](../evaluation/EVALUATION.md).                                                                                                                                           |
| NFR-4 | built   | Documents keyed by `(source_id, external_id)` with a content hash.                                                                                                                          |

## Open legal and process items

None of these can be closed in code. They are listed here so a single place holds them.

| Item                                            | What is open                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Counsel review (P0 gate 2)                      | Written answers to the three questions in scope-conformance §1: DPA adequacy, whether the architecture needs changes, and sign-off. Also the state breach matrix, Circular 230 status and OPR Alert 2026-19 implications.            |
| Whether the 2026-07-04 disclosure is reportable | 844 documents ingested (858 indexed), later found to hold 522 SSN-shaped and 518 EIN-shaped values, were sent to Gemini under DPA terms, with no audit record of the embedder. No document records an answer. **[COUNSEL]**          |
| Insurance carrier notification                  | A separate track under P0 gate 2. Not started on record.                                                                                                                                                                             |
| CR-3 data residency                             | Confirm the Gemini processing region, or move to a regional endpoint.                                                                                                                                                                |
| Hosting principal                               | Is the Railway account's named principal the firm or an individual? The scope contract requires the firm (scope-conformance §0.3). UNVERIFIED: settle from the Railway account and invoice.                                          |
| Gate 1 written sign-off                         | Chris gave verbal sign-off on 2026-10-02. Row-by-row written decisions, resolved `ASK`s, confirmed withdrawals and an archived worksheet are open. The tracking issue the record cites (#82) does not exist, so nothing tracks this. |
| Qualified Individual (CR-11)                    | The firm names a QI and confirms alerts reach them.                                                                                                                                                                                  |
| WISP (CR-12)                                    | Adopt Pub 5708 and name this system, its components and vendors.                                                                                                                                                                     |
| Staff training (CR-15)                          | An AI-limitations note and annual training, covering OPR Alert 2026-19.                                                                                                                                                              |
| Breach runbook (CR-16, CR-17)                   | Process only: detection sources, a 30-day clock on the strictest state deadline, the FTC step, the IRS Stakeholder Liaison step, QI as incident lead. Counsel owns the state matrix.                                                 |
| Vendor register (CR-9)                          | Create it, with review-due dates.                                                                                                                                                                                                    |
| Retention policy (CR-10, CR-18)                 | How long to keep `audit_log` and backups, whether a firm-tenant copy is enough or WORM is required, and a maximum. Tied to launch-runbook items 5 and 8 ([LAUNCH-RUNBOOK.md](../launch/LAUNCH-RUNBOOK.md)).                          |
| Penetration-test exemption                      | Count consumers cumulatively, including former clients with retained data ([REQUIREMENTS.md](REQUIREMENTS.md#tiers-for-a-firm-of-about-20-people)).                                                                                  |
| Class B and the Class-A-only decision           | Whether the pilot indexes Class A only ([CONTENT-SAFETY-DESIGN.md](CONTENT-SAFETY-DESIGN.md#open-items)). Not yet decided.                                                                                                           |

## Known gaps in the evidence records

These errors sit inside records that must stay byte-identical. They are reported here, not fixed in place. A
correction belongs in a new dated record or an appended `## Amendment` block, and that is the owner's decision.

- **GATE-1-CONTENT-AUDIT.md cites issue #82, which does not exist.** `gh issue view 82` on 2026-10-21 returned
  "Could not resolve to an issue or pull request". So its claim that the open definition-of-done items are "tracked
  …, not waived" has no tracker behind it.
- **GATE-1-CONTENT-AUDIT.md contradicts itself after same-day edits.** §0.2 says a verdict is now enforced, then says
  nothing acts on `WITHDRAW`. §6 still says `lifecycle_status` has no reader, while §3 says retrieval filters on it.
  §6 says "nobody has looked yet", while the header records Chris's verbal sign-off.
- **GATE-1-CONTENT-AUDIT.md §0.3 and §4 call the ingest-time content gates "unbuilt".** They exist in code
  (`packages/ingestion/src/ingest-gates.ts`, `classify-document.ts`, and Layer 2 in `pipeline.ts` `ingestOne`).
  Layer 1.5 (`CONTENT_SCAN_PROVIDER`) may be off in production (UNVERIFIED), so "not in effect" may be what the
  record meant.
- **scope-conformance-2026-09-30.md row 3.2.3 says "see §0.4"; it should say §0.6.** §0.4 is the access-control
  item; §0.6 is the PII-detection item the row is about.
- **scope-conformance-2026-09-30.md row 6.1b/c names `gemini-2.5-flash`**, while its own §0.5 and §6 say production
  runs `gemini-flash-latest`.
- **scope-conformance-2026-09-30.md cites line numbers that have moved**: `config.ts:778-782` for the DPA check (now
  `defaultCheckDpa`) and `env.example:464` for the TRI default. It also cites docs by their pre-2026-10-21 paths
  (`docs/PURGE-RECORD-2026-08-03.md`, `docs/BACKUP-SCHEDULE-RUNBOOK.md`, `PILOT-LAUNCH-STATUS.md`), which now live
  at `records/`, `operations/BACKUP-AND-RECOVERY.md` and `launch/LAUNCH-STATUS.md`.
- **vendor-dpa-google-gemini.md counts 844 documents; other records count 858.** The DPA record counts `ingest_log`
  rows marked `ingested` on 2026-07-04; the purge record counts documents in the index on 2026-08-03. Neither text
  reconciles the two.
- **vendor-dpa-google-gemini.md names `gemini-2.5-flash`** for the July calls. Production later ran the floating
  alias `gemini-flash-latest` (scope-conformance §0.5), which the record doesn't mention.
- **vendor-dpa-google-gemini.md points to Phase 1.2/1.3 of `docs/PLAN-CPA-COMPLIANCE.md`**, which is now archived at
  `archive/plans/PLAN-CPA-COMPLIANCE.md`. The open follow-ups it names are carried in this register.

## How to update this register

- Change a row only after checking the code or production, and update its Verified cell.
- When a production value changes, record the change in a new `scope-conformance-<date>.md` if counsel relies on it,
  then update the table above.
- A departure from a control or gate goes in [EXCEPTIONS-LOG.md](EXCEPTIONS-LOG.md) first.
