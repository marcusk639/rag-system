# Phase 3 — First SharePoint Sync (COMPLETE ✅) + next-session handoff

Updated 2026-06-21. The Phase 3 first-sync goal is **met and verified green**, and
all fixes are durably on `main` and deployed from `main`. This doc now serves as
the handoff for remaining cleanup/follow-ups.

## Final verified result

Sync job `a6ca467c` against source `d3461cbe-b99f-4253-aded-b3610afe56de`:

```
documentsProcessed=14  documentsFailed=2  chunksCreated=108  done=true
```

- **chunksCreated=108** (was 0) — all 14 real docs embedded; no 429 failures.
- **documentsFailed=2** = the two `.bin`/`.sndr` items, now cleanly **422-skipped**
  (not hard 500s).
- **`/search` returns real chunks** (verified: VA Form 21-0781 text came back).

## What shipped (all on `main`, deployed)

- **Parser 422 fix** (`98b2833`): markitdown 0.0.1a4 `UnsupportedFormatException`
  subclasses `BaseException`, so `except Exception` let it escape to a 500. Both
  parser boundaries now catch it; unsupported files return 422 (skip). Generic/
  missing MIME re-sniffed with libmagic. (`services/parser-py/app/main.py`, 19 tests.)
- **Embedding retry/backoff** (`a7aa669`): `retryOnRateLimit()` wraps Gemini +
  OpenAI batch embeds — capped exponential backoff + jitter on 429/RESOURCE_EXHAUSTED,
  honors Retry-After. Config knob `EMBEDDING_MAX_RETRIES` (default 5).
  (`packages/rag/src/embeddings/retry.ts`, 9 tests.)
- **Zero-chunk re-embed** (`ebc211d`): a doc whose `content_hash` matches but has 0
  chunks is re-embedded (no more silent skips). **This removes the need for the old
  manual `content_hash` reset** — future syncs self-heal.
- **Streaming `/ask`** (`053d994`): SSE `POST /ask/stream` (token/done/error).
  Deployed in api but **not yet exercised end-to-end** (needs the web client).
- **Deploy reconciliation** (`f710e9c`, `c2c618b`): `main` now carries the Railway
  Dockerfiles (`apps/{api,worker,mcp}/Dockerfile`, `railway.json`) AND excludes
  `apps/web` from backend images. `main` is the single deployable source.

## Live infra (Railway project `rag-system` `d5676b24…`, env `production` `53a51a39…`)

| Service      | State   | Built from          | Notes                           |
| ------------ | ------- | ------------------- | ------------------------------- |
| rag-postgres | RUNNING | —                   | pgvector pg16, 768-d embeddings |
| rag-parser   | RUNNING | `main` working tree | 422 skips live                  |
| rag-api      | RUNNING | `main` (c2c618b)    | + retry, ebc211d, streaming     |
| rag-worker   | RUNNING | `main` (c2c618b)    | + retry, ebc211d                |
| rag-mcp      | RUNNING | (unchanged)         |                                 |

- API: `https://rag-api-production-07b4.up.railway.app`
- Source: `d3461cbe-b99f-4253-aded-b3610afe56de` (sharepoint, RAGTestSite, 16 items;
  14 parseable docs, 2 `.bin`/`.sndr` permanently 422-skipped).
- `railway ssh` note: CLI v5.19 does **not** surface remote stdout in non-interactive
  mode — only stderr. Read DB state interactively, or route psql stdout to a NOTICE.

## OPEN ITEMS for next session (priority order)

1. **Fix the root lockfile bug (blocks local `pnpm install --frozen-lockfile`).**
   `apps/web` is a _tracked_ pnpm workspace member but its deps were never written to
   `pnpm-lock.yaml` (lockfile has `apps/web: {}`). Backend deploys are unblocked
   (we excluded `apps/web` via `.dockerignore`), but root installs / CI fail. Fix:
   `pnpm install` at repo root, commit the updated `pnpm-lock.yaml`. Then decide:
   does `apps/web` (Next.js chat UI) deploy as its **own** Railway service? If yes,
   give it a Dockerfile + railway.json and DO NOT exclude it from its own image.
2. **gitignore `apps/web/next-env.d.ts`** (untracked generated file).
3. **Delete superseded branches** (gated earlier — force-delete needs your OK):
   `git branch -D integ/phase3-deploy feat/pluggable-oidc-auth`. Nothing unique is
   stranded: `59563fb` deploy config is on main via cherry-pick; `d2314bf` streaming
   is superseded by `053d994`. Worktrees already removed.
4. **Test the streaming endpoint** `POST /ask/stream` end-to-end once `apps/web` is
   wired up (SSE contract: `event: token|done|error`).
5. **Embedding provider decision** (compliance-relevant): the free-tier Gemini key
   works now (retry absorbs 429s), but for **real client tax docs** sending text to
   Google reintroduces §7216 / Circular-230 exposure. Options discussed: enable
   billing on the Gemini key (cheapest, ~cents for this corpus) OR stand up a
   self-hosted embedder (e.g. `nomic-embed-text`, 768-d → no index migration) as a
   sidecar so client data never leaves the infra. No code change needed for billing;
   a provider swap needs re-embed (now trivial — just re-run the sync).

## Quick re-verify / redeploy recipe (from `main`)

```bash
cd ~/dev/rag-system && git checkout main && git pull
railway up --service rag-worker --environment production --ci   # ~3-4 min
railway up --service rag-api    --environment production --ci
API=https://rag-api-production-07b4.up.railway.app
TOK=$(railway variables --service rag-api --kv | grep '^API_TOKENS=' | cut -d= -f2- | cut -d, -f1)
curl -s -X POST "$API/sources/d3461cbe-b99f-4253-aded-b3610afe56de/sync" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"mode":"full"}'
railway logs --service rag-worker | grep 'sync completed' | tail -1   # expect chunksCreated>0
curl -s -X POST "$API/search" -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{"query":"<phrase>","limit":3}'
```

Helper left in `scripts/reset_source_documents.py` (untracked) — no longer needed for
normal syncs thanks to `ebc211d`, but handy for a forced full re-embed.

```

```
