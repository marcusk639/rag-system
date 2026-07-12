# TWK Readiness — Manual Intervention Runbook

**Audience:** Marcus, acting as the de facto technical/ops lead for this engagement — not a CPA, not an attorney. Every item below requires human judgment, a business/legal decision, real infrastructure access, or another person's domain expertise (Doug's, Chris's, or counsel's) — none of it can be done by writing code, and none of it should be silently resolved by an AI agent on your behalf.

**Companion document:** `docs/PLAN-TWK-READINESS-AUTOMATABLE.md` — everything that IS a code/test/config fix lives there instead. Where an item below depends on that plan (or vice versa), it's called out explicitly.

**How to use this:** Work items in the stated order within each priority tier — later items in P0 generally depend on earlier ones being at least started. Each item has a **Why**, an **Exact steps** section, a **Done when** checkpoint, and a **Depends on / blocks** line. Nothing here is legal advice; item 2 exists specifically because you need real legal advice, not this document's approximation of it.

---

## P0 — STOP: these are gates, not backlog

Per the original 2026-07-04 reconciliation document's own framing, items 1-3 below are **hard gates** — nothing about this KB bot should proceed past internal planning/demo until they're resolved. This isn't a priority ranking where P0 just means "do first"; it means "do not treat this as anything beyond an internal, unapproved pilot until these are done."

### 1. Audit what's actually indexed today

**Do this WITH Chris or Doug, not solo.** You (Marcus) are an external consultant — recognizing an SSN or EIN in a document is universal, but reliably telling a de-identified research memo apart from an actual client engagement file often requires firm-specific/CPA context you may not have. Pull Doug or Chris in for the actual folder-by-folder review in step 2-3 below rather than making this judgment call alone.

**Why:** The technical classification gate that's supposed to block client-confidential content isn't wired yet (`docs/PLAN-TWK-READINESS-AUTOMATABLE.md` Task 1 fixes the code; until it ships AND you've confirmed what's already synced, you don't actually know what's sitting in the database). This is the single fastest way to find out whether there's already a problem, independent of any code fix.

**Exact steps:**

1. Get a list of every currently-configured source. From a machine with database access:
   ```bash
   psql "$DATABASE_URL" -c "SELECT id, kind, name, data_class, created_at FROM sources ORDER BY created_at;"
   ```
2. For every SharePoint source in that list, open the actual SharePoint site/folder it points at (the `config` JSON column on the `sources` row has the site/folder identifiers — cross-reference against your own knowledge of what's in the firm's SharePoint) and manually look at the folder contents.
3. For each folder, answer honestly: does it contain ONLY firm-internal SOPs, templates, or de-identified research notes? Or does it contain (even mixed in) client engagement files, tax workpapers, client correspondence, or anything with a client's name/SSN/EIN attached?
4. If you find anything questionable in a folder that's already synced: **pause that source's sync immediately.** The tooling for this already exists and works:
   ```bash
   # Via the API (replace <source-id> and use an admin token):
   curl -X DELETE "$RAG_API_URL/sources/<source-id>" -H "Authorization: Bearer $ADMIN_TOKEN"
   ```
   or use the MCP `purge_source` tool from an admin session. This is destructive (deletes the source and everything ingested from it) — that's the correct response if something client-confidential got in, not an overreaction.
5. Write down, in one page, exactly what you found: which sources are clean, which were paused, and why. Keep this note — it's the honest record you'd want to have if this question ever comes up later.

**Done when:** every currently-configured source has been manually eyeballed once, and anything questionable has been paused. This doesn't need to be perfect forever — it needs to be true right now, before anyone relies on the system.

**Depends on / blocks:** Independent of the code plan — do this regardless of when Task 1 (the classification-gate code fix) ships, since Task 1 only prevents FUTURE misclassified ingests; it does nothing for content already sitting in the database today.

---

### 2. Get real counsel review and notify the carrier

**Why:** `docs/compliance/vendor-dpa-google-gemini.md`'s own status line says "PROVISIONAL — NOT COUNSEL-CONFIRMED." Every compliance document in this project (`compliance-scope.md`, the partner-review proposal) has said from the start that this step is required before real deployment, and there's no evidence in any repo that it's happened yet. §7216 carries criminal penalties; Circular 230 violations carry suspension/disbarment from IRS practice; GLBA violations carry FTC enforcement. This is not a step to skip or defer.

**Exact steps:**

1. Identify a tax-practice attorney (the firm may already have one on retainer, or ask Chris who the firm uses for other legal matters — a tax-practice specialist is strongly preferred over general business counsel given the §7216/Circular 230 specifics).
2. Send them: `~/dev/cpa-consulting/docs/rag/compliance-scope.md` (or wherever the current version lives) and `~/dev/cpa-consulting/deliverables/kb-bot-partner-review.md`. Ask specifically:
   - Is the standard, non-negotiated Google Cloud DPA (`docs/compliance/vendor-dpa-google-gemini.md` describes it) legally adequate for processing firm-internal SOPs and de-identified research notes, given this practice's §7216/GLBA risk profile — or is a negotiated/enterprise agreement required?
   - Does anything in the described architecture (self-hosted Postgres, citation-based audit trail, Class A/B-only Phase-1 scope) need to change to be defensible?
   - Sign off (or don't) in writing — get this in an email or a short memo, not just a phone call, so there's a paper trail.
3. Separately, call the firm's professional-liability insurance carrier. Tell them: the firm is piloting an internal AI tool that answers staff questions from firm SOPs (not client data), self-hosted, with an audit trail. Ask whether this needs to be formally disclosed under the policy, and get their answer in writing (a follow-up email restating what was said on the call is enough).
4. Update `docs/compliance/vendor-dpa-google-gemini.md`'s status line from "PROVISIONAL — NOT COUNSEL-CONFIRMED" to "CONFIRMED" with the actual date and the attorney's name, once (3) is done. (This specific edit — changing that one line once you have a real answer — is a fine thing to ask an AI agent to do for you; getting the actual answer is not.)

**Done when:** you have written confirmation from both counsel and the carrier, and the vendor-DPA doc's status line reflects it accurately.

**Depends on / blocks:** Blocks everything else — per the original 2026-07-04 reconciliation document, this and item 1 are the two hard gates nothing else should proceed past.

---

### 3. Verify the database backup/restore path actually works

**Why:** `docs/PLAN-TWK-READINESS-AUTOMATABLE.md` doesn't build this for you (a backup-and-restore drill requires real Railway production access and a willingness to actually test a restore, which isn't something to automate blindly), but the assessment found this is currently unverified — the sole store for chunks, embeddings, sources, and the compliance audit log has no confirmed, tested recovery path.

**Exact steps:**

1. Log into the Railway dashboard for this project. Find the `rag-postgres` service (confirmed to be a raw Docker image on a Railway volume, not Railway's managed Postgres plugin — this matters because managed-plugin automatic backups may not apply here).
2. Check whether Railway's volume-snapshot feature is enabled for this specific volume, and if so, how far back snapshots go and how they're restored. If it's not enabled, enable it, or set up a scheduled `pg_dump` yourself (a simple cron-triggered Railway job running `pg_dump $DATABASE_URL | gzip > backup-$(date +%F).sql.gz` uploaded to any object storage works, and doesn't require Claude Code to build anything new — it's a few lines of shell in a scheduled Railway service).
3. **Actually run a restore drill once**, against a throwaway/staging database, not production: take today's backup, spin up a fresh empty Postgres instance somewhere (a local Docker container is fine for this drill), restore into it, and confirm the app can boot against the restored data and a `/search` query returns real results.
4. Write down what you did and what worked, so the next person (possibly future-you) doesn't have to rediscover this from scratch.

**Done when:** you've personally watched a restore succeed once, not just confirmed a backup file exists.

**Depends on / blocks:** Independent of the code plan. Do this before any real client-adjacent content enters the pipeline (even Class A/B content is worth not losing).

---

## P1 — close before adding a second real user beyond the smallest possible internal check

### 4. Deploy `apps/web` — supersedes the earlier MCP-tradeoff framing

**Why this item changed (2026-07-11):** this item originally framed "how does Doug reach the system" as a forced choice between two bad MCP options (a shared admin credential on his laptop, or per-user token/client setup). That framing predates a fact a fresh audit just surfaced: **`apps/web` — a full web chat app with Microsoft Entra ID (Office 365) SSO, already merged to `main`, already reviewed, working tree clean — already solves this.** Doug signs in with the same Microsoft account he already uses for Outlook/Teams, lands on a page with a document list and a chat box, asks a question in plain English, and gets a streamed answer with clickable citations and a non-dismissible "AI-generated draft, requires review" disclaimer. Access is properly per-user-scoped server-side (a fresh 60-second JWT re-derived from his real grants on every request) — this is the good, narrow-scope option, not the credentials-on-a-laptop one, and it's not hypothetical: the code exists and passed review.

**The actual remaining gap is deployment, not architecture.** `apps/web` has:

- No `railway.json` (unlike `apps/api`/`apps/mcp`/`apps/worker`, which each have one).
- No `Dockerfile` at all — the sibling apps' Dockerfiles aren't a drop-in copy; this needs either a Next.js-appropriate Dockerfile (standalone build output) authored from scratch, or a different Railway builder (Nixpacks) for this one app specifically.
- No entry in `docker/compose.prod.yml`.
- An `env.example` that documents the Entra SSO variables (`AUTH_ENTRA_CLIENT_ID`/`AUTH_ENTRA_CLIENT_SECRET`/`AUTH_ENTRA_TENANT_ID`, `RAG_ADMINS_GROUP_ID`) but never mentions NextAuth's own required session-signing secret (`AUTH_SECRET`) — a real, separate value to generate.
- No Azure AD app registration yet, and no `RAG-Admins` security group in the firm's tenant (both needed for Entra SSO + the admin gate to work at all).

**Exact steps:**

1. Register an Azure AD (Entra ID) application in the firm's tenant for this app — redirect URI, client secret, tenant ID. This is a ~15-30 minute task in the Azure/Microsoft 365 admin portal, not a code task; Chris or whoever manages the firm's M365 tenant may need to do this or grant you access.
2. Create a `RAG-Admins` security group in the same tenant, add yourself (and later Chris/Doug as appropriate) to it, and note its object ID for `RAG_ADMINS_GROUP_ID`.
3. Generate a real `AUTH_SECRET` (NextAuth's session-signing key — `openssl rand -base64 32` is the standard way) and the existing `INTERNAL_SCOPE_JWT_SECRET` per Task 3's now-enforced 64-character minimum (see `docs/PLAN-TWK-READINESS-AUTOMATABLE.md` Task 3).
4. This is where code work picks back up — flag to whoever's driving the automatable-plan work next: author `apps/web/Dockerfile` (Next.js standalone output mode), `apps/web/railway.json` (mirroring the sibling apps' pattern once a working builder choice is confirmed), and add `apps/web` to `docker/compose.prod.yml`. Update `apps/web/env.example` to document `AUTH_SECRET` alongside the Entra vars it's missing today.
5. Deploy, confirm you personally can sign in and ask a real question against the firm-SOP index.
6. Write the 2-minute "how do I ask a question" doc for staff — a screenshot-driven one-pager is enough. This is the single highest-leverage artifact currently missing: the code that makes this feel like a real tool instead of an engineering project already exists, unused.

**Done when:** you've personally signed into the deployed app with your Microsoft account and gotten a real answer to a real question, and the one-pager exists for handing to Doug.

**Depends on / blocks:** Depends on items 1 and 2 (both P0 gates) — don't deploy this for real staff use until the audit and counsel/carrier sign-off are done. Once deployed, granting Doug an actual source (via `/admin/access`) still requires an admin to explicitly grant him access to the firm-SOP source — the access-grant admin UI is per-client by data model, so onboarding a Phase-1 firm-SOP-only user is a small manual workaround today, not yet a one-click "add to firm index" action. Note this before promising Doug instant access on day one.

---

### 5. Decide the docs-gap-digest privacy tradeoff (Tier 2)

**Why:** `docs/PLAN-TWK-READINESS-AUTOMATABLE.md` Task 13 builds a SAFE version of the weekly digest — an aggregate count of weak-result queries, with no question text retained anywhere, matching the existing privacy-by-design decision already baked into this codebase. But the actual thing promised to Chris ("5 questions came in this week the KB couldn't answer. Top one: what's our intake checklist for Schedule F filings?") requires retaining at least a paraphrase of what was asked — a real reversal of a deliberate privacy decision made earlier in this project, not a bug to just fix.

**Exact steps:**

1. Understand what's actually being traded off: right now, the audit log stores only a one-way SHA-256 hash of every question — nobody, not even someone with full database access, can recover what was actually asked. Adding a "top question was X" feature means storing actual question text (or a close paraphrase) somewhere, at least for the small subset of questions that got a weak/no result.
2. Weigh it: is this acceptable for firm-internal SOP questions (low sensitivity, the whole point of Phase 1's scope) even though the current architecture was deliberately built to never need this tradeoff? Is there a middle ground (e.g., only retain the question for questions that scored below a threshold, with a shorter retention window, or require a staff member to explicitly opt in to having their unanswered question shown to Doug)?
3. Decide, and write it down. If you decide to build it, this becomes a new automatable-plan item (a genuine, scoped feature: add an optional `questionText` or `questionSummary` column, populate it only for weak-result events, surface it in the Tier 1 admin page from Task 13). If you decide not to, the Tier 1 aggregate-only version (already built by Task 13) is the permanent answer, and the partner-facing description of "the Friday digest" should be recalibrated to match what actually ships, not the original proposal's exact wording.

**Done when:** a decision is made and recorded, and (if building) the follow-up scoped as its own small plan item.

**Depends on / blocks:** Depends on Task 13 (the Tier 1 version) already existing so you can see what the "safe" version actually looks like before deciding whether more is worth the tradeoff.

---

### 6. Run the Phase 1 baseline diary

**Why:** The $20-30K/yr value estimate quoted to Chris is explicitly labeled `[NEW — UNVALIDATED]` in the firm's own planning docs. Quoting it again without real numbers repeats the same unvalidated-claim problem this whole reconciliation effort is trying to fix elsewhere.

**This item is listed under P1, but the action itself is a P0-timing constraint: capture the baseline before Doug (or anyone else) touches the bot at all, not merely "before a second user."** Once even one person starts using the bot instead of interrupting Chris, the "before" measurement is gone for good — there's no way to retroactively reconstruct how often staff used to ask him these questions. Don't let this slip past the moment item 4 grants Doug access.

**Exact steps:**

1. **Before Doug's very first session with the bot** — not "before the pilot launches" in some general sense, but literally before item 4's access decision is acted on — have Chris keep a simple diary for one full week: every time a staff member interrupts him with a question he could imagine an SOP answering, log it (a sticky note, a phone note, whatever's low-friction for him — the point is a rough count, not perfect data).
2. Separately, time a small sample (3-5 staff) doing a "find the BOI SOP" (or equivalent) exercise today, without the bot, to get a real baseline for "how long does this currently take."
3. Once the pilot has run for a few weeks, repeat both measurements and compare. This is the actual evidence for whether the $20-30K number (or any number) is real, instead of a projection nobody's checked.

**Done when:** you have one week of real baseline data captured, and that week ended before Doug's first real use of the bot — not just before comparing against anything post-pilot.

**Depends on / blocks:** Blocks item 4 being acted on (granting Doug access) — sequence this diary week to finish first, even though it's filed under P1. Should happen before or in parallel with the pilot's Week 1-2 infrastructure stand-up (per the original timeline) — not after the fact, since you need a "before" to compare against.

---

## P2 — worth doing, not blocking a tightly-scoped internal pilot

### 7. Write real CPA-domain questions for the retrieval-eval gold set, with Doug

**Why this is more load-bearing than its P2 placement suggests (updated 2026-07-11):** a dedicated LLM-evaluation audit confirmed this isn't just "makes the numbers more meaningful" — it's the literal prerequisite for every retrieval-quality decision the system still needs to make. Specifically:

- **Reranking is built and wired but defaults off** (`config.rerank.provider = "none"`) — the codebase's own tracking (`docs/ISSUES-AND-OPTIMIZATIONS.md`, item H1) marks turning it on as explicitly "blocked on a real-embedder eval baseline." Nobody can respons­ibly decide whether to enable it without this.
- **`pnpm eval:real` (the real-embedder path) has never been run at all** — `docs/EVAL-BASELINE.md` says so directly. The only numbers that exist (97%+ recall, MRR 1.000) are against a deliberately keyword-trivial 14-document synthetic corpus (Postgres tuning, gardening, sailing) under a bag-of-words `FakeEmbedder` — the doc's own words: "not meaningful evidence of retrieval quality."
- **There is no answer-faithfulness/groundedness evaluation anywhere in the codebase** — no LLM-as-judge, no human-eval rubric. `ISSUES-AND-OPTIMIZATIONS.md` names this gap explicitly too. This item's real CPA questions are also the natural seed for closing that gap later, not just retrieval scoring.

In short: RRF weight tuning, the reranker on/off decision, chunk-size tuning, and any future answer-faithfulness check are ALL currently guesses, not measurements, and stay that way until this item is done. `docs/PLAN-TWK-READINESS-AUTOMATABLE.md` Task 8 already made the harness capable of running against a real embedder at zero cost — but the actual questions in the test corpus are still 17 synthetic, vocabulary-distinctive ones. Building genuine confidence requires real questions a CPA would actually ask, with real "near-neighbor" distractor documents that are hard to tell apart semantically (not trivially keyword-separable, unlike the current corpus).

**Exact steps:**

1. Sit down with Doug for an hour. Ask him to write, from memory, 30-50 questions he's actually asked or been asked at the firm — the kind of thing the KB bot is supposed to answer (BOI filing procedures, time codes, intake checklists, K-1 treatment questions, UPE calculations, whatever comes up naturally).
2. For each question, identify (or write, redacted) the actual SOP/document that should answer it, plus 1-2 similar-but-wrong documents that a naive keyword search might confuse it with (the "near-neighbor distractor" the current corpus lacks entirely).
3. Hand this list to whoever is running the automatable plan's Task 8 follow-up — turning this list into the actual eval corpus file (`tests/e2e/src/eval/corpus.ts`) IS a mechanical, automatable step once the questions exist; writing the questions themselves is the part that needed Doug.
4. Once the real corpus exists, run `pnpm eval:real` (with `EMBEDDING_PROVIDER=local` — no API key needed, per `EVAL-BASELINE.md`) and paste the results into that file's "Real-embedder results" section, replacing the current "no real-embedder run has been recorded yet" gap.
5. Only after step 4 produces real numbers, revisit the reranker on/off decision (`ISSUES-AND-OPTIMIZATIONS.md` H1) with actual evidence instead of a guess.
6. Make sure nothing in this list contains real client names, SSNs, EINs, or actual tax positions taken for a real client — keep it to genuinely firm-internal SOP content or clearly fictionalized examples, consistent with the same Class A/B boundary the rest of this project respects.

**Done when:** a 30-50 item question list with matched correct/distractor documents exists, has been turned into the real corpus, and `pnpm eval:real` has produced recorded, real-embedder numbers in `docs/EVAL-BASELINE.md`.

**Depends on / blocks:** Feeds into (but doesn't strictly block) a tightly-scoped internal pilot — the harness already works without this. But it DOES block making the reranker decision, any RRF-weight tuning, and any future answer-faithfulness evaluation on real evidence rather than a guess. Treat as effectively P1 in practice, even though it's filed under P2 here for document-structure continuity.

---

### 8. Decide where off-host audit logs should actually ship

**Why:** `docs/PLAN-TWK-READINESS-AUTOMATABLE.md` Task 14 builds a generic, vendor-agnostic webhook mechanism for shipping audit logs off the primary database — but "off-host" only means something once you've picked an actual destination.

**Exact steps:**

1. This doesn't need to be fancy for a small pilot. Options in rough order of cost/effort: (a) a free-tier log aggregator that accepts a webhook (many exist — pick one you're comfortable trusting with this data given it's the audit trail, not the underlying documents); (b) a private Slack/Teams channel via an incoming webhook, if you just want a human-readable stream rather than a queryable log store; (c) skip this for now if the pilot stays small enough that the primary Postgres audit log with the P0 backup drill (item 3) already covers "don't lose this data."
2. Pick one, get its webhook URL/credentials, and set the `AUDIT_SINK_PROVIDER`/`AUDIT_SINK_WEBHOOK_URL`/`AUDIT_SINK_WEBHOOK_TOKEN` env vars (once Task 14 ships) to point at it.
3. Separately from the destination, decide a **retention/purge policy** for the audit log itself — off-host shipping only answers "where does a copy live," not "how long do we keep it anywhere." The `auditLog` table (and, if shipped off-host, the destination) will otherwise grow unbounded. Decide: how long does the firm actually need to retain query-audit records (§7216/Circular 230 don't mandate a specific retention window for this kind of internal tool-usage log the way they do for return records themselves, so this is a firm-policy call, not a fixed legal minimum) — a year, indefinitely, something else? Once decided, this becomes a small automatable follow-up (a scheduled purge job deleting `auditLog` rows older than the chosen window) — write the decision down here even if you defer building the purge job itself.

**Done when:** a destination is chosen (including explicitly choosing "not yet, revisit later" as a valid choice for a small pilot) and configured if chosen, AND a retention/purge window is decided and recorded (even if the decision is "keep everything for now, revisit at N months of data").

**Depends on / blocks:** Depends on Task 14 (the mechanism) existing; independent of everything else.

---

### 9. Decide build-vs-buy for the document type/class classifier

**Update (2026-07-11):** a separate, cross-repo design effort (a generic `DocumentClassifier` engine in `rag-system` plus product-owned rule sets in `cpa-consulting`/`veteran-claims-app`) was explored and then explicitly deferred — see `cpa-consulting/docs/superpowers/specs/2026-07-11-classifier-migration-design.md`, now marked "Status: DEFERRED... Explicitly not required for the TWK KB launch." That effort is a possible future path if this item is ever revisited, but changes nothing about the decision below, which remains open.

**Why:** This item was excluded entirely from the automatable code plan — it's a genuine multi-day machine-learning feature build, and the firm's own planning docs (`~/dev/cpa-consulting/docs/rag/evaluations/document-classification-automation.md`) already frame this as an open "Slice A (build) vs. Slice B (buy SurePrep/GruntWorx for client tax documents)" decision that hasn't been made. Building it without that decision risks building the wrong thing.

**Exact steps:**

1. Read `~/dev/cpa-consulting/docs/rag/evaluations/document-classification-automation.md` in full (or wherever the current version of this evaluation lives) to refresh on the actual build-vs-buy tradeoffs already identified there.
2. Note that this classifier (SOP vs. template vs. research memo, with a confidence-gated human-approve queue) is about the document TYPE, which is a materially smaller, cheaper problem than what SurePrep/GruntWorx solve (client tax-document classification/extraction) — the "buy" option in that evaluation may be solving a different, bigger problem than what's actually needed here. Confirm you're comparing the right things before deciding.
3. If "build" is the answer: this becomes a new, properly-scoped implementation plan of its own (not a bolt-on to the automatable plan above) — worth a fresh brainstorming/design pass given its size, not a quick addition to an existing task list.
4. If "buy" or "defer": say so explicitly, and note in `docs/TWK-CPA-READINESS-ASSESSMENT-2026-07-08.md`'s priority list that this item is deliberately deferred pending that decision, not silently dropped.

**Done when:** a decision is recorded, and if "build," a fresh planning pass is scheduled separately rather than folded into unrelated work.

**Depends on / blocks:** Independent — this can happen whenever there's bandwidth for it; nothing else in either plan depends on it.

---

### 10. Reset the shared local dev Postgres container (`rag-postgres`)

**Why:** A pre-launch DB audit (2026-07-11) root-caused a recurring problem this session — `pnpm --filter @rag/db test`/e2e runs against this container have periodically reported tables as missing despite the migration journal claiming they're applied. Root cause, confirmed precisely: Drizzle's migrator only checks a single MAX(`created_at`) watermark, not per-migration hash presence — any migration whose journal `when` value sits _below_ the container's current watermark gets silently skipped forever, even if it was genuinely never applied. This container's watermark currently sits above `0012_staff_source_assignments`'s and `0013_docs_gap_digest_runs`'s `when` values (both tables confirmed missing via direct inspection), and its migration lineage is provably mixed with at least one other, unrelated, unmerged branch (`feat/kb-governance-phase5-staleness-archive`) that was also migrated against this same shared container at some point.

**This is not safe to fix by just running `pnpm db:migrate` again** — the audit confirmed that would crash outright (`0015_add_git_markdown_source_kind.sql` tries to add an enum value already present under this container's mixed lineage, with no `IF NOT EXISTS` guard, and Drizzle wraps the whole migration run in one transaction, so the crash rolls back anything else that migration attempted too).

**Exact steps:**

1. Confirm nothing you (or anyone else sharing this machine's docker state) currently need from this container — the audit found it holds only trivial dev data (1 source, 1 document, 1 chunk, 275 dev-noise audit-log rows), but this is your call to make, not an assumption to accept from an agent.
2. Reset it: `pnpm docker:down` then `pnpm docker:up` with the Postgres volume wiped (or `docker exec rag-postgres psql -U rag -d postgres -c "DROP DATABASE rag;"` + recreate), then run a fresh `pnpm --filter @rag/db migrate` — this exact 0000→0017 chain was already verified to apply cleanly from scratch against a disposable database during the PR #33 merge.
3. Consider, as a low-cost follow-up (not blocking, not urgent): add `ADD VALUE IF NOT EXISTS` to future enum-extending migrations, and/or a CI check asserting every migration's `when` value is strictly greater than every other committed migration's `when` — this exact failure mode (a non-monotonic/skip-prone migration ordering) has now recurred at least twice this project's history under concurrent-branch merges.

**Done when:** the container's `\dt` output matches the full expected table list, and a fresh `pnpm --filter @rag/e2e test` run (against this container, not a disposable one) passes.

**Depends on / blocks:** Independent of the P0 gates. Not urgent for TWK's actual production data (this is a _local dev_ container, not the live Railway deployment), but it should happen before trusting any future local e2e run against this container, and before deploying item 4's `apps/web` work if any local verification against this container is part of that process.

---

## Quick reference — what's already handled by the automatable plan vs. here

| Assessment doc item                          | Where it's handled                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 Audit what's indexed                    | **Here, item 1**                                                                                                                  |
| P0-2 Wire data-class gate                    | Automatable plan, Task 1                                                                                                          |
| P0-3 Counsel + carrier                       | **Here, item 2**                                                                                                                  |
| P0-4 Correct stale doc                       | Automatable plan, Task 2                                                                                                          |
| P0-5 Verify backup/restore                   | 100% manual — **here, item 3** (the automatable plan builds no backup mechanism; Task 17 is deployment docs/hardening only)       |
| P0-6 Raise secret min length                 | Automatable plan, Task 3                                                                                                          |
| P1-7 MCP audit-logging gap                   | Automatable plan, Task 4                                                                                                          |
| P1-8 Deploy `apps/web` for staff access      | **Here, item 4** (reframed 2026-07-11 — the web app already exists and is reviewed; the gap is deployment, not a design tradeoff) |
| P1-9 Reconcile admin-access model            | Automatable plan, Task 9                                                                                                          |
| P1-10 Migration-timestamp guard              | Automatable plan, Task 5                                                                                                          |
| P1-11 `purge_source` test                    | Automatable plan, Task 6                                                                                                          |
| P1-12 Baseline diary                         | **Here, item 6**                                                                                                                  |
| P2-13 512-token truncation                   | Automatable plan, Task 7                                                                                                          |
| P2-14 Real eval baseline                     | Harness: automatable plan Task 8; real questions: **here, item 7**                                                                |
| P2-15 Weekly digest / KB-gap queue           | Tier 1: automatable plan Task 13; Tier 2 decision: **here, item 5**                                                               |
| P2-16 Type/class classifier                  | **Here, item 9** (build-vs-buy decision, then its own plan if "build")                                                            |
| P2-17 Citation/table/versioning fixes        | Automatable plan, Tasks 10-12                                                                                                     |
| P2-18 Security headers + test coverage       | Automatable plan, Tasks 15-16                                                                                                     |
| P3-19 Off-host log shipping                  | Mechanism: automatable plan Task 14; destination: **here, item 8**                                                                |
| P3-20 Rollback docs, alerting, deploy config | Automatable plan, Task 17                                                                                                         |
| (New) Shared dev DB drift                    | **Here, item 10** — not in the original assessment; found by the 2026-07-11 pre-launch audit                                      |
