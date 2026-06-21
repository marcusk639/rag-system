# Phase 3 — First SharePoint Sync (RESOLVED diagnosis + fixes)

Updated 2026-06-19. The earlier "stuck `ingestion_jobs` row" theory was **wrong** —
that table was clean. Direct inspection of prod found three independent defects.
Fixes are on branch `fix/phase3-first-sync` (commit `058e5f1`) and deploying.

## Infra state (all green)

| Service      | State   | Notes                                                               |
| ------------ | ------- | ------------------------------------------------------------------- |
| rag-postgres | RUNNING | pgvector pg16. pg-boss schema present (v10.4.2).                    |
| rag-api      | RUNNING | `https://rag-api-production-07b4.up.railway.app` `/health`,`/ready` |
| rag-mcp      | RUNNING | —                                                                   |
| rag-worker   | RUNNING | pg-boss connected, consumes `rag.sync_source`.                      |
| rag-parser   | RUNNING | markitdown primary, unstructured fallback.                          |

Project `rag-system` `d5676b24-…`, env `production` `53a51a39-…`.
Source: `d3461cbe-b99f-4253-aded-b3610afe56de` (`sharepoint`, site
`twkcpafirmllc.sharepoint.com/sites/RAGTestSite`). **Connector + Graph auth verified
working**: a real sync fetched `count=16` docs with a valid delta cursor (no 403/404),
so admin consent + the bare `siteId` resolve fine.

## Root causes (what actually blocked the first sync)

1. **pg-boss queue never created (the false 409).** pg-boss v10 requires queues to
   exist before `send()`/`work()`. The `createQueue()` wrapper only called
   `boss.start()`, so `rag.sync_source` was absent from `pgboss.queue`. v10's
   `insertJob` does `INSERT … SELECT … FROM (job) j JOIN pgboss.queue q ON j.name =
q.name ON CONFLICT DO NOTHING RETURNING id`; with no queue row the JOIN yields
   nothing, the insert returns no id, and `enqueueSync` misreads that `null` as a
   duplicate → **409 SYNC_ALREADY_RUNNING** with nothing actually running. Meanwhile
   `work()` silently polled a queue that never filled (worker logged only "worker
   started"). **Fix:** `createQueue()` now creates every `JOB_NAMES` queue on boot
   (idempotent). Already created in prod manually; the code fix makes it durable.

2. **Embedding model retired.** `text-embedding-004` now 404s on Gemini
   `embedContent` ("not found for API version v1beta"). **Fix:** default
   `gemini-embedding-001`, which emits 768-d vectors via `outputDimensionality`
   (no index migration). Requires prod env `EMBEDDING_MODEL=gemini-embedding-001`
   on **both** rag-api (query embed) and rag-worker (doc embed) — staged.

3. **Parser 500 on docx.** `markdownify>=0.13` passes `parent_tags=` into
   `convert_*`; markitdown `0.0.1a4`'s `_CustomMarkdownify.convert_a()` predates that
   kwarg → `TypeError … unexpected keyword argument 'parent_tags'`. **Fix:** pin
   `markdownify<0.13` in `services/parser-py/requirements.txt`.

## UPDATE 2026-06-19 ~8:10pm CDT — restart DONE, 3 original blockers RESOLVED, 2 NEW blockers

The env-var restart is complete and the original three defects are confirmed fixed.
The first sync now runs end-to-end through the queue. Two _new_, independent blockers
stop ingestion from producing chunks.

What was done this session:

- The prior session's `railway redeploy`/`railway up` attempts FAILED (api `e7db129d`
  23:25, worker `d981a9fa` 23:54) — almost certainly `railway up` run from the
  `fix/phase3-first-sync` checkout, which lacks the `apps/{api,worker}/Dockerfile`s,
  which also poisoned the retained upload snapshot (so a nonce/var-change redeploy
  would just rebuild the broken snapshot and fail).
- Fix: created a clean worktree of `feat/pluggable-oidc-auth` at `~/dev/rag-system-oidc`
  (has both Dockerfiles) and ran `railway up --service rag-api` then `--service
rag-worker` from there with explicit `--project`/`--environment`. Both built + deployed
  clean (api `8ee49637`, worker `68eca9be`, both RUNNING/SUCCESS, booted ~01:00 UTC —
  AFTER `EMBEDDING_MODEL` was set).
- Re-triggered full sync (`jobId 82e139fa`). Worker processed it: **no false 409, queue
  works, embedding model migrated** (errors are no longer the `text-embedding-004` 404).
- Sync result: `documentsProcessed=8 documentsFailed=8 chunksCreated=0`.

TWO NEW BLOCKERS (both must be cleared before chunks are produced):

1. **Gemini billing exhausted — `429 RESOURCE_EXHAUSTED`** "Your prepayment credits are
   depleted." Confirms `gemini-embedding-001` is being called correctly; the Google AI
   project simply has no credits. **USER ACTION:** top up prepay credits at
   https://ai.studio (or rotate `GEMINI_API_KEY` to a funded project). Blocks ALL docs.
2. **Parser 500 on unrecognized formats** — `markitdown UnsupportedFormatException:
... formats ['.bin','.sndr'] are not supported`. The original `parent_tags` docx
   crash IS fixed (markdownify pin worked); this is new. The connector hands the parser
   files with no usable filename/extension → generic `.bin` temp file → markitdown can't
   sniff → `unstructured` fallback doesn't catch → hard 500. **CODE FIX** (parser-py
   and/or connector): pass real filename/mime from SharePoint, and have the parser skip
   unsupported formats gracefully (422/empty) instead of 500.

Durability follow-up still open: the running api/worker images are built from
`feat/pluggable-oidc-auth` (NOT commit `058e5f1`); prod is correct only via the
`EMBEDDING_MODEL` env override + manually-created queue. Land `058e5f1` onto the
Dockerfile-bearing branch to make it durable.

Worktree `~/dev/rag-system-oidc` (branch `feat/pluggable-oidc-auth`) left in place for
follow-up deploys; `git worktree remove` it when done.

### UPDATE 2026-06-19 ~10:15pm CDT — free-tier Gemini key swapped; embedding 429 CLEARED

- User minted a fresh **free-tier** Gemini key (the old one was on paid prepay that ran
  dry → 429) and set `GEMINI_API_KEY` on both services. That var change auto-redeployed
  both (rebuilding the now-good upload snapshot — confirms the "poisoned snapshot" theory):
  rag-api `1de3cfc5`, rag-worker `adcf9bc8`, both RUNNING/SUCCESS @ ~03:08 UTC.
- Re-ran full sync (`jobId 9ece1538`): `documentsProcessed=14 documentsFailed=2
chunksCreated=0`. **ZERO EmbeddingError/429 this run → embedding blocker is fixed.**
  The 2 failures are the parser `.bin`/`.sndr` docs.

TWO REMAINING ITEMS for a green sync (chunksCreated>0):

1. **Stale doc-hashes block re-embedding (chunksCreated=0 despite no embedding errors).**
   The earlier 429 runs upserted `documents` rows (recording `content_hash`) BEFORE
   embedding failed. ingestOne short-circuits on unchanged hash → skips embedding → no
   chunks. The 12 "processed, not failed" docs were silently SKIPPED, never embedded.
   FIX: reset the source's docs so a re-sync re-embeds — e.g.
   `DELETE FROM documents WHERE source_id='d3461cbe-b99f-4253-aded-b3610afe56de';`
   (or `UPDATE documents SET content_hash=NULL WHERE source_id=…`) via a DB connection
   (no DELETE endpoint exists yet). USER/DB action — touches prod data.
   Deeper fix (follow-up): don't treat a document with 0 chunks as "done"; re-embed if
   `content_hash` matches but the doc has no chunks.
2. **Parser 500 on extensionless/odd files** (`services/parser-py/app/main.py`). Root cause
   confirmed: the pipeline sends `filename: source.title` + `mimeType: source.mimeType`;
   some SharePoint items arrive with a generic/empty MIME (`application/octet-stream`) and
   a name the parser can't route, so `ext=""` + unknown mime → `_suffix_for_mime()`
   returns `.bin`, AND the parser trusts the provided mime over `magic` sniffing. Two-part
   fix: (a) when the provided mime is generic/missing, prefer `magic.from_buffer(raw)`
   sniffing to pick the suffix; (b) when markitdown AND unstructured both reject a truly
   unsupported binary, return **422** (skip) instead of 500 so one bad file doesn't poison
   the doc as a hard failure. Optional connector-side: pass a better filename/mime.

VERIFY after both: re-sync → `chunksCreated>0`, then `/search` returns chunks.

---

## End-of-session state (2026-06-19 ~12:30pm CDT) — SUPERSEDED by the UPDATE above

DONE:

- Code committed: branch `fix/phase3-first-sync` off `origin/main`, commit `058e5f1`
  (queue creation + embedding default + parser pin). NOT pushed, NOT merged.
- **Parser fix is LIVE**: `railway up --service rag-parser` rebuilt with
  `markdownify<0.13` (deploy `42416e27`, SUCCESS/RUNNING). docx 500s resolved.
- **Queue is created in prod**: `rag.sync_source` exists in `pgboss.queue`; the false
  409 is gone. A real sync already ran and fetched 16 SharePoint docs.
- Env set on rag-worker + rag-api: `EMBEDDING_MODEL=gemini-embedding-001` (value is
  present in the service variables).

NOT DONE — the single remaining blocker:

- The **running** rag-worker (deploy `2a67591b`, booted 16:25) and rag-api (`4159e409`,
  booted 13:25) started **before** `EMBEDDING_MODEL` was set, so their live processes
  still use `text-embedding-004` in memory → embeddings still 404 until they restart.
- `railway redeploy --service <svc> --yes` **silently no-ops** in CLI v5.17.0 (exits 0,
  no new deployment). Re-setting `EMBEDDING_MODEL` to the same value also does NOT
  trigger a deploy (unchanged value = no-op).
- Cannot `railway up` worker/api from this branch: **`apps/api/Dockerfile` and
  `apps/worker/Dockerfile` do not exist on `origin/main`** — they live only on
  `feat/pluggable-oidc-auth` (the branch prod is actually built from). `origin/main`
  is stale/incomplete for these two services.

## RESUME PLAN (next session — force the restart via CLI, then verify)

Goal: get rag-worker + rag-api to restart so they pick up `EMBEDDING_MODEL=
gemini-embedding-001`, then prove the first sync ingests + search returns chunks.

Step 1 — force a redeploy by CHANGING a variable (a value change DOES trigger a
deploy of the current image; an unchanged set does not). Use a throwaway nonce var:

```bash
cd ~/dev/rag-system
# bump the value each run so it always differs (use any changing token)
railway variables --service rag-worker --set "REDEPLOY_NONCE=phase3-a"
railway variables --service rag-api    --set "REDEPLOY_NONCE=phase3-a"
# confirm a NEW deployment id + fresh boot:
railway status --json | python3 -c "import sys,json;d=json.load(sys.stdin);[print(n['node'].get('serviceName'),[ (x.get('id','')[:8],x.get('createdAt')) for x in (n['node'].get('activeDeployments') or [])]) for e in d['environments']['edges'] if e['node']['name']=='production' for n in e['node']['serviceInstances']['edges'] if n['node'].get('serviceName') in ('rag-worker','rag-api')]"
railway logs --service rag-worker | grep 'worker started' | tail -1   # boot time must be AFTER the env was set
```

(If the nonce approach is undesirable, restart both from the Railway dashboard
instead — Deployments → ⋮ → Redeploy. Then delete REDEPLOY_NONCE later.)

Step 2 — re-trigger the sync and prove it works:

```bash
API=https://rag-api-production-07b4.up.railway.app
TOK=$(railway variables --service rag-api --kv | grep '^API_TOKENS=' | cut -d= -f2- | cut -d, -f1)
curl -s -X POST "$API/sources/d3461cbe-b99f-4253-aded-b3610afe56de/sync" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"mode":"full"}'
railway logs --service rag-worker        # expect documentsProcessed>0, chunksCreated>0, NO EmbeddingError/ParserError
curl -s "$API/sources/d3461cbe-b99f-4253-aded-b3610afe56de" -H "Authorization: Bearer $TOK"  # lastSyncedAt + cursor set
curl -s -X POST "$API/search" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"query":"<distinctive phrase from an uploaded doc>","limit":5}'   # returns chunks
```

Step 3 — cleanup: if you added `REDEPLOY_NONCE`, remove it
(`railway variables --service rag-worker --unset REDEPLOY_NONCE`, same for api).

NOTE on durability: the queue-creation + embedding-default CODE fix (commit `058e5f1`)
is NOT in the running worker/api images (they build from `feat/pluggable-oidc-auth`,
which lacks these fixes). Prod works anyway because the queue is already created and
the env var overrides the model default. To make it durable, land `058e5f1` onto
whichever branch carries the `apps/*/Dockerfile`s (likely `feat/pluggable-oidc-auth`)
or reconcile main, then redeploy worker/api from there.

## Follow-ups (not blocking)

- Land `fix/phase3-first-sync` to `main` via PR.
- Worker logging on job receipt/skip so a missing job is visible (was invisible here).
- Gemini query embeds use `taskType: RETRIEVAL_DOCUMENT`; queries should arguably use
  `RETRIEVAL_QUERY` (minor retrieval-quality nit, pre-existing).
- Consider a `DELETE /sources/:id` / job-reset endpoint so DB never needs raw SQL.
