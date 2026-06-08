# CPA RAG KB — Regulatory & Compliance Requirements

> Grounded requirements catalog for a U.S. CPA firm operating a RAG knowledge base over client and
> taxpayer data. Drives the control matrix in `CPA-KB-IMPLEMENTATION-SPEC.md`. Researched 2026-06-08.
> **This is not legal advice.** Items marked **[COUNSEL]** require a tax attorney's review before go-live.

## The one decision that gates everything: IRC §7216

"Disclosure" = making taxpayer return information (TRI) known to any third party **in any manner**.
The disclosure event occurs the moment TRI leaves the firm's control — i.e., the moment it is sent to
an **external embedding API, LLM endpoint, or hosted vector DB**. There is no incidental carve-out, and
**the IRS has issued no AI-specific guidance** (as of 2026-06), so the general prohibition applies at
full force. Penalties: §7216 criminal (up to $1,000 / 1yr per violation; $100,000 with identity-theft
predicate); §6713 civil ($250/disclosure, $10,000/yr cap).

- The **auxiliary-services/contractor exception** (26 CFR §301.7216-2(e)) is scoped to "programming,
  maintenance, repair, testing, or procurement of equipment or software used for tax return
  preparation," requires the contractor be **U.S.-located** and given **written §7216 notice**, and
  almost certainly **does not** cover a general-purpose LLM doing Q&A. **[COUNSEL]** if relied upon.
- **Consent** path (Rev. Proc. 2013-14) requires verbatim statutory language, signed before disclosure,
  specific as to purpose/recipient — operationally heavy and per-client.

**Chosen compliance path (conservative, recommended):** **self-host the embedding model** so TRI never
leaves firm infrastructure for vectorization, and use a **US-region enterprise LLM with a signed DPA +
no-train + zero-retention** terms for generation (or self-host generation too). Embedding vectors
derived from TRI are treated as TRI themselves (reversible-enough argument) → encrypted + purgeable.

Sources: 26 USC §7216 / §6713 (law.cornell.edu); 26 CFR §301.7216-2; Rev. Proc. 2013-14
(irs.gov/pub/irs-drop/rp-13-14.pdf); Tax Adviser Jan 2024
(thetaxadviser.com/issues/2024/jan/the-many-implications-of-sec-7216/).

## Control matrix (Requirement → Control → Verify)

| #     | Requirement (source)                                                                     | Software control                                                                                                                                             | Verify                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CR-1  | §7216 no TRI disclosure (26 USC §7216)                                                   | Self-host embeddings; no TRI to external API. Pre-flight TRI scan flags SSN/EIN/named-taxpayer-amounts before any external call                              | Data-flow diagram; automated egress test asserts embedding calls hit only localhost/self-hosted; TRI-pattern scanner blocks external send |
| CR-2  | §7216 vendor written notice (26 CFR §301.7216-2(e)) **[COUNSEL]**                        | Vendor onboarding gate: no external API key activates without a stored signed §7216 acknowledgment                                                           | Config validation blocks external calls if acknowledgment file missing/expired                                                            |
| CR-3  | §7216 U.S.-located vendor (26 CFR §301.7216-2(e))                                        | Pin LLM/API endpoints to US regions; data-residency clause in DPA                                                                                            | DPA review; network log audit → all API calls resolve to US IPs                                                                           |
| CR-4  | No vendor training on inputs (§7216; GLBA §314.4(f); AICPA)                              | Enterprise tier + signed DPA with no-train/zero-retention; self-hosted = block telemetry egress                                                              | Signed DPA on file; annual re-cert; egress firewall rules                                                                                 |
| CR-5  | Least-privilege access (GLBA §314.4(c))                                                  | RBAC: staff see only assigned-client sources; fail-closed ACL (Phase 1); Marcus has no prod TRI access without explicit grant                                | Quarterly access review; test: staff role cannot retrieve out-of-scope client docs; retrieval audit log                                   |
| CR-6  | Encrypt at rest (GLBA §314.4(e); Pub 5708)                                               | Postgres TDE/disk encryption; pgvector in encrypted tablespace; app-level AES-256-GCM on chat transcript content                                             | Infra audit: encryption flag on; raw snapshot unreadable without key                                                                      |
| CR-7  | Encrypt in transit (GLBA §314.4(e))                                                      | TLS 1.2+ on every hop (connectors→parser→DB→API→channels→LLM); no plaintext HTTP on data paths                                                               | testssl scan; CI rejects HTTP on data endpoints                                                                                           |
| CR-8  | MFA for all access (GLBA §314.4(d); Pub 5708 2024 — no in-office exception)              | MFA on web UI (PropelAuth/IdP), DB/admin, SharePoint config, Teams (Entra conditional access), CI secrets                                                    | IdP logs show MFA challenges; no human-interactive bypass                                                                                 |
| CR-9  | Service-provider oversight (GLBA §314.4(f))                                              | Vendor register: every external service + DPA status + §7216 ack + residency + last-reviewed; annual cycle                                                   | Vendor register in WISP appendix; calendar-triggered review                                                                               |
| CR-10 | Monitoring & logging (GLBA §314.4(h))                                                    | Structured retrieval logs (user, ts, doc/client id, query hash) shipped to independent aggregator; ≥3yr retention; anomaly alerts (bulk export, after-hours) | Aggregator ingesting; test alert on simulated bulk pull; retention enforced                                                               |
| CR-11 | Designated Qualified Individual (GLBA §314.4(a); Pub 5708)                               | QI named in WISP + system docs; QI = security-alert recipient; QI sign-off for arch/vendor/access changes                                                    | WISP names QI; runbook requires QI sign-off; alert routing confirmed                                                                      |
| CR-12 | WISP names the system (Pub 4557/5708)                                                    | RAG system + all components + vendors documented in firm WISP before go-live                                                                                 | WISP version post-impl names "RAG KB system"; annual review log                                                                           |
| CR-13 | Human-in-the-loop for tax positions (Circular 230 §10.22; SSTS §1.4)                     | Non-dismissible AI-generated disclaimer on every answer; "reviewed by [CPA]" record before any client-facing use/filing                                      | Audit log: no client deliverable sent without CPA review record; UI test confirms disclaimer                                              |
| CR-14 | Written-advice standards (Circular 230 §10.35–10.37)                                     | No direct client→AI response path; outputs labeled "Draft — requires practitioner review"; review queue interposed                                           | Arch review: no client-to-AI path; workflow test holds output until CPA approves                                                          |
| CR-15 | Technological competence (Circular 230 proposed 2024)                                    | System description doc (data ingested, retrieval, failure modes) + annual staff training on limitations                                                      | Training records; versioned system-description doc                                                                                        |
| CR-16 | Breach notification ≤30 days, 500+ consumers (FTC Safeguards, eff. 2024-05-13; Pub 5708) | Breach detection alerts; IR runbook with 30-day clock, FTC portal, state matrix; QI paged                                                                    | Annual tabletop; runbook current; test alert acknowledged                                                                                 |
| CR-17 | IRS Stakeholder Liaison breach notice (Pub 4557/5708)                                    | IR runbook includes IRS Stakeholder Liaison step parallel to FTC                                                                                             | Runbook reviewed; contact current                                                                                                         |
| CR-18 | Retention + secure disposal (IRS norms; FTC Disposal Rule 16 CFR 682; GLBA)              | `retain_until` per doc type/filing date; scheduled purge **hard-deletes source chunks AND embedding vectors**; purge logged                                  | Test: rows past retention absent; pgvector spot-audit; monthly purge-log review                                                           |
| CR-19 | Secure media disposal (FTC Disposal Rule)                                                | Cryptographic erasure / DoD overwrite on decommission; retain cloud deletion certs; no stale snapshots                                                       | Decommission checklist; deletion cert on file; backup inventory audit                                                                     |
| CR-20 | Availability / backup testing (Pub 5708 2024; SOC2 A1.2)                                 | Tested backups of Postgres; documented restore drill                                                                                                         | Restore drill log; backup monitoring                                                                                                      |

## Minimum viable posture for a ~20-person firm

**Mandatory (legal, non-negotiable, before any real client data):** CR-1 (§7216 architecture — decide
first), CR-12 (WISP names system), CR-8 (MFA everywhere), CR-6/CR-7 (encryption), CR-4 (vendor
DPA/no-train), CR-16 (breach runbook), CR-13 (human-in-the-loop), CR-5 (RBAC), CR-18 (retention+purge).

**Within 90 days of go-live:** CR-11 (QI documented), CR-9 (vendor register + annual review), CR-10
(off-host structured audit logs), CR-15 (staff AI-limitations training).

**Nice-to-have / reassess on growth or if productized:** SOC 2 Type II (disproportionate for internal
use at 20 people); penetration testing (firms <5,000 consumer records are exempt under GLBA — **count
records to confirm** the exemption applies, else annual pen testing is mandatory); formal data-class
taxonomy.

## Gaps requiring counsel before deployment **[COUNSEL]**

1. Review the specific vendor DPA for simultaneous §7216 + GLBA sufficiency.
2. If relying on the auxiliary-services exception instead of self-hosting/consent, get a formal legal opinion (no IRS guidance exists).
3. State laws (CCPA, NY SHIELD, etc.) based on client geography — not covered here.
4. Confirm final text/effective date of the proposed Circular 230 technological-competence amendments.

## Key sources

- FTC Safeguards Rule: ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know · breach notice: ftc.gov/business-guidance/blog/2024/05/safeguards-rule-notification-requirement-now-effect
- IRS Pub 4557 / 5708 (WISP): verito.com/blog/irs-publication-4557-vs-5708/ · irs.gov/newsroom/tax-professional-tips-for-creating-a-data-security-plan
- Circular 230: irs.gov/pub/irs-pdf/pcir230.pdf · proposed changes: currentfederaltaxdevelopments.com/blog/2024/12/22/irs-proposes-changes-to-circular-230
- AICPA AI Tax Resource Center: aicpa-cima.com/resources/landing/artificial-intelligence-ai-tax-resource-center
- IRS AI governance (internal): irs.gov/irm/part10/irm_10-024-001r
