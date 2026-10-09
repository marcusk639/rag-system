# Selling RAG / Agentic AI to the Federal Government as a Solo SDVOSB — Research Report

**As of:** 2026-10-09 · **Mode:** deep (8-phase pipeline, 1 red-team round) · **Companion plan:** [`../SDVOSB-GOV-GTM-PLAN.md`](../SDVOSB-GOV-GTM-PLAN.md)

Citations like `[S100]` resolve to the Bibliography at the end. Each one is backed by a verbatim quote in `evidence.jsonl`, copied from a page that was actually fetched. The atomic claims and their red-team verdicts are in `claims.jsonl` (IDs like `C102`).

---

## Executive Summary

A solo SDVOSB founder with deep agentic-AI skills has a real but narrow path into federal AI revenue in late 2026. The thing that makes it narrow is not the SDVOSB status, which is strong. It is that model access has become a near-free commodity bought centrally, so a small vendor cannot win by selling "AI chat." It wins by selling the **retrieval, integration, citation, and evaluation layer** that agencies are now required to care about.

**Headline conclusions (confidence in brackets):**

1. **The SDVOSB lever is strong, especially at VA, but it only works once you are SBA-certified.**
   - VA sends about a fifth of its prime dollars to SDVOSBs (~$10.1B, 21.6% in FY2025) [S106].
   - VA must set aside work when two or more eligible veteran-owned firms can compete [S109].
   - VA can sole-source up to **$5M including options** [S109]. Government-wide SDVOSB sole-source authority is **$5M** for non-manufacturing work [S100].
   - Since 2024, both sole-source authorities require SBA certification [S100][S110].
   - VetCert reviews have recently averaged 12–15 days per SBA-sourced reporting [S103][S105]. **[High]**
2. **Demand exists and is shifting toward exactly what RAG does, but generic chat is taken.**
   - VA reports 367 AI use cases, 138 of them deployed [S200][S202]. VA GPT has 95,000+ users [S203].
   - OneGov priced Claude, ChatGPT and Gemini at roughly $1 or less per agency deal [S206][S207][S208].
   - The opening is in what OMB now requires agencies to buy for: portability, no training on agency data, testing on agency data, and new entrants [S205].
   - Oversight bodies are flagging auditability gaps in VA's AI use [S211][S212]. **[High]**
3. **The compliance barrier is lower than folklore suggests.**
   - Software installed in an agency's own cloud tenant is outside FedRAMP scope [S404].
   - A July 2026 VA IT memo says existing FedRAMP certification is not required to win VA bids, though a VA ATO still is [S416][S417].
   - VA advertises an accelerated path to an initial ATO in 60 days for pilots [S421].
   - So the cheapest route is **deploy into the customer's environment, not SaaS**. **[Medium-high]** The memo is known only through two news reports.
4. **Most big contract vehicles are closed to a brand-new firm. Three doors are open:**
   - small direct awards under the $350K simplified acquisition threshold [S102]
   - subcontracting to primes with SDVOSB goals [S328]
   - DoD's open AI marketplace, Tradewinds [S309]
   - Larger doors arrive later: GSA MAS needs two years of history unless an agency sponsors you [S302][S317], and OASIS+ is continuously open but needs past performance [S321]. **[High]**
5. **The safest revenue while certification is pending is outside the federal agencies: state veterans departments and county veterans offices, sold as a supervised tool for accredited representatives.**
   - Selling claims help directly to veterans for a fee is legally hazardous [S601][S603][S605]. **[Medium]** The legal framing is verified; market sizing is thin.

---

## Introduction

### Scope and decision

- **The question:** how a solo, newly forming SDVOSB (staff engineer, agentic-AI skills, no clearance, VetCert and SAM.gov pending) can build substantial, sustainable revenue selling RAG and agentic AI to the federal government, VA first.
- **In scope:** unclassified federal civilian work (VA first), unclassified DoD, and adjacent veteran-ecosystem markets.
- **Out of scope:** classified work and non-veteran state or local markets.

### Method

- **Six research angles:**
  - SDVOSB mechanics
  - demand
  - contract vehicles
  - compliance
  - competition and pricing
  - adjacent markets
- **Process:** each angle was researched by a separate agent and recorded as an atomic claim ledger. A three-persona red team then reviewed all 103 claims.
- **Verdicts:** 72 confirmed, 31 unverified, 0 refuted. About 35 claims were narrowed to what their quotes literally support.
- **Sources:** 104 fetched sources across 63 domains (72 primary-tier sources registered overall).
- **Deviation from the skill's tool contract:** the container's network policy denied the built-in web fetch for every government and news host. Pages were fetched with the Firecrawl and Exa connectors, and the evidence locators record which one. Angle 5 (competition and pricing) could not be re-fetched, so its claims stay **unverified leads** and appear only under Limitations.

### Assumptions

- Dollar figures are as published on the cited dates.
- FAR text is as shown on acquisition.gov under FAC 2026-01 [S100].
- "Now" means 2026-10-09.

---

## Finding 1 — What the SDVOSB status actually buys in 2026

**Thresholds** (raised on October 1, 2025):

| Threshold                                         | Value                           | Source       |
| ------------------------------------------------- | ------------------------------- | ------------ |
| Micro-purchase (FAR 2.101 exceptions aside)       | $15,000                         | [S101][S102] |
| Simplified acquisition                            | $350,000                        | [S102][S107] |
| Government-wide SDVOSB sole-source, other NAICS   | $5M (was $4M)                   | [S100][S102] |
| Government-wide SDVOSB sole-source, manufacturing | $8.5M (was $7M)                 | [S100][S102] |
| VA Veterans First sole-source (SDVOSB/VOSB)       | $5M, options included; no split | [S109]       |

- **No increase is coming yet.** As of CRS's September 8, 2026 report, bills to raise the SDVOSB sole-source limit (e.g., H.R. 6648) were pending, and none had been enacted [S106].
- **VA must look to veteran firms first.** Under Veterans First, VA considers SDVOSB set-asides before VOSB set-asides. It must set aside actions above the micro-purchase threshold when market research shows two or more eligible veteran-owned firms are likely to offer at a fair and reasonable price [S109].
- **The rule of two survived the FAR overhaul.** The Revolutionary FAR Overhaul (RFO) model deviation for Part 19 keeps it below the simplified acquisition threshold, where a statute requires it, and above it as a policy choice [S113][S115]. It makes set-asides of orders under multiple-award contracts discretionary [S115]. The above-threshold rule is regulatory rather than statutory, so a later rule could remove it [S107].
- **Certification is now mandatory.**
  - Certification moved from VA to SBA on January 1, 2023, and VA's own database was replaced by SBA's [S103][S110].
  - Since January 1, 2024, government-wide SDVOSB sole-source awards may go only to firms that SAM shows as SBA-certified [S100].
  - Self-certified firms' one-time grace period ended then [S103].
  - A further SBA rule reportedly ended self-certification for subcontracting credit after December 2024 (single secondary source, **unverified**) [S104].
- **Certification is quick.** SBA reported about 15 days on average in VetCert's first year [S103]. In November 2025 it reported clearing a backlog of 2,700+ applications, with a 12-day average [S105].
- **There is a lot of SDVOSB money.**
  - Government-wide, SDVOSBs received 5.01% of prime dollars ($32.5B) in FY2025, against a 5% goal [S106].
  - VA alone awarded about $10.1B (21.6%) to SDVOSBs in FY2025 [S106]. It reported $10.2B in FY2024, against an internal goal of 15% [S108].
- **Teaming rules:**
  - A joint venture, including a mentor-protégé JV, can bid SDVOSB set-asides and sole-source awards if the certified SDVOSB is the managing venturer and, for a separate legal entity, owns at least 51% [S111].
  - Under a mentor-protégé JV, the protégé must do at least 40% of the JV's work [S111].
  - On SDVOSB service set-asides, the prime may pay no more than 50% of what it receives to firms that are not similarly situated [S112].

**Implication:** finishing VetCert is the single highest-leverage task, because every sole-source path at VA and government-wide depends on it. The 50% services cap also fits a solo founder: the code you write is the work you perform.

## Finding 2 — Where federal AI demand is, and where it isn't

**VA demand:**

- VA's 2025 inventory lists 367 individual AI use cases plus 13 consolidated commercial ones [S200][S203].
- 138 are deployed. MeriTalk counts 72 retired, 21 in pilot and 136 in pre-deployment [S200][S202].
- The 2024 inventory had roughly 227–229 [S200][S202].
- VA GPT, VA's on-network chat tool, has more than 95,000 users onboarded [S203].
- More than 50,000 staff use commercial tools such as Copilot Chat [S201].

**Generic AI access is now nearly free and centrally bought:**

- GSA's OneGov deals priced Claude and ChatGPT at $1 for a year and Gemini at $0.47 per agency [S206][S207].
- As of late September 2026, the Claude deal was extended to October 31, 2026 [S206].
- OpenAI's deal was being replaced by a 27-month agreement at 50% off token usage [S208].
- GSA's free USAi platform has offered evaluation and chat to every agency since August 2025 [S217].
- EO 14240 pushes common IT buying toward GSA as executive agent for government-wide contracts [S216].
- On the defense side, CDAO reportedly gave four frontier labs $200M-ceiling agentic-AI awards (**unverified**: single trade source) [S214]. GenAI.mil reports more than 2M users in a week (**unverified**: single source) [S209].

**What OMB requires agencies to buy for.** OMB M-25-22 (April 3, 2025) tells agencies to:

- prefer American AI
- write in lock-in protections: knowledge transfer, data and model portability, rights to code and models
- permanently prohibit vendors from using nonpublic agency data to train publicly or commercially available models without consent
- seek out new entrants
- test vendor systems on agency-defined data [S205]

OMB M-26-04 (December 11, 2025) adds "Unbiased AI Principles" contract terms to every LLM solicitation [S215].

**Oversight is pushing toward auditable, cited systems:**

- VA's Inspector General found that VA did not treat VA GPT or Copilot Chat as high-impact, while it did treat the ambient scribe that way. It also found no AI-specific safety-event reporting [S211].
- GAO warns that using generative AI to automate disability claims could make errors hard to detect [S212].

**A live VA AI procurement:** Nextgov reports that VA planned to release, in October 2026, a final solicitation for a three-year Enterprise AI Support Services contract [S210]. Its scope includes "enterprise knowledge retrieval" and agentic tasks, while the core AI product is bought separately [S210]. This is **unverified**: one report on an RFI, with the set-aside status unknown.

**Implication:** the market a solo vendor can win is not models or chat. It is integration and retrieval over agency content that is source-grounded, model-agnostic and auditable, plus evaluation evidence. That is what M-25-22, the Inspector General and GAO all point toward.

## Finding 3 — How a new firm actually gets on contract

**Most large vehicles are closed or not realistic for a new firm:**

- **T4NG2** (VA's main IT vehicle) is an awarded, closed IDIQ. A court judgment upholding its 32 awards was reported only by counsel for one awardee (**unverified**) [S318]. Its 2023 RFP required relevant projects of at least $250K each [S319].
- **CIO-SP4** was cancelled, and CIO-SP3's last orders are due October 29, 2026 [S307][S322].
- **SEWP VI** was mid-award in 2026, with GSA intending to take it over [S320][S323].
- **Polaris SDVOSB** awards were made in phases in 2025–2026 [S306].

**Doors that are open:**

- **OASIS+** solicitations, including the SDVOSB pool, have been continuously open since January 12, 2026 with rolling awards [S321]. They require SBA certification and scored past performance, so this is a year-2 target.
- **GSA MAS fast paths need an agency sponsor.** As of April 3, 2026, Startup Springboard (which waives the two-year experience requirement) is limited to IT offers that qualify for FASt Lane and are agency-sponsored [S302]. FASt Lane itself requires a signed request from an ordering agency's contracting officer showing a compelling need [S317]. This contradicts widespread older advice: a new firm needs a customer champion first.
- **SBIR/STTR** lapsed on September 30, 2025 and was reauthorized through 2031 on April 13, 2026 [S300].
  - VA is not an SBIR agency [S325].
  - DoD lists AI and autonomy as a priority [S324].
- **Defense paths:**
  - CDAO's Tradewinds Solutions Marketplace accepts 5-minute pitch videos from U.S. small businesses on a rolling basis [S309].
  - The FY2026 NDAA reportedly widened DoD's commercial solutions openings (**unverified**) [S310].
- **VA has no other-transaction authority yet.** S.1591 would grant it, and has sat at the House desk since December 15, 2025 [S326][S327].
- **Subcontracting:**
  - Large primes must set SDVOSB subcontracting goals.
  - They post opportunities on SBA SubNet and search SBA's Small Business Search to find small subs [S328].
- **Planning:** VA publishes an FY2027 Forecast of Contracting Opportunities [S329].

**Implication:** in the first 12 months, the realistic routes are:

1. direct awards under $350K
2. subcontracting to large primes and established SDVOSBs with VA AI work
3. a Tradewinds pitch for DoD

After that, VA sole-source awards up to $5M once VetCert lands and a customer exists, then OASIS+ or a sponsored MAS award.

## Finding 4 — The compliance path for a solo vendor

**Deploying into the customer's own cloud avoids FedRAMP:**

- Under FedRAMP's 2026 rules, independent software installed in a single tenant of an agency's cloud, or deployed as "virtual on-prem" and run by the agency, is outside FedRAMP scope. Only the hosting service is in scope, and the agency decides [S404].
- The VA memo of July 28, 2026 says existing FedRAMP certification is not required to win VA bids [S416][S417].
- Vendors still need a VA ATO and must supply a security assessment report, architecture and data-flow diagrams, an asset inventory and vulnerability scans [S416][S417].
- VA's AI strategy advertises an initial VA ATO within 60 days, for pilots [S421].
- VA builds authorization packages in eMASS and reviews software through its Technical Reference Model [S415][S423].

**If you do want SaaS, FedRAMP 20x is now real but not free:**

- Phase 1 (Low pilot) received 26 packages and finished 13 reviews in 2025 [S400].
- Phase 2 (Moderate) authorized its first cohort on March 6, 2026 [S400].
- Under the 2026 Consolidated Rules (CR26), certifications are Classes A–D [S403]:
  - 20x certification needs no agency sponsor [S402].
  - Class A needs a SOC 2 Type II from the past 12 months, and fits only pilots or public, negligible-risk data [S405][S406][S408].
  - CR26 becomes mandatory January 1, 2027, and new Rev5 certifications end June 11, 2027 [S401].

**Baseline obligations either way:**

- **Accessibility:** an Accessibility Conformance Report (ACR, the government's form built on the VPAT template) against WCAG 2.0 A/AA is required for Section 508 [S418].
- **Encryption:** FIPS 140-2 validations moved to NIST's historical list on September 21, 2026, so new systems should use FIPS 140-3 modules [S419]. CR26 makes validated crypto mandatory only at Class D [S407].
- **CMMC** is DoD-only. Its clause applies to FCI and CUI data, and it is phased in through November 2028 [S413][S414].
- **Training ban:** M-25-22's prohibition on training with agency data applies to solicitations issued 180 or more days after April 2025 [S412].
- **Protected records:** VA records about substance use, HIV and sickle cell anemia are specially protected under 38 U.S.C. 7332 [S422]. Any RAG system that touches VHA clinical data has to enforce that.

**Frontier models are available inside government clouds:**

- **Azure OpenAI** is in scope in Azure Government up to FedRAMP High and IL6 [S411].
- **Gemini for Government** deploys in Assured Workloads at FedRAMP High or IL4 [S420].
- **Claude** is stated by Anthropic to be FedRAMP High and IL4/IL5 on Bedrock in AWS GovCloud [S409][S410]. This is **unverified**: vendor-only sourcing, possibly paraphrased.

**Implication:** a model-agnostic system that runs inside the customer's tenant and points at whichever government-authorized model the agency already buys is the lowest-friction product shape, and it is the shape this repository already has.

## Finding 5 — Adjacent veteran-ecosystem markets and their legal limits

**Selling claims help directly to veterans is hazardous:**

- Federal law bars charging for help with an initial VA claim. Accredited agents and attorneys may charge only after the initial decision, and fees up to 20% of past-due benefits are presumed reasonable [S601][S604].
- VA's lawyers read "preparation, presentation, or prosecution" to include advice, evidence gathering and form-filling. 38 CFR 14.629 lets unaccredited assistants help only under an accredited attorney's supervision [S601][S603].
- The criminal penalties were repealed in 2006 [S601][S624], but courts are acting:
  - In May 2026 a federal judge in North Carolina ruled that Veterans Guardian acted as an unaccredited agent and collected unlawful fees [S605][S606].
  - In January 2026 a Texas court reportedly ordered VA Claims Insider to pay $6.8M (single source) [S605].
- The GUARD VA Benefits Act (H.R. 1732) is still only "Introduced", with a hearing on March 18, 2026 [S600].
- California reportedly enacted civil penalties starting in 2027 (**unverified**) [S607], and state law is unsettled overall [S601].

**The safer market is tools for accredited representatives:**

- VA counted 13,670 accredited individuals in November 2024: 8,141 VSO representatives, 5,008 attorneys and 521 claims agents. About three-quarters of open claims had an accredited representative [S608].
- Case-management software is dominated by Tyler's VetraSpec, which claims more than 300 counties and 4,500 VSOs [S609][S610]. VetPro is next [S611].
- Seat prices are low: about $476 per user per year for VetraSpec in 2025 and about $520 for VetPro in 2026 [S610][S611].
- Purchasing is consolidating at the state level: Tennessee now pays all county licensing for a new statewide system [S613]. A 2022 Colorado audit found weak user-access controls on VetraSpec [S614].

**State preference programs:**

- California's DVBE program sets a 3% participation goal [S617][S618].
- New York's SDVOB goal is 6% of discretionary spending, with about 1,000 certified firms [S615][S616].
- Texas now runs VetHUB for Texas-resident owners with a disability rating of 20% or more [S619][S620].

**Implication:** a regulation-grounded assistant, such as 38 CFR Part 4 rating-schedule search with citations, sold to state veterans departments as a supervised tool for accredited representatives can generate revenue and references before federal awards. Price it per state or platform rather than per seat.

---

## Synthesis

The findings agree on one pattern:

- **Status:** VA's SDVOSB rules give a certified firm an unusually short path to award, with sole-source authority up to $5M [S109].
- **Demand:** VA's growing inventory, oversight findings and procurement direction pull toward auditable, retrieval-grounded AI [S200][S211][S212][S205].
- **Compliance:** the deploy-in-tenant model avoids FedRAMP and fits the memo's ATO-not-FedRAMP stance [S404][S416].

The binding constraints are elsewhere:

- **Past performance and a customer champion.** Big vehicles are closed or demand experience, and fast GSA paths need an agency sponsor [S302][S317][S321].
- **Competing with free generic chat** [S206][S208][S217].

So the strategy that fits the evidence is sequential:

1. Earn references and revenue through sub-$350K direct work, subcontracting and the state-level adjacent market.
2. Use VetCert to convert a VA champion into a sole-source or set-aside award.
3. Then climb onto OASIS+ or MAS.

## Limitations & Open Questions

- **Angle 5 (competition, pricing, new-entrant economics) could not be verified.** The page fetches failed, and none of these leads may be treated as fact:
  - reported small-firm VA AI awards (Mind Computing ~$94.8M DAS4, ReflexAI ~$17M, an SDVOSB joint venture's intended sole-source for clinical-documentation AI)
  - the VA AI Tech Sprint prize amounts
  - the "87% of registrants never win" statistic
  - NVSBE 2026 dates
  - AI and ML labor rates. **No 2025–2026 rate data was verified.** Benchmark on GSA CALC+ yourself.
- **Single-source or vendor-only claims (unverified):**
  - CDAO's $200M awards and GenAI.mil usage [S214][S209]
  - the VA Enterprise AI Support Services timeline [S210]
  - the T4NG2 judgment [S318]
  - Polaris counts [S306]
  - MAS Refresh 31, a draft [S311]
  - Claude's FedRAMP and IL coverage [S409][S410]
  - the end of SDVOSB self-certification for subcontracting credit [S104]
  - RFO automatic release from 8(a) and Part 19 rulemaking timing [S114][S115]
  - California SB 694 [S607]
- **Conflicts:**
  - The 2024 VA inventory count is 227 per Nextgov and 229 per MeriTalk [S200][S202].
  - GenAI.mil user metrics vary by report.
  - Older guidance says Startup Springboard is open to all categories; GSA's April 2026 page says otherwise, and the newer primary source governs [S302].
- **The VA memo** is known only through two outlets. FNN frames it as clarification rather than new policy [S417]. Ask VA contracting officers to confirm how it applies to a specific buy.
- **Open questions:**
  - whether the RFO Part 19 rule was published after mid-2026
  - whether VA's Enterprise AI solicitation is set aside
  - whether 2026 VetCert processing times still match the 2025 figure

## Recommendations

These are evidence-backed. The companion plan turns them into a schedule.

1. **Finish VetCert and SAM** before anything else; every VA and SDVOSB lever depends on them [S100][S109].
2. **Productize for deploy-in-customer-tenant**, with a security package ready on day one: architecture and data-flow diagrams, an asset inventory, a vulnerability scan, an Accessibility Conformance Report, FIPS 140-3 crypto, and 38 U.S.C. 7332 data handling [S404][S416][S418][S419][S422].
3. **Position around M-25-22 and the oversight findings:** model-agnostic, no training on agency data, cited answers, an evaluation harness on agency-defined data, and audit logs [S205][S211][S212].
4. **Pursue three near-term doors:** sub-$350K VA awards, prime and SDVOSB teaming (including on VA's Enterprise AI Support Services if it is real), and a Tradewinds pitch [S102][S210][S309][S328].
5. **Earn adjacent revenue** from state veterans departments and county offices as a tool for accredited representatives. Never sell claims help to veterans for a fee [S601][S603][S613].
6. **Climb to OASIS+ SDVOSB and sponsored MAS** once you have past performance and a VA champion [S302][S317][S321].

## Bibliography

See [`bibliography.md`](./bibliography.md) for all 104 fetched sources (S1xx SDVOSB mechanics; S2xx demand; S3xx vehicles; S4xx compliance; S6xx adjacent markets), with URL, publisher, date and quality tier. Unreachable or snippet-only leads remain in `sources.jsonl` with `quality: "unreachable"` and are not cited.

## Methodology Appendix

| Item                  | Value                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                  | deep                                                                                                                                                  |
| Angles                | 6 (one research agent each; angles 2 and 6 re-run after fetch failures)                                                                               |
| Sources with evidence | 104 (63 domains; floor for deep mode is 10)                                                                                                           |
| Evidence quotes       | 257 verbatim, ≤40 words, each with locator                                                                                                            |
| Claims                | 103 — 72 confirmed, 31 unverified, 0 refuted                                                                                                          |
| Red team              | 3 personas, 1 round; ~35 claims narrowed (`redteam.jsonl`)                                                                                            |
| Delta-retrieval       | Not run — fetch credits were low and the environment denied built-in fetch; unverified claims are disclosed above                                     |
| Fetch tooling         | Firecrawl / Exa connectors (built-in WebFetch blocked by environment network policy) — a disclosed deviation from the skill's built-in-tools contract |
| Ledgers               | `sources.jsonl`, `evidence.jsonl`, `claims.jsonl`, `redteam.jsonl`, `run_manifest.json` in this directory                                             |
