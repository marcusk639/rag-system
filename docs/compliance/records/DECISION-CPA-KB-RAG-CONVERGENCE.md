# Decision Memo: cpa-knowledge-base × rag-system convergence

**Date:** 2026-06-23
**Status:** Accepted — ratifies and records prior decisions; no new direction
**Scope:** Relationship between the standalone `cpa-knowledge-base` repo and the `rag-system` monorepo

---

## Decision

**Do not maintain `cpa-knowledge-base` as a separate project, and do not merge any
backends.** `rag-system` is the platform of record. The `cpa-knowledge-base` UI has
already served its purpose as the design donor: its shell now lives in the monorepo
as `apps/web`, wired to the real backend. The standalone repo is therefore
**deprecated** in favor of `rag-system/apps/web`.

This memo consolidates decisions already recorded across `CPA-KB-ADOPTION-PLAN.md`,
`CPA-KB-IMPLEMENTATION-SPEC.md`, `app-comparison-2026-06-21.md`,
`PLAN-LIVE-DEPLOY-AND-CHAT-UI.md`, and `PLAN-LAUNCH-READINESS.md`. It does not
introduce a new direction; it makes the convergence state explicit for anyone
arriving fresh.

## Context: what each project actually is

|                  | `cpa-knowledge-base` (standalone)                                        | `rag-system`                                                                                          |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Nature           | Frontend **UI mock**, ~15 source files                                   | Production-oriented RAG backend, v0.1.0                                                               |
| Data             | 100% hardcoded (`use-documents.tsx:11-42`, `use-chat-sessions.tsx:7-36`) | Real Postgres + pgvector + pg-boss                                                                    |
| Chat             | Inert — `onSendMessage={() => {}}` (`knowledge-base.tsx:107`)            | Streaming cited answers via `/ask/stream`                                                             |
| Backend logic    | None                                                                     | Crash-safe ingestion, hybrid RRF retrieval, 5 connectors, MCP server, fail-closed ACL + PII allowlist |
| CPA domain logic | None (cosmetic strings only)                                             | Compliance controls planned/partially built                                                           |

The weighted platform comparison scored `rag-system` 6.9 vs the `cpa-backend` +
`cpa-knowledge-base` stack at 2.0. The decisive factor: `rag-system` returns a
grounded, cited answer; the alternative stack cannot.

## Is combining them worthwhile? Yes — but it's "finish the salvage," not "merge"

The intersection is already chosen and substantially built. `rag-system/apps/web`
**is** the combined product:

- UI shell lifted from `cpa-knowledge-base`; PropelAuth + mock data stripped.
- Server-side BFF holds the scoped API token (`apps/web/src/lib/rag-api.ts`); the
  browser never sees it.
- Real SSE streaming chat with citations (`apps/web/src/lib/stream-chat.ts`,
  `apps/web/src/app/api/chat/route.ts` → backend `apps/api/src/routes/ask.ts:55`).
- BFF routes for sources, document viewer, download, and flagged upload.

This is the right call: the expensive half (a hardened RAG backend) exists, and the
cheap half (a UI shell) is done. Keeping the standalone repo alive only invites
drift — the two `app-comparison-2026-06-21.md` copies are already byte-identical,
an early sign of divergence risk.

## What is NOT worthwhile

- Continuing feature work in the standalone `cpa-knowledge-base` repo.
- Merging `cpa-backend` into anything — it is to be retired (its RAG pipeline is
  dead code with zero call sites).
- Re-litigating the platform choice.

## Remaining work (platform hardening, not integration)

Ordered by leverage; none of this is "combining" work:

1. **CI quality gates** — _now addressed_ by `.github/workflows/ci.yml` (build +
   typecheck + lint + unit tests). Previously only `e2e.yml` ran, so unit tests,
   typecheck, and lint were never gated on PRs.
2. **Persistent chat sessions** — `apps/web/src/hooks/use-chat-sessions.tsx` is
   still ephemeral `useState`; the server-side session store (adoption Phase 5 /
   spec Phase E, 3 Drizzle tables) is not yet wired.
3. **Deployment artifacts** — Dockerfiles + `railway.json` now exist for all four
   services (api, mcp, worker, parser-py); the launch-readiness doc's "no
   Dockerfiles" note is **stale**. Remaining: prod compose + runbook for the
   single-VM per-tenant target.
4. **Ops hardening** — rate limiting, `PARSER_SECRET` enforcement in prod, Sentry,
   `/metrics`, DLQ alerting.
5. **Compliance, scaled to data sensitivity** — for tenant #1 the KB is general
   research/SOPs (LOW–MODERATE) and real client data lives in Onvio, so **IRC
   §7216 self-hosted embeddings is NOT a launch gate** for tenant #1. The
   proportionate action is data classification + curating the few real client
   examples out of scope (D2a). Full §7216/self-hosting/retention activates lazily
   only for a future high-sensitivity tenant.
6. **Retrieval quality baseline** — replace the synthetic eval corpus with a real
   30–50-question CPA gold set + faithfulness judge before claiming quality.

## Timing constraint

The firm freezes builds Jan 15–Apr 15 (tax season). The implementation window is
May–September.

## Consequences

- `cpa-knowledge-base` is marked deprecated (see its `README.md`); no further
  feature work there.
- All chat-UI work happens in `rag-system/apps/web`.
- ~~New contributors should read this memo plus `PLAN-LAUNCH-READINESS.md` for the
  current go-live checklist.~~ **Corrected 2026-08-03:** `PLAN-LAUNCH-READINESS.md`
  is superseded. New contributors should read this memo plus
  [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md) (what is true now) and
  [`plans/2026-06-26-launch-readiness-consolidated.md`](./plans/2026-06-26-launch-readiness-consolidated.md)
  (priority and sequencing).

> ### ⚠ One premise in §5 is falsified (marked 2026-08-03)
>
> Item 5 above reasons that _"real client data lives in Onvio, so **IRC §7216
> self-hosted embeddings is NOT a launch gate** for tenant #1."_ Onvio is indeed
> not connected — but the inference that the SharePoint KB is therefore free of
> client data is wrong. A screen of all 858 indexed documents found client
> billing files, engagement letters, and one spreadsheet holding 522 SSN-shaped
> values. See [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md) for the full
> correction.
>
> The convergence decision itself is unaffected — it is about which codebase to
> build on, not about corpus contents. What is affected is item 5's conclusion
> that the proportionate action is merely "curating the few real client examples
> out of scope": there are more than a few, and that curation was never done.
