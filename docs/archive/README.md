---
title: Archive
status: archived
last_verified: 2026-10-21
answers: What the archived docs are, why they are kept, and where the current version of each lives.
read_when: You followed a link or grep hit into docs/archive/ and need to know whether to trust it.
---

# Archive

Everything here is a historical record. None of it describes current behaviour. Where an archived doc disagrees with
the code or a live doc, the code and the live doc are right. Each archived file starts with a `superseded_by` line
naming the live doc that replaced it. Four of them also carry a warning that their central claim was later found to
be false.

These files were archived on 2026-10-21, when `docs/` was consolidated from 116 files to about 30 live ones. Before
archiving, their unique facts were moved into the live docs. Git history holds every earlier version.

## Why keep them

- **Plans and specs** record what was intended and in what order. Their design rationale has been extracted into
  [architecture/DECISIONS.md](../architecture/DECISIONS.md). Their embedded code is a stale copy of what shipped; read
  the code instead.
- **Reviews** record what was found and when. Their open findings now live in [KNOWN-ISSUES.md](../KNOWN-ISSUES.md).
  Some code comments still cite their IDs (`ISSUES-AND-OPTIMIZATIONS.md` C3, H2, P3) as rationale.
- **History** holds superseded runbooks, incident notes and session handoffs.

## Layout

| Folder                                     | Contents                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [`reference/`](reference/)                 | `RAG-ARCHITECTURE-GUIDE.md` (merged into `architecture/ARCHITECTURE.md`)                                         |
| [`reviews/`](reviews/)                     | RAG, launch-readiness, prototype-readiness, queue, documentation and auth reviews; `ISSUES-AND-OPTIMIZATIONS.md` |
| [`evaluation/`](evaluation/)               | `EVAL-BASELINE.md` (merged into `evaluation/EVALUATION.md`)                                                      |
| [`history/`](history/)                     | Superseded deploy, Azure, backup-drill, Teams and SharePoint runbooks; CI incident; session notes                |
| [`plans/`](plans/)                         | Completed or superseded `PLAN-*` docs, CPA adoption and compliance plans, June 2026 phase plans                  |
| [`plans/superpowers/`](plans/superpowers/) | Agent-executed TDD implementation plans (July–September 2026)                                                    |
| [`specs/`](specs/)                         | Implemented or superseded design specs                                                                           |
| [`off-topic/`](off-topic/)                 | Material not about the rag-system product, kept pending a decision on where it belongs                           |

## Off-topic material

These files are not product documentation:

- `SDVOSB-GOV-GTM-PLAN.md` and `sdvosb-research/`: federal go-to-market strategy.
- `claude-plugin-recommendations.md`, `HOOK-INJECTION-FINDINGS.md` and `PLAN-HOOK-INJECTION-REMEDIATION.md`: Claude
  Code tooling.
- `timeline-weeks/`: claude-mem history dumps, which can be regenerated.
- `STAFF-BOT-ONE-PAGER.md`: firm-facing copy for an undeployed surface. Its "no client files" statement is false.
- `EMAIL-IT-TEAMS-APP-UPLOAD.md`: unsent draft correspondence.

They stay here until the owner decides where each belongs.
