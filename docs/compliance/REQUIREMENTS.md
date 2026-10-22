---
title: CPA compliance requirements
status: current
last_verified: 2026-10-21
verified_against: db0ceae
answers: What IRC §7216, the FTC Safeguards Rule (GLBA), Circular 230 and the firm require of this system (CR-1..CR-20, FR/NFR, human-in-the-loop design), and the legal research behind them.
read_when: Designing or reviewing anything that touches client data, egress, access, logging, retention or answer presentation; or preparing a counsel packet.
supersedes:
  [
    CPA-COMPLIANCE-REQUIREMENTS.md,
    PLAN-CPA-COMPLIANCE.md §0.3,
    CPA-KB-IMPLEMENTATION-SPEC.md §1-2 and Phase G,
  ]
code: []
---

# CPA compliance requirements

This is the canonical catalog of what the system must satisfy for a U.S. CPA firm whose knowledge base may hold
taxpayer data. The bottom line: **sending taxpayer return information (TRI) to any external embedding model, LLM or
hosted vector store is a §7216 disclosure**, so the architecture keeps TRI out of every external call by default.
The controls that follow are CR-1..CR-20. This file says what is required. Whether each control is met today lives in
[CONTROL-STATUS.md](CONTROL-STATUS.md), and production departures live in [EXCEPTIONS-LOG.md](EXCEPTIONS-LOG.md).

> **Not legal advice.** The catalog was researched on 2026-06-08 and the regulatory updates on 2026-07-03. Neither
> has been re-checked since. Items marked **[COUNSEL]** need the firm's tax counsel before they are relied on.

## IRC §7216 shapes the architecture

"Disclosure" means making TRI known to any third party **in any manner**. It happens the moment TRI leaves the
firm's control, which includes sending it to an external embedding API, LLM endpoint or hosted vector database.
There is no incidental carve-out. As of 2026-06 the IRS had issued no AI-specific guidance, so the general
prohibition applies in full.

| Penalty          | Amount                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| §7216 (criminal) | Up to $1,000 and/or 1 year per violation; up to $100,000 with an identity-theft predicate |
| §6713 (civil)    | $250 per disclosure, capped at $10,000 per year                                           |

The two statutory routes around the prohibition are both poor fits:

- **The auxiliary-services exception** (26 CFR §301.7216-2(e)) covers "programming, maintenance, repair, testing,
  or procurement of equipment or software used for tax return preparation". It requires a U.S.-located contractor
  that has been given written §7216 notice. It almost certainly does not cover a general-purpose LLM answering
  questions. **[COUNSEL]** if it is ever relied on.
- **Taxpayer consent** (Rev. Proc. 2013-14) requires verbatim statutory language, signed before the disclosure, and
  specific as to purpose and recipient. It is heavy and per-client.

**Chosen path (conservative).** Self-host the embedding model, so TRI is never sent out to be vectorised. Use a
U.S.-region enterprise LLM under a signed DPA with no-train and zero-retention terms for generation, or self-host
generation as well. Treat embedding vectors derived from TRI as TRI themselves: they are close enough to reversible,
so they must be encrypted and purgeable like the text.

The code implements this path as `COMPLIANCE_MODE=client-data` (the boot requirements are in [README.md](README.md)).
Production does not run that mode; see [CONTROL-STATUS.md](CONTROL-STATUS.md).

## Control requirements CR-1 to CR-20

Source abbreviations: GLBA = FTC Safeguards Rule, 16 CFR Part 314. Pub 4557 / Pub 5708 = IRS WISP guidance.

| ID    | Requirement (source)                                                       | Required control                                                                                                         | How it is verified                                                                    |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| CR-1  | No TRI disclosure (26 USC §7216)                                           | Self-hosted embeddings; no TRI to an external API; a TRI pre-flight scan before any external call                        | Data-flow diagram; egress test showing embeddings stay local; scanner blocks the send |
| CR-2  | Written §7216 notice to the vendor (26 CFR §301.7216-2(e)) **[COUNSEL]**   | No external API key activates without a stored, signed §7216 acknowledgment                                              | Config validation blocks external calls when the acknowledgment is missing or expired |
| CR-3  | U.S.-located vendor (26 CFR §301.7216-2(e))                                | LLM/API processing in U.S. regions; data-residency clause in the DPA                                                     | DPA review (a network check of IP regions proves nothing for a SaaS API endpoint)     |
| CR-4  | No vendor training on inputs (§7216; GLBA §314.4(f); AICPA)                | Enterprise tier plus a signed DPA with no-train and zero-retention; no telemetry egress from self-hosted parts           | Signed DPA on file; annual re-certification; egress rules                             |
| CR-5  | Least-privilege access (GLBA §314.4(c))                                    | Staff see only their assigned sources; access control fails closed; the operator has no production TRI access by default | Quarterly access review; test that a staff role can't retrieve out-of-scope documents |
| CR-6  | Encryption at rest (GLBA §314.4(e); Pub 5708)                              | Encrypted database storage, vectors included; app-level AES-256-GCM on any stored chat transcript                        | Infra audit; a raw snapshot is unreadable without the key                             |
| CR-7  | Encryption in transit (GLBA §314.4(e))                                     | TLS 1.2+ on every hop (connectors, parser, DB, API, channels, LLM); no plaintext HTTP on data paths                      | TLS scan; CI rejects HTTP data endpoints                                              |
| CR-8  | MFA for all access (GLBA §314.4(d); Pub 5708 2024, no in-office exception) | MFA on the web UI (Entra ID), Teams (Entra conditional access), DB/admin access, SharePoint config and CI secrets        | IdP logs show MFA challenges; no human-interactive bypass                             |
| CR-9  | Service-provider oversight (GLBA §314.4(f))                                | Vendor register: each external service, DPA status, §7216 notice, residency, last review; annual cycle                   | Register in the WISP appendix; calendar-triggered review                              |
| CR-10 | Monitoring and logging (GLBA §314.4(h))                                    | Structured retrieval logs (user, time, document/source, query hash) shipped off-host; ≥3-year retention; anomaly alerts  | Aggregator receiving rows; alert fires on a simulated bulk pull; retention enforced   |
| CR-11 | A designated Qualified Individual (GLBA §314.4(a); Pub 5708)               | QI named in the WISP and system docs; QI receives security alerts and signs off architecture, vendor and access changes  | WISP names the QI; runbooks require QI sign-off                                       |
| CR-12 | The WISP names the system (Pub 4557 / 5708)                                | The RAG system, its components and vendors are documented in the firm's WISP before go-live                              | WISP version names the system; annual review log                                      |
| CR-13 | Human-in-the-loop for tax positions (Circular 230 §10.22; SSTS §1.4)       | A non-dismissible "AI-generated" disclaimer on every answer; a "reviewed by [CPA]" record before any client-facing use   | UI test for the disclaimer; no client deliverable without a review record             |
| CR-14 | Written-advice standards (Circular 230 §10.35–10.37)                       | No direct client-to-AI path; answers labelled "Draft — requires practitioner review"; a review queue before any send     | Architecture review; workflow test holds output until a CPA approves                  |
| CR-15 | Technological competence (Circular 230, proposed)                          | A system-description doc (what is ingested, how retrieval works, failure modes) and annual staff training on limits      | Training records; versioned system description                                        |
| CR-16 | Breach notice within 30 days for 500+ consumers (FTC, eff. 2024-05-13)     | Breach-detection alerts; an incident-response runbook with a 30-day clock, the FTC portal and a state matrix; QI paged   | Annual tabletop; runbook current                                                      |
| CR-17 | IRS Stakeholder Liaison breach notice (Pub 4557 / 5708)                    | The incident-response runbook includes the IRS Stakeholder Liaison step, in parallel with the FTC step                   | Runbook reviewed; contact current                                                     |
| CR-18 | Retention and secure disposal (IRS norms; FTC Disposal Rule 16 CFR 682)    | Retention per document type; a scheduled purge that hard-deletes chunks **and** embedding vectors; every purge logged    | Rows past retention are absent; vector spot-audit; monthly purge-log review           |
| CR-19 | Secure media disposal (FTC Disposal Rule)                                  | Cryptographic erasure on decommission; deletion certificates kept; no stale snapshots                                    | Decommission checklist; certificate on file; backup inventory audit                   |
| CR-20 | Availability and tested backups (Pub 5708 2024; SOC 2 A1.2)                | Tested Postgres backups and a documented restore drill                                                                   | Restore drill log; backup monitoring                                                  |

The web app authenticates staff with Microsoft Entra ID, so Entra conditional access is the MFA control for both the
web UI and Teams (CR-8). Earlier drafts named a different identity provider; that is no longer part of the design.

### Tiers for a firm of about 20 people

| Tier                                  | Controls                                                                |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Mandatory before any real client data | CR-1, CR-4, CR-5, CR-6, CR-7, CR-8, CR-12, CR-13, CR-16, CR-18          |
| Within 90 days of go-live             | CR-9, CR-10 (off-host logs), CR-11, CR-15                               |
| Reassess on growth or productisation  | SOC 2 Type II, annual penetration testing, a formal data-class taxonomy |

CR-1 is decided first, because everything else assumes its answer.

**The penetration-testing exemption depends on a cumulative count.** The FTC Safeguards Rule exempts firms with fewer
than 5,000 consumers from the written risk assessment, annual penetration test, incident-response plan and board
reporting (16 CFR §314.6). §314.2(b)(1) defines a consumer as anyone who "obtains **or has obtained**" a service. So
former and inactive clients whose returns are still on file count. Count every individual taxpayer ever served whose
data is still retained, and recount as that population grows, before assuming the exemption applies.

## Functional and non-functional requirements

These came from the 2026-06-08 implementation spec. Their build status is in
[CONTROL-STATUS.md](CONTROL-STATUS.md#functional-and-non-functional-requirements).

| ID    | Requirement                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| FR-1  | Ingest firm documents from SharePoint (primary) and from Outlook, Gmail and Drive, with delta sync.             |
| FR-2  | Parse common formats (PDF, DOCX, XLSX, PPTX, images including scans) to clean markdown.                         |
| FR-3  | Chunk and embed; hybrid dense and sparse retrieval fused with RRF; optional reranking.                          |
| FR-4  | Grounded, cited answers through the `/ask` API and an MCP agent surface.                                        |
| FR-5  | A web chat UI, a Microsoft Teams bot, and an SMS line restricted to non-confidential sources.                   |
| FR-6  | Multi-turn chat across channels with server-side session memory and history-aware retrieval.                    |
| FR-7  | A non-developer operator can add a source, run a sync and see status without editing JSON.                      |
| FR-8  | Every channel and automation calls the same governed retrieval layer (HTTP `/ask` and MCP tools), never the DB. |
| NFR-1 | One Postgres database (pgvector, tsvector, pg-boss, sessions). No second datastore.                             |
| NFR-2 | Strict TypeScript and parameterised queries; test coverage does not regress.                                    |
| NFR-3 | Retrieval quality is measured by an eval harness (recall@k, nDCG@k) before and after any tuning.                |
| NFR-4 | Resumable, idempotent ingestion that short-circuits on content hash.                                            |

## Human-in-the-loop design

CR-13 and CR-14 apply to every channel (web, Teams, MCP, and SMS if it is built):

1. **A non-dismissible disclaimer on every AI answer**, sourced from the server as a typed field, not a UI string a
   client can strip. Its meaning: AI-generated, not reviewed by a licensed tax professional.
2. **Answers are labelled "Draft — requires practitioner review".**
3. **No direct client-to-AI response path.** The system is staff-facing only.
4. **A review queue** holds any output touching a tax position until a CPA approves it, with a logged "reviewed by
   [CPA]" record before it reaches a client or a filing. It is required only once the product has a way to send or
   export to clients. A send or export feature must ship with review gating from its first release.
5. **Scope is computed on the server.** No browser, Teams or SMS client supplies its own source ids.
6. **SMS, if built, is restricted:** non-confidential sources only, a phone allowlist, verified numbers, and an audit
   record for every query. Client-confidential data never travels over SMS.
7. **The Teams bot is registered single-tenant.** Microsoft deprecated multi-tenant bot registration on 2025-07-31.

## Regulatory updates researched 2026-07-03

- **Circular 230 technological-competence amendment: proposed, not final.** REG-116610-20 was published in the
  Federal Register on 2024-12-26, and comments closed 2025-02-24. No final rule existed as of 2026-07. Treat CR-15 as
  best practice rather than a binding duty. UNVERIFIED after 2026-07-03: check the Federal Register for a final rule.
- **IRS OPR Alert 2026-19 (24–26 June 2026), "Introductory Guidelines for Responsible AI Use in Federal Tax
  Practice".** It is informal guidance, not a Treasury regulation, but it comes from the office that administers
  Circular 230 discipline. It says AI must "augment, not replace" professional judgment, which strengthens CR-13 and
  CR-14 through the already-final §10.22 diligence duty. It says practitioners should use only "secure,
  enterprise-approved AI" for client data (CR-1 to CR-4), and that firms must train staff and vet third-party AI tools
  (CR-9, CR-15). It also adds a duty the control matrix lacked: **billing transparency**. Efficiency gained from AI
  must be reflected in client billing, not billed as if the work were done by hand.
- **IRS Pub 5708 is an official, adaptable WISP template.** It isn't turnkey, because its placeholder language must
  be replaced with firm specifics. It covers QI designation, a data and asset inventory, risk assessment,
  administrative, technical and physical safeguards, vendor oversight, an incident-response plan, training records,
  backup and restore testing, and periodic review. QI eligibility is deliberately loose: any owner or partner who
  "oversees and enforces" the program.
- **State breach-notification law follows the client's state of residence, not the firm's location.** A firm with
  clients in several states must satisfy each one. Build the incident-response clock around the strictest deadline
  that applies. California, Colorado, Florida and Washington all require notice within 30 calendar days as of 2026
  (California's 30-day rule, SB 446, took effect 2026-01-01). No source consulted would generalise the full
  50-state picture, so the state matrix stays **[COUNSEL]**.
- **FTC breach notice.** Notify the FTC within 30 days of discovering a breach affecting 500 or more consumers
  (effective 2024-05-13).

## Questions reserved for counsel

1. Is the vendor DPA sufficient for §7216 and GLBA at the same time?
2. If the auxiliary-services exception is ever relied on instead of self-hosting or consent, a formal legal opinion is
   needed. No IRS guidance exists.
3. Which state privacy and breach laws apply (for example CCPA, NY SHIELD), given the firm's client geography?
4. The final text and effective date of the Circular 230 technological-competence amendments.
5. What OPR Alert 2026-19 means for firm policy, including billing transparency.

The current list of open counsel items, including those raised by events, is in
[CONTROL-STATUS.md](CONTROL-STATUS.md#open-legal-and-process-items).

## Sources

- 26 USC §7216 and §6713 (law.cornell.edu); 26 CFR §301.7216-2; Rev. Proc. 2013-14
  (irs.gov/pub/irs-drop/rp-13-14.pdf); The Tax Adviser, January 2024
  (thetaxadviser.com/issues/2024/jan/the-many-implications-of-sec-7216/).
- FTC Safeguards Rule: ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know; breach
  notice: ftc.gov/business-guidance/blog/2024/05/safeguards-rule-notification-requirement-now-effect;
  16 CFR 314.6 and 314.2 (law.cornell.edu/cfr/text/16/314.6, /314.2).
- IRS Pub 4557 and 5708: irs.gov/pub/irs-pdf/p5708.pdf; irs.gov/newsroom/tax-professional-tips-for-creating-a-data-security-plan.
- Circular 230: irs.gov/pub/irs-pdf/pcir230.pdf; proposed changes: federalregister.gov/documents/2024/12/26/2024-29371.
- OPR Alert 2026-19 coverage: journalofaccountancy.com/news/2026/jun/irs-outlines-ai-risks-circular-230-duties-for-tax-practitioners/.
- State breach laws: ncsl.org/technology-and-communication/security-breach-notification-laws.
- AICPA AI Tax Resource Center: aicpa-cima.com/resources/landing/artificial-intelligence-ai-tax-resource-center.
- IRS internal AI governance: irs.gov/irm/part10/irm_10-024-001r.
