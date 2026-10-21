# PLAN: Live SharePoint Ingestion Deploy + Frontend Chat Agent

> **Phased, LLM-friendly plan.** Each phase is self-contained and executable in a
> fresh Claude Code session. Phases run in order. Every phase says exactly what to
> COPY (with file:line refs from the real codebase), how to verify, and what NOT
> to do. Repo: `/Users/marcus/dev/rag-system`.

## Locked decisions (do not re-litigate)

| Decision        | Choice                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Deploy target   | **Railway** (managed Postgres+pgvector; Docker services for api / worker / parser)                                               |
| Chat → RAG path | **Fastify `/ask` + new SSE streaming endpoint** (generators are non-streaming today; we add streaming)                           |
| Browser auth    | **BFF proxy**: a Next.js server route holds the bearer token; the browser never sees it                                          |
| Chat UI base    | **Lift the `cpa-knowledge-base` UI shell** (Next.js 15 + Tailwind + shadcn), strip its PropelAuth + mock data, rewire to the BFF |

## Goal (what "done" means)

1. SharePoint files ingest **live**: a real Azure app registration → a `sources`
   row → `POST /sources/:id/sync` → worker runs `runIngestion` → chunks+embeddings
   land in managed Postgres. Runs on Railway, on a schedule or on demand.
2. A **Next.js chat UI** answers questions by calling the API's `/ask`
   (streaming), rendering the answer with `[N]` citations. The browser talks only
   to the Next.js BFF; the BFF holds the API bearer token.

---

## PHASE 0 — Documentation Discovery (consolidated; READ before any phase)

These are VERIFIED facts from the current codebase (signatures quoted from
source). Treat this as the "Allowed APIs" list. Do NOT invent endpoints,
parameters, or streaming methods beyond what's here without first reading the
cited file.

### Existing architecture (ground truth)

- **3 backend apps**, no frontend, no cloud deploy config exist today. Apps:
  `apps/api` (Fastify v5), `apps/mcp`, `apps/worker`. Workspace = pnpm@9.12.0,
  Node >=22, plain `tsc` per package (no turbo/nx). Workspaces:
  `packages/*`, `apps/*`, `tests/*`, `examples/*`.
- **Only Dockerfile that exists**: `services/parser-py/Dockerfile` (python:3.12-slim
  - libreoffice/poppler/tesseract/pandoc; `uvicorn app.main:app --workers 2`,
    `EXPOSE 8000`). **No Dockerfile for api/mcp/worker** — Phase 1 creates them.
- **docker/docker-compose.yml** is local-dev only (postgres `pgvector/pgvector:pg16`
  - parser bound to `127.0.0.1:8000`). Header says prod should use managed services.

### SharePoint ingestion path (exact symbols)

- Connector: `packages/connectors/src/sharepoint/index.ts` — `class SharePointConnector implements Connector`, `kind="sharepoint"`. `validate()` GETs `/sites/{siteId}`; `list(options)` paginates with a base64 `SharePointCursor`; `fetch("<driveId>:<itemId>")`.
- Config schema (stored in `sources.config` JSONB): `packages/connectors/src/sharepoint/config.ts` — `{ siteId (required, "host,siteCollectionId,siteId"), driveId?, folderPath?, maxFileBytes? (default 50MB) }`.
- Credentials are **global env, not per-source**: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (MSAL client-credentials, scope `https://graph.microsoft.com/.default`). Required Graph **Application** permissions: `Sites.Read.All`, `Files.Read.All` (Mail.Read only if Outlook). Factory: `packages/connectors/src/factory.ts:46`.
- Sources table: `packages/db/src/schema.ts:50` — `{ id, kind, name, config jsonb, cursor text(null=full next sync), lastSyncedAt, ... }`. **No `public`/`credentials` column** — confidentiality is the API-token layer. Writer: `createSource(db, row)` (`packages/db/src/queries.ts:33`). `cursor` updated per page by `updateSourceCursor` (resumable).
- Pipeline entry: `runIngestion(sourceId, connector, startCursor, opts, deps)` (`packages/ingestion/src/pipeline.ts:55`). Loops `connector.list` → `ingestOne` (parse → sha256 → upsertDocument → chunk → embedBatch → replaceChunks). Ends on connector `done:true`.
- Queue: `JOB_NAMES.syncSource = "rag.sync_source"`, `SyncSourcePayload = {sourceId, mode:"full"|"incremental", ingestionId}`, `enqueueSync` with `singletonKey: "sync:{sourceId}"`, retryLimit 3 (`packages/ingestion/src/queue.ts`). Worker registers `queue.work(JOB_NAMES.syncSource, …, handleSyncSource)` (`apps/worker/src/main.ts`, `handlers/sync-source.ts:16`).
- Trigger service: `triggerSync(deps, {sourceId, mode}) → {jobId, ingestionId, mode}` (`packages/services/src/sources.ts:35`). HTTP: **`POST /sources/:id/sync`** body `{mode}` → 202 (`apps/api/src/routes/sources.ts:76`). Create: **`POST /sources`** body `{kind, name, config}` → 201.
- Parser: FastAPI `POST /parse` + `GET /health`; opt-in `X-Parser-Token` when `PARSER_SECRET` set (`services/parser-py/app/main.py`). Node client `HttpParserClient(url, timeoutMs, secret)` (`packages/rag/src/parser/parser-client.ts`). Config: `PARSER_URL` (default `http://localhost:8000`), `PARSER_TIMEOUT_MS`, `PARSER_SECRET`.

### Ask / search / generation path (exact symbols)

- Service: `askQuestion(deps, input, defaultTopK, scope) → {answer, citations, retrieved}` (`packages/services/src/ask.ts:47`). **Returns a FULL answer — NOT streaming.** `searchDocuments(deps, input, defaultTopK, scope)` (`search.ts:26`). `ServiceDeps = {db, retriever, generator: Generator|null, queue, logger}` (`deps.ts:30`). `scope: AuthorizationScope = {enforcedSourceIds: string[]|null}` (`packages/core/src/access-control.ts:50`).
- Generator: `Generator.answer(question, context: RetrievalResult[]) → Promise<GenerationResult{answer, citations}>` (`packages/rag/src/generation/generator.ts:14`). Providers Gemini (`@google/genai`, default `gemini-2.5-flash`) + OpenAI (`openai`). **Both are single-shot `generateContent`/`chat.completions.create` — NO streaming today.** Prompt-injection defense wraps chunks in `<document>` tags, escapes literal `</document>`, temp 0.2 (`generator.ts:33-66`). Factory `createGenerator({provider, model, apiKey})` (`generator.ts:143`).
- API: Fastify v5, port `API_PORT` (3000), host `API_HOST` (`0.0.0.0`). Routes `/search`, `/ask`, `/sources*`, `/documents/:id`, `/health`, `/ready`. `main.ts:16` boot order: `loadConfig` → `assertEmbeddingDimensions` → logger → `buildDeps` → `assertRequiredIndexes(createIndexExistenceRunner(deps.db))` → `buildServer` → listen. Graceful shutdown SIGTERM/SIGINT → `app.close()` + `deps.close()`.
- **CORS is ABSENT.** No `@fastify/cors`. Auth: `Authorization: Bearer <token>` on all paths except `/health`,`/ready` (`apps/api/src/auth.ts`). Tokens from `API_TOKENS` (admin) ∪ `API_PRINCIPALS` (`[{token, allowedSourceIds[]}]`, scoped). `scopeFromRequest` (`routes/authz.ts:13`) → fail-closed `DENY_ALL_SCOPE`.
- Runtime: `buildCoreDeps(config, logger)` (`packages/runtime/src/index.ts:48`) wires db/embedder/retriever/queue/generator + idempotent `close()`. Generator enabled only if `GENERATION_PROVIDER` + `GENERATION_MODEL` + the embedding provider's API key are all set (generation reuses `GEMINI_API_KEY`/`OPENAI_API_KEY`).

### MCP surface (reference; NOT the chosen chat path)

- `apps/mcp` Streamable HTTP on `MCP_HTTP_PORT` (3001), tools `search_documents`/`ask`/`get_document`/`list_sources`/`trigger_sync`, per-session scope. We are NOT using this for the chat UI (decided: Fastify `/ask`), but it stays deployed as the agent surface.

### Env vars (full required set to boot)

`DATABASE_URL`, `PG_BOSS_SCHEMA`, `EMBEDDING_PROVIDER/MODEL/DIMENSIONS`, `GEMINI_API_KEY` (or `OPENAI_API_KEY`), `PARSER_URL`/`PARSER_TIMEOUT_MS`/`PARSER_SECRET`, `API_PORT`/`API_HOST`/`API_TOKENS`/`API_PRINCIPALS`, `MCP_*`, `WORKER_CONCURRENCY`/`WORKER_POLL_INTERVAL_MS`, `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET`, `GENERATION_PROVIDER`/`GENERATION_MODEL`. Template: `env.example` (DO NOT edit `.env` — hook-blocked).

### Reusable assets in sibling repos (VERIFIED)

Two sibling prototypes exist; treat them as a parts bin, not running systems.

- **`/Users/marcus/dev/cpa-knowledge-base`** — Next.js **15.0.3** App Router,
  React **18.3.1**, Tailwind **3.4.1** + **shadcn/ui** (style "new-york",
  baseColor slate), `lucide-react`, **npm** (package-lock only). It is a **static
  mock**: hardcoded sessions/docs, `onSendMessage` wired to `() => {}`, **no
  fetch/API layer, no streaming, no citation rendering**. Auth = PropelAuth with a
  hardcoded test-tenant URL.
  - **LIFT (presentational, light edits):** `src/components/chat-interface/chat-interface.tsx` (message list + input markup), `src/components/sessions-menu/sessions-menu.tsx`, `src/components/document-list/document-list.tsx`, `src/components/upload-modal/upload-modal.tsx`, `src/components/knowledge-base/knowledge-base.tsx` (2-col shell), `src/components/ui/card.tsx` (remove the `/api/placeholder` img), `tailwind.config.ts`, `components.json`, `src/lib/utils.ts` (`cn`), `src/types/chat.ts` (`Message`/`ChatSession` — strip the dead `ExampleUsage`/duplicate `createNewSession`), `src/types/document.ts`.
  - **STRIP / REBUILD:** `src/hooks/use-documents.tsx` + `src/hooks/use-chat-sessions.tsx` (mock data → real BFF calls); `src/app/page.tsx` PropelAuth provider (REMOVE — decided: BFF token, no per-user login). Add: streaming token render, markdown, citation chips, real send handler.
  - **Convert npm → pnpm** to fit the workspace.
- **`/Users/marcus/dev/cpa-backend`** — Express + **MongoDB** + **Vespa** +
  OpenAI; **no `/ask`/`/search`, no streaming, no retrieval wired, no connectors**.
  It is a duplicate-but-inferior RAG attempt that **rag-system supersedes** — DROP
  its RAG/ingestion/Vespa/Mongo/Redis-worker. Do NOT port it. (Its session-CRUD +
  S3 upload-presign route shapes — `routes/chat-session.ts`, `routes/data-entity.ts`
  — are a reference IF you later add chat-session persistence or UI uploads; out of
  scope for this plan.)

### Docs to read at execution time (per phase)

- **Railway**: invoke the `use-railway` skill (or read its SKILL.md) for service/Dockerfile/Postgres/env patterns. Do NOT invent Railway CLI flags — copy from the skill.
- **Streaming generation**: use context7 (`/google/generative-ai-js` for `@google/genai` streaming `generateContentStream`; `openai-node` for `stream: true`) before writing Phase 4 generator streaming. Verify the exact method name against the installed SDK version in `packages/rag/package.json` — do NOT assume.
- **Next.js App Router + SSE**: context7 `/vercel/next.js` for Route Handlers + streaming responses.

### Anti-patterns to avoid (verified)

- Do NOT assume `askQuestion`/generators stream — they don't. Phase 4 ADDS streaming as a new path; the non-streaming `/ask` stays.
- Do NOT add CORS-less cross-origin browser calls — either add `@fastify/cors` (Phase 4) or keep the browser same-origin behind the BFF (Phase 5). We do BFF, so the browser never calls the API cross-origin directly.
- Do NOT put the API bearer token in client JS (decided: BFF). Only the Next.js server holds it.
- Do NOT edit `packages/db/drizzle/0000_init.sql`, `pnpm-lock.yaml`, or `.env` (hook-blocked / owner files).
- Do NOT run a full source sync inside an HTTP request — always enqueue (already enforced).

---

## PHASE 1 — Production Dockerfiles for the Node apps

**What to implement.** Three Dockerfiles so api/worker/mcp can run as Railway
services. The parser already has one (`services/parser-py/Dockerfile`) — reuse it
as-is.

1. Create `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/mcp/Dockerfile`.
   Each: multi-stage (deps → build → runtime) Node 22 image. COPY the workspace,
   `pnpm install --frozen-lockfile`, `pnpm -r build`, then run the app's
   `node dist/main.js`. Use `corepack enable` + `pnpm@9.12.0` (matches root
   `package.json` `packageManager`).
2. Add a root `.dockerignore` (node_modules, .git, postgres-data, .worktrees,
   dist, .env\*).
3. Each app already has `start: "node dist/main.js"` (verified in app
   `package.json`) — the runtime stage just calls it.

**Documentation references.** Build scripts: root `package.json` `build` =
`pnpm -r ... run build`; app scripts have `build`/`start` (verified). Node engine
`>=22`. Because it's a pnpm workspace with internal `@rag/*` deps, you MUST build
from the repo root context, not per-app — copy the whole workspace in the build
stage.

**Verification checklist.**

- [ ] `docker build -f apps/api/Dockerfile -t rag-api .` succeeds from repo root.
- [ ] `docker build -f apps/worker/Dockerfile -t rag-worker .` succeeds.
- [ ] `docker build -f apps/mcp/Dockerfile -t rag-mcp .` succeeds.
- [ ] Running `rag-api` with a `DATABASE_URL`+`API_TOKENS` boots and serves `GET /health` → `{status:"ok"}`.

**Anti-pattern guards.** Do NOT `pnpm install` per-app (breaks workspace symlinks).
Do NOT bundle — the project uses plain `tsc`, ship `dist/` + `node_modules`. Do
NOT hardcode secrets in the image; all config is env at runtime.

---

## PHASE 2 — Railway deployment (Postgres + 4 services)

**What to implement.** Provision the live stack on Railway: managed Postgres with
pgvector, plus services for api, worker, mcp, parser.

1. **Read the `use-railway` skill first** for the exact CLI/project/service/env
   workflow. COPY its patterns; do not invent flags.
2. Provision **Postgres** with the `pgvector` extension. The repo's
   `docker/init-db.sql` shows the required init (`CREATE EXTENSION vector` etc.) —
   replicate that on the managed DB. Capture `DATABASE_URL`.
3. Create 4 Railway services from the Dockerfiles: `rag-api` (Phase 1),
   `rag-worker`, `rag-mcp`, `rag-parser` (`services/parser-py/Dockerfile`).
4. Set env on each service per Phase 0's required set. Critical cross-service
   wiring: `PARSER_URL` on api+worker points at the parser service's internal
   URL; set `PARSER_SECRET` identically on parser + api + worker (the parser is no
   longer loopback-only, so auth MUST be on). `DATABASE_URL` identical on
   api/worker/mcp. `API_HOST=0.0.0.0`, `API_PORT=$PORT` (Railway injects `PORT`).
5. Run migrations against the managed DB: `pnpm --filter @rag/db migrate` (a
   one-off Railway job or locally pointed at `DATABASE_URL`). The boot guard
   `assertRequiredIndexes` + the new `migration-guard.test.ts` protect the HNSW/GIN
   indexes and tsv trigger.

**Documentation references.** `use-railway` skill (Railway specifics);
`docker/init-db.sql` (pgvector init); `env.example` (full env list);
`apps/api/src/main.ts:16` (boot order — note the fail-fast guards so a misconfig
surfaces at deploy, loudly).

**Verification checklist.**

- [ ] `GET https://<rag-api>/ready` → 200 `{status:"ready"}` (pings DB).
- [ ] `GET https://<rag-parser>/health` → ok; api/worker can reach it (set `PARSER_SECRET`, confirm a parse doesn't 401).
- [ ] Worker logs show it connected to pg-boss (schema `PG_BOSS_SCHEMA`) and is polling.
- [ ] `pnpm --filter @rag/db migrate` reports applied; `assertRequiredIndexes` passed at api boot (no startup throw).

**Anti-pattern guards.** Do NOT leave `PARSER_SECRET` unset once the parser is
network-reachable (it would be an open parse endpoint). Do NOT point services at
`localhost` — use Railway internal service URLs. Do NOT skip migrations (retrieval
indexes/trigger won't exist → silent degradation).

---

## PHASE 3 — Go live with a real SharePoint source

**What to implement.** Wire a real Azure app registration and create + sync a
SharePoint source against the live API.

1. **Azure app registration** (Entra ID): create an app, grant **Application**
   permissions `Sites.Read.All` + `Files.Read.All`, admin-consent them, create a
   client secret. Set `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` on the
   `rag-api` and `rag-worker` Railway services.
2. **Resolve the `siteId`** in Graph format `"hostname,siteCollectionId,siteId"`
   (via Graph `GET /sites/{hostname}:/sites/{path}`). Optionally a `driveId` /
   `folderPath` to scope.
3. **Create the source**: `POST /sources` with
   `{ kind:"sharepoint", name:"<lib name>", config:{ siteId, driveId?, folderPath? } }`
   using an admin `API_TOKENS` bearer. Capture the returned source `id`.
4. **Trigger first full sync**: `POST /sources/:id/sync` body `{mode:"full"}` → 202.
   Watch worker logs: `connector.validate()` (auth probe) → pages → chunks.
5. **Schedule incremental syncs**: add a Railway cron (or a small scheduler) that
   periodically `POST /sources/:id/sync` with `{mode:"incremental"}` — the
   connector's delta cursor makes this cheap. (singletonKey prevents overlap → 409
   if one's already running, which is fine.)

**Documentation references.** `apps/api/src/routes/sources.ts:37` (create body),
`:76` (sync body); `packages/connectors/src/sharepoint/config.ts` (config shape);
`packages/connectors/src/factory.ts:46` (the exact "requires microsoft
credentials" error if env is missing); `handlers/sync-source.ts:16` (full vs
incremental = `null` vs stored cursor).

**Verification checklist.**

- [ ] `POST /sources` returns 201 with a source id.
- [ ] `POST /sources/:id/sync {mode:"full"}` returns 202; worker completes, `ingestion_jobs` row → `completed`.
- [ ] `POST /search {query:"<term known to be in a doc>"}` returns results citing the SharePoint docs.
- [ ] A second `{mode:"incremental"}` sync processes only changed files (cursor advanced; `lastSyncedAt` updated).
- [ ] Bad `siteId` surfaces at `connector.validate()` in worker logs (not silently) — confirms fail-loud.

**Anti-pattern guards.** Do NOT expect per-source credentials — MS creds are
global env. Do NOT trigger sync from the browser/UI with an admin token (sync is
an ops action; keep it server-side / CI). Do NOT assume create-time validation —
`config` is validated at sync time when the connector is constructed.

---

## PHASE 4 — Streaming `/ask` on the API (CORS + SSE + streaming generator)

> The chat UI talks to the BFF (Phase 5), and the BFF talks to the API. We add a
> streaming endpoint so tokens appear live. The existing non-streaming `POST /ask`
> stays untouched as a fallback.

**What to implement.**

1. **Add `@fastify/cors`** to `apps/api` and register it in
   `apps/api/src/server.ts` (before routes). Restrict `origin` to the Next.js app
   origin via a new env (e.g. `API_ALLOWED_ORIGINS`). (Even with the BFF, CORS is
   cheap insurance and needed if the UI ever calls directly.)
2. **Add streaming to the `Generator` interface** — a new method
   `answerStream(question, context): AsyncIterable<string>` ALONGSIDE the existing
   `answer(...)`. Implement for Gemini (`generateContentStream`) and OpenAI
   (`stream: true`) — **verify the exact method names against the installed SDK
   via context7 before writing** (Phase 0 note). Reuse the SAME `SYSTEM_PROMPT` /
   `buildPrompt` from `generator.ts:33-66` (copy the prompt construction; only the
   call site changes to a streaming call). Citations are computed from `context`
   exactly as today (one per retrieved chunk), emitted after the stream ends.
3. **Add a service path** `askQuestionStream(deps, input, defaultTopK, scope)` in
   `packages/services/src/ask.ts` that mirrors `askQuestion` (same retrieval, same
   `GenerationNotConfiguredError` guard, same `EMPTY_ANSWER` short-circuit) but
   yields answer tokens then a final citations payload. COPY the retrieval half of
   `askQuestion` verbatim; swap `generator.answer` → `generator.answerStream`.
4. **Add route `POST /ask/stream`** in `apps/api/src/routes/ask.ts` returning
   **SSE** (`text/event-stream`): stream `event: token` chunks, then a final
   `event: done` with `{citations, retrieved}`. Reuse the SAME zod request body as
   `/ask` (`routes/ask.ts:10-16`) and the SAME `scopeFromRequest`. On
   no-generator, return 503 (same `GENERATION_NOT_CONFIGURED` mapping).

**Documentation references.** `packages/rag/src/generation/generator.ts:14`
(interface), `:33-66` (prompt + injection defense to reuse), `:90`/`:120`
(provider call sites to mirror in streaming form), `:143` (factory);
`packages/services/src/ask.ts:47` (the function to mirror); `routes/ask.ts:10-30`
(body + handler to copy); `apps/api/src/server.ts:21` (where to register CORS).
SDK streaming method names: context7 `@google/genai` + `openai`.

**Verification checklist.**

- [ ] `pnpm --filter @rag/rag test` + `pnpm --filter @rag/services test` green (add unit tests for the streaming generator with a fake that yields chunks; assert tokens then citations).
- [ ] `curl -N -X POST /ask/stream -H 'Authorization: Bearer …' -d '{"question":"…"}'` streams `event: token` lines then `event: done` with citations.
- [ ] Non-streaming `POST /ask` still returns the full `{answer, citations, retrieved}` (unchanged).
- [ ] `pnpm typecheck` workspace-wide green (new interface method implemented by BOTH providers — exhaustiveness).
- [ ] No-generator config → both `/ask` and `/ask/stream` return 503, not 500.

**Anti-pattern guards.** Do NOT replace `answer()` — add `answerStream()`
alongside (MCP + non-stream `/ask` still use `answer`). Do NOT re-implement the
prompt or drop the `</document>` escaping — copy it. Do NOT invent SDK streaming
methods — verify against the installed version. Do NOT bypass `scopeFromRequest`
(confidentiality boundary).

---

## PHASE 5 — Chat UI: lift the `cpa-knowledge-base` shell into `apps/web` + BFF proxy

**What to implement.** A new `apps/web` Next.js (App Router) app built by LIFTING
the presentational shell from `/Users/marcus/dev/cpa-knowledge-base`, stripping its
PropelAuth + mock data, and wiring it to a server-side BFF that streams from the
API's `/ask/stream`. Do NOT scaffold the chat markup from scratch — copy it.

1. **Scaffold `apps/web`** as a Next.js 15 App Router app in the workspace
   (`apps/*` glob already matches). Match the sibling's stack: Next 15 + React 18 +
   Tailwind 3 + shadcn/ui. **COPY config verbatim** from cpa-knowledge-base:
   `tailwind.config.ts`, `components.json`, `postcss`/globals, `src/lib/utils.ts`
   (`cn`). **Convert npm → pnpm** (the sibling uses npm; the monorepo is pnpm@9.12.0).
2. **Lift presentational components** (COPY then adapt — paths in Phase 0 reuse
   list): `chat-interface.tsx`, `sessions-menu.tsx`, `document-list.tsx`,
   `upload-modal.tsx`, `knowledge-base.tsx` (2-col shell), `ui/card.tsx` (remove the
   `/api/placeholder` img). Lift `types/chat.ts` (`Message`/`ChatSession`) and
   `types/document.ts` — strip the dead `ExampleUsage`/duplicate `createNewSession`.
3. **STRIP the mock + auth layers**: do NOT copy `use-documents.tsx` /
   `use-chat-sessions.tsx` mock hooks or the PropelAuth `RequiredAuthProvider` in
   `page.tsx` (decided: BFF token, no per-user login). Replace the chat hook's
   `onSendMessage` no-op with a real handler that calls the BFF and consumes the
   stream.
4. **BFF route** `apps/web/app/api/chat/route.ts` (server-only): reads the API
   base URL + bearer token from **server env** (`RAG_API_URL`, `RAG_API_TOKEN` —
   NOT `NEXT_PUBLIC_*`), forwards `{question}` to `POST /ask/stream`, and pipes the
   SSE stream straight back. The browser calls only `/api/chat` (same-origin) — no
   token, no CORS.
5. **Wire streaming + citations** into the lifted `chat-interface.tsx`: on submit
   `fetch('/api/chat', …)`, read the stream, append `token` events to the live
   assistant message, then on `done` render `[N]` citation chips from
   `{index, documentId, title, url?}`. (The lifted component renders content as a
   raw string today — add token-append + citation chips.)
6. **Env**: document `RAG_API_URL`, `RAG_API_TOKEN` (a scoped `API_PRINCIPALS`
   token — least privilege) in `apps/web/.env.example`. Deploy `apps/web` (Railway
   service, or Vercel — the BFF route is a short-lived proxy, fine on serverless).

**Documentation references.** Reuse sources: Phase 0 "Reusable assets" list (exact
files in `cpa-knowledge-base/src/`). context7 `/vercel/next.js` for App Router
Route Handlers + streaming `Response` bodies. API contract: Phase 4
`POST /ask/stream` (SSE `token`/`done`). Scope model:
`packages/core/src/access-control.ts:40-63` (scoped principal token). Citation
shape: `AskResult.citations` `{index, documentId, title, url?, chunkId, score}`
(`packages/services/src/ask.ts`).

**Verification checklist.**

- [ ] `pnpm --filter @rag/web build` succeeds; `dev` serves the chat page (lifted shell renders).
- [ ] Asking a question streams tokens into the UI live, then shows citation chips.
- [ ] **Browser devtools Network/JS shows NO bearer token** and **no PropelAuth** — only same-origin `/api/chat`. (BFF requirement; confirms auth was stripped.)
- [ ] A question outside the UI token's source scope returns the grounded "I don't know" answer (scope enforced server-side).
- [ ] `grep -rn "propelauth\|@propelauth" apps/web` → no matches (PropelAuth fully stripped).
- [ ] No mock data: `grep -rn "use-documents\|use-chat-sessions" apps/web` → only real implementations, no hardcoded arrays.

**Anti-pattern guards.** Do NOT carry over PropelAuth or the mock hooks — they're
explicitly stripped. Do NOT use `NEXT_PUBLIC_` for the token or API URL. Do NOT
call the RAG API from a client component directly (BFF only). Do NOT give the UI an
admin `API_TOKENS` token — use a scoped `API_PRINCIPALS` token. Do NOT add
sync/source-mutation or upload→ingestion buttons to the user surface (ops actions;
the lifted `upload-modal` should be hidden/removed unless an ingestion-trigger flow
is explicitly scoped later).

---

## PHASE 6 — End-to-end verification

**What to verify.**

1. **Ingestion live**: SharePoint source created, full + incremental syncs
   complete on Railway, chunks queryable. (`/search` returns SharePoint hits.)
2. **Chat works end-to-end**: UI → BFF → `/ask/stream` → streamed grounded answer
   with citations, token never exposed to the browser.
3. **Guards intact**: `pnpm typecheck`, `pnpm test` (incl. `migration-guard.test.ts`
   and the new streaming tests) all green. `assertRequiredIndexes` passes at api
   boot on the managed DB.
4. **Anti-pattern grep**:
   - `grep -rn "NEXT_PUBLIC_RAG" apps/web` → no token/URL leaks.
   - `grep -rn "propelauth" apps/web` → none (auth stripped from the lifted UI).
   - confirm `generator.ts` still has both `answer` AND `answerStream` (streaming
     was added, not swapped).
   - confirm `POST /ask` (non-stream) still present and unchanged.
   - confirm `PARSER_SECRET` set on parser + api + worker (no open parse endpoint).
5. **Security pass**: run the `security-review` skill over the new `apps/web` BFF
   route, the new `/ask/stream` route, and the SSE handling (SSRF/secret-leak/
   injection). Confirm the `<document>` injection defense is preserved in the
   streaming generator.

**Final report**: a checklist of the above with evidence (URLs, log excerpts,
test counts), and a short runbook: how to add another SharePoint source, how to
re-sync, how to rotate the UI token.

---

## Phase dependency order

```
Phase 1 (Dockerfiles) ─┐
                       ├─> Phase 2 (Railway up) ─> Phase 3 (SharePoint live)
Phase 0 (read) ────────┘                                   │
Phase 4 (streaming /ask) ──────────────────────> Phase 5 (chat UI) ─> Phase 6 (verify)
```

Phase 4 can be built in parallel with 1–3 (it's API/generator code, no infra
dep), but it must be DEPLOYED (re-run Phase 2 deploy for `rag-api`) before Phase 5
can stream against it.

## Cross-cutting constraints (every phase)

- Prettier PostToolUse hook reformats `.ts/.tsx/.md` on save — don't fight it.
- Do NOT edit `.env`, `pnpm-lock.yaml`, or `packages/db/drizzle/0000_init.sql`.
- Commit per phase only when the user asks; branch first if on `main`.
- Keep business logic in `@rag/services`; never duplicate search/ask in a route or
  the BFF — the BFF only proxies bytes.
