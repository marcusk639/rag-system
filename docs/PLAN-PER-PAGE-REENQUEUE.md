# Implementation Plan: Per-Page Self-Re-Enqueue for Ingestion (S1–S4)

> **Source of truth:** `docs/QUEUE-ARCHITECTURE-REVIEW.md` (Suggestions S1–S4, Concerns C1/C4).
> **Verdict reminder:** Keep pg-boss. This plan does **not** migrate queue libraries. It fixes job _granularity_.
> **Status:** Ready to execute. Each phase is self-contained for a fresh context.
> **Date authored:** 2026-06-19
> **pg-boss version in repo:** `^10.1.6` (worker + ingestion), `^10.1.5` (api).

---

## How to execute this plan

- Phases are ordered. Do them in sequence; **Phase 1 (spike) gates the design of Phases 2–3** and must not be skipped.
- Each phase lists: **what to implement**, **authoritative references** (file:line — re-verify before editing, code may have moved), a **verification checklist**, and **anti-pattern guards**.
- Tooling: this repo uses **Serena** for code reads/edits. Use `get_symbols_overview` → `find_symbol` → `replace_symbol_body`/`insert_*`. Markdown/JSON edits may use plain Read/Edit.
- After each phase: `pnpm typecheck` and `pnpm --filter @rag/ingestion test` (plus worker tests). Commit per phase.

---

## Phase 0 — Documentation Discovery (consolidated; READ FIRST)

This was completed during planning. The facts below are verified against the live code and the official pg-boss v10 docs. **Re-verify line ranges before editing.**

### 0.1 Current behavior (the thing we are changing)

| Fact                                                                                                                                                                                                                            | Evidence                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `runIngestion(sourceId, connector, startCursor, opts, deps)` loops **all** pages internally in `while (!pageDone)`, persisting cursor after each page, then returns.                                                            | `packages/ingestion/src/pipeline.ts:55-121` (loop `:74-106`, cursor persist `:97-99`)                       |
| It already returns a `done` flag. Today it is effectively always `true` on natural completion.                                                                                                                                  | `PipelineRunResult` `packages/ingestion/src/pipeline.ts:48-53`                                              |
| Self-re-enqueue is foreshadowed but unimplemented.                                                                                                                                                                              | `packages/ingestion/src/pipeline.ts:71-73` (verbatim comment about connector `done=false` + job re-enqueue) |
| Cursor is persisted on the **`sources`** table (`sources.cursor`, `lastSyncedAt`), **not** on `ingestion_jobs`.                                                                                                                 | `updateSourceCursor` `packages/db/src/queries.ts:48-57`                                                     |
| Worker derives start cursor: `mode === "full" ? null : source.cursor`, calls `runIngestion` once with `pageSize: 50`, then marks the history row completed/failed.                                                              | `apps/worker/src/handlers/sync-source.ts:45-68`                                                             |
| Handler signals success by returning, failure by throwing (pg-boss then applies retries).                                                                                                                                       | `apps/worker/src/handlers/sync-source.ts:70-80`                                                             |
| Worker registers via `queue.work<SyncSourcePayload>(JOB_NAMES.syncSource, { batchSize, pollingIntervalSeconds }, async (jobs)=>{ for (job of jobs) await handleSyncSource(...) })`. Jobs processed **serially** within a batch. | `apps/worker/src/main.ts:53-67`                                                                             |

### 0.2 Queue + lifecycle facts

| Fact                                                                                                                                                                                                                                              | Evidence                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Job name: `rag.sync_source`. Payload: `{ sourceId, mode: "full"\|"incremental", ingestionId }`.                                                                                                                                                   | `packages/ingestion/src/queue.ts:9-23`                          |
| `enqueueSync` calls `boss.send(name, payload, { singletonKey: `sync:${sourceId}`, retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInHours: 6 })`; throws `SyncAlreadyRunningError` when `send` returns falsy.                            | `packages/ingestion/src/queue.ts:60-76`                         |
| Queues are explicitly created on boot (`boss.createQueue(name)` for each `JOB_NAMES`). pg-boss v10 requires this before `send`/`work`.                                                                                                            | `packages/ingestion/src/queue.ts:30-57`                         |
| `triggerSync` is the **sole writer** of `ingestion_jobs`: creates exactly one `pending` row, threads its `id` as `ingestionId` into the payload; worker only transitions it. On enqueue failure: delete row (duplicate) or mark `failed` (other). | `packages/services/src/sources.ts:25-99`                        |
| `ingestion_jobs` columns: `id, sourceId, status(pending\|running\|completed\|failed), mode, documentsProcessed, documentsFailed, chunksCreated, error, startedAt, completedAt, createdAt`. **No cursor/page columns.**                            | `packages/db/src/schema.ts:198-227`; enum `ingestionStatusEnum` |
| DB helpers: `createIngestionJob(db, row)`, `updateIngestionJob(db, id, patch)` (overwrite patch, no return), `deleteIngestionJob(db, id)`, `updateSourceCursor(db, id, cursor)`.                                                                  | `packages/db/src/queries.ts:48-57, 437-459`                     |
| Graceful drain: `queue.stop({ graceful: true })` then close DB pool; idempotent.                                                                                                                                                                  | `packages/runtime/src/index.ts:128-144`                         |

### 0.3 Allowed pg-boss v10 APIs (cited from official `/timgit/pg-boss` docs)

USE these — they are real:

- `boss.send(name, data, options)` → returns **job id (string) OR `null`**. `null` is returned (silently, no throw) when a unique/throttle/dedup constraint blocks the insert.
- `boss.insert(name, jobs[], options)` → bulk; **no debounce/singleton support**, ids not returned unless `returnId`. **Do not use for the continuation.**
- `boss.work(name, options, handler)` → handler receives an **array** of jobs; **return = success**, **throw = failure→retry**. A handler **may** call `boss.send(...)` to re-enqueue.
- `send` options that exist: `priority, id, retryLimit, retryDelay, retryBackoff, retryDelayMax, expireInSeconds, retentionSeconds, deleteAfterSeconds, startAfter, group, singletonSeconds, singletonNextSlot, singletonKey`.
- Queue **`policy`** (set at `createQueue`): `standard | short | singleton | stately | exclusive | key_strict_fifo`. Stateful "one-at-a-time" is a **queue policy**, not a `send` flag. `policy`/`partition` are immutable after creation.
- `boss.deleteJob(queue, id)`, `getBlockedKeys()` exist for advanced control.

### 0.4 Anti-patterns / APIs that DO NOT exist (guards)

- ❌ `useSingletonQueue` — not in v10. Use a queue `policy` instead.
- ❌ Assuming a duplicate `send()` **throws** — it **resolves `null`**. Code that ignores the return value silently loses the re-enqueue. (This is the central trap of S1.)
- ❌ Using `insert()` for the continuation (no dedup, no id).
- ❌ Inventing a `complete()`/`done()` callback — v10 uses return-or-throw.
- ❌ Treating `expireInHours` as canonical — v10's canonical field is `expireInSeconds` (`expireInHours` still works as legacy sugar). "Expiration" means: a job in `active` longer than the limit is **reclaimed → retried if retries remain, else failed**.

### 0.5 The load-bearing open question (resolved in Phase 1)

The continuation job must re-`send()` for the **same source**. The existing dedupe key is `singletonKey: sync:${sourceId}`. **If the re-send happens while the current job is still `active`, pg-boss may dedupe it to `null` and drop the continuation.** The exact boundary depends on the queue `policy` and is version-sensitive. **Phase 1 pins this down empirically before any pipeline change.** The hard constraint from the review still holds: **do not remove `singletonKey`** (it prevents duplicate _externally-triggered_ concurrent syncs per source).

---

## Phase 1 — Spike: pin down singletonKey + continuation semantics (HIGH; ~0.5 day) — GATING

**Goal:** Empirically determine, for the installed pg-boss `10.1.x` + the repo's current default queue policy, whether a self-re-enqueue with the same `singletonKey` lands or is dropped — and choose the continuation strategy accordingly. Do **not** touch the pipeline until this is answered.

### What to implement

1. Write a throwaway integration test (or scratch script) under `packages/ingestion/` using the real `createQueue`/`enqueueSync` path against a local Postgres (`pnpm docker:up`). Reference the existing test setup in `packages/ingestion/` (mirror whatever harness `enqueueSync`/`createQueue` tests already use; if none, use a minimal `PgBoss` against `DATABASE_URL`).
2. Reproduce the continuation scenario precisely:
   - `createQueue` exactly as `packages/ingestion/src/queue.ts:30-57` does (same schema, same `createQueue(name)` registration, **same default policy** — i.e. whatever pg-boss uses when `createQueue(name)` is called with no explicit `policy`).
   - `send` job A with `singletonKey: sync:SOURCE`.
   - Start a `work` handler; **inside** the handler (job A still `active`), call `boss.send(name, payload, { singletonKey: sync:SOURCE, ... })` and record whether it returns an **id** or **`null`**.
   - Separately test: `send` the continuation **after** the handler resolves job A.
3. Record the observed behavior in a short findings note appended to this file under "Phase 1 results".

4. **Also prove serialization across the re-enqueue window.** The continuation `send` runs in a **separate transaction** from the current job's completion. If the worker crashes between "re-send succeeded" and "current job marked complete", pg-boss retries the current job — which re-processes the page **and sends another continuation**. Assert that `singletonKey` prevents two continuations from ever being `active` concurrently (otherwise two continuations race on `sources.cursor`). Test: with a same-key job already active, attempt a second concurrent same-key `send` + `work` and confirm only one runs at a time. This is the cursor-write-race guard, not just the null-return check.

### Decision rule (pick the FIRST that the spike proves safe)

- **Option A — re-send inside handler returns a real id:** simplest. Worker re-enqueues continuation as the last step before returning. Keep `singletonKey` as-is. Treat a `null` return as a hard error (it would mean a successor already exists — should not happen for a serial continuation).
- **Option B — re-send inside handler returns `null` (deduped):** the current job is still `active`, so the key is occupied. Resolve via one of, in preference order:
  - **B1:** Switch the `rag.sync_source` queue to `policy: "singleton"` (1 active, unlimited queued) at `createQueue` and re-verify the continuation queues rather than drops. (Cleanest if it works; preserves one-active-per-source AND allows a queued successor.)
  - **B2:** Keep dedupe semantics but make the **continuation** bypass the same-key collision by NOT relying on `singletonKey` for the successor while still preventing external duplicates — e.g. mark the in-flight sync in `ingestion_jobs` and have `triggerSync` reject a new external trigger when a row is `running` (DB-level guard), reserving `singletonKey` for the brief enqueue window. (More moving parts; only if B1 fails.)
  - **B3:** `singletonNextSlot: true` so a throttled re-send is scheduled into the next slot instead of dropped. (Last resort; changes timing semantics.)

### Verification checklist

- [ ] A reproducible result recorded: "same-key send while active returns `<id|null>` under policy `<policy>`."
- [ ] Serialization proven: two same-key continuations are never `active` concurrently (cursor-write-race guard).
- [ ] The chosen Option (A or B1/B2/B3) is written into "Phase 1 results" with the evidence.
- [ ] If Option B1 (queue `policy`) is chosen: note that applying it is an **irreversible** queue change (policy is immutable → requires drop/recreate of `rag.sync_source`). The createQueue edit + deploy migration is assigned to **Phase 3** (see Phase 3 step 6).
- [ ] Confirmed the existing external-duplicate protection (two `triggerSync` calls for one source → second is rejected) still holds under the chosen option. Reference: `SyncAlreadyRunningError` path `packages/ingestion/src/queue.ts:72-74`, `packages/services/src/sources.ts:59-96`.
- [ ] Spike code is deleted or clearly quarantined (not shipped).

### Anti-pattern guards

- Do NOT design Phases 2–3 on the assumption that the re-send "just works." Prove it.
- Do NOT remove `singletonKey`.
- Do NOT change a queue `policy` blindly — `policy` is **immutable after creation**; changing it requires the queue to be dropped/recreated (note this for deployment in Phase 4).

---

## Phase 2 — Make `runIngestion` process one page and report continuation (HIGH; ~0.5 day)

**Goal:** Convert the internal multi-page loop into a single-page (bounded) step that persists the cursor and reports whether more work remains. Keep all existing per-document parse/chunk/embed logic untouched.

### What to implement (copy, don't reinvent)

1. In `packages/ingestion/src/pipeline.ts`, keep the body of one loop iteration **exactly** as it is today (`:74-106`): `connector.list` → `pLimit`/`Promise.allSettled` over `ingestOne` → counter tallies → `updateSourceCursor`. Reference snippet: `pipeline.ts:74-106`.
2. Change control flow so a single `runIngestion` call executes **one page** (or a small bounded page budget — default **1**; make it an `opts.maxPagesPerRun` with default 1 so it stays tunable). After the budgeted page(s):
   - Set `PipelineRunResult.done = page.done` (the connector's authoritative end-of-feed flag — see `pipeline.ts:74-106` note: do NOT infer done from `documents.length === 0`).
   - Return the result; the caller decides whether to re-enqueue.
3. Preserve the existing `done` field semantics in `PipelineRunResult` (`pipeline.ts:48-53`). Optionally add `nextCursor?: string | null` to the result if the worker needs it directly — but note the cursor is **already persisted to `sources.cursor`** via `updateSourceCursor`, so the continuation can read it from `source.cursor`. Prefer reading from `sources` to avoid threading cursor through the payload (keeps payload minimal).
4. Update the `pipeline.ts:71-73` comment to describe the now-implemented behavior (point it at this plan / the worker handler).
5. **Fix the `lastSyncedAt` semantic regression (user-visible).** `updateSourceCursor` sets `lastSyncedAt = new Date()` on **every** page (`packages/db/src/queries.ts:48-57`). Today that effectively reads as "sync ran." Under per-page it would advance mid-sync, after each page — and `lastSyncedAt` is surfaced to users via the MCP `list_sources` tool (`apps/mcp/src/tools/list-sources.ts:22,30`) and `trigger_sync` literally tells users to _"poll list_sources to see when lastSyncedAt updates"_ (`apps/mcp/src/tools/trigger-sync.ts:52`). If it advances mid-sync, that "is it finished?" signal lies. Fix: **decouple cursor persistence from `lastSyncedAt`.** Split `updateSourceCursor` into (a) a per-page cursor-only write, and (b) a `lastSyncedAt` stamp applied **only** on the final transition (`done === true`, in the worker — Phase 3). Keep the two writes as separate `@rag/db` helpers so the pipeline never touches `lastSyncedAt`.

### Authoritative references

- Loop + cursor persistence to copy: `packages/ingestion/src/pipeline.ts:74-106`
- Result shape: `packages/ingestion/src/pipeline.ts:48-53`
- Cursor sink (to split): `packages/db/src/queries.ts:48-57`
- `lastSyncedAt` consumers (the reason for the split): `apps/mcp/src/tools/list-sources.ts:22,30`, `apps/mcp/src/tools/trigger-sync.ts:52`

### Verification checklist

- [ ] `runIngestion` with `maxPagesPerRun: 1` processes exactly one page, persists cursor, returns `done` reflecting `page.done`.
- [ ] Unit test: a fake connector returning `done:false` then `done:true` across two calls causes two `runIngestion` invocations to complete the source, with cursor advancing each call.
- [ ] Unit test: a single-page source (`done:true` on first page) returns `done:true` with one call — **no behavior change** for small sources.
- [ ] `pnpm --filter @rag/ingestion test` green; `pnpm typecheck` green.
- [ ] Content-hash idempotency still makes re-processing a page a no-op (don't break `ingestOne`). Reference: `pipeline.ts` `ingestOne` (~`:124-217`).
- [ ] `lastSyncedAt` does NOT advance during a multi-page sync — only the cursor moves per page; `lastSyncedAt` is stamped once on completion (verified end-to-end with Phase 3).

### Anti-pattern guards

- Do NOT break on empty `page.documents` — only `page.done` ends the feed (`pipeline.ts:74-106` comment).
- Do NOT move cursor persistence to "only at run end" — it must persist per page so a crash/retry resumes (`pipeline.ts:97-99`).
- Do NOT change `ingestOne` or the embedding/chunking contracts.

### Phase 2 results (COMPLETE — 2026-06-20)

Implemented and green (`pnpm --filter @rag/ingestion test` 5/5, `@rag/db` 16/16,
typecheck db+ingestion+worker clean):

- `@rag/db`: split `updateSourceCursor` into a **cursor-only** write (no longer
  stamps `lastSyncedAt`) + new `markSourceSynced(db, id)` that stamps
  `lastSyncedAt = now()`. Both exported via the barrel.
- `@rag/ingestion` `pipeline.ts`: added `opts.maxPagesPerRun`; the page loop now
  stops on `page.done` **or** the page budget. `PipelineRunResult` gained
  `nextCursor` and `done` now authoritatively reflects the last page's `done`.
- `apps/worker` `handleSyncSource`: stamps `lastSyncedAt` via `markSourceSynced`
  **only** when `result.done === true`, immediately before marking the history
  row completed — the single place `lastSyncedAt` advances now.
- New unit tests `packages/ingestion/src/pipeline.test.ts` (mock `@rag/db`, fake
  connector/parser/chunker/embedder) cover: `maxPagesPerRun:1` single-page +
  `done:false`; two-call continuation with cursor advance; single-page no-change;
  default-unbounded drain-all; empty-page-with-`done:false` does not terminate.

**Deliberate deviation from the plan (read before Phase 3):** `maxPagesPerRun`
**defaults to unbounded** (drain-all), NOT 1. Reason: Phase 2 must ship without
Phase 3. The current worker calls `runIngestion` once and marks the row
completed regardless of `done`; defaulting to 1 now would mark multi-page syncs
"completed" after one page (data-loss regression). Unbounded default preserves
exact current behavior while making single-page a tunable opt-in. **Phase 3 flips
the worker to pass `maxPagesPerRun: 1` and re-enqueues on `done === false`** (and
moves the `markSourceSynced` stamp to the terminal continuation). The
`lastSyncedAt`-on-completion stamp was pulled forward into Phase 2 (gated on
`result.done`) so the DB split doesn't regress the signal in the interim.

---

## Phase 3 — Worker self-re-enqueues until `done`, with one history row per sync (HIGH; ~0.5 day)

**Goal:** The worker, on `done === false`, re-enqueues a continuation that resumes from the persisted cursor; on `done === true`, marks the single `ingestion_jobs` row completed. The continuation uses the **strategy proven in Phase 1**.

### What to implement

1. In `apps/worker/src/handlers/sync-source.ts`, after `runIngestion` returns (`:53-60`):
   - If `result.done === true`: mark the history row `completed` exactly as today (`:62-68`), **accumulating** counters (see #3).
   - If `result.done === true`: mark the history row `completed` (`:62-68`), accumulate final counters (#3), **and stamp `sources.lastSyncedAt = now`** here — the only place it advances (per Phase 2 step 5).
   - If `result.done === false`: re-enqueue a continuation job for the same `sourceId` carrying the **same `ingestionId`**, then return (success) so pg-boss completes the current job. Use the Phase 1 strategy for the re-send and **check the return value** of the enqueue (treat unexpected `null` as an error per Phase 1 decision). Do **not** stamp `lastSyncedAt` on a continuation.
2. **Continuation must resume from the stored cursor.** A continuation of a `"full"` sync must NOT reset cursor to `null`. Add a payload signal so the worker derives `startCursor = source.cursor` for continuations regardless of original mode. Extend `SyncSourcePayload` (`packages/ingestion/src/queue.ts:13-23`) with an explicit, well-commented field, e.g. `continuation?: boolean` (or `resumeFromCursor?: boolean`). Worker start-cursor logic becomes: `const startCursor = (job.data.mode === "full" && !job.data.continuation) ? null : source.cursor;` (reference current logic `sync-source.ts:53`).
3. **One history row per logical sync, with honestly-approximate counters.** The continuation reuses `ingestionId`, so the row stays `running` across continuations and is only marked `completed` on the final page. Counters must **accumulate** across pages, not overwrite (today's success path overwrites — `sync-source.ts:62-68`).
   - ⚠️ **Neither accumulation approach is exactly-once under retries.** A SQL additive update (`documents_processed = documents_processed + $delta`) is **NOT crash-safe**: if the worker crashes after incrementing but before the job is marked complete, pg-boss retries the same page and increments **again** (content-hash idempotency protects chunk _writes_, but not the counter arithmetic). Carrying running totals in the payload has the same retry-drift. Today's whole-sync overwrite is self-correcting on retry precisely because it overwrites — that property is lost the moment we go per-page.
   - **Decision:** accept that per-sync counters are **approximate** under retries and document it inline on the row/field. Use the simplest mechanism (additive SQL helper `incrementIngestionJobCounters(db, id, delta)` in `packages/db/src/queries.ts`), and treat the counters as observability, not billing/correctness. If exact counts are ever required, derive them from a `COUNT` over the `documents`/`chunks` tables for the source rather than from accumulators. Do **not** claim crash-safety in code comments.
4. Preserve every existing lifecycle transition and the **sole-writer invariant**: the worker still only _transitions_ the row created by `triggerSync`; it never creates an `ingestion_jobs` row, even for continuations. References: `sync-source.ts:38-39, 40-43, 62-68, 70-80`; `services/sources.ts:25-99`.
5. Add a continuation safety bound to avoid an infinite re-enqueue loop on a misbehaving connector (e.g. a max-continuations counter or detect non-advancing cursor → fail the row with a clear error). Surface as `failed` with an explanatory `error`.
6. **Land the queue-policy change if Phase 1 chose Option B1.** If the spike selected `policy: "singleton"` (or any non-default policy) for `rag.sync_source`, make the `boss.createQueue(name, { policy: ... })` edit here (`packages/ingestion/src/queue.ts:30-57`). Because `policy` is **immutable after creation**, the existing `rag.sync_source` queue must be dropped/recreated on deploy — document this as an explicit migration step (see the new "Rollback / deploy safety" section). If Phase 1 chose Option A, no queue change is needed and this step is a no-op.
7. **Mind the per-continuation connector cost.** Each handler invocation re-runs `connector.validate()` (`sync-source.ts:51`) — for Microsoft Graph connectors (SharePoint/Outlook) that is an auth round-trip against a **shared, throttled** Graph quota (a known gotcha in `CLAUDE.md` / the review). Per-page turns 1 sync × 1 validate into N pages × N validates. Mitigate by: (a) defaulting `maxPagesPerRun` > 1 for Graph-backed connectors so continuations are coarser, and/or (b) skipping `validate()` on continuation jobs when a token is still valid. Pick one and note it; do not silently N×-multiply Graph auth calls.

### Authoritative references

- Handler body + lifecycle: `apps/worker/src/handlers/sync-source.ts:16-81`
- Enqueue helper to extend/reuse: `packages/ingestion/src/queue.ts:60-76`
- Payload type to extend: `packages/ingestion/src/queue.ts:13-23`
- DB update helper to add near: `packages/db/src/queries.ts:443-449`

### Verification checklist

- [ ] Integration test: a multi-page fake source drives N continuation jobs through the worker, ending in exactly one `completed` `ingestion_jobs` row with **summed** counters and `sources.cursor` fully advanced.
- [ ] The continuation re-send return value is asserted non-null (per Phase 1).
- [ ] A `"full"` sync's continuations resume from cursor (do NOT re-enumerate from scratch).
- [ ] External duplicate trigger during an in-flight (continuing) sync is still rejected (`SyncAlreadyRunningError`).
- [ ] Worker restart mid-sync resumes at the next page (cursor-driven), no duplicate chunks (content-hash idempotency).
- [ ] Non-advancing/looping connector hits the safety bound and fails cleanly with a descriptive `error`.
- [ ] `sources.lastSyncedAt` advances **only** when the final continuation marks the row `completed` — not on intermediate pages.
- [ ] **Fairness test (the headline benefit):** two sources whose syncs both span multiple pages interleave their continuations on a single worker — neither monopolizes the worker for its whole run.
- [ ] Counters are documented as approximate-under-retry (no crash-safety claim in code/comments).
- [ ] `connector.validate()` is not N×-multiplied unmitigated (per step 7: coarser `maxPagesPerRun` for Graph connectors or skip-validate-on-continuation).
- [ ] `pnpm typecheck` + worker tests green.

### Anti-pattern guards

- Do NOT create a new `ingestion_jobs` row in the worker (violates sole-writer invariant — `services/sources.ts:29`).
- Do NOT remove `singletonKey` (`QUEUE-ARCHITECTURE-REVIEW.md` "Do NOT do this").
- Do NOT overwrite counters on continuation — accumulate.
- Do NOT re-enqueue before the real work is done in the handler (a thrown error after re-enqueue could double-execute). Re-enqueue as the **last** step before returning.

---

## Phase 4 — Tighten expiry (S2) + failure visibility / dead-letter (S3) (LOW + MEDIUM; ~0.5 day)

**Goal:** Now that jobs are per-page (short), make expiry sane and ensure permanently-failed syncs are noticed.

### What to implement

1. **S2 — expiry.** In `enqueueSync` (`packages/ingestion/src/queue.ts:60-76`), reduce the now-oversized `expireInHours: 6`. Switch to the canonical `expireInSeconds`. ⚠️ **Size it against a page's worst-case _duration_, not its document count.** "One page" bounds the job to `pageSize` documents (50), but a page of large PDFs through the parser + embedder can still take many minutes — so per-page only _partially_ solves C4 (long-running jobs). Pick `expireInSeconds` generously above the realistic slowest page, with margin. **Cross-check `pollingIntervalSeconds` and `retryDelay`** so a slow page isn't reclaimed mid-flight (a reclaim mid-page = a retry that races a continuation). If S2 is intentionally deferred, instead add an explicit comment near `enqueueSync` documenting the ">6h sources get killed" constraint (per S2 fallback in the review).
2. **S3 — dead-letter / visibility.** After `retryLimit: 3` exhaustion the row is already marked `failed` (`sync-source.ts:70-80`), but nothing alerts. Add visibility:
   - Minimal: a clear `logger.error`/`fatal` with a stable, greppable marker on terminal failure, plus surface failed syncs on an existing health/admin endpoint (check `apps/api/src/routes/` for an existing health/status surface to extend rather than adding new infra).
   - Optional (if a deadLetter queue is wanted): pg-boss v10 supports a `deadLetter` queue at `createQueue`. Wire `rag.sync_source` to a `rag.sync_source.dead` queue and a tiny handler that logs/records it. Note the **policy/partition immutability** caveat from Phase 1 — adding deadLetter to an existing queue may require recreation; document the migration step.

### Authoritative references

- Expiry + send options: `packages/ingestion/src/queue.ts:60-76`
- Queue creation (where deadLetter/policy would go): `packages/ingestion/src/queue.ts:30-57`
- Failure transition: `apps/worker/src/handlers/sync-source.ts:70-80`
- Worker knobs (poll interval / concurrency): `packages/core/src/config.ts:78-80, 293-295`

### Verification checklist

- [ ] `expireInSeconds` chosen with documented rationale vs page worst-case and poll/retry timing.
- [ ] A forced terminal failure (exhaust retries) produces a clearly visible signal (log marker and/or health surface entry).
- [ ] Deployment note added if the queue must be recreated to add deadLetter/policy.
- [ ] `pnpm typecheck` green; existing queue tests green.

### Anti-pattern guards

- Do NOT set `expireInSeconds` shorter than a realistic single-page processing time (would cause spurious reclaim/retry storms).
- Do NOT add a second stateful service for alerting — reuse logs/health surface (review explicitly favors zero new infra).

---

## Rollback / deploy safety

This feature ships as code, but two aspects need explicit handling.

### Rolling-deploy interop (no big-bang)

- **Old coarse jobs hitting the new worker are safe.** A job enqueued by the pre-change producer carries the same payload shape (no `continuation` field). The new single-page `runIngestion` processes one page and returns `done=false`; the new worker re-enqueues a continuation. The sync simply finishes as a chain instead of one long job. **Add a test** asserting a payload without the `continuation` field is treated as a first (non-continuation) job (`continuation === undefined` → falsy).
- **New continuation jobs reaching an old worker** (mixed fleet mid-deploy): an old worker ignores the `continuation` field and runs its old whole-loop `runIngestion` from `source.cursor` — still correct (idempotent, cursor-driven), just coarse. No corruption. Drain/replace workers normally.

### Reverting

- **Code revert** of Phases 2–3 restores whole-sync behavior; safe at any time (cursor + content-hash idempotency mean an in-flight chain just gets re-run coarsely).
- **The one irreversible step is the queue `policy` change (Option B1).** `policy` is immutable, so adopting `singleton`/etc. requires drop + recreate of `rag.sync_source`, and reverting requires the same. Document the exact drop/recreate (and that in-flight jobs in that queue are lost on recreate — drain first via graceful stop). If Phase 1 chose Option A, there is nothing irreversible here.

---

## Phase 5 — Docs (S4) + final verification

### What to implement

1. **S4.** Link `docs/QUEUE-ARCHITECTURE-REVIEW.md` and this plan from `docs/ARCHITECTURE.md` near line 133 (the existing queue rationale), so the "keep pg-boss + fix granularity" decision and its implementation travel together.
2. Update `docs/QUEUE-ARCHITECTURE-REVIEW.md`: mark S1 implemented; fold in the Phase 1 finding about singletonKey/continuation.
3. Update the `pipeline.ts:71-73` comment (if not already done in Phase 2) to reflect implemented behavior.

### Final verification (whole-feature)

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all green across the workspace.
- [ ] End-to-end: a real multi-page source (or a faithfully faked one) ingests fully via N continuation jobs; one `completed` history row; cursor fully advanced; no duplicate chunks.
- [ ] Grep guards for invented APIs return nothing:
  - `useSingletonQueue` → no matches.
  - Any `boss.send(`/`enqueue` continuation path checks the return value (no ignored `send` results in the continuation path).
- [ ] `singletonKey` still present in `enqueueSync`.
- [ ] Worker never calls `createIngestionJob` (sole-writer invariant intact): `grep` `createIngestionJob` → only in `packages/services/src/sources.ts`.
- [ ] `lastSyncedAt` is written only on the completion transition: `grep -rn "lastSyncedAt" packages apps` → the per-page cursor write no longer sets it; only the `done===true` path does.
- [ ] No code comment claims the counter accumulation is crash-safe/exactly-once.
- [ ] The original review's "Do NOT do this" list is honored (no queue migration; singletonKey kept; sole-writer invariant kept).

### Anti-pattern guards

- Do NOT begin any queue-library migration (the verdict is keep pg-boss).
- Do NOT let docs drift — S1's behavior change must be reflected in ARCHITECTURE.md and the review doc.

---

## Phase 1 results (COMPLETE — 2026-06-19)

**Environment:** pg-boss **`10.4.2`** installed/hoisted (package.json declares `^10.1.6`, but the
resolved + prod runtime is `10.4.2` — the prod `pgboss` schema is also v10.4.2). Spike ran against
local Postgres (`postgres://rag:rag@localhost:5432/rag`). Spike script:
`packages/ingestion/scratch/spike-singleton.ts` (deleted after recording — see checklist).

### Empirical results (spike)

| Probe                                                    | `standard` (default) | `singleton`     |
| -------------------------------------------------------- | -------------------- | --------------- |
| Q1: in-handler re-send while job A **active** (same key) | **`id`**             | **`id`**        |
| Q2: re-send after A **completed** (immediate)            | `id`                 | `id`            |
| Q2: re-send after A completed (post-archive)             | `id`                 | `id`            |
| Q3: max concurrently **active** same-key jobs            | (see note)           | **1**           |
| Q3: two same-key `send()` both return id?                | yes (`id`,`id`)      | yes (`id`,`id`) |

### Root-cause confirmation (read from pg-boss `10.4.2` source — authoritative)

`src/plans.js` builds the singleton-uniqueness indexes **gated by queue `policy`**:

- `job_i1` (short): `UNIQUE (name, singleton_key) WHERE state='created' AND policy='short'`
- `job_i2` (singleton): `UNIQUE (name, singleton_key) WHERE state='active' AND policy='singleton'`
- `job_i3` (stately): `UNIQUE (name, state, singleton_key) WHERE state<='active' AND policy='stately'`
- `job_i4` (throttle): `UNIQUE (name, singleton_on, singleton_key) WHERE singleton_on IS NOT NULL` — and
  `singleton_on` is set **only** by `singletonSeconds/Minutes/Hours` (`src/attorney.js`), **not** by `singletonKey`.

**Therefore: under the default `standard` policy, `singletonKey` alone (no `singletonSeconds`) performs
ZERO deduplication and ZERO serialization.** No index applies. `fetchNextJob` only gates concurrency for
`singleton`/`stately` policies. This is confirmed both by the source and the spike (two same-key sends both
returned ids; the Q3 `standard` measurement showing `1` was a teardown/timing artifact — the source proves
two same-key `standard` jobs **can** be active concurrently).

### Decision: **Option B1 — set `rag.sync_source` queue `policy: "singleton"`.**

Reasoning (and why the literal "Option A" is a trap here):

- Mechanically, the continuation re-send returns a real `id` under **both** policies (Q1), so by the bare
  letter of the decision rule Option A "passes." **But Option A's safety contract** — "treat a `null` return
  as a hard error because `singletonKey` guarantees a serial continuation / no concurrent duplicate" — is
  **false under `standard`**. `singletonKey` provides no serialization there, so the Phase 1-step-4
  cursor-write-race guard (crash between "re-send succeeded" and "job A marked complete" → pg-boss retries A
  while the continuation is also active → two writers racing `sources.cursor`) is **not** satisfied. This is
  the §0.4 "central trap of S1" in a subtler form: the re-send _looks_ safe (returns id) but the protection
  isn't real. **Reject naive Option A.**
- `policy: "singleton"` (`job_i2`: unique **active** per `singleton_key`) guarantees **exactly one active job
  per `sync:${sourceId}`** at any instant, while letting the continuation **queue** behind the active job
  (Q1=`id`; Q3: max-active=1, both processed). That is exactly the "1 active, unlimited queued" behavior B1
  promised, and it **does** satisfy the cursor-write-race guard.

### Migration mechanics — REFINEMENT (de-risks Phase 3 + the Rollback section)

The plan repeatedly assumes "`policy` is immutable → drop/recreate the queue." That is **overstated** for
this change:

- `create_queue(...)` is `ON CONFLICT DO NOTHING` and returns early when the queue already exists — so the
  boot-time `boss.createQueue(name)` call will **not** change the existing `rag.sync_source` policy. Editing
  `createQueue` to pass `{ policy }` is therefore a **no-op on an existing queue**.
- Instead call **`boss.updateQueue("rag.sync_source", { policy: "singleton" })`** (public API,
  `manager.js:570`). It `UPDATE`s `queue.policy`; the partition's policy indexes (`job_i1/i2/i3`) already
  exist and filter on each job's own `policy` column (copied from the queue at insert via `fetchNextJob`/
  insert join). New jobs immediately get `policy='singleton'` and are enforced by `job_i2`; in-flight jobs
  finish under their original policy. **No drop/recreate, no lost jobs, and reversible** via
  `updateQueue(..., { policy: "standard" })`.
- → **Phase 3 step 6 and the "Rollback / deploy safety" section should use `updateQueue`, not drop/recreate.**
  The only residual subtlety: the flip applies to newly-inserted jobs; drain or tolerate in-flight `standard`
  jobs during the transition (they remain correct, just unserialized for their remaining life).

### Pre-existing bug surfaced (do NOT fix in this phase — flag for Phase 3 design)

Because `singletonKey` is inert under the current `standard` policy, the existing
`enqueueSync` → `SyncAlreadyRunningError` protection (which relies on `boss.send` returning `null` for a
same-key duplicate, `queue.ts:72-74`) **never fires today**. Two concurrent external `triggerSync` calls for
one source currently BOTH enqueue and could BOTH run. Adopting `singleton` policy fixes the dangerous part
(they can no longer be **active** concurrently — the second **queues**), but the second `send` still returns
an `id` (queued), so it is **not rejected** with `SyncAlreadyRunningError`. **Phase 3 design decision:**
either (a) accept "queue instead of reject" as the new, arguably-better semantics (no lost trigger, no race),
or (b) add an app-level guard (Option B2 flavor: have `triggerSync` reject when an `ingestion_jobs` row is
`running`) to preserve the original "reject duplicate" contract. Update the Phase 1 verification-checklist
expectation in Phase 3 accordingly (the current checklist asserts the second trigger is _rejected_ — under
B1 it is _queued/serialized_ unless (b) is added).

### Phase 1 verification checklist — status

- [x] Reproducible result recorded: "same-key `send` while active returns **`id`** under policy `standard` **and** `singleton`; under `standard` there is no dedup/serialization at all (no applicable index)."
- [x] Serialization proven: under `singleton`, `job_i2` + `fetchNextJob` gating guarantee one active per key (spike max-active=1, both processed); under `standard` it is **not** serialized (source-authoritative).
- [x] Chosen Option recorded with evidence: **B1 (`policy: "singleton"`)**.
- [x] B1 application note — **REVISED**: it is **not** an irreversible drop/recreate. Use `boss.updateQueue("rag.sync_source", { policy: "singleton" })` (idempotent, reversible). Assigned to **Phase 3 step 6**.
- [x] External-duplicate protection: **FINDING** — currently broken under `standard` (never rejects). Under B1 the duplicate is serialized/queued, not rejected; preserving the original "reject" contract requires the Phase 3 app-level guard above.
- [x] Spike code deleted (not shipped): `packages/ingestion/scratch/spike-singleton.ts` removed.
