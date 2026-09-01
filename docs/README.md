# Documentation index

**Updated:** 2026-08-03 · 80+ documents live here, and most of them are history.
This page exists so you can tell which is which.

> **The one rule this corpus keeps breaking.** When you find that a document is
> wrong, **edit that document** — even when you are writing the correction
> somewhere else. Several documents here discovered an error, recorded it in
> their own text, and left the wrong document untouched for weeks. That is how a
> reader ends up trusting a stale claim in a file nobody thought to update.

---

## Start here

| If you want to know…                            | Read                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| What is deployed, what is broken, what is gated | [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md)                                     |
| How the system works                            | [`ARCHITECTURE.md`](./ARCHITECTURE.md) — canonical                                       |
| How to change the code without breaking it      | [`RAG-ARCHITECTURE-GUIDE.md`](./RAG-ARCHITECTURE-GUIDE.md) — engineering companion       |
| What the known defects are, ranked              | [`PROTOTYPE-READINESS-REVIEW-2026-08-01.md`](./PROTOTYPE-READINESS-REVIEW-2026-08-01.md) |
| What the standing engineering backlog is        | [`ISSUES-AND-OPTIMIZATIONS.md`](./ISSUES-AND-OPTIMIZATIONS.md)                           |
| Where the documentation itself is wrong         | [`DOCUMENTATION-REVIEW-2026-08-03.md`](./DOCUMENTATION-REVIEW-2026-08-03.md)             |

⚠ **Never read a `PLAN-*.md` checkbox as a status signal.** Those files are
execution guides, not trackers; several are ~1% checked with the work long since
complete. Status lives in `PILOT-LAUNCH-STATUS.md`.

---

## Current — reference

Describes how the system works today. Should be correct; correct it if not.

| Document                                                             | Covers                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md)                               | System model, data flow, design tradeoffs. **Canonical.**   |
| [`RAG-ARCHITECTURE-GUIDE.md`](./RAG-ARCHITECTURE-GUIDE.md)           | Repo layout, conventions, gotchas. Subordinate to the above |
| [`API.md`](./API.md)                                                 | HTTP endpoint reference                                     |
| [`MCP.md`](./MCP.md)                                                 | Agent-facing tool reference                                 |
| [`CONNECTORS.md`](./CONNECTORS.md)                                   | All six connectors: auth, config, gotchas                   |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md)                                   | Production deployment; Railway is the live target           |
| [`CONFIGURE-PRINCIPALS.md`](./CONFIGURE-PRINCIPALS.md)               | Per-token source-ID access control                          |
| [`CPA-COMPLIANCE-REQUIREMENTS.md`](./CPA-COMPLIANCE-REQUIREMENTS.md) | The CR-1…CR-20 control matrix. Cited across the corpus      |

## Current — status and operations

| Document                                                                                                   | Covers                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md)                                                       | **The status source.** Deployed surfaces, P0/P1/P2 gates                                                         |
| [`PILOT-MANUAL-RUNBOOK.md`](./PILOT-MANUAL-RUNBOOK.md)                                                     | Procedure for the human/legal/infra items. Not a status source                                                   |
| [`BACKUP-SCHEDULE-RUNBOOK.md`](./BACKUP-SCHEDULE-RUNBOOK.md)                                               | Backup layers and what each does and does not cover                                                              |
| [`BACKUP-RESTORE-DRILL.md`](./BACKUP-RESTORE-DRILL.md)                                                     | The proven restore procedure, incl. applying a migration by hand                                                 |
| [`AZURE-DEPLOY-RUNBOOK.md`](./AZURE-DEPLOY-RUNBOOK.md)                                                     | Entra + Azure Bot setup for web and Teams                                                                        |
| [`plans/2026-06-26-launch-readiness-consolidated.md`](./plans/2026-06-26-launch-readiness-consolidated.md) | **Active** — priority and sequencing only. Its §7216 reconciliation rests on a falsified premise; see its banner |
| [`DECISION-CPA-KB-RAG-CONVERGENCE.md`](./DECISION-CPA-KB-RAG-CONVERGENCE.md)                               | Live decision memo (build on `rag-system`). One falsified premise in §5, flagged in place                        |
| [`PROTOTYPE-DELIVERY-OPTIONS.md`](./PROTOTYPE-DELIVERY-OPTIONS.md)                                         | Ranked delivery surfaces. Carries a corrected compliance premise                                                 |
| [`STAFF-BOT-ONE-PAGER.md`](./STAFF-BOT-ONE-PAGER.md)                                                       | ⛔ **Not for distribution** — describes an undeployed surface                                                    |
| [`compliance/`](./compliance/)                                                                             | DPA artifacts. The Gemini DPA is **PROVISIONAL, not counsel-confirmed**                                          |

## Current — evaluation

A well-cross-linked set; read in this order.

| Document                                                       | Covers                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| [`EVAL-AND-FEEDBACK.md`](./EVAL-AND-FEEDBACK.md)               | The design: four mechanisms, the Tier 1 / Tier 2 split |
| [`EVAL-BASELINE.md`](./EVAL-BASELINE.md)                       | The numbers, and why they do not yet mean much         |
| [`EVAL-GOLD-SET-GUIDE.md`](./EVAL-GOLD-SET-GUIDE.md)           | How to run the session that unblocks retrieval tuning  |
| [`EVAL-CORPUS-GROUND-TRUTH.md`](./EVAL-CORPUS-GROUND-TRUTH.md) | Design for a third scoring tier. Not built             |

## Current — reviews and analysis

| Document                                                                                 | Covers                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`PROTOTYPE-READINESS-REVIEW-2026-08-01.md`](./PROTOTYPE-READINESS-REVIEW-2026-08-01.md) | End-to-end defect review, severity-scored. Several fixed          |
| [`ISSUES-AND-OPTIMIZATIONS.md`](./ISSUES-AND-OPTIMIZATIONS.md)                           | Standing backlog with resolution history                          |
| [`DOCUMENTATION-REVIEW-2026-08-03.md`](./DOCUMENTATION-REVIEW-2026-08-03.md)             | This corpus, reviewed                                             |
| [`QUEUE-ARCHITECTURE-REVIEW.md`](./QUEUE-ARCHITECTURE-REVIEW.md)                         | Advisory: keep pg-boss. Still valid                               |
| [`HOOK-INJECTION-FINDINGS.md`](./HOOK-INJECTION-FINDINGS.md)                             | Tooling security investigation, self-corrected                    |
| [`CPA-READINESS-ASSESSMENT-2026-07-08.md`](./CPA-READINESS-ASSESSMENT-2026-07-08.md)     | Broad gap audit. Many items since resolved; cites one missing doc |

## Active design and plans (2026-08)

| Document                                                                                                                                                           | Status                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [`superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md`](./superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md)                       | **The live platform design** — data-first vertical packs    |
| [`superpowers/plans/2026-08-03-local-generation.md`](./superpowers/plans/2026-08-03-local-generation.md)                                                           | Slice 2 of that spec. Committed, ready                      |
| [`superpowers/plans/2026-08-03-kb-content-boundary.md`](./superpowers/plans/2026-08-03-kb-content-boundary.md)                                                     | **Do first** — removes client data from the live index      |
| [`superpowers/plans/2026-08-01-reranking-and-conversation-memory.md`](./superpowers/plans/2026-08-01-reranking-and-conversation-memory.md)                         | In flight                                                   |
| [`superpowers/plans/2026-08-03-generic-core-and-vertical-plugin.md`](./superpowers/plans/2026-08-03-generic-core-and-vertical-plugin.md)                           | ⛔ Superseded by the packs spec. Read its §0 discovery only |
| [`superpowers/specs/2026-07-17-platform-tenancy-and-plugin-boundary.md`](./superpowers/specs/2026-07-17-platform-tenancy-and-plugin-boundary.md)                   | Superseded in part; its three-layer model carries forward   |
| [`superpowers/specs/2026-07-11-generic-document-classification-engine-design.md`](./superpowers/specs/2026-07-11-generic-document-classification-engine-design.md) | Absorbed into the packs spec                                |

---

## Historical

Kept for their reasoning, their copy-this-pattern references, and the record.
**None of them describes current state.** Several carry supersession banners.

- **Superseded planning:** [`PLAN-LAUNCH-READINESS.md`](./PLAN-LAUNCH-READINESS.md) ⛔ · [`CPA-KB-IMPLEMENTATION-SPEC.md`](./CPA-KB-IMPLEMENTATION-SPEC.md) ⛔ · [`DEPLOYMENT-TARGET.md`](./DEPLOYMENT-TARGET.md) ⛔ · [`CPA-KB-ADOPTION-PLAN.md`](./CPA-KB-ADOPTION-PLAN.md) · [`app-comparison-2026-06-21.md`](./app-comparison-2026-06-21.md)
- **Completed execution plans:** `PLAN-KB-SYNC.md` · `PLAN-POST-MERGE-FOLLOWUPS.md` · `PLAN-HOOK-INJECTION-REMEDIATION.md` · `PLAN-FIVE-SYSTEMS.md` (+ `-RESUME`) · `plans/2026-06-26-phase-a-7216-architecture.md` · `plans/2026-06-23-test-fixtures-package.md`
- **Partially executed / stale checkboxes:** `PLAN-PILOT-READINESS-AUTOMATABLE.md` (17 tasks — recorded complete in `PILOT-LAUNCH-STATUS.md`, boxes unchecked here) · `PLAN-SHAREPOINT-READINESS.md` · `PLAN-SHAREPOINT-GOLIVE.md` · `PLAN-PER-PAGE-REENQUEUE.md` · `PLAN-CPA-COMPLIANCE.md` · `PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md` (its premise **is** verified — the source briefing lives in `cpa-consulting`; one secondary source is missing) · `PLAN-CHAT-FRONTEND.md` · `PLAN-LIVE-DEPLOY-AND-CHAT-UI.md` · `HARDEN-SEARCH-INDEX-GUARDS.md` · `plans/2026-06-21-prelaunch-hardening-plan.md` · `plans/2026-06-22-phase-g3-retrieval-quality.md`
- **Runbooks for one-time events:** `PHASE-2-RAILWAY-RUNBOOK.md` · `PHASE-3-SHAREPOINT-RUNBOOK.md` · `PHASE-3-FIRST-SYNC-RESUME.md`
- **Research and spikes:** `AUTH-AND-SESSIONS-RESEARCH.md` · `ECFR-CONNECTOR-SPIKE.md` · `SESSION-2026-05-26.md` (greenfield checkpoint; its "read this first" advice is long obsolete)
- **Earlier superpowers plans/specs:** `superpowers/plans/2026-07-{06,15,16}-*` · `superpowers/specs/2026-07-{06,16}-*`
- **Session logs:** [`timeline-weeks/`](./timeline-weeks/) — generated observation logs; the index is stale and two W25 files overlap

---

## Known gaps in this corpus

Tracked in [`DOCUMENTATION-REVIEW-2026-08-03.md`](./DOCUMENTATION-REVIEW-2026-08-03.md); listed here so they are not rediscovered.

- **Cited but not found anywhere:** `RAG-VALIDATION-REPORT.md`, `CPA-CONSULTING-PLAN-REVIEW.md`, `EVAL-ANSWER-BASELINE.md`, `PLAN-P0-GATES-EXECUTION.md`, `compliance/BREACH-IR-RUNBOOK.md`, `compliance/VENDOR-REGISTER.md`. **Only the first two carry a warning in their citing documents so far** — `ISSUES-AND-OPTIMIZATIONS.md`, `CPA-READINESS-ASSESSMENT-2026-07-08.md`, and `PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md`. The rest are still cited without one, in `superpowers/plans/2026-07-16-e2e-autopilot-and-feedback.md` and `PLAN-CPA-COMPLIANCE.md`.
- **Cited as local but actually cross-repo:** `CPA_Firm_Operations_Consultant_Briefing.md` **does exist**, at `cpa-consulting/docs/marcus-onboarding/`. It was briefly and wrongly listed here as missing. Same shape as the `docs/rag/…` citations below — check `~/dev/cpa-consulting` before concluding a document is gone.
- **Planned but unwritten** (deliverables of the packs spec §9): `PACK-AUTHORING.md`, `DEPLOYING.md`, `UPGRADING.md`, `SETTINGS.md`, `LOCAL-GENERATION.md`.
- **Cross-repo citations:** paths like `docs/rag/kb-design.md` and `docs/issue-synthesis/policies/…` resolve in **`cpa-consulting`**, not here. Prefix them `cpa-consulting/`.
- **`dev-prompts.md/`** is a directory with a `.md` extension holding a raw prompt paste. It is not documentation.
- **Only 1 of 8 packages has a README**, though the root `README.md` used to claim all did.
