# Documentation Review: `docs/` tree

**Reviewed:** 2026-08-03 · **Documents:** 81 markdown files (~1.69 MB) under `docs/`
**Reviewer:** documentation-review skill (inline engine — no subagents, per standing instruction)
**Rubric:** `~/.claude/skills/documentation-review/references/rubric.md`

> **Coverage, stated honestly.** ~47 of 81 documents were read in full or in
> substantial part — every current-state document, every 2026-08 plan/spec, every
> top-level reference doc, and a representative depth-read of the historical
> `PLAN-*` pile. All 81 were covered by two mechanical sweeps: a status/date/
> supersession-marker extraction and a link-integrity resolution pass. The
> remaining ~34 are historical execution plans whose staleness pattern was
> confirmed independently in six documents; deeper reads of them would refine
> counts, not change findings. Every finding below was verified against the
> cited text or against code — none are inferred from the sweeps alone.

---

> ## ✅ HIGH + MEDIUM findings applied — 2026-08-03
>
> All 8 HIGH and all 8 MEDIUM findings below have been fixed in place across 22
> files. LOW findings (17, 19) were left; 18 and 20 were cheap enough to do anyway.
> **F-13 is partially applied** — status lines were added to the six reference
> documents and the timeline index, not to all 40 undated files; `superpowers/plans/*`
> still lack them.
>
> **Two defects were introduced by the fixes and caught by the re-review pass**,
> which is the reason that pass exists:
>
> - The staff one-pager's sign-in bullet was orphaned into a list about client
>   data, where it read as a non-sequitur. Split into its own section.
> - `PROTOTYPE-DELIVERY-OPTIONS.md`'s "nobody has confirmed…" paragraph directly
>   contradicted the correction inserted above it. Rewritten, along with
>   guardrail 3, which instructed writing a scope note asserting the falsified
>   claim.
>
> Verified after fixing: no client names in any tracked file · Prettier clean ·
> every relative link in the two new files resolves · the only surviving
> `text-embedding-004` and `no client files` matches are inside correction blocks
> quoting the old text, or in historical session logs.
>
> The findings below are preserved as written — they are the record of what was
> wrong, and several name the specific sentence that was replaced.

## Summary

The corpus is unusually well written. Individual documents show real epistemic
discipline — dated corrections, explicit supersession notes, "what this is and is
not evidence of" tables, and several places where a prior conclusion is
deliberately retracted with reasoning. `PROTOTYPE-READINESS-REVIEW-2026-08-01.md`
and `EVAL-BASELINE.md` are models of the form.

The problem is not document quality. It is **corpus mechanics**: corrections are
written into the document that _discovers_ them and never propagated to the
document that _asserts_ the error. That single pattern produces the top four
findings, and it has now reached the point where the three documents a reader is
most likely to trust — the repo README, the designated "current source of truth,"
and the one-pager handed to staff — each contain at least one claim the project
has already disproven in writing.

**The single most important thing to fix:** three documents still assert the
indexed corpus contains no client files. The firm's own corpus screen falsified
that, and the falsification is load-bearing — that sentence is the stated reason
a pilot is defensible without counsel sign-off.

## Scores

| Document                                                             | Type                | Score    | One-line verdict                                                                              |
| -------------------------------------------------------------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `PROTOTYPE-READINESS-REVIEW-2026-08-01.md`                           | Proposal/analysis   | **9/10** | Exemplary: measured not inferred, retracts its own prior conclusion, names what it did not do |
| `EVAL-BASELINE.md`                                                   | Knowledge/reference | **9/10** | Carries a dated self-correction that reverses its own headline finding                        |
| `EVAL-AND-FEEDBACK.md`                                               | Knowledge/reference | **9/10** | Honest capability table; Tier 1/Tier 2 split is well argued                                   |
| `superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md` | Plan/spec           | **8/10** | Strong design; supersedes a prior spec but leaves a competing live plan unmarked (F-4)        |
| `superpowers/plans/2026-08-03-kb-content-boundary.md`                | Plan/spec           | **8/10** | Correctly identifies F-1; its own remediation task names only 1 of 3 affected docs            |
| `EVAL-GOLD-SET-GUIDE.md`                                             | Guide               | **8/10** | Clear, well-sequenced, honest about why a CPA is required                                     |
| `ISSUES-AND-OPTIMIZATIONS.md`                                        | Knowledge/reference | **7/10** | Rich and well-maintained, but cites a document that never existed (F-6)                       |
| `PILOT-MANUAL-RUNBOOK.md`                                            | Plan/SOP            | **6/10** | Designated the remaining-work source, but ≥2 items completed elsewhere still shown open       |
| `ARCHITECTURE.md`                                                    | Knowledge/reference | **6/10** | Connector list and reranker status both wrong vs. code; undefined `CR-*` refs                 |
| `CLAUDE.md`                                                          | Knowledge/reference | **5/10** | States four apps (there are five); retired embedding model; unrelated model-tier policy       |
| `PILOT-LAUNCH-STATUS.md`                                             | Knowledge/reference | **5/10** | Self-declared source of truth carrying the corpus claim (F-1) and a stale backup status       |
| `README.md`                                                          | Guide/onboarding    | **4/10** | "Greenfield scaffold"; retired model; 4 of 6 connectors; per-package READMEs that don't exist |
| `STAFF-BOT-ONE-PAGER.md`                                             | Guide               | **3/10** | Staff-facing, undated, repeats F-1, and documents a bot that cannot be used (F-2)             |
| `DEPLOYMENT-TARGET.md`                                               | Proposal/analysis   | **2/10** | Known stale since at least 2026-07-31; still carries no marker and is still linked to (F-3)   |
| `dev-prompts.md/system-reviewer-aug-1.md`                            | —                   | **1/10** | Not documentation: a raw prompt paste in a directory misleadingly named `*.md`                |

---

## Findings

### HIGH

**1. Accuracy / currency — three documents assert the indexed corpus contains no client files; the project's own screen falsified it.**

- `PILOT-LAUNCH-STATUS.md:142-147` — _"**Verified 2026-08-01:** all 3 indexed sources are SharePoint, `data_class = general` … **no client files, no Onvio, no QuickBooks**. §7216 attaches to taxpayer data; this corpus has none, which is why a scoped pilot is defensible without counsel sign-off."_
- `PROTOTYPE-DELIVERY-OPTIONS.md:27-29` — _"There are no client files, no Onvio content, and no QuickBooks data."_
- `STAFF-BOT-ONE-PAGER.md:28` — _"It does **not** have your client files, Onvio data, or anything outside the KB."_

`corpus-analysis/client-identifier-screen.md` screened the same 858-document corpus: **355 of 858 documents carry a pattern hit**, including engagement letters, per-client billing and production analyses under a dozen client-named folders, client fee/scope deliverables, and one spreadsheet with **522 SSN-shaped and 518 EIN-shaped values**. A second SharePoint drive contributes veteran-disability claim documents with SSN hits — content not represented in the three-source table at all.

All three documents hedged correctly on the _mechanism_ (`data_class = general` is the ingestion default, not a verified judgment). They nonetheless stated the _conclusion_ in bold as verified, and built the compliance argument on it.

**Fix:** Correct all three. `superpowers/plans/2026-08-03-kb-content-boundary.md` Task 1.3 already specifies this — but names only `PILOT-LAUNCH-STATUS.md`. Add the other two, and prioritize the staff one-pager: it is the only one already distributed to people who will act on it.

---

**2. Accuracy — the staff-facing one-pager documents a Teams bot that cannot currently be used.**

`STAFF-BOT-ONE-PAGER.md:9-21` instructs staff to _"search for **the knowledge base** in the chat/search bar"_ and to `@mention` it in channels. `PILOT-LAUNCH-STATUS.md:163-172` records that the Teams bot is blocked: _"the Teams bot needs an Azure subscription the firm does not have … `az` returns `No subscriptions found`."_ `PROTOTYPE-DELIVERY-OPTIONS.md` Option 3 confirms it, and the shipped surface is the **web app** at a Railway URL — which the one-pager never mentions.

A staff member following this document finds nothing and concludes the tool is broken. The document also carries no date, no status, and no pilot-scope note (contrast every other current doc).

**Fix:** Either retarget it at the web app URL, or mark it clearly as pending the Teams deployment. Add a date and status line.

---

**3. Currency — `DEPLOYMENT-TARGET.md` is known-stale, unmarked, and still actively linked.**

It states _"## Chosen target: single VM + docker-compose"_ (D1, 2026-06-14) with no supersession banner. Two other documents already record it as wrong:

- `PILOT-LAUNCH-STATUS.md:204` — _"`docs/DEPLOYMENT-TARGET.md` is stale … the system actually runs on **Railway**."_
- `superpowers/specs/2026-07-17-platform-tenancy-and-plugin-boundary.md:77` — same correction.
- `PLAN-PILOT-READINESS-AUTOMATABLE.md` even contains an unchecked task to reconcile it.

Meanwhile `DEPLOYMENT.md:44` still routes readers _into_ it: _"See `docs/DEPLOYMENT-TARGET.md` for the deployment-target rationale (D1) and provisioning steps."_ A reader arriving via that link gets no warning.

**Fix:** Put the banner in `DEPLOYMENT-TARGET.md` itself. This is the corpus's defining failure mode — the correction exists only in the correcting document.

---

**4. Internal consistency / precedence — two live 2026-08-03 design documents specify incompatible architectures for the same problem, with no precedence marker.**

|                | `plans/2026-08-03-generic-core-and-vertical-plugin.md`                   | `specs/2026-08-03-multi-vertical-rag-platform-design.md`          |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Mechanism      | **Code plugins** — `packages/plugin-cpa/`, `PluginRegistry`, `RagPlugin` | **Data packs** — `packs/cpa/pack.yaml`, no plugin code by default |
| npm publishing | Phase 2: _"publish `@rag/core` and `@rag/rag` publicly"_                 | §7 Out of scope: _"Publishing `@rag/*` to npm … for no benefit"_  |
| First step     | Phase 1 — externalize the prompt                                         | §8.1 — slice 2, local generation, first                           |

The spec states it _"Supersedes in part"_ the 2026-07-17 tenancy spec and _"replaces its code-plugin-first mechanism with data-first packs"_ — and the plugin plan is the implementation of exactly that superseded mechanism. The plan carries **no** superseded marker.

Confirmed which one is live: `plans/2026-08-03-local-generation.md` (the newest, and the only one committed) names its **Source spec** as the multi-vertical packs design. So the plugin plan is superseded in practice and unmarked in writing.

**Fix:** Mark the plugin plan superseded, naming the spec and what carries forward (its Phase 0 discovery — the `0c` publishability audit and `0d` "cpa-consulting is not a code repo" finding — is still valid and is not duplicated in the spec).

---

**5. Accuracy — core reference docs contradict the code on connector count, reranker status, and app count.**

Verified against the tree:

| Claim                                                                                           | Where                                                                                    | Reality                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Four connectors (SharePoint, GDrive, Gmail, Outlook)                                            | `README.md:19`, `CLAUDE.md:9`, `ARCHITECTURE.md` diagram, `RAG-ARCHITECTURE-GUIDE.md:70` | **Six** + `custom`: `git-markdown` and `ecfr-part4` also ship (`packages/connectors/src/factory.ts`, `sourceKindEnum`)                                                                                             |
| _"ships four connectors out of the box"_ then documents six                                     | `CONNECTORS.md:14`                                                                       | Self-contradicting within one document                                                                                                                                                                             |
| _"Not a reranker by default … no shipped implementation. Add Cohere Rerank … when you need it"_ | `ARCHITECTURE.md:189`                                                                    | **Shipped.** `Retriever` takes a `rerank` option with pool over-fetch and soft failure; `RERANK_PROVIDER` config exists, defaults to `none`. It is _off_, not absent — the doc sends a reader to build what exists |
| _"The three backend apps (api/mcp/worker) … The fourth app, `apps/web`"_                        | `CLAUDE.md:47`                                                                           | **Five** apps — `apps/teams-bot` appears **zero** times in `README.md`, `CLAUDE.md`, or `ARCHITECTURE.md`, despite being built, merged, 43 unit tests, and the surface the firm actually asked for                 |
| _"Each package has its own `README.md` describing the module's contract"_                       | `README.md:73`                                                                           | **1 of 8** packages has one (`packages/connectors/`)                                                                                                                                                               |

**Fix:** Correct all five. The `teams-bot` omission is the most consequential — a contributor reading `CLAUDE.md` has no idea the app exists.

---

**6. Citations / evidence — documents cite a prior audit that has never existed in this repository.**

`docs/RAG-VALIDATION-REPORT.md` is cited by three documents, including as a _method_ input:

- `CPA-READINESS-ASSESSMENT-2026-07-08.md:3` — _"**Method:** … cross-referenced against two prior audits (`docs/RAG-VALIDATION-REPORT.md`, 2026-07-06 …)"_
- `ISSUES-AND-OPTIMIZATIONS.md:318` — _"See `docs/RAG-VALIDATION-REPORT.md` (2026-07-06) for the verification pass that caught the drift."_

`git log --all -- docs/RAG-VALIDATION-REPORT.md` returns **nothing** — it was never committed. Same for `docs/CPA-CONSULTING-PLAN-REVIEW.md`.

> **⛔ Correction to this finding (2026-08-03, from the follow-up review pass).**
> This finding originally also named `docs/CPA_Firm_Operations_Consultant_Briefing.md`
> — the source `PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md` rests its premise on —
> as never written. **That was wrong.** It exists at
> `cpa-consulting/docs/marcus-onboarding/CPA_Firm_Operations_Consultant_Briefing.md`;
> its §C is titled _"The knowledge base is foundational and currently unreliable"_
> and contains all four quoted gaps verbatim. The premise is verified, not
> unverifiable.
>
> The error came from checking only _this_ repository's git history for a path
> that was always cross-repo — the exact hazard this review's own Cross-Document
> Findings section flags two sections below. Worth keeping as a worked example:
> **"absent from `git log`" is not "does not exist."**

This matters more than a broken link: a reader cannot audit the chain of evidence behind a document that presents itself as verification-driven.

**Fix:** Either restore the documents, or replace the citations with what actually grounds the claims. Also missing and cited: `EVAL-ANSWER-BASELINE.md`, `PLAN-P0-GATES-EXECUTION.md`, `compliance/BREACH-IR-RUNBOOK.md`, `compliance/VENDOR-REGISTER.md`, `SESSION-2026-05-26-research.md`.

---

**7. Currency — a retired embedding model is documented as the default in four places.**

`ARCHITECTURE.md:153` states plainly: _"`text-embedding-004` is retired — always use `gemini-embedding-001`."_ Code agrees (`packages/core/src/config.ts:574` defaults to `gemini-embedding-001`). Still presenting the retired model as current:

- `README.md:64` — _"Gemini `text-embedding-004` (free) by default"_
- `CLAUDE.md:12` — _"768-dim vectors (Gemini `text-embedding-004` by default)"_
- `RAG-ARCHITECTURE-GUIDE.md:27` — _"768-dim Gemini `text-embedding-004` by default"_

A June document (`app-comparison-2026-06-21.md:28`) already has it right, so this is drift in the _maintained_ docs, not age.

**Fix:** Correct all three. Per the rubric, a retired value presented as current is HIGH.

---

**8. Currency — `README.md` describes the project as a greenfield scaffold and points at a resource that cannot exist.**

`README.md:73` — _"**Status.** Greenfield scaffold. See task list in chat for the build sequence."_

The system is deployed on Railway, auth-gated, serving a pilot, with 858 documents indexed, a proven backup/restore drill, and nightly backups running. _"See task list in chat"_ is unresolvable for any reader.

This is the repository's front door, and it is the single most misleading document in the corpus.

**Fix:** Replace with the current state and a link to `PILOT-LAUNCH-STATUS.md` (once F-1 is corrected).

---

### MEDIUM

**9. Currency — `PILOT-MANUAL-RUNBOOK.md`, designated the authoritative remaining-work source, shows completed items as open.** `PILOT-LAUNCH-STATUS.md:58` says _"Tracked in detail in `docs/PILOT-MANUAL-RUNBOOK.md`"_ and `:205` calls it _"the remaining-work source."_ But its item 3 (backup/restore) still reads _"Done when: you've personally watched a restore succeed once"_ — completed 2026-07-31 per `BACKUP-RESTORE-DRILL.md`; and item 4 (deploy `apps/web`) is framed as pending — live since 2026-08-01. **Fix:** reconcile, or demote it to background and name a single work source.

**10. Currency — the reverse direction of the same problem: `PILOT-LAUNCH-STATUS.md` is stale against `BACKUP-SCHEDULE-RUNBOOK.md`.** The runbook (2026-08-01) declares _"Stopgap LIVE since 2026-08-01 — nightly backups are running"_ and _"Closes: the open half of P0 gate #3."_ `PILOT-LAUNCH-STATUS.md` P0 #3 still reads _"A restore is proven; a backup schedule is not"_ and lists enabling volume backups as _"do this now, it is checkboxes"_ — already done. **Fix:** update P0 #3.

**11. Precedence — four documents claim authority over the same ground, none referencing the others' claims.** `plans/2026-06-26-launch-readiness-consolidated.md` (_"Active. Single source of truth"_); `PILOT-LAUNCH-STATUS.md` (_"current source of truth"_); `CPA-KB-IMPLEMENTATION-SPEC.md` (_"The authoritative master plan"_); and `PLAN-LAUNCH-READINESS.md`, which `DECISION-CPA-KB-RAG-CONVERGENCE.md:97` still tells new contributors to read — while the consolidated plan says it supersedes it. `PLAN-LAUNCH-READINESS.md` itself carries only _"Status: Draft — created 2026-06-14."_ **Fix:** one authority statement per scope, and put the superseded marker in the superseded file.

**12. Redundancy — `ARCHITECTURE.md` (18 KB) and `RAG-ARCHITECTURE-GUIDE.md` (32 KB) are two architecture documents that never reference each other.** Both open with a mental model, a pipeline diagram, and a package-layout table. They have already drifted (connector lists differ in framing; the guide carries the retired embedding model). **Fix:** merge, or state explicitly which is canonical and make the other link to it.

**13. Metadata — 40 of 81 documents carry no status, date, or owner line.** Including `ARCHITECTURE.md`, `API.md`, `MCP.md`, `CONNECTORS.md`, `DEPLOYMENT.md`, `RAG-ARCHITECTURE-GUIDE.md`, `PILOT-MANUAL-RUNBOOK.md`, `STAFF-BOT-ONE-PAGER.md`, and every `superpowers/plans/*` file. In a corpus whose central problem is knowing what is current, an undated document cannot be triaged. **Fix:** a one-line front-matter convention (`**Status:** … **Updated:** …`) applied to reference docs and plans first.

**14. Currency — `PLAN-LAUNCH-READINESS.md` and `DECISION-CPA-KB-RAG-CONVERGENCE.md` carry the F-1 premise as a live rationale.** `PLAN-LAUNCH-READINESS.md:11-12` — _"Real client data lives in **Onvio**, not the KB … §7216 is **not a launch gate** for tenant #1."_ `DECISION-CPA-KB-RAG-CONVERGENCE.md:77-82` — the same. Neither is corrected by F-1's fix list. **Fix:** include them in the F-1 sweep, or mark both superseded.

**15. Topic focus — `CLAUDE.md` carries a general-purpose model-tier policy unrelated to this repo.** Lines 118-155 describe an 80/15/5 routing rule naming _"Firebase function scaffolding"_ and _"Content calendar generation, email drafts"_ — neither exists here. It dilutes an otherwise excellent orientation document. **Fix:** move to user-level config; keep only the RAG-specific calibration below it.

**16. Discoverability — no entry point or index for 81 documents.** `README.md:50-56` lists five docs and stops. There is no map distinguishing current reference from historical plan, and the naming carries no signal — `PLAN-*` covers both complete and never-started work, and the two most current status documents (`PILOT-LAUNCH-STATUS.md`, `PROTOTYPE-READINESS-REVIEW-2026-08-01.md`) sort into unrelated parts of an alphabetical listing. **Fix:** a `docs/README.md` index with a Current / Historical split.

### LOW

**17. Naming — `docs/dev-prompts.md` is a _directory_ with a `.md` extension**, containing `system-reviewer-aug-1.md`, which is a raw unedited prompt paste (typos intact: _"sored in postgress"_, _"frindings"_, _"knolwedge"_). It is a scratch artifact, not documentation. **Fix:** move out of `docs/` or delete.

**18. Naming/consistency — `timeline-weeks/README.md` is stale and two files collide.** It claims _"430 observations across 3 ISO week(s)"_ and lists W23–W25; the directory holds five week files including a W26 and **two different W25 files** (`2026-W25-Jun15-to-Jun17.md` and `2026-W25-Jun15-to-Jun21.md`) in two different formats. **Fix:** regenerate the index; resolve the W25 duplicate.

**19. Accuracy — stale absolute paths.** `app-comparison-2026-06-21.md:3` and `CPA-KB-ADOPTION-PLAN.md:33-35` use `/Users/marcus/dev/…`; the actual root is `/Users/marcusklein/dev/…`. `CONNECTORS.md:184` hardcodes a personal absolute path as a config example.

**20. Reference validity — `ARCHITECTURE.md:144` cites "CR-1 and CR-3" with no link.** Both are defined in `CPA-COMPLIANCE-REQUIREMENTS.md`; a reader of the architecture doc has no way to know that.

**21. Domain leakage in generic docs.** `ARCHITECTURE.md:139` (_"local ONNX (CPA default)"_), `DEPLOYMENT.md:104` (_"Local embedding provider setup (CPA / §7216 compliance)"_), and `CONNECTORS.md:168-195` (a connector _"Built specifically for ingesting `veteran-disability-ai-resources`"_) sit inside documents that open by calling the system generic and source-agnostic. Tracked by the packs spec §2; noted here because the docs are the surface a new consumer reads first.

---

## Cross-Document Findings

- **The structural failure, stated once:** corrections are written into the _discovering_ document and never propagated to the _asserting_ one. Confirmed independently six times — F-1 (corpus claim), F-3 (`DEPLOYMENT-TARGET`), F-9 and F-10 (runbook and launch status, in opposite directions), F-11 (four authority claims), F-14. Every individual document is honest; the corpus is not, because honesty was recorded in the wrong place. **This is the finding to fix as a process, not one document at a time.**
- **Contradictions:** F-1 (three docs vs. the corpus screen) · F-4 (two live 2026-08-03 architectures) · F-5 (four docs vs. code on connectors/apps/reranker) · F-7 (three docs vs. `ARCHITECTURE.md` and code) · F-9/F-10 (mutually stale pair).
- **Redundancy / SSOT:** F-12 (two architecture docs) · the connector list is restated in four places with no canonical home · the eval story is spread across `EVAL-BASELINE`, `EVAL-AND-FEEDBACK`, `EVAL-GOLD-SET-GUIDE`, and `EVAL-CORPUS-GROUND-TRUTH` — these are well cross-linked and are a _good_ example of the opposite pattern.
- **Missing cross-references:** `DEPLOYMENT.md` → the Railway reality (it links only to the stale target doc) · `ARCHITECTURE.md` → `CPA-COMPLIANCE-REQUIREMENTS.md` for `CR-*` · `README.md` → `PILOT-LAUNCH-STATUS.md` for actual state · the plugin plan ↔ the packs spec.
- **Coverage gaps:** no `docs/README.md` index (F-16) · no per-package READMEs despite `README.md:73` promising them · five documents the packs spec §9 declares as deliverables are unwritten (`PACK-AUTHORING`, `DEPLOYING`, `UPGRADING`, `SETTINGS`, `LOCAL-GENERATION`) — expected, listed here so they are not mistaken for the broken references in F-6.
- **Citation ambiguity (distinct from F-6):** references such as `docs/rag/kb-design.md` and `docs/issue-synthesis/policies/…` resolve in **`cpa-consulting`**, not here. They exist and are correct, but read as local paths. Prefix them `cpa-consulting/` — most already are; the inconsistent ones are the hazard.
- **Naming consistency:** `PLAN-*` marks both completed and never-started work · `docs/plans/` and `docs/superpowers/plans/` are two plan directories with no stated distinction · date-in-filename is used in `docs/plans/` and `superpowers/` but not at top level.

## Open Questions

These need a human decision; they are not findings to fix.

1. **Does the packs spec fully supersede the plugin plan, or do parts survive?** The plan's Phase 0 discovery (packages are unpublishable as-is; `cpa-consulting` is not a code repo) is real and is not duplicated in the spec. Answer decides whether F-4 is a supersede or a merge.
2. **Is `STAFF-BOT-ONE-PAGER.md` already distributed?** If staff have it, F-1 and F-2 are a correction to send, not just an edit to make.
3. ~~**Do `RAG-VALIDATION-REPORT.md` and `CPA_Firm_Operations_Consultant_Briefing.md` exist outside this repo?**~~ **ANSWERED 2026-08-03.** The briefing exists in `cpa-consulting` and its premise checks out. `RAG-VALIDATION-REPORT.md` and `CPA-CONSULTING-PLAN-REVIEW.md` are not present anywhere under `~/dev` — the documents resting on _those two_ still need their claims re-grounded (F-6).
4. **Should the firm-specific docs stay in `rag-system/docs/`?** The plugin plan's Task 4b.2 proposes moving the content-boundary plan out; ~10 `the firm-*`/`CPA-*` documents raise the same question, and it interacts with the genericisation work.
5. **Is `docs/plans/` vs `docs/superpowers/plans/` a meaningful split?** If not, merging removes a standing source of confusion.

## Recommended Action Plan

1. **Correct the corpus claim in all three documents** — addresses F-1. Staff one-pager first. The content-boundary plan's Task 1.3 covers one of the three; widen it.
2. **Fix the staff one-pager's surface** — addresses F-2. Point at the web app or mark pending; add a date.
3. **Rewrite `README.md`'s Status, connector list, embedding model, and package-README claim** — addresses F-8, F-5, F-7. Highest ratio of reader-impact to effort in the corpus.
4. **Put supersession banners in the superseded files** — addresses F-3, F-4, F-11, F-14. `DEPLOYMENT-TARGET.md`, the plugin plan, `PLAN-LAUNCH-READINESS.md`, `CPA-KB-IMPLEMENTATION-SPEC.md`.
5. **Correct `CLAUDE.md`** — app count and `teams-bot`, embedding model, and drop the unrelated tier policy — addresses F-5, F-7, F-15.
6. **Resolve or re-ground the missing citations** — addresses F-6.
7. **Reconcile the runbook/launch-status pair** — addresses F-9, F-10.
8. **Add `docs/README.md` with a Current / Historical split** — addresses F-16, and makes F-13 tractable by giving undated documents a home.
9. **Fix `ARCHITECTURE.md`'s reranker paragraph and `CR-*` links; decide the two-architecture-docs question** — addresses F-5, F-20, F-12.
10. **Housekeeping** — `dev-prompts.md` directory, `timeline-weeks` index and W25 collision, stale absolute paths — addresses F-17, F-18, F-19.

> **A process note, since the pattern is the real finding.** Steps 1–4 all exist
> because a correction was written somewhere other than where the error lives. The
> durable fix is a rule this corpus already half-follows: _when you discover a
> document is wrong, edit that document — even if you are writing the correction
> somewhere else._ Several documents here do exactly that and are the strongest in
> the set.
