# Queue Architecture Review: Is pg-boss the right job queue?

> **Audience:** humans and AI agents.
> **Status:** Advisory. No code changes implied by this document alone.
> **Date:** 2026-06-19
> **Scope:** The ingestion job queue (`pg-boss`) — its fitness for this system, concerns, and concrete suggestions.
> **TL;DR:** Keep pg-boss. It is the correct choice at current and foreseeable scale. The highest-leverage improvement is **not** swapping queue libraries — it is fixing job _granularity_ (per-page self-re-enqueue), which is already foreshadowed in the code but unimplemented.

---

## How to use this document

- **Humans:** Read "Verdict" → "Concerns" → "Suggestions". Each suggestion has a priority and a rough effort estimate.
- **AI agents:** Treat the "Concerns" and "Suggestions" sections as a backlog. Each item lists the authoritative source files. Verify the cited line ranges still hold before acting (the code may have moved). Do **not** begin a queue-library migration on the basis of this document — see "Do NOT do this".

---

## System facts (verified against the code)

These are the load-bearing facts behind the verdict. Re-verify before relying on them.

| Fact                                                                                                                                                                                | Evidence                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One pg-boss job == one **entire** source sync. The full pagination + per-document parse/chunk/embed loop runs _inside_ a single job.                                                | `packages/ingestion/src/pipeline.ts` (`runIngestion`, `while (!pageDone)` loop ~L74); `apps/worker/src/handlers/sync-source.ts` (calls `runIngestion` once per job)                              |
| Job _rate_ is therefore tiny — roughly one job per source per sync, not thousands/sec.                                                                                              | Derived from the above                                                                                                                                                                           |
| The real throughput bottleneck is the Python parser sidecar + the embedding API, not queue dispatch.                                                                                | `docs/ARCHITECTURE.md:133`; pipeline calls `parser` then `embedder.embedBatch` per document                                                                                                      |
| Queue lives in the same Postgres (`pgboss` schema) as all app data.                                                                                                                 | `packages/ingestion/src/queue.ts` (`schema: opts.schema ?? "pgboss"`)                                                                                                                            |
| Features actually used: `singletonKey` dedupe, `retryLimit`/`retryDelay`/`retryBackoff`, `expireInHours`, `archiveCompletedAfterSeconds`, graceful drain, multi-worker row-locking. | `packages/ingestion/src/queue.ts` (`enqueueSync`, `createQueue`); `packages/runtime/src/index.ts` (`stop({ graceful: true })` ~L135); `apps/worker/src/main.ts` (header comment on multi-worker) |
| pg-boss version                                                                                                                                                                     | `^10.1.6` in `apps/worker/package.json` and `packages/ingestion/package.json`                                                                                                                    |
| Worker knobs                                                                                                                                                                        | `WORKER_CONCURRENCY` (default 4) → `batchSize`; `WORKER_POLL_INTERVAL_MS` (default 2000) → `pollingIntervalSeconds`. `packages/core/src/config.ts:78-80, 293-295`                                |
| Deployment                                                                                                                                                                          | Railway, 4 services (api, worker, mcp, postgres), single Postgres instance. `docs/DEPLOYMENT.md`                                                                                                 |

---

## Verdict

**pg-boss is the right job queue for this system.** Switching would be a net negative today. Rationale:

1. **Job rate is trivially low.** pg-boss's practical ceiling (hundreds–low-thousands of jobs/sec) is 3–4 orders of magnitude above this system's need, because a whole sync is one coarse job.
2. **Zero new infrastructure.** Postgres+pgvector is already mandatory and central. A Redis-backed queue (BullMQ) adds a second stateful service to operate, back up, and monitor — unjustified at this scale.
3. **Transactional enqueue / no dual-write hazard.** Queue and application bookkeeping share one Postgres, so enqueue and DB writes can be made atomic. Redis/SQS queues force a dual-write with a "committed one, lost the other" failure mode.
4. **The needed features are first-class and in use:** dedupe (`singletonKey`), retries with backoff, archival, expiry, graceful drain, exactly-once dispatch across N workers via row locks, and cron (available if scheduled incremental syncs are wanted).

The existing reasoning in `docs/ARCHITECTURE.md:133` ("slower than BullMQ at thousands of jobs/second, but ingestion is bounded by the parser and embedding API") is correct and should be preserved.

---

## Concerns

### C1 — Coarse job granularity is the real latent risk (HIGH)

The entire multi-page sync executes as one job under `expireInHours: 6` and `retryLimit: 3` (`packages/ingestion/src/queue.ts`). Consequences:

- A library large enough to take **>6h** to sync will be **expired mid-flight**.
- A failure late in the run forces a retry of the **whole sync**.
- A single huge source can monopolize a worker slot for the entire run, starving other sources.

**Mitigations already present** (these soften, not eliminate, the risk):

- Per-page cursor persistence (`pipeline.ts`, `updateSourceCursor` after each page) — a retry resumes near where it left off rather than from zero.
- Content-hash idempotency — re-ingesting unchanged documents is a no-op, so retries are cheaper than they appear.

**Key finding:** the proper fix is **described in the code but not implemented**. See `packages/ingestion/src/pipeline.ts` ~L71-73:

> _"For very large sources, the worker can split this by having the connector return `done=false` and the job re-enqueue itself with the new cursor."_

This is a _usage_ gap, not a pg-boss limitation. pg-boss does fan-out / self-re-enqueue fine.

### C2 — Polling, not push (LOW at current scale)

pg-boss polls (default every ~2s here). This adds pickup latency and a steady trickle of DB queries. Irrelevant at this job volume, but it is the structural reason pg-boss loses to Redis-backed queues on raw latency/throughput. Note only.

### C3 — Queue and retrieval share one Postgres (LOW now, watch later)

Queue polling competes with vector search / API queries for connections on the same instance. Fine today; becomes a scaling consideration if query load and sync load grow together.

### C4 — Long-running jobs are an anti-pattern for any queue (MEDIUM)

Independent of library choice: a job that runs for minutes-to-hours strains visibility-timeout / heartbeat assumptions in every queue system. C1's fix (smaller jobs) also resolves this.

---

## Suggestions

### S1 — Implement per-page self-re-enqueue (HIGH; ~0.5–1 day)

Have `runIngestion` process **one page**, persist the cursor, and re-enqueue the same job with `done=false` and the new cursor until the connector signals end-of-feed. Benefits:

- Syncs become **checkpointed and resumable** across the 6h expiry window.
- **Fairer** scheduling — large sources no longer hog a worker for the whole run.
- **Crash-tolerant** — a worker restart resumes at the next page.

This delivers most of what one imagines gaining from a "better" queue, without leaving Postgres. Touch points: `packages/ingestion/src/pipeline.ts`, `apps/worker/src/handlers/sync-source.ts`, and the `ingestion_jobs` lifecycle updates. Preserve the `singletonKey` dedupe semantics across re-enqueues.

### S2 — Re-evaluate `expireInHours` after S1 (LOW; minutes)

Once jobs are per-page, the 6h expiry becomes generous and safer. If S1 is deferred, document the "sources that take >6h will be killed" constraint explicitly near `enqueueSync`.

### S3 — Add a dead-letter / failure-visibility path (MEDIUM; ~0.5 day)

After `retryLimit: 3` exhaustion, ensure the failure is surfaced (it is recorded on the `ingestion_jobs` row by `sync-source.ts`, but there is no alerting). Consider a small admin/health surface or log-based alert so permanently-failed syncs are noticed.

### S4 — Keep the decision recorded (LOW; done by this doc)

Link this document from `docs/ARCHITECTURE.md` near L133 so the queue rationale and the C1 caveat travel together.

---

## When you would actually outgrow pg-boss

Switch only if **one** of these becomes true:

- Ingestion moves to **per-document/per-page fan-out at thousands of jobs/sec**.
- You need **sub-second** job pickup latency.
- **Postgres becomes the contention point** and you want queue load offloaded to separate infra.

None are near for the current workload (small org, SharePoint-scale libraries).

---

## Alternatives considered (and why not, yet)

| Option                                         | Pros                                                          | Why not now                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **BullMQ (Redis)**                             | Faster, push-based, mature dashboards                         | New stateful infra; dual-write consistency loss; overkill at this job rate                                            |
| **Graphile Worker (Postgres)**                 | `LISTEN/NOTIFY` → lower latency than polling; lighter         | A legitimate peer, but pg-boss's singleton/cron/archival set is richer and already integrated; migration not worth it |
| **Temporal**                                   | Best conceptual fit for long, multi-step, resumable workflows | Large operational overhead; only if ingestion orchestration gets dramatically more complex                            |
| **Cloud queues (SQS / Cloud Tasks / Pub/Sub)** | Managed, scalable                                             | Lose transactional enqueue; mismatched with the persistent-worker-on-Railway model                                    |

---

## Do NOT do this

- **Do not start a queue-library migration** based on this document. The verdict is "keep pg-boss." Any migration requires its own explicit decision with the trigger conditions above met.
- **Do not remove the `singletonKey` dedupe** when implementing S1 — it is what prevents duplicate concurrent syncs per source.
- **Do not break the "sole writer of `ingestion_jobs`" invariant** (`triggerSync` creates the row; the worker only transitions it). See `apps/worker/src/handlers/sync-source.ts`.
