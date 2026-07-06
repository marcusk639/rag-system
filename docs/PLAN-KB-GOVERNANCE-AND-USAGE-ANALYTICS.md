# Implementation Plan: Knowledge-Base Governance & Usage Analytics

> **Context:** `docs/CPA_Firm_Operations_Consultant_Briefing.md` (an operations-consulting
> briefing for the CPA firm this system serves) repeatedly names the knowledge base as
> "foundational but currently unreliable" and calls out specific governance gaps: _"who can
> add/edit files," "what counts as an SOP vs template vs research note vs example file," "how
> outdated material gets archived,"_ and _"recurring usage summaries to identify missing
> documentation or training needs."_ Cross-referencing that briefing against the current
> codebase and the existing `docs/CPA-KB-ADOPTION-PLAN.md` / `docs/PLAN-CPA-COMPLIANCE.md`
> plans found that most of the briefing's technical asks are already scoped elsewhere (Teams
> bot, citations, ACL, web chat, reranking/eval) — but four concrete gaps are addressed by
> **no existing plan**. This plan covers those four gaps only.
>
> **Explicitly out of scope** (organizational/process problems the briefing raises that have
> no code solution in this repo): time tracking / Carbon dashboards / coding-mismatch review,
> an "AI QA layer before tax-return reviewer stage" (a return-validation workflow, not a
> knowledge-retrieval problem), pod structure / role clarity, client-request-chasing workflows,
> and productized pricing. Do not attempt to fold these into this plan.
>
> **Revision note (2026-07-05):** this plan was reviewed against
> `docs/CPA-CONSULTING-PLAN-REVIEW.md` and every open item there was resolved by re-reading the
> actual code (not re-guessing). Changes made as a result:
>
> 1. **Phases reordered.** The content-type taxonomy (originally Phase 4) now runs _before_ the
>    audit-parity/digest work (originally Phases 2-3), because the briefing's own stated
>    priority order is "clean/restructure the knowledge base... **only then** build dashboards
>    /automation on top" — the old order inverted that, and nothing technical forced it (the
>    dependency table already showed the taxonomy as independent of the other phases).
> 2. **Phase 1's MCP item is no longer a "check if" footnote — it's a confirmed, exact fix.**
>    `apps/mcp/src/server.ts:43` calls `registerListSources(server, deps)` **without** the
>    `scope` parameter that every sibling tool registration (`registerSearchDocuments`,
>    `registerGetDocument`, `registerTriggerSync`, `registerPurgeSource`, `registerAsk` — lines
>    41,42,44,45,46) already receives. This is a real, currently-shipping instance of the same
>    vulnerability Phase 1 fixes on the API side, not a hypothetical one.
> 3. **The `upsertDocument` re-sync-clobbering risk is resolved — it's not a bug, but it is a
>    trap for the _next_ phase.** `packages/db/src/queries.ts:109-162`'s hand-written SQL uses
>    an explicit `ON CONFLICT ... DO UPDATE SET` column list (not `SET *`), so Postgres will
>    only touch the columns literally named there. The new governance columns are safe from
>    being clobbered on re-sync **as long as nobody adds them to that SET list** — this is now
>    a stated anti-pattern in the taxonomy phase below, not an open question.
> 4. **A numeric confidence score already exists** (`RetrievalResult.score`,
>    `packages/core/src/types.ts:233-234`) and the digest now captures it, restoring this
>    session's original "zero-citation **or low-confidence**" framing that had been quietly
>    dropped to zero-result-only.
> 5. **The known, already-tracked `H2` full-scan issue** (`docs/ISSUES-AND-OPTIMIZATIONS.md:63`,
>    still open) is called out explicitly against the new retrieval-path filter in the staleness
>    phase, with a "measure, don't guess" resolution instead of either ignoring it or
>    over-building an index speculatively.
> 6. **Confirmed zero regression risk** for restricting `POST /sources` to admin-only: no
>    Teams/SMS/Twilio code exists anywhere in the repo yet (`docs/CPA-KB-ADOPTION-PLAN.md`'s
>    Phase 7 is unbuilt), so there is no existing non-admin workflow that creates sources today.
> 7. **Scope honesty on `POST /sources`:** restricting source _creation_ answers "who may
>    register a new connected system," not the briefing's "who can add/edit files" — that's
>    native SharePoint file-level permission, upstream of and untouched by this system (which
>    only pulls, per `CLAUDE.md`). Stated explicitly in Phase 1 below so it isn't oversold.
>
> Every fact below was gathered by documentation-discovery passes against the actual code on
> 2026-07-05 (grep + full-file reads, not assumption).

This plan is written to be executed **one phase per fresh chat context**, matching the style of
`docs/PLAN-CPA-COMPLIANCE.md`. Each phase cites exact files/lines to copy from, gives a
verification checklist, and lists anti-patterns to avoid. Do not invent APIs — every function
name/signature below was verified against the code on 2026-07-05.

---

## Phase 0 — Discovery consolidation (READ FIRST, do not skip)

### Allowed APIs / verified facts

**Existing classification systems — do NOT conflate with the new taxonomy in Phase 2:**

- `DocumentClass` (`packages/core/src/types.ts:33-34`, values `A|B|C|D`) — Zod enum on
  `SourceConfig.docClass` / `DocumentMetadata.docClass`, enforced by the ingestion pipeline
  (`packages/ingestion/src/pipeline.ts:244`, blocks C/D via `ClassBlockedError`). This is a
  **legal/regulatory gate** (§7216/GLBA), not a content taxonomy.
- `DataClass` (`packages/db/src/schema.ts:48-54`, Drizzle pgEnum, values
  `general|research|sop|client_confidential`) — the `sources.dataClass` DB column
  (`schema.ts:80`, `NOT NULL DEFAULT 'general'`), mapped to `DocumentClass` by
  `packages/ingestion/src/classify-source.ts:16-18` (`mapDataClassToDocumentClass`). Also a
  **compliance-purposed** classification, one value per _source_ (not per document), with no
  `"template"`/`"example"` values and no owner/lifecycle concept.

**Existing audit/logging — read before Phase 3:**

- `auditLog` table (`packages/db/src/schema.ts:307-337`): one row per `/ask` call. Columns:
  `principalKind` ("admin"|"scoped"), `principalSources` (nullable `text[]`),
  **`questionHash`** (SHA-256 — **raw question text is never stored**, by explicit design, per
  the table's own doc comment: "for §7216/Circular 230 accountability"), `channel`
  ("api"|"mcp"), `model`, `sourceIds`/`chunkIds`/`docIds` (`text[]`), `retrievedCount`
  (integer), `createdAt`. Indexes: `audit_log_created_idx`, `audit_log_principal_kind_idx`.
- Write path: `logAskEvent(db, row: AskEventRow)` — `packages/db/src/queries.ts:709`,
  `AskEventRow` interface at `:693`. Called by `auditAsk` in `apps/api/src/routes/ask.ts:29-48`
  — fire-and-forget (`void logAskEvent(...).catch(...)`, line 37/47), invoked after both the
  non-streaming handler (`ask.ts:80`) and the `"done"` SSE event of the streaming handler
  (`ask.ts:126`).
- **`POST /search` (`apps/api/src/routes/search.ts`) has zero logging** — confirmed by grep,
  no `logSearchEvent`/equivalent exists anywhere. This is the parity gap Phase 3 closes.
- **`RetrievalResult.score: number`** (`packages/core/src/types.ts:233-234`, "Combined score
  (0-1, higher is better)", plus dense/sparse component scores nearby) — a numeric confidence
  signal already exists and is cheap to capture; Phase 3's audit row should record it.
- `ingestLog` table (`schema.ts:346-378`) is a separate, unrelated audit trail — one row per
  document-ingestion attempt (`action`: "ingested"|"blocked"|"tri-flagged"). Not touched by
  this plan.

**Existing ACL — already on `main`, already read-side only, and already partially inconsistent
on the MCP surface:**

- `packages/core/src/access-control.ts` — confirmed via `git log --all --oneline` to be merged
  into `main` across 4 commits (not a worktree, contrary to the older
  `docs/CPA-KB-ADOPTION-PLAN.md`'s Phase 1 framing, which is stale on this point).
  `Principal = {kind:"admin"} | {kind:"scoped", allowedSourceIds: string[]}`,
  `AuthorizationScope = {enforcedSourceIds: string[] | null}`, `ADMIN_SCOPE`,
  `DENY_ALL_SCOPE`, `parsePrincipalsConfig`, `resolvePrincipal`, `principalToScope`.
  `API_PRINCIPALS`/`API_ENFORCE_SCOPING` are wired in `packages/core/src/config.ts:61-70,438-441`
  and documented in `env.example:99-114` — also already on `main`.
- **`Principal` has no write-capability concept at all** — both shapes are 100% about
  read-side `sourceId` scoping. This is the gap Phase 1 closes.
- `apps/api/src/routes/sources.ts` — confirmed via full read: `DELETE /sources/:id`
  (lines 104-119), `POST /sources/:id/sync` (146-155), and `POST /sources/:id/documents`
  (188-195) **do** check `scope.enforcedSourceIds` (404 on a forbidden id — the established
  "no existence leak" convention). But `POST /sources` (63-81), `GET /sources` (84-87), and
  `GET /sources/:id` (90-99) have **zero scope/authorization check** — any valid bearer token
  (admin or scoped) can create a source, and can list/read every source's metadata regardless
  of its `allowedSourceIds`. `listPublicSources` (`packages/services/src/sources.ts:106-111`)
  doesn't even accept a `scope` parameter today.
- **MCP mirrors this gap exactly, confirmed by reading `apps/mcp/src/server.ts` in full:** every
  tool registration except one passes `scope` — `registerSearchDocuments(server, deps, scope)`
  (line 41), `registerGetDocument(..., scope)` (42), `registerTriggerSync(..., scope)` (44),
  `registerPurgeSource(..., scope)` (45), `registerAsk(..., scope)` (46) — but
  **`registerListSources(server, deps)` (line 43) omits it.** `apps/mcp/src/tools/list-sources.ts`
  internally calls the same unscoped `listPublicSources(deps)`. There is no MCP tool that
  creates a source (grepped, none exists), so the MCP-side risk is read-only (source
  enumeration), not write.

**Job/scheduling infrastructure — nothing recurring exists today:**

- `packages/ingestion/src/queue.ts` — `JOB_NAMES` (lines 9-11) has exactly one entry:
  `syncSource: "rag.sync_source"`. `createQueue` (49-89) only calls `boss.createQueue()` /
  `boss.updateQueue()` (singleton policy) for that one job. `enqueueSync`/`enqueueContinuation`
  (92-139) are one-off `boss.send(...)` calls.
- Repo-wide grep for `.schedule(`/`retention` across `packages/ingestion/src` and
  `apps/worker/src` returns **zero matches**. pg-boss 10.4.2 (the installed version) does
  expose `schedule(name, cron, data?, options?)` / `unschedule()` / `getSchedules()`
  (`node_modules/.pnpm/pg-boss@10.4.2/node_modules/pg-boss/types.d.ts:370-372`) — it is simply
  never called. `docs/CPA-KB-ADOPTION-PLAN.md:319` names a "nightly pg-boss retention sweep"
  as planned-but-not-built Phase 8 work — confirmed still not built.
- `apps/worker/src/handlers/` contains exactly one handler file, `sync-source.ts`. Dispatch is
  a single hardcoded `queue.work(JOB_NAMES.syncSource, {...}, handler)` call in
  `apps/worker/src/main.ts:55-70` — there is no registry/dispatch-table abstraction. Adding a
  new job type means adding one more `queue.work(...)` call in `main.ts`, copying this shape.

**Schema facts for the new columns (Phases 2, 5):**

- `documents` table (`packages/db/src/schema.ts:92-138`) timestamp columns today:
  `sourceModifiedAt` (nullable, source-reported), `createdAt`/`updatedAt` (both
  `NOT NULL DEFAULT NOW()`). **No "human last-reviewed" column exists.**
- `chunks` table (148-213) has only `createdAt`, no `updatedAt`.
- **`upsertDocument` (`packages/db/src/queries.ts:109-162`) — read this before Phase 2.** It's
  a hand-written SQL upsert, not a Drizzle ORM helper: `INSERT INTO documents (source_id,
external_id, title, mime_type, source_modified_at, content_hash, size_bytes, metadata,
markdown) VALUES (...) ON CONFLICT (source_id, external_id) DO UPDATE SET title = ...,
mime_type = ..., source_modified_at = ..., content_hash = ..., size_bytes = ...,
metadata = ..., markdown = ...` (lines 130-147) — an **explicit** column list, not
  `SET * = EXCLUDED.*`. Postgres only overwrites columns literally named in that `SET` clause
  on conflict; any column _not_ named there is left untouched on re-sync. This means new
  governance columns are automatically safe from being clobbered by a re-sync **as long as
  Phase 2 never adds them to this statement's `INSERT`/`SET` lists** — see that phase's
  anti-pattern guard.
- Existing soft-delete precedent to copy: `staffClientAssignments.revokedAt`
  (`schema.ts:393-415`, nullable `timestamptz`, comment at line 409: _"Null = active. Set to
  now() to revoke. Never DELETE."_) — this is the pattern Phase 5's archive flag should mirror.
- Migration conventions (`packages/db/drizzle/`): two established styles. (1) drizzle-kit
  generated (`0007_audit_log.sql`) — tab-indented, `--> statement-breakpoint` separators, no
  `IF NOT EXISTS`. (2) hand-written (`0006_client_assignments.sql`) — `IF NOT EXISTS` guards,
  2-space aligned columns, header comment block. New hand-authored migrations in this plan
  should use style (2). Enum-creation convention (`0004_data_class.sql`):
  ```sql
  DO $$ BEGIN
    CREATE TYPE "type_name" AS ENUM('val1', 'val2');
  EXCEPTION
    WHEN duplicate_object THEN null;
  END $$;
  ```
- **Known, already-tracked performance issue relevant to Phase 5:**
  `docs/ISSUES-AND-OPTIMIZATIONS.md:63`, `H2 — Metadata filter is a guaranteed full scan`,
  still open per that doc's own fix-priority table (estimated "S–M" effort, not yet done).
  Phase 5 adds one more `WHERE` clause to the same query family — see that phase's resolution
  (measure, don't speculatively index).

**Logging convention to match** (from `packages/ingestion/src/pipeline.ts` and
`apps/worker/src/handlers/sync-source.ts`): create a child logger once per unit of work
(`logger.child({...contextIds})`), then call `log.<level>({ ...structuredFields, marker?:
"dotted.namespaced.tag" }, "lowercase message")`. `marker` is reserved for events worth
grepping/alerting on, not used on every call. Errors pass the raw `{ err }` object (pino
serializes it), never a manually-stringified message.

### Global anti-patterns (apply to every phase below)

- ❌ Do not conflate the new content-type taxonomy (Phase 2) with `DataClass`/`DocumentClass`
  — they answer different questions (legal sensitivity vs. librarian content-type) and gating
  logic must never read one where it means the other.
- ❌ Do not add raw question/query text storage to close the logging gap (Phase 3/4) — the
  existing `questionHash`-only design is a deliberate compliance choice; the digest must work
  from aggregate signals (`retrievedCount`, `chunkIds.length`, `score`), not reconstructed text,
  unless a follow-up phase is explicitly scoped with a stated retention policy and business
  sign-off.
- ❌ Do not hard-delete anything (documents, sources, audit rows) to implement "archive" —
  status-flip only, following `revokedAt`'s "never DELETE" precedent.
- ❌ Do not build a dispatch-table/job-registry abstraction for 2-3 job types — copy the
  existing single-`queue.work()`-call-per-job-type pattern; a registry is unjustified
  complexity at this scale.
- ❌ Do not build a new admin dashboard/report UI as part of this plan — every "report" in
  this plan ships as a structured log line (`marker: "..."`) as the proportionate MVP. A UI is
  a separate, later decision once the firm confirms it wants one.

---

## Phase 1 — Close per-principal authorization gaps on `/sources` (API + MCP)

**Why first:** independent of the other phases, and closes a real access-control hole that is
confirmed to exist on **both** surfaces — today any valid scoped (non-admin) bearer token can
enumerate every source's metadata via `GET /sources`/`GET /sources/:id` (HTTP) and
`list_sources` (MCP), and create arbitrary new sources via `POST /sources`, regardless of
`allowedSourceIds`. This is inconsistent with the deny-by-default pattern already enforced on
`DELETE`/`sync`/`documents` routes in the same file, and on every other MCP tool.

**Scope honesty:** this phase answers "who may register a new connected source system
(SharePoint site, Drive, mailbox)." It does **not** answer the briefing's "who can add/edit
files" in the everyday sense of individual documents within an already-connected SharePoint
library — that's native SharePoint file/folder permission, entirely upstream of and untouched
by this system, which only pulls from sources (per `CLAUDE.md`, connectors are read-only). Do
not present this phase as solving that broader question.

### What to implement

1. `listPublicSources` (`packages/services/src/sources.ts:106-111`) — add a mandatory
   `scope: AuthorizationScope` parameter; filter the returned rows to
   `scope.enforcedSourceIds` (null → return all, admin case; array → filter `id IN (...)`;
   empty array → return `[]`, matching `DENY_ALL_SCOPE`). Update its two callsites:
   - `apps/api/src/routes/sources.ts` `GET /sources` handler (~line 86) — pass
     `scopeFromRequest(request)` (same helper already used by `/search`/`/ask`,
     `apps/api/src/routes/authz.ts:13-17`).
   - `apps/mcp/src/tools/list-sources.ts` — this file's `registerListSources` function
     currently takes only `(server, deps)`; change its signature to
     `registerListSources(server, deps, scope)` (mirroring
     `apps/mcp/src/tools/search-documents.ts`'s registration signature exactly), and pass
     `scope` through to the `listPublicSources(deps, scope)` call inside its tool handler.
   - Update the one call site missing the argument: `apps/mcp/src/server.ts:43` currently
     reads `registerListSources(server, deps);` — change to
     `registerListSources(server, deps, scope);`, matching the five sibling registrations on
     the surrounding lines (41, 42, 44, 45, 46) exactly.
2. `GET /sources/:id` handler (`sources.ts:90-99`) — add the identical
   `scope.enforcedSourceIds === null || scope.enforcedSourceIds.includes(id)` check already
   used verbatim by the `DELETE /sources/:id` handler (`sources.ts:104-119`); on failure,
   throw/return the same `NotFoundError` → 404 pattern (no existence leak).
3. `POST /sources` handler (`sources.ts:63-81`) — restrict to `request.principal?.kind ===
"admin"`, else 403. This is the minimal viable gate given `Principal`'s current two-shape
   model (admin vs. scoped-to-specific-existing-sources) — creating a brand-new source doesn't
   fit the "scoped to existing sourceIds" model, so there's no natural non-admin case to
   support yet. Do not invent a third `Principal` shape (e.g. a `canCreateSource` flag) in this
   phase — that's a bigger change (touches `parsePrincipalsConfig`, `resolvePrincipal`, their
   tests) that should only happen if a real non-admin "can create sources" use case emerges.
   **Confirmed zero regression risk:** no Teams/SMS/Twilio integration code exists anywhere in
   the repo (grepped) — `docs/CPA-KB-ADOPTION-PLAN.md`'s Phase 7 (the only place a non-admin
   source-creation flow might plausibly emerge) is unbuilt, so there is no existing caller this
   403 could break.

### Documentation references

- Pattern to copy: `apps/api/src/routes/sources.ts:104-119` (`DELETE` handler's scope check).
- `scopeFromRequest`: `apps/api/src/routes/authz.ts:13-17`.
- `AuthorizationScope`/`Principal`: `packages/core/src/access-control.ts:40-53`.
- MCP scope-threading pattern to copy: `apps/mcp/src/tools/search-documents.ts` (registration
  signature), `apps/mcp/src/server.ts:41-46` (call sites).

### Verification checklist

- [ ] A scoped principal's `GET /sources` response contains only sources in its
      `allowedSourceIds` — verified on **both** the HTTP API and the MCP `list_sources` tool.
- [ ] A scoped principal's `GET /sources/:id` for a disallowed id returns 404 (not 403 — no
      existence leak, matching the `DELETE` convention).
- [ ] A scoped principal's `POST /sources` returns 403; an admin principal's succeeds
      unchanged.
- [ ] `grep -n "registerListSources(server, deps)" apps/mcp/src/server.ts` returns nothing
      (confirms the missing-argument call site was fixed).
- [ ] `pnpm typecheck && pnpm test` green.

### Anti-pattern guards

- ❌ Do not return 403 (vs 404) for a disallowed `GET /sources/:id` — that leaks existence,
  breaking the convention every other id-scoped route in this file already follows.
- ❌ Do not add a new `Principal` capability shape "for later" — the 403-on-non-admin gate is
  the intentionally minimal fix; a richer write-capability model is a separate, explicitly
  scoped follow-up if ever needed.
- ❌ Do not fix only the API side and leave `apps/mcp/src/server.ts:43` as-is — that would
  relocate the vulnerability to the agent-facing surface instead of closing it.

---

## Phase 2 — Content-type / governance taxonomy (distinct from `DataClass`)

**Why moved up:** the briefing's own stated priority order is "clean/restructure the knowledge
base... **only then** build dashboards/automation on top." This taxonomy phase _is_ the
KB-restructuring work; Phases 3-4 (logging/digest) are the "automation on top." Nothing
technical forces the old order — this phase has always been independent of Phases 3-4.

**Why it's needed:** the briefing's _"what counts as an SOP vs template vs research note vs
example file"_ and _"who can add/edit"_ need a librarian-facing taxonomy that today doesn't
exist — `DataClass`/`DocumentClass` answer a different question (legal sensitivity) and must
not be repurposed for this.

### What to implement

1. New Drizzle pgEnum in `packages/db/src/schema.ts`, distinctly named
   `contentTypeEnum`/`ContentType` (values: `"sop" | "template" | "research_note" |
"example" | "general"`) — do not reuse or extend `dataClassEnum`.
2. New nullable columns on `documents`: `contentType contentTypeEnum` (default `null` —
   unclassified; do not force a default guess on backfill), `ownerId text` (maintainer's
   IdP/user id — free-form string, matching the existing precedent at
   `staffClientAssignments.userId`, "not a DB FK"), `lifecycleStatus text NOT NULL DEFAULT
'active'` (free-text values `"draft"|"active"|"archived"`, matching the existing
   free-text-status precedent used by `ingestLog.action`/`pendingUploads.status` rather than
   inventing a third enum style for this one field).
3. New hand-written migration (Phase 0 style #2: `IF NOT EXISTS` guards, header comment,
   2-space aligned columns), following the enum-creation convention from
   `0004_data_class.sql`.
4. **Do not touch `upsertDocument`'s `INSERT`/`ON CONFLICT DO UPDATE SET` column lists**
   (`packages/db/src/queries.ts:130-147`) to add these new columns. Leaving them out of both
   lists is what keeps them safe from being reset on every re-sync (see Phase 0's discovery
   note) — adding them there "for symmetry" with the other columns would silently defeat the
   entire point of this phase the next time a source syncs.
5. Scope this phase to schema + types only. **Do not** build a `PATCH /documents/:id` HTTP
   route in this phase — no such route exists today, and building one is a materially larger
   scope (validation, authz, response shape) than "add the taxonomy columns." Land the schema
   now; treat an admin-editing surface as a separate, later-scoped follow-up once it's clear
   who will actually set these fields and how (manually via DB, via a future connector-side
   metadata hint, or via a dedicated route).

### Documentation references

- Distinguishing existing classification systems: `packages/core/src/types.ts:33-34`
  (`DocumentClass`), `packages/db/src/schema.ts:48-54` (`DataClass`).
- Migration style to copy: `packages/db/drizzle/0006_client_assignments.sql` (hand-written),
  `0004_data_class.sql` (enum-creation `DO $$ ... EXCEPTION WHEN duplicate_object` idiom).
- Soft-delete/status-flag precedent: `staffClientAssignments.revokedAt`
  (`schema.ts:393-415`).
- Re-sync safety mechanism to preserve: `packages/db/src/queries.ts:109-162`
  (`upsertDocument`'s explicit `ON CONFLICT ... SET` column list).

### Verification checklist

- [ ] Migration applies cleanly; `documents` has `content_type`, `owner_id`,
      `lifecycle_status` columns.
- [ ] `grep -rn "contentTypeEnum\|dataClassEnum" packages/` shows two separate, never-conflated
      definitions.
- [ ] **Re-sync safety test:** manually set `lifecycleStatus`/`contentType`/`ownerId` on a
      document, re-run ingestion for its source (unchanged content → `contentChanged: false`
      path), and confirm the three governance columns are unchanged after the sync completes.
- [ ] `pnpm typecheck && pnpm test` green.

### Anti-pattern guards

- ❌ Do not reuse `dataClassEnum`/`DocumentClass` for this taxonomy — they gate legal access;
  conflating them risks a librarian re-tagging accidentally changing what's legally exposed.
- ❌ Do not add `contentType`/`ownerId`/`lifecycleStatus` to `upsertDocument`'s `INSERT` values
  or `ON CONFLICT DO UPDATE SET` clause — doing so reintroduces the exact re-sync-clobbering
  risk this phase is designed to avoid.
- ❌ Do not build a full document-editing HTTP API in this phase.

---

## Phase 3 — Search-path audit logging parity + digest privacy design decision

**Why:** `/ask` already logs every call to `audit_log`; `/search` logs nothing. Phase 4's
documentation-gap digest needs both endpoints' zero-result/low-confidence events to be
comparably visible.

### What to implement

1. Add a discriminator column to `auditLog`: `endpoint text NOT NULL DEFAULT 'ask'` (values
   `"ask"|"search"`) via a new hand-written migration (style per Phase 0's convention #2),
   backfilling existing rows to `'ask'` explicitly in the migration so historical semantics
   are preserved.
2. Add a nullable `topScore real` column to `auditLog` (same migration) — capture
   `retrieved[0]?.score ?? null` (from `RetrievalResult.score`, `packages/core/src/types.ts:
233-234`) in both `auditAsk` and the new `auditSearch`. This restores the original
   "zero-citation **or low-confidence**" framing without adding any raw text: it's one more
   numeric column, already computed by the retriever, just not previously persisted.
3. Add `auditSearch` in `apps/api/src/routes/search.ts`, mirroring `auditAsk`
   (`apps/api/src/routes/ask.ts:29-48`) field-for-field (`principalKind`, `principalSources`,
   `questionHash` of the search query, `channel: "api"`, `sourceIds`/`chunkIds`/`docIds`
   derived from results, `retrievedCount`, `topScore`), setting `endpoint: "search"`. Reuse
   `logAskEvent`/`AskEventRow`/`audit_log` — do not create a second table; the row shape is
   identical, only the discriminators differ.
4. **Privacy design decision (resolved, not deferred):** `audit_log.questionHash` is one-way —
   the digest cannot show literal unanswered questions. This plan builds Phase 4's digest
   **only from aggregate signals already on the row** (`retrievedCount === 0`,
   `chunkIds.length === 0`, and now `topScore` below a configurable threshold, grouped by
   `sourceIds`/day) — this requires no new raw-text storage and preserves the table's existing
   explicit compliance design ("no raw question stored", per its own schema comment). Only
   build a separate redacted-text-capture table if the firm explicitly confirms (a business
   decision, analogous to the "[COUNSEL]" gates in `docs/PLAN-CPA-COMPLIANCE.md`) that it wants
   literal query text retained for documentation review, with its own stated retention window.

### Documentation references

- Pattern to copy: `apps/api/src/routes/ask.ts:29-48` (`auditAsk`).
- `logAskEvent`/`AskEventRow`: `packages/db/src/queries.ts:693,709`.
- `RetrievalResult.score`: `packages/core/src/types.ts:233-234`.
- Existing enum-migration style: `packages/db/drizzle/0004_data_class.sql`.

### Verification checklist

- [ ] `POST /search` inserts an `audit_log` row with `endpoint = "search"` and a populated
      `topScore` (test: seed a search call, query the table).
- [ ] Existing `/ask` behavior unchanged; new rows have `endpoint = "ask"` and `topScore`
      populated; a migration test confirms pre-existing rows backfill to `endpoint = 'ask'`,
      `topScore = null`.
- [ ] No new column storing raw question/search text was added, unless the alternate design
      was explicitly chosen and documented with a named owner and retention policy.
- [ ] `pnpm typecheck && pnpm test` green.

### Anti-pattern guards

- ❌ Do not create a parallel `search_log` table — one table, two discriminator/signal
  columns (`endpoint`, `topScore`).
- ❌ Do not add raw-text storage "to make the digest more useful" without the explicit
  business sign-off called out above — this reverses a deliberate compliance decision.

---

## Phase 4 — Documentation-gap digest (first recurring job in this codebase)

**Why:** the briefing calls this out twice independently (§C: _"how missing answers become
documentation tasks"_; §H, sourced from Opzer's own audit: _"recurring usage summaries to
identify missing documentation or training needs"_). Depends on Phase 3 (search parity,
`topScore` capture, and the aggregate-only design decision).

### What to implement

1. Add `docsGapDigest: "rag.docs_gap_digest"` to `JOB_NAMES`
   (`packages/ingestion/src/queue.ts:9-11`), alongside the existing `syncSource` entry.
2. In `createQueue` (`queue.ts:49-89`), after the existing `createQueue`/`updateQueue` calls,
   add: `await boss.schedule(JOB_NAMES.docsGapDigest, cronExpr, null, { tz })`. Make
   `cronExpr`/`tz` config-driven (new env vars, e.g. `DOCS_GAP_DIGEST_CRON`/`_TZ`, wired
   through `loadConfig` the same way every other env var in `packages/core/src/config.ts` is,
   and documented in `env.example`) — do not hardcode the schedule.
3. New query function in `packages/db/src/queries.ts`, e.g.
   `getWeakResultAuditEvents(db, { since, minScore }): Promise<AuditLog[]>` — selects rows
   where `retrievedCount = 0 OR array_length(chunkIds, 1) IS NULL OR topScore < minScore`,
   `createdAt >= since`, grouped conceptually by `sourceIds` (aggregate in the handler, not
   necessarily in SQL, given the `text[]` column shape). `minScore` should also be config-driven
   (e.g. `DOCS_GAP_DIGEST_MIN_SCORE`), not hardcoded, since the right threshold depends on the
   embedding/reranking setup.
4. New handler `apps/worker/src/handlers/docs-gap-digest.ts`, registered via a second
   `queue.work(JOB_NAMES.docsGapDigest, {...}, handler)` call in `apps/worker/src/main.ts`
   (copy the exact registration shape at `main.ts:55-70`). Handler: query the past week's
   zero-result/weak-score events, aggregate counts per `sourceIds` combination and per
   `endpoint`, log the summary via `log.info({ ...counts, marker:
"docs.gap_digest.summary" }, "weekly documentation gap digest")`. No new report table, no
   UI — a structured log line is the scoped MVP (per Phase 0's global anti-pattern list).

### Documentation references

- Job registration pattern: `apps/worker/src/main.ts:55-70`.
- `createQueue`/`JOB_NAMES`: `packages/ingestion/src/queue.ts:9-11,49-89`.
- Logging convention: `packages/ingestion/src/pipeline.ts:207-219` (`marker` pattern).
- pg-boss `schedule()` API: `node_modules/.pnpm/pg-boss@10.4.2/node_modules/pg-boss/types.d.ts:370-372`.

### Verification checklist

- [ ] After worker boot, `boss.getSchedules()` (or querying the `pgboss.schedule` table)
      shows `docsGapDigest` registered with the configured cron/tz.
- [ ] Manually invoking the handler against seeded `audit_log` rows (mix of zero-result,
      weak-score, and strong-score) produces one `marker: "docs.gap_digest.summary"` log line
      with correct aggregate counts, and strong-score rows are correctly excluded.
- [ ] `pnpm test` green (unit-test the aggregation query and handler directly; do not require
      waiting for a real cron tick in CI).

### Anti-pattern guards

- ❌ Do not hardcode the cron expression, timezone, or score threshold — config-driven, per
  `loadConfig` convention.
- ❌ Do not derive "gap" from `questionHash` — use `retrievedCount`/`chunkIds`/`topScore` only,
  per Phase 3's design decision.
- ❌ Do not build a dispatch-table abstraction for job routing — one more `queue.work()` call
  in `main.ts`, copying the existing shape.

---

## Phase 5 — Staleness / archive workflow

**Why:** briefing: _"how outdated material gets archived."_ Depends on Phase 2's
`lifecycleStatus` column and reuses Phase 4's scheduling pattern.

### What to implement

1. Add `documents.lastReviewedAt timestamptz` (nullable) via a new hand-written migration —
   a human-confirmed "still current" signal, distinct from `updatedAt` (bumped by any write)
   and `sourceModifiedAt` (source-reported, not a human review). Same re-sync-safety rule as
   Phase 2 applies: do not add this column to `upsertDocument`'s `SET` clause either.
2. "Archiving" = setting `lifecycleStatus = 'archived'` (Phase 2's column) — never a hard
   delete, mirroring `revokedAt`'s "never DELETE" precedent. Reversible by flipping back to
   `'active'`.
3. `hybridSearch` (`packages/db/src/queries.ts:296-359`, `HybridSearchOptions`) — add a
   default `WHERE documents.lifecycle_status != 'archived'` clause so archived material stops
   surfacing in `/search`/`/ask` results without being deleted. This is the step that actually
   solves the briefing's problem — an archive flag with no retrieval-side effect doesn't stop
   stale material from surfacing to staff.
   **Performance note (resolved, not ignored):** `docs/ISSUES-AND-OPTIMIZATIONS.md:63` already
   tracks metadata filtering on this query family as a known, open full-scan issue (`H2`,
   independent of this plan). Adding one more `WHERE` clause here doesn't change that finding's
   status. Given this system serves a single firm's KB (not a large multi-tenant corpus), do
   **not** speculatively add a new index in this phase — instead, run the existing eval harness
   (`pnpm eval`, from `docs/CPA-KB-ADOPTION-PLAN.md` Phase 3) before/after this change to
   confirm no regression, matching that plan's own "measure, don't guess" principle for changes
   to `hybridSearch`. If `pnpm eval` or real usage later shows this is a bottleneck, address it
   together with `H2` rather than in isolation.
4. New recurring job `JOB_NAMES.stalenessSweep = "rag.staleness_sweep"`, scheduled via
   `boss.schedule(...)` — copy Phase 4's exact pattern (`createQueue` addition,
   `apps/worker/src/main.ts` registration, `docs-gap-digest.ts`'s handler shape). Handler
   queries documents where `lifecycleStatus = 'active' AND (lastReviewedAt IS NULL OR
lastReviewedAt < now() - interval 'N days')`, logs a summary
   (`marker: "docs.staleness_sweep.summary"`) grouped by `sourceId`. Log-line MVP only, no new
   table/UI, per Phase 0's global anti-patterns.

### Documentation references

- Scheduling pattern to copy: Phase 4 above (`docs-gap-digest.ts`, `queue.ts`, `main.ts`).
- Soft-delete/never-DELETE precedent: `staffClientAssignments.revokedAt`
  (`schema.ts:393-415`).
- Retrieval query to modify: `packages/db/src/queries.ts:296-359`.
- Known open performance finding: `docs/ISSUES-AND-OPTIMIZATIONS.md:63` (`H2`).
- Eval harness: `docs/CPA-KB-ADOPTION-PLAN.md` Phase 3 (`pnpm eval`).

### Verification checklist

- [ ] Setting a document's `lifecycleStatus` to `'archived'` removes it from `/search` and
      `/ask` results (test before/after) without deleting the row.
- [ ] Flipping back to `'active'` restores it to results — no data loss.
- [ ] Staleness sweep job logs correct document ids for seeded stale rows (`lastReviewedAt`
      past the configured threshold or null).
- [ ] `pnpm eval` run before/after the `hybridSearch` change shows no recall/nDCG regression.
- [ ] `pnpm typecheck && pnpm test` green.

### Anti-pattern guards

- ❌ Do not hard-delete stale/archived documents.
- ❌ Do not skip the `hybridSearch` filter — an archive flag that doesn't affect retrieval
  doesn't solve the actual problem.
- ❌ Do not add a speculative index for the new `WHERE` clause without measuring first —
  `H2` is already tracked; don't half-fix it in a side phase.
- ❌ Do not build a second job-dispatch mechanism — copy Phase 4's `queue.work()` pattern
  verbatim.

---

## Execution order summary

| Phase | Goal                                                           | Gates                                                                                 |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1     | Close `/sources` read+write authorization gaps (API + MCP)     | independent, do first (security)                                                      |
| 2     | Content-type/governance taxonomy (schema only)                 | independent of 1, 3-4 — do second, per the firm's own "restructure KB first" priority |
| 3     | `/search` audit parity + `topScore` capture + privacy decision | independent of 1-2; blocks Phase 4                                                    |
| 4     | Documentation-gap digest (first recurring job)                 | needs Phase 3                                                                         |
| 5     | Staleness/archive workflow                                     | needs Phase 2 (`lifecycleStatus`); reuses Phase 4's scheduling pattern                |

Phase 1 has no dependencies and should land first as a standalone security fix (both API and
MCP surfaces). Phase 2 should land next — it's independent of everything else, and matches the
briefing's own "restructure the KB before automation" sequencing. Phases 3→4 are a dependent
pair and can run in parallel with Phase 2. Phase 5 depends on Phase 2 and copies Phase 4's
job-scheduling mechanism, so it lands last.
