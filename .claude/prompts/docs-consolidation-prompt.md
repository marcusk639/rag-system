# Prompt: consolidate rag-system/docs for human and LLM readers

Paste everything below the line into a fresh Claude Code session started at the repo root
(`/Users/marcusklein/dev/rag-system`, not `docs/`). The digests file it relies on sits next to
this one: `.claude/prompts/docs-digests-2026-10-21.md`.

---

<role>
You are the documentation maintainer for rag-system, a production RAG service for a ~20-person CPA
firm's internal knowledge base. You are doing a one-time consolidation of `docs/`: merging
duplicates, archiving what is historical, correcting what has drifted from the code, and
reshaping what remains so that an LLM agent can find and trust the right fact on the first read.
You are working on a branch with full repo access. The code is the source of truth; the docs
are claims about it.
</role>

<context>
**Who reads these docs.** Mostly LLM coding agents (Claude Code sessions) that arrive via the
root `CLAUDE.md`, a grep hit, or a link in a code comment, and read one or two files before acting.
Second, the owner (Marcus) and occasionally counsel or firm partners for the compliance records.
An agent that reads a stale doc acts on it, so a wrong sentence costs more than a missing one.

**State of `docs/` as of 2026-10-21.** 128 files, ~36k lines, ~300k words. Nine reviewers read
every file and checked them against the code. Their findings, condensed:

- About 60% of the volume is completed implementation plans (`PLAN-*.md`, `plans/`,
  `superpowers/plans/`). Their embedded code has since drifted from what shipped, and their
  checkboxes were never ticked, so they mislead readers about current behaviour.
- The same facts live in 3 to 5 places that disagree. Examples: the SharePoint re-sync procedure
  ("item 3a") appears in five docs; there are four overlapping go-live checklists;
  `ARCHITECTURE.md` and `RAG-ARCHITECTURE-GUIDE.md` overlap heavily, and the guide copies large
  parts of the root `CLAUDE.md`.
- Living docs are layered with dated "⛔ CORRECTED" or "AMENDED" banners placed on top of the false
  text they correct. The false text remains greppable, and a reader has to work out which
  layer is current.
- Reference docs have drifted from the code. Examples: `MCP.md` says the protocol has no auth (the
  HTTP transport authenticates per session); `API.md` omits five routes and says sync conflicts
  return 500 (they return 409); "five tools/services" appears in docs while the code has six tools
  and nine service functions.
- The newest review (`RAG-QUALITY-REVIEW-2026-10-17.md`) and `LAUNCH-READINESS-REVIEW-2026-10-03.md`
  are linked from nowhere.
- Off-topic and tool material is mixed in: federal go-to-market research, Claude Code tooling
  notes, raw prompt pastes, claude-mem timeline dumps, and untracked tool files.

**Lessons from the previous cleanup (`DOCUMENTATION-REVIEW-2026-08-03.md`).** Design around these:

1. A month later, commit `2e6987e` restored five files to their pre-cleanup text, which brought
   back a false "no client files" claim, and the review's "✅ all fixed" banner kept saying
   otherwise. Fixes that no check enforces get lost, so this consolidation ships its own check
   (see `<deliverables>`).
2. Mechanical fixes held up: banners on superseded files, the index, model-name corrections. Judgement
   fixes inside long living docs and low-priority housekeeping did not. So prefer moves, deletions
   and rewrites over advice and banners.
3. Appending a correction instead of rewriting the sentence kept falsehoods alive. In a living
   doc, rewrite the sentence and let git hold the history.
4. Line-number citations went stale within weeks (`queries.ts` became `hybrid-search.ts`). Cite
   path plus symbol.
5. "Not in git log" does not mean "doesn't exist". Some cited files live in `~/dev/cpa-consulting`.
</context>

<inputs>
- `.claude/prompts/docs-digests-2026-10-21.md`: the nine reviewers' per-file digests. For each file they give
  status, unique facts, overlaps, contradictions with line refs, inbound references, and a
  recommendation. Each group ends with a "facts that must survive" list. Use it as your map, but
  treat every claim in it as a lead to re-verify against HEAD before you write it into a doc as
  current fact. Some of it will be out of date by the time you run.
- The repo itself: root `CLAUDE.md`, `apps/web/CLAUDE.md`, `env.example`, the code, `git log`.
</inputs>

<constraints>
These are real limits. Each has its reason; if a situation fits none of them, use your judgement.

1. **`docs/compliance/` keeps its path, and `vendor-dpa-*.md` keeps its naming pattern.** The
   `COMPLIANCE_MODE=client-data` boot check (`defaultCheckDpa` in `packages/core/src/config.ts`)
   globs for it, and `.dockerignore` and the Dockerfiles copy the directory into images. Renaming
   it breaks production boot in that mode.

2. **Evidence records stay byte-identical.** They are dated legal and compliance records for
   counsel and auditors. Any change goes into a new dated file, or a clearly marked
   `## Amendment YYYY-MM-DD` block appended at the end. The records:
   `compliance/vendor-dpa-google-gemini.md`, `compliance/scope-conformance-2026-09-30.md`,
   `compliance/GATE-1-CONTENT-AUDIT.md`, `PURGE-RECORD-2026-08-03.md`,
   `CPA-READINESS-ASSESSMENT-2026-07-08.md`, `DECISION-CPA-KB-RAG-CONVERGENCE.md`.
   - You may relocate the non-`compliance/` ones (for example into `compliance/records/`) with
     `git mv`, if every reference is updated.
   - Their known internal errors (for example `GATE-1` citing a nonexistent issue #82) are
     reported to the user, not fixed in place.

3. **Code and config that cite a doc path must keep resolving.** If you move or rename a cited
   doc, update the citation in the same commit. Change only comments and strings; never change
   code behaviour. Known citers (re-grep; this list may be incomplete):
   - `CLAUDE.md`, `README.md`, `SETUP.md`, `env.example`, `docker/compose.prod.yml` (cites a
     nonexistent "DEPLOYMENT.md §Encryption"), `apps/worker/Dockerfile`.
   - `packages/core/src/{content-safety,tri-scanner,config-schema,access-control,errors}.ts`.
   - `packages/db/src/{client,queries,schema}.ts`, `packages/db/src/read-only.test.ts`,
     `packages/db/drizzle/0001_*.sql`, `0008_*.sql`, `0009_*.sql`.
   - `packages/rag/src/{generation/generator,extraction/claim-extractor,extraction/claim-verification}.ts`,
     `packages/rag/src/content-scanning/ollama-scanner.ts`, `packages/connectors/src/ecfr-part4/index.ts`.
   - `apps/api/src/routes/{ask,sources,audit-log.test,ask-stream-errors.test}.ts`.
   - `tests/e2e/src/eval/{gold-set,run-gold-eval,run-real-eval}.ts`,
     `tests/e2e/src/specs/{governance-taxonomy,audit-log-parity,docs-gap-digest}.spec.ts`.
   - `scripts/{check-kb-grounding.mjs,gate1-content-audit.mjs,create-sharepoint-source.sh,extract-corpus.ts}`.
   - `.claude/skills/rag-add-provider/SKILL.md`.
     Find them all with:
     `git grep -nE 'docs/[A-Za-z0-9_./-]+\.md|[A-Z][A-Z0-9-]{3,}\.md' -- ':!docs'`.

4. **Stable IDs that code cites keep their meaning.** Code comments cite `PILOT-MANUAL-RUNBOOK`
   items 5 and 8 (`env.example`, `config-schema.ts`) and `ISSUES-AND-OPTIMIZATIONS` IDs C3, H2 and
   P3 (db code, a migration, an e2e spec). Either carry the IDs into the new doc as stable anchors,
   or update every citing comment.

5. **Don't introduce firm or client identity into tracked files, and report what's already
   there.** The root `CLAUDE.md` and a CI guard enforce de-tenanting.
   - `superpowers/plans/2026-08-03-kb-content-boundary.md` (~L240–242, ~L307) contains a staff
     roster and the firm's legal name.
   - `superpowers/plans/2026-08-03-generic-core-and-vertical-plugin.md` (~L132) contains a
     firm-name token.
   - Remove these from anything you keep or move. Tell the user they remain in git history: you
     do not rewrite history.
   - Partner first names (Chris, Doug) are already used throughout. Keep them consistent: define
     each once in the glossary by role, and don't add new personal names.

6. **Nothing leaves the repo, and nothing tracked is deleted, without the user's approval of the
   manifest (Phase 1).** Git keeps history, but the user decides what the repo is for.
   - Untracked, gitignored tool files are safe to delete once they are listed in the manifest:
     `docs/.claude/`, `docs/timeline-weeks/digests/.claude/`, `docs/.token-optimizer/`, `**/.DS_Store`.

7. **Work on branch `docs/consolidation` from up-to-date `origin/main`.** Commit one cluster per
commit, using the conventional `docs:` prefix. Do not push or open a PR until the user approves
the final report. The pre-commit hook runs prettier on `.md` files; let it reformat. Don't put
tables inside list items: prettier oscillates on them (issue #62).
</constraints>

<target_shape>
This is a proposed end state. Deviate where the content argues for it, and give the reason in the
manifest. The goal is one authoritative home per question, and a reader who can tell from the
filename and first five lines whether a doc answers their question.

```
docs/
  README.md                 Index: every doc, one line each: status, what it answers, when to read it
  GLOSSARY.md               People-by-role, gate/item IDs (P0 #2, 3a, CR-n, Class A-D), acronyms
  KNOWN-ISSUES.md           Single open-issues backlog (see deliverables)
  architecture/
    ARCHITECTURE.md         Canonical: ARCHITECTURE + RAG-ARCHITECTURE-GUIDE, minus what CLAUDE.md already says
    DECISIONS.md            ADR-style log of durable decisions + rejected alternatives (from plans/specs)
  reference/
    API.md  MCP.md          Regenerated from apps/api/src/routes and apps/mcp/src/tools
    CONNECTORS.md           Absorbs ECFR-CONNECTOR-SPIKE conclusion + SharePoint folderPath/driveId gotchas
    CONFIGURATION.md        Optional: env grouped by concern, pointing at env.example as source
  operations/
    DEPLOYMENT.md           Railway production reference + self-host appendix (absorbs DEPLOYMENT-TARGET D4)
    FRESH-DEPLOY-GUIDE.md   Ordered bring-up checklist (absorbs AZURE-DEPLOY-RUNBOOK detail, PHASE-2 gotchas)
    SHAREPOINT-RUNBOOK.md   PHASE-3-SHAREPOINT-RUNBOOK + PLAN-SHAREPOINT-GOLIVE reusable parts + the single 3a procedure
    ACCESS-CONTROL.md       CONFIGURE-PRINCIPALS + DB-backed grants (staff_source_assignments, manage-access CLI)
    BACKUP-AND-RECOVERY.md  BACKUP-SCHEDULE-RUNBOOK + BACKUP-RESTORE-DRILL; dated drill evidence as appendix
    LOCAL-GENERATION.md
  evaluation/
    EVALUATION.md           EVAL-AND-FEEDBACK + EVAL-BASELINE (post-fix numbers only) + judge-calibration spec
    EVAL-GOLD-SET-GUIDE.md  Procedure (code links here)
    EVAL-CORPUS-GROUND-TRUTH.md  Rewritten: built vs not built, rules not narrative
  launch/
    LAUNCH-STATUS.md        The one tracker: current-state header, gate table, then nothing historical
    LAUNCH-RUNBOOK.md       Human/legal/infra procedures; keep item numbers stable
  compliance/               Path frozen. README, REQUIREMENTS, CONTROL-STATUS (living CR-1..20 register),
                            EXCEPTIONS-LOG, CONTENT-SAFETY-DESIGN, evidence records unchanged, records/ for relocated evidence
  specs/                    Only specs with open work, each with a per-slice status header
  archive/
    README.md               What is here, why, and what superseded each file
    plans/ reviews/ specs/ history/ ...
```

Some files probably belong outside this repo. Propose a destination in the manifest and leave the
decision to the user:

- `plans/SDVOSB-GOV-GTM-PLAN.md` and `plans/sdvosb-research/`: business strategy, which includes
  personal certification and IP details.
- `claude-plugin-recommendations.md`, `HOOK-INJECTION-FINDINGS.md`,
  `PLAN-HOOK-INJECTION-REMEDIATION.md`: Claude Code tooling, which belongs in `~/dev/claude-config`.
- `dev-prompts.md/`: raw prompt paste.
- `timeline-weeks/`: claude-mem dumps that can be regenerated.
- `STAFF-BOT-ONE-PAGER.md`, `EMAIL-IT-TEAMS-APP-UPLOAD.md`: firm-facing copy and draft
  correspondence.

Separately, the repo root carries docs clutter that is out of scope unless the user opts in: `CODEBASE-REVIEW.md`,
`readiness-report.md`, `journey-into-rag-system.md`, `b-renamed.md`, `c.md` and
`documentation-review-artifacts/`. List them in the manifest as optional scope.
</target_shape>

<doc_standard>
Every doc that stays live (not archived, not an evidence record) meets this standard. The point
of each rule is that an agent reading one file, cold, gets the current truth and knows how far to
trust it.

- **Front matter.** Start each doc with a small YAML block, so a reader or a script can tell
  freshness and authority without reading the body:
  ```yaml
  ---
  title: Backup and recovery
  status: current # current | living-tracker | evidence | archived
  last_verified: 2026-10-21 # date you checked the content against code/prod
  verified_against: 00d13a7 # commit
  answers: How production Postgres is backed up, how to restore it, and what is still open.
  read_when: Restoring data, changing the Postgres image, or auditing backup posture.
  supersedes: [BACKUP-SCHEDULE-RUNBOOK.md, BACKUP-RESTORE-DRILL.md]
  code: [services/backup/backup.sh, docker/Dockerfile.warm-base]
  ---
  ```
- **Answer first.** The first paragraph says what the doc answers and gives the current
  bottom line. Rationale, procedure and history come after it.
- **Current state only.** Living docs state what is true now, in plain sentences. No stacked
  dated banners, no strikethrough, and no quoting the old wrong text in order to correct it.
  Superseded history goes to `archive/` or git. A short "History" section with absolute dates
  and commit hashes is fine when the history explains a present constraint (for example, why the
  TRI policy is `warn`).
- **One fact, one home.** Each fact is stated in exactly one doc, and the others link to it.
  Don't restate what the root `CLAUDE.md` already says, such as its ground rules, commands and
  gotchas; link to it instead. A copy will drift from it.
- **Cite code by path plus symbol** (`packages/db/src/hnsw.ts` `resolveEfSearch`), not by line number.
- **Absolute dates** (`2026-10-02`), never "yesterday", "next session" or "now". Define every ID,
  gate number and person-by-role on first use, or link to `GLOSSARY.md`.
- **Structure for retrieval.** Use descriptive, stable headings, because other docs and code link
  to them. Use tables for enumerable facts (endpoints, env vars, services, gate status), with short
  cells. Use numbered steps only for procedures where order matters, and give each procedure a
  "Done when" line.
- **Mark uncertainty explicitly.** Write `UNVERIFIED:` with what would settle it. Don't present
  a guess as fact. Write "not yet decided" rather than inventing a decision.
- **No embedded agent instructions.** Directives like "REQUIRED SUB-SKILL", "agentic workers
  must…" or paste-ready prompts don't belong in docs. A docs-reading agent may execute them as
  if they were its own task.
- **Size by question, not by topic.** If a doc is past ~400 lines, it is usually answering two
  questions; split it.
- **No secrets, and no operational identifiers beyond what an operator needs.** Production URLs,
  the Railway project ID and Entra object IDs may stay in operations docs. Tokens and keys never
  appear.
  </doc_standard>

<process>
Work in four phases. Stop after Phase 1 for the user's approval, because the manifest decides what
gets deleted, moved out of the repo or archived, and those calls are the user's.

**Phase 0: ground truth.**

- Branch from `origin/main`.
- Re-run the inventory, the link graph and the inbound-reference grep in constraint 3, and diff
  the results against the digests.
- Re-verify the specific contradictions you will settle, using code as the arbiter. The digests
  list them with line refs. These matter most:
  - Which services read `MS_*`. The digests found `rag-worker` (connectors) and `rag-web` (Graph),
    but not `rag-api`.
  - Whether `rag-mcp` needs `API_PRINCIPALS`. It does: `apps/mcp/src/main.ts` uses
    `buildAuthProvider`. The 3a procedure was corrected for this and for `MS_*` on 2026-10-21; confirm the fix
    is present in every copy of 3a you merge.
  - The real HTTP routes, status codes and rate limits; the MCP tool list and its auth model.
  - Queue semantics: per-page continuation, a 1800 s expiry, the singleton policy.
  - Index size: 47 vs 48 docs, 210 vs 211 chunks.
  - DPA status: billing-verified, with counsel review outstanding.
  - TRI policy: the code default is `block`; production runs `warn`.
  - Whether Class C and D collapse in `sources.data_class`.
  - The production generation model alias.
  - The backup size floor (`BACKUP_MIN_BYTES` defaults to 10 MB) vs the 1.2 MiB nightly artifacts.
- Where production state can't be checked from the repo, mark it `UNVERIFIED` and don't guess.

**Phase 1: manifest. Then stop.** Write `docs-consolidation-manifest.md` outside `docs/` (in your
scratchpad, or the repo root, removed before the PR) and present it to the user. It contains:

1. One row per existing file: path · action (keep / rewrite / merge→target / archive /
   move-out-proposed / delete) · destination · reason.
2. A fact ledger. For every file being merged, archived or deleted, list the unique facts that
   must survive and the exact destination section for each. Mark any fact you are deliberately
   dropping as stale, with the evidence. This ledger is how Phase 3 proves nothing was lost.
3. Contradictions and how you resolved each, with the code evidence.
4. Inbound-reference updates (file → old path → new path).
5. The open questions that only the user can answer: what moves out of the repo and where; the
   optional root-level scope; anything you couldn't verify.
6. The commit plan, in order.

Then ask the user to approve or edit the manifest. Don't start Phase 2 until they do.

**Phase 2: execute, one cluster per commit.** Suggested order:

1. Tool-file cleanup.
2. Archive moves (`git mv`, so history follows the file).
3. Each merge cluster:
   - architecture
   - reference
   - operations
   - backup
   - evaluation
   - launch
   - compliance living docs
   - known issues
   - decisions
4. Inbound-reference updates.
5. `README.md` and `GLOSSARY.md`.
6. The check script.

Independent clusters can go to parallel subagents if you have them. Give each one its slice of
the fact ledger and the `<doc_standard>`, and review its output against the ledger before you
commit. When you merge, write the destination doc fresh from the verified facts. Concatenating
the sources and trimming keeps their contradictions.

**Phase 3: verify.** All of these must pass before you report:

- Every fact-ledger entry is present at its destination, or recorded as dropped-with-reason.
- `node scripts/check-docs.mjs` passes (see deliverables).
- Every doc path that code cites resolves, and `git grep` finds no reference to a moved path.
- `pnpm format:check` is clean, and the pre-commit hooks pass on every commit.
- The evidence records are byte-identical to `origin/main` (`git diff origin/main -- <file>`
  is empty), except for appended amendment blocks.
- A cold-read test. Spawn a fresh subagent with no context, give it only `docs/README.md`, and ask
  it five questions that need different docs:
  - Which services need `MS_*`?
  - How do I restore Postgres to a point in time?
  - What is the current status of P0 gate 2?
  - What does `POST /sources/:id/sync` return when a sync is already running?
  - Why is `GENERATION_TRI_POLICY` set to `warn`?

  Check its answers against the code. A wrong answer means a doc or the index is failing; fix it.

**Phase 4: report.** Give the user:

- the before and after (file count, line count, live vs archived);
- what moved where;
- the fact-ledger outcome;
- the contradictions you settled;
- the findings you could not fix in place (evidence-record errors, firm data left in git history,
  production values marked UNVERIFIED);
- the proposed PR description.

Push and open the PR only after they approve.
</process>

<deliverables>
- **`KNOWN-ISSUES.md`.** A single backlog of open issues. Sources: `RAG-QUALITY-REVIEW-2026-10-17`
  (the newest; use it as the primary source), the open parts of `RAG-REVIEW-2026-09-16` (§9, §11.2,
  §11.3), `ISSUES-AND-OPTIMIZATIONS`, `LAUNCH-READINESS-REVIEW-2026-10-03`, and the open items in
  the archived plans (the digests list about 40 of them, deduplicated). Layout:
  - One table row per issue: stable ID · area · severity · status (`open` / `decision-needed` /
    `deferred: <unblocker>`) · code location (path plus symbol) · source · last verified.
  - Separate sections for **Decisions needed** (owner calls) and **Deliberately not doing**
    (rejected approaches and why: LangChain, HyDE/multi-query, semantic caching as a
    cross-principal risk, Graph RAG for phase 1, BaseConnector, and so on).
  - Resolved items are not listed. Git and the archived reviews hold them.
- **`architecture/DECISIONS.md`.** Durable decisions extracted from plans and specs before they
  are archived, each with date, decision, why, rejected alternatives and status. The digests'
  "design rationale to keep" sections give the candidates. Among them:
  - the scope-assertion JWT design;
  - Teams channel-scope intersection;
  - per-tenant isolated deployments (D5);
  - core enforces while packs supply policy;
  - redaction as an egress control, not a confidentiality control;
  - the identifying vs contextual scanner split;
  - conversation memory decision B0;
  - the pg-boss choice and its outgrow triggers;
  - originals in object storage, with 404-not-403;
  - Drizzle journal `when` gating;
  - the singleton-policy finding.
- **`launch/LAUNCH-STATUS.md`.** The single tracker. It opens with:
  - one verified corpus/state table;
  - one gate table (gate · status · owner by role · blocker · evidence link · last verified).

The 3a procedure lives once, in `operations/SHAREPOINT-RUNBOOK.md`, checked against the
Phase 0 findings.

- **`scripts/check-docs.mjs` plus a colocated test** (repo convention: test first). It fails when:
  - a live doc under `docs/` (outside `archive/` and evidence records) is missing from
    `docs/README.md`;
  - a relative link in `docs/` doesn't resolve;
  - a live doc lacks valid front matter;
  - a doc path cited from code (constraint 3's grep) doesn't exist;
  - a live doc contains a known-false phrase: start the list with `no client files`,
    `RAG-VALIDATION-REPORT.md`, `/Users/marcus/`, `text-embedding-004` (except inside a "retired"
    warning), and `PropelAuth`.

  Wiring it into the pre-commit hook or CI changes shared tooling, so propose that in the manifest
  and do it only if the user approves.
  </deliverables>

<success_criteria>
You're done when:

- A cold agent can answer the five Phase 3 questions correctly from `docs/README.md` alone.
- Every live doc has a single clear purpose, valid front matter and current content.
- No fact is stated in two live docs.
- Every unique fact in the ledger survived or was dropped with evidence.
- The evidence records are untouched.
- Every code-cited path resolves.
- The new check passes, and would have caught the `2e6987e` regression.

Expect the live set to be roughly 25–35 docs, with the rest archived or moved out. Treat that as
a sanity check, not a target.
</success_criteria>
