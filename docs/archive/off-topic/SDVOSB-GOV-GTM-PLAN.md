# SDVOSB Federal AI Go-To-Market Plan

**Date:** 2026-10-09 · **Owner:** founder (solo SDVOSB, VetCert + SAM pending, no clearance) · **Evidence base:** [`sdvosb-research/RESEARCH-REPORT.md`](./sdvosb-research/RESEARCH-REPORT.md)

How to read this document:

- `[Sxxx]` cites the research bibliography.
- **(assumption)** marks a planning number that is not a research finding. Validate it before relying on it.
- Repo facts cite file paths in this repository.

---

## 1. The thesis in one paragraph

Agencies can now get generic AI chat almost free, through GSA OneGov deals and the USAi platform [S206][S208][S217]. Don't sell models or chat. Sell what OMB and the oversight bodies now require and what agencies cannot get from a $1 chat license:

- **source-grounded, cited answers** over the agency's own regulations, manuals and records
- **deployed inside the agency's own tenant**
- **working with whatever government-authorized model the agency already buys**
- **evidence that it works**, from an evaluation harness run on the agency's data

M-25-22 asks for portability, no training on agency data, testing on agency data, and new entrants [S205]. VA's Inspector General and GAO are flagging auditability gaps in VA's current AI use [S211][S212].

Your SDVOSB certification makes you awardable fast at VA: set-asides under the rule of two, and sole-source awards up to $5M [S109]. Your engineering lets you deliver as a team of one. This repository already is most of that product.

## 2. What the repo already gives you

| Federal requirement / buyer concern                           | Already in the repo                                                                                                                                 | Gap to close                                                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Out of FedRAMP scope when deployed in agency's tenant [S404]  | Self-hostable stack: `docker/compose.prod.yml`, `docs/AZURE-DEPLOY-RUNBOOK.md`; worker/api/mcp split                                                | Infrastructure as code for Azure Government and AWS GovCloud; hardened base images; one-command install                                                                 |
| VA ATO package items: SAR, data-flow, inventory, scans [S416] | Architecture docs (`docs/ARCHITECTURE.md`), conformance records (`docs/compliance/`)                                                                | An SSP-style package (ideally OSCAL), SBOM, automated vulnerability scan, data-flow diagrams per deployment                                                             |
| No training on agency data; portability [S205]                | Model-agnostic generation (`GENERATION_PROVIDER` gemini/openai/claude, OpenAI-compatible `GENERATION_BASE_URL`); MIT-licensed core (`package.json`) | AWS Bedrock (GovCloud) provider; Azure OpenAI Gov config doc; a written data-rights/no-training statement                                                               |
| Testing on agency-defined data [S205]                         | Eval harness + gold set (`pnpm eval`, `pnpm eval:gold`, `docs/EVAL-GOLD-SET-GUIDE.md`)                                                              | A packaged "evaluation report" deliverable an agency can file with its AI use-case inventory                                                                            |
| Auditability, the OIG/GAO concern [S211][S212]                | `audit_log` table + `ship-audit-log` worker handler + `AUDIT_SINK_*` env; numbered citations on every answer                                        | Mapping to NIST 800-53 AU controls; SIEM sink (Splunk/Sentinel) adapter                                                                                                 |
| Air-gapped / no-egress operation                              | `COMPLIANCE_MODE=client-data`, local ONNX embeddings, self-hosted generation (`docs/LOCAL-GENERATION.md`)                                           | A validated open-weight model recipe (vLLM) for an unclassified enclave                                                                                                 |
| Per-user access control                                       | Pluggable `AuthProvider` (OIDC/static/composite), scope-threaded retrieval                                                                          | Document PIV/CAC via the agency IdP (Entra ID / Okta / Login.gov) through OIDC                                                                                          |
| Section 508 [S418]                                            | Next.js UI (`apps/web`), Teams bot (`apps/teams-bot`), MCP server                                                                                   | **WCAG 2.0 AA audit + Accessibility Conformance Report (ACR)**: only 3 files in `apps/web/src` use ARIA roles or attributes, and there is no accessibility audit or ACR |
| FIPS 140-3 crypto [S419]                                      | TLS everywhere; Postgres                                                                                                                            | Node/OpenSSL FIPS provider build; FIPS-validated Postgres TLS; document crypto boundaries                                                                               |
| Regulation content                                            | eCFR connector (`packages/connectors/src/ecfr-part4/`, defaults Title 38 Part 4 but takes any `title`/`part`)                                       | Multi-part support (Title 48 FAR/VAAR/DFARS; 38 CFR Parts 3, 4, 14, 17); public VA manuals (M21-1) ingestion                                                            |
| Sensitive VHA records (38 U.S.C. 7332) [S422]                 | Ingestion sensitivity gate (`pipeline.ts` `dataClass` / `ClassBlockedError`)                                                                        | A 7332 record class that is blocked by default, plus a documented handling procedure                                                                                    |
| M-26-04 "Unbiased AI" model documentation pass-through [S215] | None                                                                                                                                                | A generated document listing model card, provider, and version per deployment                                                                                           |

**IP hygiene, a prerequisite.** `methodology/README.md` and `clients/pilot/README.md` record a pre-employment IP agreement. The generic platform is your background IP, and the pilot tenant's material belongs to that tenant.

- Before any government demo or delivery, confirm in writing that Schedule A covers the platform packages and apps as background IP.
- Move the remaining firm-specific files into `clients/pilot/`, as that README already asks, and exclude that directory from any deliverable.
- Decide deliberately between keeping the core MIT-licensed and making it proprietary:
  - **MIT** is a strong answer to M-25-22's anti-lock-in language [S205]: you sell deployment, integration, evaluation and support, not the license.
  - **Proprietary** protects license revenue but invites data-rights negotiation.
  - Get a GovCon attorney's view before your first proposal.

## 3. Ranked offerings

Ranked by fit to the evidence, time-to-cash for a solo founder, and how much of the work the repo already does.

### #1 — Regulatory and Policy Answer Engine, "cited answers in your tenant" (VA first)

- **What:** RAG over the regulations and policy manuals staff consult all day, deployed in the VA tenant, answering in Teams (already built) with numbered citations. Content: 38 CFR Parts 3, 4 and 14; the M21-1 adjudication manual; VHA directives; VA acquisition regulations (VAAR) and the FAR for contracting staff.
- **Why it wins:**
  - VA GPT and Copilot are generic, and VA's Inspector General flagged that VA did not treat them as high-impact even when staff used them clinically [S211].
  - A cited, scoped, evaluated tool is the auditable alternative.
  - VA's strategy lists claims processing and information management among its priorities (**unverified**: news-sourced) [S204].
- **Buyer:** VBA program offices, VHA policy offices, VA's acquisition offices, and the reported Enterprise AI Support Services contract (knowledge retrieval in scope, **unverified**) [S210].
- **Contract shape:**
  - A firm-fixed-price pilot under $350K (simplified acquisition threshold) [S102].
  - It converts to a VA SDVOSB sole-source award up to $5M with options once VetCert is in place [S109].
- **Delivery for a solo founder:** high. The connectors, Teams bot and eval harness exist.

### #2 — FAR/RFO Acquisition Assistant, commercial SaaS sold to government contractors

- **What:** the same engine over the FAR and its supplements (Title 48), the RFO deviations and GSA's MAS documents, sold as a commercial subscription to small government contractors and their proposal teams.
- **Why:** the RFO is rewriting the FAR in stages, through class deviations and rolling proposed rules [S114][S115]. Contractors need current, cited answers.
- **Why it matters for this plan:**
  - It is commercial revenue that needs no ATO or certification, so it can start this month.
  - It builds commercial past performance.
  - It puts you in front of the primes and SDVOSBs you want to team with.
- **Contract shape:** per-firm subscription **(assumption: $100–$400/month per firm; validate with 10 discovery calls)**.
- **Delivery:** extend the eCFR connector to Title 48, then use the existing web UI. Accessibility work is optional here, since it is commercial.

### #3 — Accredited-Representative Rating Assistant, state and county veterans offices

- **What:** 38 CFR Part 4 rating-schedule search (connector already built) plus M21-1, as a **supervised tool for accredited representatives**. It is sold to state veterans departments and county veterans service offices, ideally integrated alongside VetraSpec or VetPro rather than replacing them [S609][S611].
- **Why:** 13,670 accredited individuals; three-quarters of open claims have one [S608]. States are consolidating purchases and paying county licenses [S613]. State preferences help: New York's 6% goal [S615][S616], California DVBE [S617], Texas VetHUB for Texas residents [S619].
- **Legal guardrail:**
  - Never sell claims help to veterans for a fee [S601][S603][S605].
  - Contract terms must say representatives remain the accredited party.
- **Contract shape:** per-state or per-platform license **(assumption: $25K–$150K per year per state)**, because seat prices are only about $476–$520 per user per year [S610][S611].

### #4 — AI Evaluation and Assurance Service

- **What:** a fixed-price engagement that runs an agency's AI tool, whether yours or someone else's, against an agency-defined gold set. The output:
  - accuracy, citation-faithfulness and refusal metrics
  - an audit trail
  - M-26-04 documentation
- **Why:** M-25-22 tells agencies to test on their own data [S205]. GAO warns that errors in AI-automated claims are hard to detect [S212]. VA's Inspector General found no AI-specific safety-event reporting [S211].
- **Buyer:** VA AI program offices, and primes delivering AI who need an independent evaluator. That is a natural SDVOSB subcontract.
- **Delivery:** the eval harness exists; package it as a repeatable report.

### #5 — Retrieval-layer subcontractor to primes on VA enterprise AI

- **What:** team as the retrieval, agent-workflow and evaluation subcontractor under a large prime or an established SDVOSB on VA AI work, including the reported Enterprise AI Support Services contract [S210].
- **Why:** primes must meet SDVOSB subcontracting goals and look for subs on SubNet and Small Business Search [S328]. Government-wide SDVOSB subcontracting ran 2.42% in FY2025, below the 3% goal [S106], so primes need SDVOSB subs.
- **Constraint:** if you are a sub, the 50% limit binds the prime, not you. If you prime an SDVOSB set-aside, it binds you: at most 50% may go to firms that are not similarly situated [S112].

### #6 — No-egress RAG appliance for DoD unclassified environments (Tradewinds)

- **What:** the `COMPLIANCE_MODE=client-data` stack with a local model, pitched on Tradewinds [S309].
- **Why:** it is open on a rolling basis, needs no clearance to pitch, and selected solutions become available to DoD buyers through rapid acquisition [S309].
- **Caveats:**
  - CMMC applies only where FCI or CUI touches your systems [S413][S414]. A customer-operated appliance keeps that minimal.
  - This is a second-tier bet. Do one pitch video; don't build a DoD pipeline yet.

**Deprioritized:**

- **T4NG2, Polaris, SEWP VI, CIO-SP:** closed or awarded vehicles [S306][S307][S318][S320].
- **SBIR:** VA isn't a participating agency [S325]. DoD SBIR remains an option later [S300][S324].
- **Generic chat SaaS:** OneGov makes it free [S206].
- **FedRAMP 20x SaaS:** defer until a customer pays for it. Class A requires a SOC 2 Type II and covers only pilot-grade use [S405].

## 4. Phased plan

### Phase 0 — Days 0–30: unblock

1. **VetCert:** submit or finish the application, with VA disability-rating proof ready, since VA determines who qualifies as a service-disabled veteran [S106]. Recertification is every 3 years [S106]. Target approval in about 30 days; recent averages were 12–15 days per SBA reporting [S103][S105].
2. **SAM.gov:** get a UEI and an active registration. Choose NAICS codes:
   - 541511 (custom programming)
   - 541512 (systems design)
   - 541519 (other IT)
   - 541715 (R&D; useful for DoD SBIR later)
3. **Free help:** enroll with your local **APEX Accelerator** (formerly PTAC) and VA's small-business office (OSDBU) **(lead: verify locally; APEX details unverified in research)**.
4. **IP hygiene** (Section 2): sign-off on background IP, and move the client folder out of the deliverable.
5. **Capability statement** (one page): SDVOSB status (pending), NAICS codes, the M-25-22-aligned differentiators, and a 2-minute demo video of offering #1 over public VA content.

### Phase 1 — Days 30–90: first revenue and a VA champion

1. **Launch offering #2** (FAR/RFO assistant) commercially. Run 10 discovery calls with SDVOSB and small-business government contractors. Goal: 5 paying firms.
2. **Build the public demo of #1:** 38 CFR Parts 3, 4 and 14 plus M21-1, running in Azure Government or GovCloud on a government-authorized model [S411][S420]. Include an eval report.
3. **Read VA's FY2027 Forecast of Contracting Opportunities** [S329] and SAM.gov sources-sought notices. Answer every relevant RFI. Answering RFIs is how you get on contracting officers' radar for set-aside decisions.
4. **Teaming:** register on SubNet and SBA's Small Business Search [S328]. Pitch #4 and #5 to 10 primes or SDVOSBs that hold VA AI work. Track whether VA's Enterprise AI Support Services solicitation is released in October 2026, and who is bidding it [S210].
5. **Adjacent market:** pick two states whose veterans departments run statewide case-management systems (e.g., Tennessee, which consolidated [S613]; New York, for its 6% SDVOB goal [S615]) and offer a 60-day pilot of #3.
6. **Tradewinds:** submit one pitch video for #6 [S309].

### Phase 2 — Months 3–12: first federal award and ATO muscle

1. **Convert a champion to a pilot.** Target a VA program office with a firm-fixed-price pilot under $350K [S102]. Once certified, the contracting officer can set it aside or sole-source it [S109].
2. **Ship the ATO kit** so a VA ATO, and the accelerated 60-day pilot path, is fast [S416][S421]:
   - SSP or SAR inputs, data-flow diagrams, asset inventory, SBOM
   - automated vulnerability scans, an ACR [S418], FIPS 140-3 notes [S419]
   - the 7332 record class [S422]
3. **Close the repo gaps from Section 2** in priority order: accessibility and ACR → Bedrock and Azure-Gov provider configuration → infrastructure as code → FIPS → SIEM audit sink → M-26-04 documentation.
4. **Keep #2 and #3 growing** for cash flow and references.

### Phase 3 — Months 12–36: scale beyond one person

1. **Sole-source follow-on:** convert the pilot into a production award with options, up to $5M at VA [S109].
2. **OASIS+ SDVOSB:** apply once you have scorable past performance; it is continuously open [S321]. Also apply for a **GSA MAS** contract, either on reaching two years in business or earlier through agency-sponsored FASt Lane [S302][S317].
3. **Scale without breaking the 50% rule:** add 1099 or teaming partners that are **themselves certified SDVOSBs**. They are similarly situated, so their work counts toward your share [S112].
4. **Mentor-protégé joint venture:** use one only if a specific larger bid needs it. You stay the managing, 51%-owning venturer [S111].
5. **Watch these:**
   - the SDVOSB sole-source limit bill (H.R. 6648) [S106]
   - VA other-transaction authority (S.1591) [S327]
   - the RFO Part 19 final rule [S114]
   - the CR26 FedRAMP transition (mandatory January 1, 2027) [S401]

## 5. Revenue model

**Every number in this section is an assumption, not a research finding.** Labor-rate and contract-size data could not be verified (see the research report, Limitations). Calibrate these against GSA CALC+ and USAspending searches for NAICS 541511 and 541512 VA awards before using them in a pitch.

| Stream                          | Year 1 (FY27) conservative / base / stretch | Year 2                      | Year 3                     |
| ------------------------------- | ------------------------------------------- | --------------------------- | -------------------------- |
| #2 FAR/RFO SaaS (commercial)    | $10K / $40K / $100K                         | $60K / $150K / $300K        | $100K / $250K / $500K      |
| #3 State/county licenses        | $0 / $50K / $150K                           | $50K / $200K / $450K        | $150K / $400K / $800K      |
| #1/#4 VA pilots and evaluations | $0 / $150K / $350K                          | $200K / $600K / $1.5M       | $500K / $1.2M / $3M        |
| #5 Subcontracts                 | $50K / $100K / $200K                        | $100K / $200K / $400K       | $100K / $300K / $500K      |
| **Total**                       | **$60K / $340K / $800K**                    | **$410K / $1.15M / $2.65M** | **$850K / $2.15M / $4.8M** |

**Capacity reality check (assumption):**

- A solo founder can bill roughly 1,500 hours a year alongside sales.
- Services revenue above about $300K–$400K a year therefore requires either license-heavy deals (#1–#3 as products) or similarly situated SDVOSB partners [S112].
- The year-2 and year-3 base cases assume both.

## 6. Risks and kill criteria

| Risk                                                          | Signal                                                             | Response                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| VetCert delayed or denied                                     | No decision by day 60                                              | Lean on #2/#3 (no certification needed); contact SBA                                             |
| No VA champion after 2 quarters                               | Zero sources-sought responses turning into meetings by month 6     | Shift federal effort to subcontracting (#5) and DoD (#6); keep the adjacent markets              |
| OneGov or VA first-party suite absorbs retrieval [S208][S210] | VA solicitations bundle knowledge retrieval with the model license | Reposition as an evaluation and assurance provider (#4), and as an integrator under whoever wins |
| Rule-of-two or sole-source changes via the RFO [S107][S115]   | Part 19 final rule text                                            | Re-plan; set-asides below the simplified acquisition threshold are statutory and survive         |
| Claims-assistance legal exposure [S601][S605]                 | Any feature that advises veterans directly or takes fees           | Do not build it; sell only to accredited representatives and offices                             |
| IP challenge from the prior engagement                        | Ambiguity in Schedule A                                            | Resolve before the first government proposal (Section 2)                                         |
| Cash flow (federal payment lag, proposal cost)                | Under 6 months of runway                                           | Keep #2 subscriptions growing; take subcontract work                                             |

**Kill criteria at month 12.** Reassess federal focus if all three hold:

- no federal award or subcontract
- fewer than 10 paying commercial subscribers
- no state pilot

## 7. Next 10 actions (this week)

1. Finish VetCert and SAM.gov; book an APEX Accelerator appointment.
2. Email the attorney: background-IP confirmation, plus the license strategy (MIT vs. proprietary).
3. Branch work: extend the eCFR connector to multiple parts and Title 48.
4. Stand up the public demo (#1) over 38 CFR Parts 3, 4 and 14 and the FAR.
5. Draft the one-page capability statement.
6. Pull VA's FY2027 forecast [S329]; shortlist 5 IT or AI line items.
7. Search SAM.gov for VA's Enterprise AI Support Services RFI and solicitation [S210]; list probable primes.
8. Line up 10 discovery calls for #2.
9. Identify the right contact at two state veterans departments for #3.
10. Record the Tradewinds pitch outline (#6) [S309].
