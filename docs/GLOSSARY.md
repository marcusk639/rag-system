---
title: Glossary
status: current
last_verified: 2026-10-21
answers: Who the people named in these docs are, and what the IDs, acronyms and terms used across docs/ mean.
read_when: A doc uses a name, gate number, class letter or acronym you don't recognise.
---

# Glossary

## People

These docs name people by first name only, and only in the roles below. No other personal names belong in this repo.

| Name   | Role                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marcus | Builds and operates rag-system: engineering, Railway, and day-to-day ops lead for the pilot.                                                         |
| Chris  | Partner at the client CPA firm. Administers the firm's Microsoft 365 tenant (admin consent, app registrations) and gave the Gate 1 content sign-off. |
| Doug   | CPA at the client firm. Domain reviewer: authors and verifies the gold-set questions (`tier2-cpa-verified`) and is the first intended pilot user.    |

## Launch gates and runbook items

Gate and item numbers are stable, and code comments cite some of them. Status lives in
[launch/LAUNCH-STATUS.md](launch/LAUNCH-STATUS.md); procedures live in [launch/LAUNCH-RUNBOOK.md](launch/LAUNCH-RUNBOOK.md).

| ID         | Meaning                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| P0 gate 0  | Production `GENERATION_TRI_POLICY` decision (`warn` vs `block`).                                    |
| P0 gate 1  | Content audit: may every indexed document be shown to every staff member?                           |
| P0 gate 2  | Counsel and insurance-carrier sign-off (§7216, Circular 230, FTC Safeguards, DPA adequacy).         |
| P0 gate 3  | Backups exist off the database host and a restore has been proven.                                  |
| P0 gate 3a | The Microsoft 365 tenant has a SharePoint Online licence, and the source has been re-synced.        |
| Item 5     | Docs-gap digest / audit-log content privacy decision (`AUDIT_LOG_CONTENT`). Cited by `env.example`. |
| Item 8     | Audit-log destination and retention window. Cited by `env.example`.                                 |
| P1, P2     | Launch-runbook priority tiers below P0: should happen before or soon after first use.               |

## Data classes and content

| Term                      | Meaning                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class A / B / C / D       | Per-document sensitivity (`DocumentClass`, `packages/core/src/types.ts`). A = firm-internal, non-sensitive (SOPs, templates); B = firm-internal, de-identification required; C = per-client business data (needs a §314.4(f) addendum); D = client tax return data (needs a §7216 consent workflow). The ingestion gate blocks C and D alike with `ClassBlockedError`. |
| `data_class` (source)     | Per-source label in `sources.data_class` (`packages/db/src/schema.ts` `dataClassEnum`): `general`, `research`, `sop`, `client_confidential`. It is mapped to a document class at ingest, failing closed.                                                                                                                                                               |
| `content_type`            | Librarian taxonomy for a document (`contentTypeEnum`). It is separate from data class and must never be conflated with it.                                                                                                                                                                                                                                             |
| `lifecycle_status`        | Free-text document state (`documents.lifecycle_status`, default `active`). Retrieval returns only `active` rows (`packages/db/src/hybrid-search.ts`); anything else, e.g. a Gate 1 withdrawal, is hidden.                                                                                                                                                              |
| TRI                       | Tax return information under IRC §7216. The TRI scanner (`packages/core/src/tri-scanner.ts`) and the scanner pack (`packs/cpa/pack.yaml`) detect it.                                                                                                                                                                                                                   |
| Identifying vs contextual | Scanner match kinds. Identifying (SSN, EIN, …) always blocks generation. Contextual (a form number next to an amount) follows `GENERATION_TRI_POLICY`.                                                                                                                                                                                                                 |
| Scanner pack              | Data-only bundle of patterns, validators and dispositions (`packs/<vertical>/pack.yaml`). Core enforces; packs supply policy.                                                                                                                                                                                                                                          |

## Compliance

| Term              | Meaning                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §7216             | IRC §7216 and 26 CFR §301.7216: criminal and civil penalties for disclosing tax return information. Sending TRI to an external model counts as a disclosure. |
| FTC Safeguards    | 16 CFR Part 314 (GLBA Safeguards Rule): written security program, Qualified Individual, breach notice.                                                       |
| Circular 230      | Treasury rules for tax practitioners. §10.37 is the reason for the "Draft — requires practitioner review" label on answers.                                  |
| CR-1 … CR-20      | Control requirements in [compliance/REQUIREMENTS.md](compliance/REQUIREMENTS.md); status in [compliance/CONTROL-STATUS.md](compliance/CONTROL-STATUS.md).    |
| DPA               | Data processing agreement with a vendor. On record: [compliance/vendor-dpa-google-gemini.md](compliance/vendor-dpa-google-gemini.md).                        |
| QI, WISP          | Qualified Individual and Written Information Security Program (FTC Safeguards).                                                                              |
| `COMPLIANCE_MODE` | `none` or `client-data`. `client-data` hard-fails boot unless local embeddings, content scanning and a DPA file are in place (root `CLAUDE.md`).             |

## System terms

| Term        | Meaning                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source      | One configured connector instance (`sources` row). Its config can't be edited; changing tenant or site means creating a new source with a new id.   |
| Principal   | An authenticated caller and its allowed source ids. Comes from `API_PRINCIPALS`, a scope token, or OIDC.                                            |
| Scope token | 60-second HS256 JWT minted by `rag-web` and the Teams bot, carrying a user's resolved source ids (`INTERNAL_SCOPE_JWT_SECRET[S]`).                  |
| BFF         | Backend-for-frontend. `apps/web` and `apps/teams-bot` call the API server-side, so no credential reaches the browser.                               |
| RRF         | Reciprocal rank fusion of the dense (pgvector HNSW) and sparse (tsvector) result lists.                                                             |
| Gold set    | Hand-verified evaluation questions in `tests/e2e/src/eval/gold-set.ts`. See [evaluation/EVAL-GOLD-SET-GUIDE.md](evaluation/EVAL-GOLD-SET-GUIDE.md). |
| SPO         | SharePoint Online. Without an SPO licence, Graph auth succeeds but every sync fails (`Tenant does not have a SPO license`).                         |
| KB          | The firm's knowledge base: the SharePoint "Knowledge Base" library plus manual uploads.                                                             |
