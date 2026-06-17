# PLAN — Source-Cited Chat Front-End (`apps/web`)

> Focused, LLM-executable plan for a chatbot UI that asks the RAG system questions and
> renders **streamed, source-cited** answers. Derived from `docs/PLAN-LIVE-DEPLOY-AND-CHAT-UI.md`
> (Phases 4–6, locked decisions) and a fresh Phase 0 discovery pass on 2026-06-15.
>
> **Scope decisions (locked for this plan):**
>
> - **Streaming: full.** Build the backend SSE endpoint AND the streaming UI.
> - **Sessions: ephemeral, in-memory.** No DB, no persistence endpoints.
> - **Surfaces included:** chat panel, document/source list (read-only), citation viewer, sessions menu, upload modal.
>
> **Execution order:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → (Phase 5 ∥ Phase 6) → Phase 7.
> Each phase is self-contained: it names what to **copy**, the **doc references**, a **verification
> checklist**, and **anti-pattern guards**. Do not invent APIs not listed in Phase 0.

---

## Phase 0 — Documentation Discovery (consolidated, authoritative)

This is the **Allowed APIs** list. Treat anything not here as nonexistent until verified in code.

### 0.1 Backend HTTP API (real, today) — `apps/api/src/`

All routes except `/health` and `/ready` require `Authorization: Bearer <token>`.
Error envelope (always): `{ "error": { "code": string, "message": string } }` (`apps/api/src/error-handler.ts:20-22`).

| Endpoint                   | File                                     | Request                                                                                                     | Response (200)                                                                |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /ask`                | `apps/api/src/routes/ask.ts:20-33`       | `{question:string(1..2000), topK?:int(1..100), sourceIds?:uuid[], filter?:Record<string,string\|string[]>}` | `{answer:string, citations:Citation[], retrieved:SanitizedRetrievalResult[]}` |
| `POST /search`             | `apps/api/src/routes/search.ts:20-30`    | `{query:string(1..1000), topK?, sourceIds?, filter?}`                                                       | `{results:SanitizedRetrievalResult[]}`                                        |
| `GET /sources`             | `apps/api/src/routes/sources.ts:63-66`   | —                                                                                                           | `{sources: Omit<Source,"config">[]}`                                          |
| `GET /sources/:id`         | `apps/api/src/routes/sources.ts:57-62`   | params `{id:uuid}`                                                                                          | `Omit<Source,"config">`                                                       |
| `GET /documents/:id`       | `apps/api/src/routes/documents.ts:12-23` | params `{id:uuid}`                                                                                          | `SanitizedDocument` (incl. full `markdown`)                                   |
| `POST /sources/:id/sync`   | `apps/api/src/routes/sources.ts:64-95`   | `{mode:"full"\|"incremental"}`                                                                              | `202 {jobId, ingestionId, mode}`                                              |
| `GET /health` `GET /ready` | `apps/api/src/server.ts:57-70`           | — (no auth)                                                                                                 | `{status:"ok"}` / `{status:"ready"}`                                          |

**`Citation`** (`packages/services/src/ask.ts`, `packages/rag/src/generation/generator.ts:20-28`):

```ts
{ index: number;        // 1-indexed; matches [N] markers in answer text
  documentId: string;   // UUID -> use with GET /documents/:id
  title: string;
  url?: string;
  chunkId: string;      // UUID of the cited chunk
  score: number; }      // 0..1 combined retrieval score
```

**`SanitizedRetrievalResult`** (`packages/core/src/metadata-policy.ts`):

```ts
{ text: string; score: number; denseScore: number; sparseScore: number;
  document: { id; title; sourceId; sourceKind: "sharepoint"|"gdrive"|"gmail"|"outlook"|"custom";
              url?; metadata: ExposedMetadata };
  chunk: { id; ordinal: number; headingPath: string[]; page?: number } }
```

**`ExposedMetadata`** allowlist (PII stripped): `title, url, mimeType, sizeBytes, createdAt, modifiedAt, path`
(`packages/core/src/metadata-policy.ts:31-43`). Never expect `author/from/to/subject`.

**Auth model** (`packages/core/src/access-control.ts`): a bearer token resolves to a `Principal`
(`{kind:"admin"}` or `{kind:"scoped", allowedSourceIds}`). Scoped beats admin (least privilege).
Config: `API_TOKENS` (admin), `API_PRINCIPALS` (JSON scoped list), `AUTH_PROVIDER=static|composite`.

### 0.2 Known gaps the front-end MUST respect (do not assume away)

1. **No streaming today** — `POST /ask` is request/response only. Phase 1 adds `POST /ask/stream`.
2. **No CORS** — `apps/api/src/server.ts` registers no `@fastify/cors`. The BFF pattern makes this
   a non-issue for the browser (browser only talks to same-origin Next.js). CORS is added in Phase 1
   only to permit optional direct/dev access; the chat path does not depend on it.
3. **No list-documents endpoint** — only `GET /documents/:id`. A per-document list requires a new
   endpoint (Phase 5 prerequisite, flagged). `GET /sources` lists _sources_, not documents.
4. **No upload→ingest endpoint** — ingestion is connector + `POST /sources/:id/sync` only. A file
   upload modal requires a new ingest path (Phase 6 prerequisite, flagged — heaviest/riskiest piece).
5. **`GET /documents/:id` returns 404 for forbidden sources** (indistinguishable from missing, by design).

### 0.3 Reusable UI shell — `cpa-knowledge-base` (confirmed on disk at `/Users/marcus/dev/cpa-knowledge-base`)

- **Stack:** Next.js **15.0.3** App Router, React **18.3.1**, Tailwind **3.4.1**, shadcn-style
  components (style `new-york`, baseColor `slate`), `lucide-react`, TS 5, **npm** (convert to pnpm).
- **Lift (copy, then rewire):**
  - `src/components/chat-interface/chat-interface.tsx` — message list + input (no streaming/markdown/citations yet)
  - `src/components/sessions-menu/sessions-menu.tsx`
  - `src/components/document-list/document-list.tsx`
  - `src/components/upload-modal/upload-modal.tsx` (no backend handler today)
  - `src/components/knowledge-base/knowledge-base.tsx` — 2-column shell
  - `src/components/ui/card.tsx` — **strip example code (lines ~62–181)**
  - `src/types/chat.ts` (keep `Message`,`ChatSession`; **remove** `ExampleUsage`, dup `createNewSession`, `archiveSession`, type guards) + `src/types/document.ts`
  - `src/lib/utils.ts` (`cn()`), `tailwind.config.ts`, `components.json`, `postcss.config.mjs`, `src/app/globals.css`
- **Strip / rebuild:**
  - **Remove PropelAuth** — sole integration at `src/app/page.tsx:4,11-14` (`RequiredAuthProvider`, tenant `245466721.propelauthtest.com`); remove `@propelauth/react` from deps.
  - **Rebuild hooks** `src/hooks/use-documents.tsx` + `use-chat-sessions.tsx` — currently mock arrays / `onSendMessage = () => {}`.
- **Reality check:** zero `fetch`/`axios`, no env, no streaming/markdown/citation rendering — it is a static scaffold (~60–70% liftable, 30–40% rebuild).

---

## Phase 1 — Backend streaming foundation (`POST /ask/stream`)

**Goal:** add SSE streaming alongside the existing non-streaming `/ask`, without changing `/ask`.

### What to implement (copy existing patterns; only the SDK call differs)

1. **Verify SDK method names first** (do not hardcode from memory). Use context7 / read
   `packages/rag/package.json` to confirm the installed Gemini + OpenAI SDK streaming APIs
   (expected: Gemini `generateContentStream`, OpenAI `stream: true`). Cite what you find.
2. **Generator interface** (`packages/rag/src/generation/generator.ts:14-19`): add
   `answerStream(question, context): AsyncIterable<string>` **alongside** the existing `answer(...)`.
   Reuse the **same** `SYSTEM_PROMPT` / `buildPrompt` (`generator.ts:33-66`) and the same
   `<document>` injection-defense wrapping. Implement for both Gemini and OpenAI providers.
3. **Service function** (`packages/services/src/ask.ts`, mirror `askQuestion` at `:33-54`): add
   `askQuestionStream(deps, input, defaultTopK, scope)` that runs identical retrieval + scope
   enforcement, yields answer tokens, then emits a final `{citations, retrieved}` payload. Preserve
   the zero-results short-circuit (`ask.ts:43-45`) and the `GenerationNotConfiguredError` → 503 path.
4. **Route** (`apps/api/src/routes/ask.ts`): add `POST /ask/stream`. Same Zod body as `/ask`, same
   `scopeFromRequest` (`apps/api/src/routes/authz.ts`). Set `Content-Type: text/event-stream`.
   Emit SSE: `event: token` (data = text chunk) per token, then `event: done`
   (data = JSON `{citations, retrieved}`). Return 503 if no generator configured.
5. **CORS (optional, for dev/direct only):** register `@fastify/cors` in `apps/api/src/server.ts`
   gated on a new `API_ALLOWED_ORIGINS` env. Not required by the BFF chat path.

### Documentation references

- Mirror source: `packages/services/src/ask.ts:33-54` (askQuestion), `apps/api/src/routes/ask.ts:20-33` (route), `generator.ts:33-66` (prompt/citation logic).
- Citation/retrieved shapes: Phase 0.1.

### Verification checklist

- [ ] `pnpm --filter @rag/services test` and `pnpm --filter @rag/api test` pass.
- [ ] `pnpm typecheck` clean.
- [ ] `curl -N -H "Authorization: Bearer $TOK" -d '{"question":"..."}' .../ask/stream` streams `event: token` lines then one `event: done` with citations.
- [ ] Existing `POST /ask` response is byte-for-byte unchanged (snapshot/test).
- [ ] No-generator config → 503 `GENERATION_NOT_CONFIGURED` on `/ask/stream`.

### Anti-pattern guards

- ❌ Do NOT replace or alter `answer(...)` — add `answerStream(...)` next to it.
- ❌ Do NOT drop the `<document>` injection defense in the streaming path.
- ❌ Do NOT invent SDK method names — verify against installed versions (step 1).
- ❌ Do NOT bypass `scopeFromRequest` — streaming must enforce the same scope.

---

## Phase 2 — Scaffold `apps/web` (lift shell, strip auth, pnpm)

**Goal:** a building Next.js 15 app in the workspace with the lifted, de-authed UI shell (still mock-wired).

### What to implement

1. Create `apps/web/` as a workspace package (`@rag/web`). Copy verbatim from `cpa-knowledge-base`:
   `tailwind.config.ts`, `components.json`, `postcss.config.mjs`, `src/app/globals.css`,
   `src/lib/utils.ts`. Convert npm → pnpm (no `package-lock.json`; align to root `tsconfig.base.json`,
   path alias `@/* -> ./src/*`).
2. Copy components listed in Phase 0.3 into `apps/web/src/components/`. Strip `card.tsx` examples and
   clean `types/chat.ts` per Phase 0.3.
3. **Remove PropelAuth:** replace `src/app/page.tsx` with a plain `<KnowledgeBase />` render (no
   provider). Remove `@propelauth/react` from `apps/web/package.json`. Update `layout.tsx` metadata.
4. Keep the mock hooks **temporarily** so the app builds and renders before wiring (rewired in Phase 4).

### Documentation references

- Lift list + strip targets: Phase 0.3. Locked stack/config: `PLAN-LIVE-DEPLOY-AND-CHAT-UI.md:293-305`.

### Verification checklist

- [ ] `pnpm --filter @rag/web build` succeeds.
- [ ] `pnpm --filter @rag/web dev` renders the 2-column shell (doc list + chat card) with no console errors.
- [ ] `grep -rn "propelauth\|@propelauth" apps/web` → no matches.
- [ ] No `package-lock.json` under `apps/web`.

### Anti-pattern guards

- ❌ Do NOT carry over PropelAuth, the tenant URL, or per-user login.
- ❌ Do NOT keep `card.tsx` / `chat.ts` dead example code.

---

## Phase 3 — BFF streaming proxy (`apps/web/app/api/chat/route.ts`)

**Goal:** a server-only route that holds the API token and pipes `POST /ask/stream` back to the browser same-origin.

### What to implement

1. `apps/web/app/api/chat/route.ts` (Next.js Route Handler, server runtime). Reads **server env only**
   (never `NEXT_PUBLIC_`): `RAG_API_URL`, `RAG_API_TOKEN` (a **scoped `API_PRINCIPALS`** token).
2. Accepts `{question, topK?, sourceIds?, filter?}` from the same-origin client; forwards to
   `POST {RAG_API_URL}/ask/stream` with `Authorization: Bearer ${RAG_API_TOKEN}`; pipes the SSE body
   straight through (`Content-Type: text/event-stream`). Propagate upstream error status/codes.
3. Document `apps/web/.env.example` with `RAG_API_URL`, `RAG_API_TOKEN` (note: scoped, least-privilege).

### Documentation references

- BFF decision + env: `PLAN-LIVE-DEPLOY-AND-CHAT-UI.md:306-318`. Upstream contract: Phase 1 / Phase 0.1.

### Verification checklist

- [ ] `curl -N localhost:3000/api/chat -d '{"question":"..."}'` streams tokens then a done event (token comes from server env, not the request).
- [ ] Browser DevTools: the only RAG-related network call is same-origin `/api/chat`; no bearer token visible client-side.
- [ ] Missing/forbidden token → upstream 401/403 surfaced as a clean error, no secret leakage.

### Anti-pattern guards

- ❌ Do NOT expose `RAG_API_URL`/`RAG_API_TOKEN` via `NEXT_PUBLIC_`.
- ❌ Do NOT call the RAG API from a client component directly.
- ❌ Do NOT use an admin `API_TOKENS` token — use a scoped `API_PRINCIPALS` token.

---

## Phase 4 — Chat panel: streaming render + citations + ephemeral sessions

**Goal:** the core deliverable — ask a question, watch the answer stream in, see clickable source citations.

### What to implement

1. **Rewire send handler** in the lifted `chat-interface.tsx`: on submit, `fetch('/api/chat', {..})`,
   read the SSE stream, append `event: token` text to the live assistant message; on `event: done`
   store `citations` on that message.
2. **Markdown rendering** for assistant messages (add `react-markdown`; render the streamed text).
3. **Citation chips:** render `[N]` markers / a chip row from `message.citations`
   (`{index, documentId, title, url?}`). Clicking a chip triggers the citation viewer (Phase 5).
4. **Ephemeral sessions hook:** rebuild `use-chat-sessions.tsx` as in-memory `useState` only
   (new/switch/append message). **No persistence, no backend, no localStorage.** Reload clears history.

### Documentation references

- SSE event contract: Phase 1. Citation shape: Phase 0.1. Lift target + handler stub: Phase 0.3.

### Verification checklist

- [ ] Asking a question streams tokens live (visible incremental render), then shows citation chips.
- [ ] Citations map correctly: chip `index` N ↔ `[N]` in answer text ↔ `citations[N-1]`.
- [ ] An out-of-scope question returns a grounded "not enough information" answer with empty citations.
- [ ] `grep -rn "use-documents\|use-chat-sessions" apps/web` resolves only to real (non-mock) implementations.
- [ ] Page reload clears sessions (confirms ephemeral).

### Anti-pattern guards

- ❌ Do NOT add DB tables, persistence endpoints, or localStorage for sessions.
- ❌ Do NOT render assistant markdown as raw HTML without a safe renderer (XSS).
- ❌ Do NOT fabricate citation fields beyond Phase 0.1's `Citation` shape.

---

## Phase 5 — Supporting read-only surfaces (source list, sessions menu, citation viewer)

**Goal:** wire the remaining safe, read-only surfaces. Runs in parallel with Phase 6.

### What to implement

1. **Source list (read-only):** rebuild `use-documents.tsx` to fetch via a BFF GET that proxies
   `GET /sources`. Render the lifted `document-list.tsx` as a **source** list (rename labels to
   "Sources"). Selecting a source sets an optional `sourceIds` filter passed to `/api/chat`.
   - ⚠️ **Prerequisite gap:** there is **no list-documents endpoint** (Phase 0.2 #3). To list
     individual _documents_ (not sources), first add `GET /documents` (service + route + scope
     enforcement). If that endpoint is out of scope, ship the **source** list only and say so.
2. **Sessions menu:** wire the lifted `sessions-menu.tsx` to the ephemeral hook from Phase 4
   (new/switch). No backend.
3. **Citation viewer:** clicking a citation chip opens a panel/modal that fetches the cited document
   via a BFF GET proxying `GET /documents/:id` (using `citation.documentId`), renders `markdown`, and
   scrolls/anchors to the cited chunk using `chunkId` / `chunk.headingPath`.

### Documentation references

- `GET /sources`, `GET /documents/:id`, `SanitizedDocument`, `Citation`: Phase 0.1. Lift targets: Phase 0.3.

### Verification checklist

- [ ] Source list renders from live `GET /sources` (config never present in payload).
- [ ] Selecting a source scopes subsequent questions (verify `sourceIds` reaches `/ask/stream`).
- [ ] Clicking a citation opens the document and lands near the cited chunk.
- [ ] Forbidden/missing document → graceful "not found" (404 handled, no leak).
- [ ] If `GET /documents` was not built, the UI lists sources only and the limitation is documented in `apps/web/README` notes — no fake document list.

### Anti-pattern guards

- ❌ Do NOT invent a list-documents endpoint client-side — build it server-side or scope to sources.
- ❌ Do NOT surface stripped PII metadata fields (only the Phase 0.1 allowlist exists anyway).
- ❌ Do NOT add source-mutation/sync controls to this user surface.

---

## Phase 6 — Upload modal (FLAGGED: requires a new ingest endpoint)

**Goal:** wire the lifted upload modal to actually ingest a file. **Heaviest, riskiest, most optional piece.**

> ⚠️ The locked plan (`PLAN-LIVE-DEPLOY-AND-CHAT-UI.md:337-343`) marks upload **out of scope**. You
> explicitly opted it back in, so it gets its own phase with the missing backend called out. If the new
> endpoint is too large for this milestone, **hide the modal** and defer — do not ship a no-op button.

### What to implement

1. **Backend prerequisite (does not exist today):** add an upload→ingest path. Two options:
   - (a) `POST /sources/:id/documents` accepting a file, parsing via the Python parser sidecar, and
     enqueuing ingestion through the existing pipeline; or
   - (b) a presign + object-store drop that a connector picks up on the next sync.
     Pick one, design request/response + auth (admin or a dedicated upload scope), and enforce file-type/size limits.
2. **BFF route** `apps/web/app/api/upload/route.ts` (server-only) forwarding multipart to the new
   endpoint with the server token. Never expose the token; validate size/type at the BFF boundary too.
3. **Wire `upload-modal.tsx`** `onUpload` to the BFF route; show progress + ingestion job id.

### Verification checklist

- [ ] New ingest endpoint has unit + integration tests (parse → chunk → embed → store) and scope enforcement.
- [ ] Upload from the UI produces an `ingestionId`; the document later appears in search/ask results.
- [ ] Oversized/disallowed file types rejected with a clear error at both BFF and API.
- [ ] If deferred: modal is hidden and a note records the deferral (no dead button).

### Anti-pattern guards

- ❌ Do NOT give the upload path an admin `API_TOKENS` token through the browser.
- ❌ Do NOT trust client-reported MIME/size — validate server-side.
- ❌ Do NOT ship the modal wired to a non-existent endpoint.

---

## Phase 7 — Final verification (E2E, security, anti-pattern sweep)

**Goal:** prove the whole thing works and the guards held.

### Checks

1. **E2E happy path:** dev-run api + web; ask a question → streamed answer with working citation chips →
   open a cited document → land on the chunk.
2. **Regression:** non-streaming `POST /ask` unchanged; `generator.ts` has BOTH `answer` and
   `answerStream` (not swapped).
3. **Security pass** on new surfaces — BFF routes (`/api/chat`, `/api/upload`), `/ask/stream` SSE, and
   any new ingest endpoint: SSRF, secret-leak, injection, `<document>` defense intact in streaming.
4. **Anti-pattern greps (must all pass):**
   - `grep -rn "propelauth\|@propelauth" apps/web` → empty
   - `grep -rn "NEXT_PUBLIC_RAG" apps/web` → empty (token/URL stay server-side)
   - `grep -rn "use-documents\|use-chat-sessions" apps/web` → only real implementations
   - no client-component direct calls to `RAG_API_URL`
5. **Build/typecheck/test:** `pnpm build`, `pnpm typecheck`, `pnpm test` all green.

### Success criteria

- Streaming, source-cited chat works end-to-end through the BFF with no token exposed to the browser.
- Sessions are ephemeral; reload clears them.
- Read-only source list + citation viewer function; upload is either fully wired (with its new endpoint + tests) or cleanly hidden/deferred.

---

## Appendix — Dependency & risk notes

- **Hard prerequisite chain:** Phase 1 (streaming endpoint) must be deployed/live before Phase 3 BFF
  can stream. Phases 5 and 6 each carry a **new-endpoint prerequisite** (list-documents; upload→ingest)
  that does not exist today — these are the only places this plan touches the data/ingestion core.
- **Service-layer note:** if the five-function service layer (`@rag/services`) is mid-unification per
  `PATHFINDER-2026-06-06/03-unified-proposal.md`, land that before Phase 1 so `askQuestionStream` has a
  stable home.
- **Lowest-risk slice** (if you want to ship value fast): Phases 1–4 deliver the core streamed,
  source-cited chatbot. Phases 5–6 are additive surfaces.
