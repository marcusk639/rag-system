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

| Service      | State   | Built from          | Notes                                                         |
| ------------ | ------- | ------------------- | ------------------------------------------------------------- |
| rag-postgres | RUNNING | —                   | pgvector pg16, 768-d embeddings                               |
| rag-parser   | RUNNING | `main` working tree | 422 skips live                                                |
| rag-api      | RUNNING | `main` (c2c618b)    | streaming live; **review fixes (cb708a5) NOT yet redeployed** |
| rag-worker   | RUNNING | `main` (cb708a5)    | + retry, ebc211d, **review fixes live**                       |
| rag-mcp      | RUNNING | (unchanged)         |                                                               |

> Status 2026-06-21: PR #14 (review hardening) merged → `main` @ `cb708a5`. **rag-worker
> redeployed** from it. **rag-api redeploy still PENDING** (`railway up --service rag-api
--environment production --ci`). The api redeploy only affects query-side embedding
> (search) + streaming; the worker (doc embedding) is already current.

- API: `https://rag-api-production-07b4.up.railway.app`
- Source: `d3461cbe-b99f-4253-aded-b3610afe56de` (sharepoint, RAGTestSite, 16 items;
  14 parseable docs, 2 `.bin`/`.sndr` permanently 422-skipped).
- `railway ssh` note: CLI v5.19 does **not** surface remote stdout in non-interactive
  mode — only stderr. Read DB state interactively, or route psql stdout to a NOTICE.

## DECISION (2026-06-21): host the web client on Railway as `rag-web`

`apps/web` (Next.js chat UI) is currently hosted **nowhere** — no `Dockerfile` /
`railway.json` / `vercel.json`, no Railway service, and no API wiring
(`NEXT_PUBLIC_*` / internal URL) yet. It is WIP.

**Decision: deploy it as a 6th Railway service (`rag-web`).** Rationale: one
platform/bill; the web app can reach `rag-api` over the **private network**
(`rag-api.railway.internal`) so the API needn't be broadly public; mirrors the
existing `apps/{api,worker,mcp}` Dockerfile pattern. _Alternative considered:_
Vercel — best Next.js DX, but a second vendor + public `rag-api` exposure. Flip to
Vercel only if DX clearly outweighs the single-platform/private-network benefit.

### Next-session task: stand up `rag-web` (do in this order)

1. **Fix the root lockfile first** (Open Item #1) — `pnpm install` at repo root +
   commit `pnpm-lock.yaml` — otherwise the web image's `--frozen-lockfile` fails.
2. `apps/web/next.config.ts`: set `output: "standalone"` (container-friendly build).
3. Add `apps/web/Dockerfile` (node:22-slim, **repo-root build context**, pnpm
   install + `pnpm --filter ./apps/web build`, run the Next standalone server) and
   `apps/web/railway.json` — mirror `apps/api`.
   ⚠️ The root `.dockerignore` currently excludes `apps/web` (correct for the
   BACKEND images). The `rag-web` image MUST include it — use a dedicated
   `apps/web/.dockerignore` or a per-service build context so the global exclude
   doesn't strip the app from its own image.
4. **Wire the UI → `rag-api`**: server-side calls use
   `http://rag-api.railway.internal:<port>` with the bearer token kept
   **server-side only** (never expose `API_TOKENS` to the browser). The SSE
   consumer for `POST /ask/stream` belongs in `apps/web/src/lib/stream-chat.ts`
   (already referenced in code comments). Add auth in front of the UI.
5. Create the `rag-web` Railway service, set env (a scoped API token + the internal
   API URL), deploy, attach a public domain.
6. End-to-end test `/ask/stream` through the UI (Open Item #4 below).

## OPEN ITEMS for next session (priority order)

1. **Fix the root lockfile bug (blocks local `pnpm install --frozen-lockfile`).**
   `apps/web` is a _tracked_ pnpm workspace member but its deps were never written to
   `pnpm-lock.yaml` (lockfile has `apps/web: {}`). Backend deploys are unblocked
   (we excluded `apps/web` via `.dockerignore`), but root installs / CI fail. Fix:
   `pnpm install` at repo root, commit the updated `pnpm-lock.yaml`. This is now a
   prerequisite for the `rag-web` deploy (see DECISION above) — its image needs a
   valid lockfile. The hosting question is decided: `apps/web` → its own Railway
   service `rag-web` (not excluded from its own image).
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
