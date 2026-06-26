# apps/web — Next.js chat UI

Child guidance for the web app. The root `../../CLAUDE.md` is the source of truth for the
backend, packages, and architecture; this file covers only what's web-specific.

## What this app is

The production chat UI for the RAG system (Next.js 15 App Router + Tailwind). It is **not** wired
directly to the RAG backend from the browser — it talks to its own **server-side BFF** (route
handlers under `src/app/api/`), which forwards to the backend HTTP API.

## The load-bearing rule: the backend token is server-only

- `src/lib/rag-api.ts` reads `RAG_API_URL` and `RAG_API_TOKEN` from **server** env. These must
  **never** be exposed to the client — do not prefix them `NEXT_PUBLIC_`, and never call the
  backend directly from a client component. All backend calls go through the BFF route handlers.
- Streaming answers flow through `src/lib/stream-chat.ts` → the `/api/chat` route → the backend's
  streaming endpoint. Keep streaming on the server boundary.

## Where things are

| Concern                               | Location                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| BFF route handlers                    | `src/app/api/{chat,sources,upload,documents/[id],documents/[id]/download}/route.ts`           |
| Server→backend client (token-bearing) | `src/lib/rag-api.ts`                                                                          |
| Streaming chat client                 | `src/lib/stream-chat.ts`                                                                      |
| UI components                         | `src/components/{chat-interface,knowledge-base,document-list,upload-modal,sessions-menu,ui}/` |

## History (don't get confused)

This UI's design was lifted from the now-**deprecated** `cpa-knowledge-base` repo. During the
move, PropelAuth and all mock data were stripped and the UI was wired to the real backend through
the BFF. If you find PropelAuth references or hardcoded mock data, they are stale — remove, don't
extend. `rag-system/apps/web` is the only live copy.

## Commands

There is no root `pnpm dev:web` script. Run web via `pnpm --filter @rag/web dev` (or `next dev`
inside this dir). Lint here is `next lint`; typecheck is `tsc --noEmit`.
