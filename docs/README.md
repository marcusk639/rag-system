---
title: rag-system documentation index
status: current
last_verified: 2026-10-21
answers: Which doc answers which question, what each live doc covers, and the rules for reading and changing docs/.
read_when: Always first — before reading or editing anything else in docs/.
---

# rag-system documentation

Start here. Every live doc is listed below with the question it answers. The repo's root
[`CLAUDE.md`](../CLAUDE.md) holds the ground rules, common commands and trip-wires. These docs link to it rather than
repeating it.

## How to read these docs

- **Code wins.** When a doc disagrees with the code, the code is right; fix the doc. Every live doc's front matter
  records `last_verified` and the commit it was checked against.
- **One fact, one home.** Each fact lives in exactly one doc, and other docs link to it. If you find the same fact in
  two places, one of them is stale.
- **`UNVERIFIED:`** marks claims about production state that couldn't be checked from the repo. Each one says what
  would settle it.
- **[`archive/`](archive/README.md) is history, not current state.** Each archived file names the live doc that
  replaced it.
- **Evidence records are never edited.** They are the dated audits and decisions in `compliance/` and
  `compliance/records/`. Changes go into a new dated file or an appended `## Amendment` block. See
  [compliance/README.md](compliance/README.md).
- **People, gate numbers and acronyms** are defined in [GLOSSARY.md](GLOSSARY.md).

## Start here, by task

| If you need to…                                   | Read                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Understand how the system works                   | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md), then [RETRIEVAL.md](architecture/RETRIEVAL.md) |
| Know why something was built the way it was       | [architecture/DECISIONS.md](architecture/DECISIONS.md)                                                       |
| Call the HTTP API or the MCP server               | [reference/API.md](reference/API.md), [reference/MCP.md](reference/MCP.md)                                   |
| Add or configure a connector                      | [reference/CONNECTORS.md](reference/CONNECTORS.md)                                                           |
| Deploy or change production (Railway)             | [operations/DEPLOYMENT.md](operations/DEPLOYMENT.md)                                                         |
| Stand up a new environment from zero              | [operations/FRESH-DEPLOY-GUIDE.md](operations/FRESH-DEPLOY-GUIDE.md)                                         |
| Connect, re-sync or switch the SharePoint tenant  | [operations/SHAREPOINT-RUNBOOK.md](operations/SHAREPOINT-RUNBOOK.md)                                         |
| Grant or revoke someone's access                  | [operations/ACCESS-CONTROL.md](operations/ACCESS-CONTROL.md)                                                 |
| Back up, restore, or apply a migration by hand    | [operations/BACKUP-AND-RECOVERY.md](operations/BACKUP-AND-RECOVERY.md)                                       |
| Run generation without sending data to a vendor   | [operations/LOCAL-GENERATION.md](operations/LOCAL-GENERATION.md)                                             |
| Measure retrieval or answer quality               | [evaluation/EVALUATION.md](evaluation/EVALUATION.md)                                                         |
| Know what's blocking launch                       | [launch/LAUNCH-STATUS.md](launch/LAUNCH-STATUS.md)                                                           |
| Find what's broken or undecided                   | [KNOWN-ISSUES.md](KNOWN-ISSUES.md)                                                                           |
| Check a compliance control or a legal requirement | [compliance/CONTROL-STATUS.md](compliance/CONTROL-STATUS.md)                                                 |

## All live docs

### Top level

| Doc                                | Answers                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| [GLOSSARY.md](GLOSSARY.md)         | Who the people named in these docs are; what gate numbers, data classes and acronyms mean.   |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | Every open issue, decision needed, design not yet built, and approach deliberately rejected. |

### Architecture

| Doc                                             | Answers                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [ARCHITECTURE.md](architecture/ARCHITECTURE.md) | Packages, surfaces, ingestion pipeline, queue, schema, migrations, auth, startup gates, failure modes. |
| [RETRIEVAL.md](architecture/RETRIEVAL.md)       | Hybrid search, the `/ask` pipeline stage by stage, chunking and embeddings.                            |
| [DECISIONS.md](architecture/DECISIONS.md)       | The durable design decisions, why they were made, and what was rejected.                               |

### Reference

| Doc                                      | Answers                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| [API.md](reference/API.md)               | Every HTTP route: auth, rate limits, request and response shapes, error codes.           |
| [MCP.md](reference/MCP.md)               | The six MCP tools, the `documents://` resource, transports and their auth, client setup. |
| [CONNECTORS.md](reference/CONNECTORS.md) | Each connector's credentials, config and behaviour, and how to add a new one.            |

### Operations

| Doc                                                         | Answers                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [DEPLOYMENT.md](operations/DEPLOYMENT.md)                   | The Railway production setup: services, variables, migrations, Postgres upgrades, gotchas. |
| [FRESH-DEPLOY-GUIDE.md](operations/FRESH-DEPLOY-GUIDE.md)   | The ordered checklist for a new environment, including the Entra, Azure and Teams setup.   |
| [SHAREPOINT-RUNBOOK.md](operations/SHAREPOINT-RUNBOOK.md)   | Connecting SharePoint, running and verifying syncs, and switching tenants.                 |
| [ACCESS-CONTROL.md](operations/ACCESS-CONTROL.md)           | Who can see which sources: `API_PRINCIPALS` tokens and the database-backed grants.         |
| [BACKUP-AND-RECOVERY.md](operations/BACKUP-AND-RECOVERY.md) | Backup layers, restore and point-in-time recovery procedures, and manual migrations.       |
| [LOCAL-GENERATION.md](operations/LOCAL-GENERATION.md)       | Running answer generation on a self-hosted, OpenAI-compatible model.                       |

### Evaluation

| Doc                                                                   | Answers                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [EVALUATION.md](evaluation/EVALUATION.md)                             | How quality is measured, the eval commands and gates, and the current numbers.   |
| [EVAL-GOLD-SET-GUIDE.md](evaluation/EVAL-GOLD-SET-GUIDE.md)           | How to run the session that authors the hand-verified gold set.                  |
| [EVAL-CORPUS-GROUND-TRUTH.md](evaluation/EVAL-CORPUS-GROUND-TRUTH.md) | The corpus-grounded claims tier: what's built, what isn't, and the rules for it. |

### Launch

| Doc                                           | Answers                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| [LAUNCH-STATUS.md](launch/LAUNCH-STATUS.md)   | Current index state, deployed surfaces, and the status of every launch gate.     |
| [LAUNCH-RUNBOOK.md](launch/LAUNCH-RUNBOOK.md) | The human, legal and infrastructure procedures behind each gate, by item number. |

### Compliance

| Doc                                                             | Answers                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [README.md](compliance/README.md)                               | What this folder holds, the evidence-record rules, and the `client-data` boot requirements.  |
| [REQUIREMENTS.md](compliance/REQUIREMENTS.md)                   | The regulatory requirements (§7216, FTC Safeguards, Circular 230) as controls CR-1 to CR-20. |
| [CONTROL-STATUS.md](compliance/CONTROL-STATUS.md)               | The current status and evidence for each control, and the open legal and process items.      |
| [EXCEPTIONS-LOG.md](compliance/EXCEPTIONS-LOG.md)               | Dated exceptions to stated policy, and the decisions that accepted them.                     |
| [CONTENT-SAFETY-DESIGN.md](compliance/CONTENT-SAFETY-DESIGN.md) | How client data is kept out of the index and out of prompts, layer by layer.                 |

**Evidence records.** These are dated and never edited.

| Record                                                                                                      | What it records                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [vendor-dpa-google-gemini.md](compliance/vendor-dpa-google-gemini.md)                                       | The Gemini DPA on record. The `client-data` boot check reads this file.                                            |
| [scope-conformance-2026-09-30.md](compliance/scope-conformance-2026-09-30.md)                               | Production checked against the compliance scope, for counsel (P0 gate 2).                                          |
| [GATE-1-CONTENT-AUDIT.md](compliance/GATE-1-CONTENT-AUDIT.md)                                               | The content audit and sign-off for P0 gate 1.                                                                      |
| [records/PURGE-RECORD-2026-08-03.md](compliance/records/PURGE-RECORD-2026-08-03.md)                         | The 2026-08-03 full purge after client data was found in the index.                                                |
| [records/CPA-READINESS-ASSESSMENT-2026-07-08.md](compliance/records/CPA-READINESS-ASSESSMENT-2026-07-08.md) | The July 2026 readiness audit against the firm's requirements.                                                     |
| [records/DECISION-CPA-KB-RAG-CONVERGENCE.md](compliance/records/DECISION-CPA-KB-RAG-CONVERGENCE.md)         | The decision to adopt rag-system and retire cpa-backend.                                                           |
| [records/kb-incident-remediation-plan.md](compliance/records/kb-incident-remediation-plan.md)               | The incident-remediation prompt and its inventory of surviving copies. It is a record, not instructions to follow. |

### Specs with open work

| Doc                                                                                  | Answers                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [multi-vertical-platform.md](specs/multi-vertical-platform.md)                       | The remaining slices of the multi-vertical platform design, and the status of each. |
| [sensitive-content-discovery.md](specs/sensitive-content-discovery.md)               | The read-only discovery service. Its scanner part has shipped; the service has not. |
| [tri-identifying-pattern-exemptions.md](specs/tri-identifying-pattern-exemptions.md) | The open decision on exempting false-positive identifying TRI matches.              |

### Elsewhere

- [archive/README.md](archive/README.md): historical plans, reviews, specs and runbooks, plus off-topic material.
- [`tests/web-e2e/README.md`](../tests/web-e2e/README.md): running the browser end-to-end suite and its environment
  traps.

## Changing docs

1. **Put the fact in its one home and link to it from elsewhere.** If no live doc is the right home, add one, give it
   front matter (`title`, `status`, `last_verified`, `answers`), and add it to this index.
2. **Rewrite the wrong sentence; don't append a correction block to it.** Git keeps the history.
3. **Cite code by path and symbol, not line number.**
4. **Run `node scripts/check-docs.mjs`; CI runs it too.** It fails on:
   - a live doc missing from this index;
   - a broken relative link;
   - missing front matter;
   - a `docs/` path cited from code that doesn't exist;
   - a known-false claim.
