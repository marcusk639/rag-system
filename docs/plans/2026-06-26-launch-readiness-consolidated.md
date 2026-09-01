# Launch Readiness — Consolidated Plan (tenant #1, cloud-with-DPA)

**Status:** Active **for priority and sequencing only** (scope narrowed 2026-08-03).
Supersedes the conflicting framing of `docs/PLAN-LAUNCH-READINESS.md` (2026-06-14)
and `docs/plans/2026-06-21-prelaunch-hardening-plan.md` (2026-06-21) — keep those
for their detailed copy-patterns, but this file owns priority and sequencing.

> ⚠ **This file is not the source of truth for current state**, despite the
> earlier "Single source of truth" wording. For what is actually deployed, what
> the open gates are, and what is known broken, read
> [`../TWK-LAUNCH-STATUS.md`](../TWK-LAUNCH-STATUS.md).
>
> ⚠ **The §7216 reconciliation below rests on a falsified premise.** It concludes
> the self-host build is off the critical path because _"Onvio — not SharePoint —
> is the system of record for client engagement files."_ Onvio is not connected,
> but the SharePoint KB was never checked until 2026-08-03, and the screen found
> client billing files, engagement letters, and a 522-SSN roster inside it. The
> residual control this section names — _"curate/spot-check out any stray client
> examples"_ — was the right action and was never executed. See
> [`../TWK-LAUNCH-STATUS.md`](../TWK-LAUNCH-STATUS.md).

**Goal:** Take the RAG service from "feature-complete + partially hardened" to
"safe to run with the firm's own SharePoint KB," launching on the **enterprise
cloud LLM under a signed DPA**.

**Authored:** 2026-06-26, against the working tree at branch `chore/ci-quality-gates`
(PR #17). Line references below are directional "copy this pattern" pointers from
the prior plans — re-verify against the live tree before relying on them.

---

## The reconciliation (why the two prior plans disagreed)

- `2026-06-21` made a **self-hosted §7216 egress path the top gate (CR-1)**.
- `2026-06-14` said §7216 **does not gate** tenant #1.

**Resolution (decided):** The firm's enterprise-LLM **DPA (zero-retention +
US-region) is signed and in place.** Per the compliance verdict, an enterprise LLM
under DPA is acceptable for accounting **Class A/B** data; written client consent
is statutorily required before any **tax-return** info; consumer data is blocked.

Tenant #1's KB is **firm work-product** (research / SOPs / templates). Onvio — not
SharePoint — is the system of record for client engagement files. Therefore:

> **The self-host build is NOT on the critical path for tenant #1.** Launch on the
> cloud LLM under the DPA. Self-hosted embeddings/generation + the egress/TRI
> scanner become **build-ready, flip-on-later** items, triggered only when a
> Class C/D (real taxpayer-return / consumer) tenant arrives.

The residual §7216 control for tenant #1 is cheap: **tag data class, scope the
connector to research/SOP libraries, and curate/spot-check out any stray client
examples** (Wave 2 + process track).

---

## Current state snapshot (audited 2026-06-26)

### Done — do NOT rebuild

| Area                                              | Evidence                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Production Dockerfiles (api, mcp, worker, parser) | `apps/{api,mcp,worker}/Dockerfile`, `services/parser-py/Dockerfile`                                             |
| Deploy config + migration gate                    | `apps/*/railway.json`; worker `preDeployCommand` runs `pnpm --filter @rag/db migrate`                           |
| CI gate workflow                                  | `.github/workflows/ci.yml` (build/typecheck/lint/test), `e2e.yml`                                               |
| Reranker (config-gated, opt-in)                   | `packages/rag/src/retrieval/reranker.ts`; `config.ts` `rerank.provider` default `none`                          |
| Original-document object storage + download       | `packages/rag/src/storage/`, `services/documents.ts getDocumentDownload`; `objectStore.provider` default `none` |
| Per-page self-re-enqueue ingestion                | `packages/ingestion/src/{pipeline,queue}.ts`, migration `0003_pending_uploads`                                  |
| Mandatory per-source ACL scope in retrieval       | `packages/core/src/access-control.ts`, `db/src/queries.ts` enforced filter                                      |
| Constant-time token auth + OIDC                   | `packages/core/src/{auth,oidc-auth}.ts`                                                                         |
| Embedding query/doc task-type fix                 | `packages/rag/src/embeddings/gemini.ts`                                                                         |
| Shared test doubles (`@rag/test-fixtures`)        | `packages/test-fixtures/`                                                                                       |
| No committed secrets; Zod-validated config        | `packages/core/src/config.ts`                                                                                   |

### Absent — the gap list (drives the waves below)

Rate limiting · error reporting (Sentry) · `/metrics` · PARSER_SECRET prod
enforcement · DB TLS in pool · failed-job alerting · purge path
(`purgeSource`/`DELETE /sources/:id`) · `dataClass` field · `audit_log` · HITL
disclaimer/`reviewStatus` · real eval corpus + faithfulness judge ·
egress/TRI guard (deferred) · self-host providers (deferred; `local` throws) ·
**admin-by-default for unscoped tokens** (security risk) · effective `lint`
(CI lint job exists but no eslint config / per-package script ⇒ likely a no-op).

---

## Critical path — 3 waves + parallel process track

### Wave 1 — cheap, high-leverage hardening (S each; ~2–3 days). Unblocks exposure.

1. **Rate limiting.** `@fastify/rate-limit` on `apps/api`, stricter on `/ask` and
   `/sources/:id/sync`, per-principal key; `express-rate-limit` on the MCP HTTP
   transport. Exempt `/health`,`/ready`. Copy: `apps/api/src/server.ts` plugin
   registration order (after error handler, before routes).
2. **PARSER_SECRET prod enforcement.** Fatal at startup when missing in a prod
   profile. Copy the fail-loud shape of the embedding-dimension guard.
3. **DB TLS.** Add `ssl` to `pg.Pool` (`packages/db/src/client.ts` + `migrate.ts`);
   require `sslmode=require` in prod `DATABASE_URL`; document in `env.example`.
4. **Remove admin-by-default.** An `API_TOKENS`/OIDC token with no mapped sources
   must resolve **deny-all**, not admin. Admin only via explicit `isAdmin:true`.
   `packages/core/src/access-control.ts` (`resolvePrincipal`/`parsePrincipalsConfig`);
   update `env.example` to a scoped example.
5. **HITL disclaimer.** Non-optional typed `reviewStatus:
"draft_requires_practitioner_review"` on `GenerationResult` + `AskResult`;
   include in the SSE `done` payload; render a **non-dismissible** banner on every
   assistant answer in the web chat. (Circular 230 §10.37 — server-sourced, not a
   UI string.)
6. **Error reporting + failed-job alert.** Sentry (or equiv) in all 3 apps + parser;
   capture 5xx in the global error handler (keep redaction). Emit exactly one alert
   when a sync job exhausts retries — hook the failed branch in
   `apps/worker/src/handlers/sync-source.ts`.
7. **Make `lint` real.** One root ESLint flat config + per-package `lint` scripts so
   the existing CI lint job actually gates. Verify it fails on a planted error.

### Wave 2 — compliance substance (M each; ~1 week). The §7216/GLBA/Circular-230 controls.

8. **`dataClass` field.** Source-level enum (default most-restrictive); ingestion
   refusal for a disallowed class before `upsertDocument`; AND a class predicate at
   the proven injection point in `db/src/queries.ts`. Scope the SharePoint connector
   to research/SOP libraries (exclude client-engagement libraries by construction).
9. **Purge path.** `purgeSource` typed query (transactional delete of source +
   documents + chunks + object blobs; FK cascade handles vectors) + `DELETE
/sources/:id` route + `purge_source` MCP tool, all scope-enforced. Copy:
   `services/sources.ts` `triggerSync` shape; tombstone delete in `pipeline.ts`.
10. **Audit log.** `audit_log` table (copy `ingestionJobs` shape); thread `Principal`
    (not just `AuthorizationScope`) to the service layer; emit one record at the
    `ask()`/`askStream()` choke point (user, query/hash, source+chunk+doc IDs,
    model, channel). Write async; alert on write failure; do not block the response.

### Wave 3 — quality so "use" is credible (M; parallelizable).

11. **Real eval baseline.** Replace the synthetic FakeEmbedder corpus with 30–50
    real CPA questions labeled with relevant docs; add an **LLM-judge faithfulness +
    citation-correctness** check to `pnpm eval`; record the dated baseline. Then
    decide the reranker on/off **by the eval delta**, not intuition. Copy:
    `tests/e2e/src/specs/retrieval-eval.spec.ts`, runner `pnpm eval`.

### Parallel — process / legal track (the real long pole; not code)

- **[COUNSEL]** Confirm the signed DPA + §7216 acknowledgment + US-region pin are on
  file; add a startup config assertion that a cloud key won't activate without a
  "DPA acknowledged" flag (cheap, mirrors `parsePrincipalsConfig` fail-loud).
- **[DOMAIN]** Curate/spot-check the KB: confirm no real taxpayer-return info reaches
  the index (Onvio is SoR). Tag any stray client examples `client-confidential`.
- **[PROCESS]** Name the Qualified Individual; add the RAG system to the WISP; staff
  AI-limitations note; breach runbook reference. Confirm GLBA pen-test exemption by
  consumer-record count.

---

## Deferred — explicitly NOT gates for tenant #1

- Self-hosted embeddings/generation (`local` provider) + egress/TRI payload scanner
  — build when a Class C/D tenant arrives, or if the DPA ever lapses.
- Retention `retain_until` + scheduled purge job — 90-day; the **on-demand** purge
  (item 9) is the pre-launch baseline.
- Off-host log shipping + `/metrics` / OpenTelemetry — 90-day observability tier.
- Multi-tenancy / per-tenant provisioning (Phase T) — when a 2nd tenant arrives.
- Per-document/per-client ACL + ACL mirroring; app-level field encryption (HIGH
  tenant); web upload/a11y/session-persistence polish — post-pilot.

---

## Sequence & go-live gate

```
Wave 1 (hardening, S) ─┐
Wave 2 (compliance, M) ─┼─► Go-live verification ─► tenant #1 launch
Wave 3 (eval, M) ──────┘        (below)
Process/legal track ───┘  (DPA + curate + WISP — runs in parallel, gates sign-off)
```

**Go-live verification (run last):**

- [ ] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] `pnpm e2e` green against the Postgres + parser stack.
- [ ] `pnpm eval` at/above the recorded Wave-3 baseline.
- [ ] Rate limit active; `PARSER_SECRET` enforced; DB TLS on; Sentry receiving;
      failed-job alert fires.
- [ ] Unscoped token retrieves nothing (no admin default); ACL scope still mandatory.
- [ ] `dataClass` live + restrictive default; client examples curated/tagged; spot-check
      finds no taxpayer-return info in the corpus.
- [ ] `purgeSource` + `DELETE /sources/:id` work with scope enforced.
- [ ] One `/ask` + one MCP `ask` each write exactly one `audit_log` row.
- [ ] Every assistant answer carries the non-dismissible draft disclaimer.
- [ ] Eng sign-off + business/legal (DPA) sign-off.
