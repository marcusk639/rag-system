# Implementation Plan: CPA Regulatory Compliance (IRC §7216 / GLBA / Circular 230)

> **Goal:** Bring `rag-system` into a defensible compliance posture for a CPA firm handling real
> taxpayer return information (TRI), following the control matrix in
> `docs/CPA-COMPLIANCE-REQUIREMENTS.md`. Phased MVP-first: mandatory pre-launch controls, then
> 90-day follow-ups, then growth-triggered items.
>
> **Status:** Ready to execute. Phase 0 (discovery) is COMPLETE — see findings below. Each
> subsequent phase is self-contained for a fresh chat context.
> **Date authored:** 2026-07-03
> **This is not legal advice.** Items marked **[COUNSEL]** require sign-off from the firm's tax
> attorney/counsel before go-live or before the specific control is relied upon. Nothing in this
> plan substitutes for that review.

---

## How to execute this plan

- Phase 0 (below) is the consolidated discovery output — already done via codebase audit + legal
  research. Re-verify file:line citations before editing; code may have moved since 2026-07-03.
- Phases 1-6 can mostly run independently/in parallel across sessions; dependencies are called out
  per phase. Phase 7 (growth) is explicitly deferred — do not build it now.
- Every phase: **what to implement** (copy existing patterns where one exists), **references**
  (file:line), **verification checklist**, **anti-pattern guards**, and a **[COUNSEL]** flag where
  applicable.
- Re-read `CLAUDE.md` ground rules before editing: cross-package contracts in `@rag/core`; DB access
  only via `@rag/db`; business logic in `@rag/services`; deps wired in `@rag/runtime`; ingestion
  always async via pg-boss; embeddings immutable per (provider, model, dimensions).
- **The MVP gate is binary per the source doc:** CR-1, CR-12, CR-8, CR-6/CR-7, CR-4, CR-16, CR-13,
  CR-5, CR-18 must all be true **before any real client data** goes through this system in
  production. Several of these already involve real the operating tenant client documents ingested today
  (see `docs/PLAN-KB-SYNC.md`) — treat closing these gaps as urgent, not aspirational.

---

## Phase 0 — Discovery (COMPLETE)

### 0.1 Control-matrix implementation status

Audited against `docs/CPA-COMPLIANCE-REQUIREMENTS.md`'s CR-1..CR-20 table. Status legend:
✅ implemented · 🟡 partial · ❌ not implemented · ⚪ org/process (not code).

| #     | Requirement                               | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ----------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-1  | No TRI disclosure (§7216)                 | 🟡                        | Self-hosted embedding provider exists (`packages/rag/src/embeddings/local.ts:44-164`, ONNX, zero egress) but **`gemini` is the default**, not `local` (`packages/core/src/config.ts:375-378`). TRI pre-flight scan blocks external generation when detected (`packages/rag/src/generation/generator.ts:90-102`, `:167-177`). **Gap:** no self-hosted generation option exists — only cloud `gemini`/`openai`. TRI scanner is regex/proximity-based only (see 0.2).                                                                                                           |
| CR-2  | §7216 vendor written notice **[COUNSEL]** | 🟡                        | Boot-time gate refuses `COMPLIANCE_MODE=client-data` without a `docs/compliance/vendor-dpa-*.md` file (`packages/core/src/config.ts:359-365, 504-517`). **Gap:** checks file _existence_ only, not content (no-train/expiry not validated); **no such file currently exists in the repo.**                                                                                                                                                                                                                                                                                   |
| CR-3  | US-located vendor                         | ❌ (as network check)     | No IP/region verification exists; `EgressPolicy` only allow-lists hostnames. This is a DPA-language/vendor-selection issue, not a code gap — see Phase 1.3.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CR-4  | No vendor training on inputs              | 🟡                        | Same boot gate as CR-2. `docs/compliance/README.md:12-19` defines required DPA fields but nothing parses them.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CR-5  | Least-privilege RBAC / fail-closed        | 🟡 **(critical gap)**     | API/MCP layer is solid: `AuthorizationScope` mandatory, `DENY_ALL_SCOPE`/`ADMIN_SCOPE` (`packages/core/src/access-control.ts:56,63`), identity→scope DB tables (`packages/db/src/schema.ts:393-436`), `resolveSourceIdsForUser()` (`packages/db/src/queries.ts:721-732`). **Critical gap: the web UI has no per-user auth at all** — every browser user shares one static `RAG_API_TOKEN` (`apps/web/src/lib/rag-api.ts:1-22`, `apps/web/src/app/api/chat/route.ts:11-56`). `resolveSourceIsForUser` is built and tested but **not wired into any route** — dead code today. |
| CR-6  | Encrypt at rest                           | ❌                        | No app-level encryption anywhere (negative grep). No Postgres TDE config in code. Documented as an open gap in `docs/ISSUES-AND-OPTIMIZATIONS.md:260-264`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CR-7  | Encrypt in transit                        | 🟢 (DB) / 🟡 (other hops) | **Postgres TLS closed 2026-09-07 (PR #59)** — `?sslmode=no-verify` on `DATABASE_URL` across all five services, verified 7/7 backends `ssl = t` on TLSv1.3; see the Phase 3 status callout. This row described the pre-2026-09-07 state (`DATABASE_SSL` optional and unset). No enforcement on other hops yet.                                                                                                                                                                                                                                                                |
| CR-8  | MFA                                       | 🟡                        | Correctly not in code (IdP concern). But the static-token auth path is a documented, known MFA-bypass (`docs/plans/2026-06-21-prelaunch-hardening-plan.md:182`) and — per CR-5 — **the web UI uses exactly that path for every user**, so MFA is currently unenforceable for the primary human-facing surface.                                                                                                                                                                                                                                                               |
| CR-9  | Vendor register                           | ❌                        | No populated register exists anywhere (only the README template).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CR-10 | Monitoring & logging                      | 🟡                        | `auditLog` + `ingestLog` tables exist and are populated on every `/ask` and ingest event (`packages/db/src/schema.ts:307-338, 346-378`; `apps/api/src/routes/ask.ts:29-48`). **Gaps:** logs live in the same Postgres instance (not an independent aggregator), no ≥3yr retention enforcement, no anomaly/bulk-export/after-hours alerting.                                                                                                                                                                                                                                  |
| CR-11 | Qualified Individual                      | ⚪                        | Org/WISP item. No code hook exists (none expected).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CR-12 | WISP names the system                     | ⚪                        | Org/process item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CR-13 | Human-in-the-loop disclaimer              | ✅                        | Non-optional `reviewStatus`/`disclaimer` fields on every answer (`packages/services/src/ask.ts:55-58`), surfaced in API, MCP, and web UI non-dismissibly (`apps/web/src/components/chat-interface/chat-interface.tsx:102-113`). **Minor gap:** no recorded "reviewed by CPA" event before use — see Phase-1 reasoning below (system has no outbound client-send path today, so this is a policy/training item, not a missing feature).                                                                                                                                       |
| CR-14 | Written-advice review queue               | 🟡                        | Same disclaimer mechanism as CR-13; **no actual hold/approval queue exists** — every answer returns directly in the same response. Acceptable for now because there is no direct-to-client send feature (see Phase 1).                                                                                                                                                                                                                                                                                                                                                       |
| CR-15 | Technological competence / staff training | ⚪                        | Org/process item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CR-16 | Breach notification runbook               | ❌                        | Only generic Sentry error capture exists (`packages/core/src/config.ts:176-180`). No breach-specific detection, no 30-day-clock runbook.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| CR-17 | IRS Stakeholder Liaison notice            | ❌                        | No runbook artifact exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CR-18 | Retention + secure disposal               | 🟡                        | **No `retain_until` column anywhere, no scheduled purge job.** What exists is a manual, on-demand, whole-source purge (`packages/services/src/sources.ts:120-124`, `DELETE /sources/:id`, cascading FK deletes) — satisfies the _disposal mechanism_ half only.                                                                                                                                                                                                                                                                                                              |
| CR-19 | Secure media disposal                     | ⚪                        | Infra/vendor-level; no code artifact expected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CR-20 | Backup / restore testing                  | ❌                        | No backup/restore scripts or drill documentation found.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 0.2 How the two core controls actually work (for anyone editing them)

**TRI scanner** (`packages/core/src/tri-scanner.ts`) — pure function `scanForTRI(text)`, 7 regexes
(SSN/ITIN, EIN, "taxpayer"+$amount, Form 1040/1065/1041/1120+$amount, 1099-series+$amount incl.
en/em-dash per commit `236c8eb`, W-2+$amount, Schedule refs+$amount). Two call sites: **generation
pre-flight** (blocks the call, throws `ComplianceError` — `generator.ts:90-102,167-177`) and
**ingest-time flagging** (never blocks ingestion, just logs to `ingest_log` with marker
`ingest.tri.flagged` — `packages/ingestion/src/pipeline.ts:308-322`). Known bypass surface: purely
regex/proximity (`.{0,30}`/`.{0,50}` windows) — TRI without a nearby dollar figure, or an SSN typed
without separators (deliberately excluded to avoid false positives), will not be caught.

**Egress policy** (`packages/core/src/egress-policy.ts`) — `EgressPolicy.fromEnv()` reads
`EGRESS_ALLOWED_HOSTS` (empty = deny-all); `assertAllowed(url)` throws `EgressError` if the
hostname isn't allow-listed. Called explicitly by each provider before its SDK call (Gemini/OpenAI
embeddings and generators) — **not a global network intercept**, so any future un-wired egress path
(e.g. a new reranker vendor) would silently bypass it unless the author remembers to call
`assertAllowed`. Separately, `createEmbeddingProvider()` (`packages/rag/src/embeddings/factory.ts:24-31`)
**already throws `ComplianceError` if `COMPLIANCE_MODE=client-data` and the provider isn't `local`**
— this is the architectural enforcement of the doc's "self-host embeddings" decision, and it already
exists in code today.

### 0.3 Legal/regulatory research since the source doc (2026-06-08 → 2026-07-03)

- **Circular 230 technological-competence amendment: still proposed, not final** (REG-116610-20,
  Federal Register 2024-12-26; comment period closed 2025-02-24; no final rule as of 2026-07).
  Treat CR-15 as best-practice, not yet a binding duty — but see next point.
  ([federalregister.gov](https://www.federalregister.gov/documents/2024/12/26/2024-29371/regulations-governing-practice-before-the-internal-revenue-service))
- **NEW — IRS OPR Alert 2026-19 (June 24-26, 2026), "Introductory Guidelines for Responsible AI Use
  in Federal Tax Practice."** Informal (not a Treasury reg) but issued by the office that
  administers Circular 230 discipline. Reinforces: AI must "augment, not replace" judgment (ties to
  existing, already-final §10.22 diligence duty — strengthens CR-13/CR-14); practitioners must use
  only "secure, enterprise-approved AI" for client data (directly reinforces CR-1 through CR-4);
  firms must train staff and vet third-party AI tools (reinforces CR-9/CR-15); **new consideration
  not in the original control matrix: a billing-transparency duty** — AI-driven efficiency gains
  must be reflected in client billing, not billed as if fully manual.
  ([Journal of Accountancy](https://www.journalofaccountancy.com/news/2026/jun/irs-outlines-ai-risks-circular-230-duties-for-tax-practitioners/))
- **FTC Safeguards Rule pen-testing exemption (16 CFR §314.6): confirmed at 5,000, but "consumer"
  is cumulative, not annual.** Exemption (from written risk assessment, annual pen-test, IR plan,
  board reporting) applies only below 5,000 consumers. **§314.2(b)(1) defines "consumer" as anyone
  who "obtains **or has obtained**" a service** — former/inactive clients whose old returns are
  still retained **count toward the threshold**. A firm should count every individual taxpayer ever
  served with data still on file, not just this year's active roster, before assuming the exemption
  applies. ([16 CFR 314.6](https://www.law.cornell.edu/cfr/text/16/314.6),
  [314.2](https://www.law.cornell.edu/cfr/text/16/314.2))
- **IRS Pub 5708 is an official, adaptable WISP template** (not turnkey — placeholder language must
  be replaced with firm specifics). Required contents: QI designation, data/asset inventory, risk
  assessment, admin/technical/physical safeguards, vendor oversight, IR plan, training records,
  backup/restore testing, periodic review. QI eligibility itself is loosely defined by design (any
  owner/partner who "oversees and enforces" the program) — no further counsel gap there.
  ([IRS Pub 5708 PDF](https://www.irs.gov/pub/irs-pdf/p5708.pdf))
- **State breach-notification law is triggered by the affected client's state of residence, not the
  firm's location.** A firm with clients in multiple states must satisfy each applicable state's
  law. Practical standard approach: build the IR runbook clock around the **strictest applicable
  deadline** — CA, CO, FL, and WA all require notification within 30 calendar days as of 2026 (CA's
  30-day rule effective 2026-01-01 under SB 446). **No shortcut exists for the full survey** — every
  source consulted (including a 2026 Foley & Lardner client alert) explicitly declined to
  generalize and deferred to counsel. This remains genuinely **[COUNSEL]**.
  ([NCSL summary](https://www.ncsl.org/technology-and-communication/security-breach-notification-laws))

### 0.4 Self-hosted embedding option (for CR-1 remediation)

A self-hosted, ONNX-compatible embedding provider already exists in this codebase
(`packages/rag/src/embeddings/local.ts`). For a ~20-person firm's modest corpus (hundreds to low
thousands of documents), CPU-only inference for embeddings is workable — embedding is far cheaper
than generation and doesn't need GPU throughput for this scale. `nomic-embed-text-v1.5` is the
pragmatic default to evaluate first because it's **768-dimensional**, matching the existing
`pgvector` column and HNSW index exactly — **no index rebuild or schema migration needed** if it's
selected. Treat model selection itself (quality bar vs. Gemini's embeddings, via a small retrieval
eval using this repo's existing `pnpm eval` harness) as a short spike inside Phase 1.1, not a
separate research phase — the architecture and hosting question are already answered; only "which
exact checkpoint" needs a quick empirical check.

---

## Phase 1 — Close the compliance gate: DPA acquisition + config hardening

**Goal:** Get the system to a state where `COMPLIANCE_MODE=client-data` can actually boot with a
real, validated vendor DPA, and where self-hosted embeddings are the enforced default for any
client-data source. **Unblocks the currently-live production issue** (see `docs/PLAN-KB-SYNC.md` —
`/ask` and `/search` are 500ing right now because `EGRESS_ALLOWED_HOSTS` is empty).

> **Status update (2026-07-04):** With explicit user authorization, `EGRESS_ALLOWED_HOSTS=
generativelanguage.googleapis.com` was enabled in production **before** billing/DPA status was
> verified, scoped explicitly to an **internal demonstration for primary stakeholders already
> authorized to view all data** — not general production use. This is a deliberate, documented
> exception to the anti-pattern guard below, not a reversal of it. See
> `docs/compliance/vendor-dpa-google-gemini.md` (marked PROVISIONAL) for the exact gap and
> required follow-ups.
>
> `COMPLIANCE_MODE=client-data` was **attempted** but reverted back to `none` after discovering
> it hard-requires `EMBEDDING_PROVIDER=local` in code (`packages/rag/src/embeddings/factory.ts`) —
> not just a DPA file. Switching to local embeddings means re-embedding the entire corpus, which is
> genuinely Phase 1.1's scope, not a config flip. Asked the user explicitly; they chose to leave
> `COMPLIANCE_MODE=none` for today's demo rather than take on the re-embedding migration now. **This
> means TRI protection currently rests solely on the `EGRESS_ALLOWED_HOSTS` allow-list — the
> code-enforced "embeddings must be local" belt-and-suspenders check is NOT active.** 1.1 and 1.2
> below are still outstanding and must be completed, with `COMPLIANCE_MODE=client-data` re-enabled,
> before this moves beyond internal demo use.
>
> Separately, discovered and fixed a real infra bug while investigating this: `.dockerignore`
> excluded all of `docs/`, so `COMPLIANCE_MODE=client-data`'s DPA-file boot check could never have
> passed in any production deploy, regardless of file content. Fixed by carving out
> `docs/compliance/*.md` in `.dockerignore` and copying it into the runtime image in all three
> service Dockerfiles — this was broken independent of today's provisional-DPA decision.

### 1.1 Decide and execute the embedding path [some COUNSEL input useful, not blocking]

- Run a quick retrieval-quality spike: switch a test source to `EMBEDDING_PROVIDER=local` with
  `nomic-embed-text-v1.5` (768-dim, no index migration) and run `pnpm eval` to compare recall/nDCG
  against the current Gemini baseline (`docs/PLAN-SHAREPOINT-READINESS.md` Phase E/F baselines:
  recall@5≥0.8, recall@3≥0.7, nDCG@5≥0.6, MRR≥0.6).
- If quality holds: set `EMBEDDING_PROVIDER=local` as the **production default** for any source
  containing real client data. `createEmbeddingProvider()` already refuses cloud providers when
  `COMPLIANCE_MODE=client-data` (`packages/rag/src/embeddings/factory.ts:24-31`) — this phase is
  mostly a **configuration** change (`EMBEDDING_PROVIDER=local`, `COMPLIANCE_MODE=client-data`), not
  new code, plus **re-embedding the existing corpus** (full re-sync of every client-data source
  after the switch — embeddings are immutable per model per `CLAUDE.md`).
- If quality doesn't hold: this reopens **[COUNSEL] gap #2** from the source doc (relying on the
  §7216 auxiliary-services exception instead) — do not proceed without a documented legal opinion.

### 1.2 Get the Google Cloud DPA in place [business/legal action, not code]

- Confirm the `GEMINI_API_KEY` currently in use is tied to a Google Cloud project with **active
  Cloud Billing** — this is what moves Gemini API usage from the free tier (data used to improve
  Google's products, human review possible, **no DPA**) to the paid tier (no training on
  prompts/responses, covered by the standard [Google Cloud DPA](https://cloud.google.com/terms/data-processing-addendum)).
  If not billed, attach billing and regenerate the key.
- For most Google Cloud customers the DPA is incorporated automatically into the Cloud Terms of
  Service once there's an active Cloud Agreement — no separate signature typically required.
  Confirm/review under Cloud Console → Account/Legal agreements. If an explicit countersigned copy
  is wanted for the firm's files, contact Google Cloud's account team or Cloud Data Protection Team
  (no self-serve flow for that).
- **[COUNSEL]:** get sign-off that the DPA is simultaneously sufficient for §7216 (per CR-2's
  auxiliary-services/written-notice question) **and** GLBA §314.4(f) — this is source-doc gap #1.
  This DPA covers **generation only** if Phase 1.1 lands on self-hosted embeddings; if embeddings
  also remain cloud-based for any reason, the DPA must explicitly cover that use too.

### 1.3 Populate the vendor DPA file and harden the boot gate

- Copy `docs/compliance/README.md`'s template to `docs/compliance/vendor-dpa-google-gemini.md`,
  filling in: vendor/service, DPA reference, date signed, no-train ☑, zero-retention ☑, data region
  (note: standard Gemini API endpoints don't publish region-pinned hostnames the way e.g. AWS
  regions do — rely on the DPA's data-residency clause for CR-3, not a network check; if Vertex AI
  regional endpoints are used instead, encode the exact region in `EGRESS_ALLOWED_HOSTS`), §7216 +
  GLBA counsel sign-off date/name, renewal/expiry date.
- **[code]** Strengthen `defaultCheckDpa` (`packages/core/src/config.ts:359-365`) to actually parse
  the DPA file's required fields (no-train/zero-retention confirmed, not expired) rather than just
  checking file existence — turn the template's checkboxes into a real validation gate. Add a unit
  test: a DPA file missing a required field, or with a past expiry date, fails boot; a complete
  valid file passes.
- Set `EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com` and `COMPLIANCE_MODE=client-data` in
  production **only after** 1.1 and 1.2 are both done.

### Verification checklist

- [ ] `pnpm eval` results for `local` vs `gemini` embeddings recorded and compared against baseline
- [ ] Production `COMPLIANCE_MODE=client-data` boots successfully with a real, complete DPA file
- [ ] Unit test: incomplete/expired DPA file → boot fails (new test)
- [ ] `/ask` and `/search` return 200 again in production
- [ ] `docs/compliance/vendor-dpa-google-gemini.md` exists with counsel sign-off recorded

### Anti-pattern guards

- Do NOT set `EGRESS_ALLOWED_HOSTS` in production before the DPA is actually confirmed (billing +
  DPA terms) — a file existing isn't the same as the underlying agreement being real. **Exception
  on record for 2026-07-04:** enabled ahead of confirmation under explicit user authorization,
  scoped to internal-stakeholder demo use only — see the status update above. This guard still
  applies to any further widening of access (new users, external clients, production-for-real use).
- Do NOT invent a network-level region-pinning check for CR-3 — it doesn't verify anything
  meaningful for standard SaaS API endpoints; rely on DPA data-residency language instead.
- Do NOT re-embed only new documents — a full re-sync is required so old and new chunks share one
  embedding model (mixed-model corpora are the exact failure mode `CLAUDE.md` warns about).

---

## Phase 2 — Fix web UI authentication and RBAC wiring (CR-5, CR-8)

**Goal:** Close the most critical gap found — every web-UI user currently shares one static token,
so there is no real per-user access control at the human-facing surface, and MFA is unenforceable
there. **Highest priority, likely the largest engineering lift in this plan.**

### What to implement

1. Add real per-user login to `apps/web` using this repo's existing OIDC support
   (`AUTH_PROVIDER=oidc`/`composite`, `packages/core/src/oidc-auth.ts`) instead of the current
   single shared `RAG_API_TOKEN` (`apps/web/src/lib/rag-api.ts:1-22`,
   `apps/web/src/app/api/chat/route.ts:11-56`). Copy the OIDC verification pattern already proven
   server-side; the web app's BFF needs to obtain/verify a per-user token instead of a static one.
2. Wire the already-built, already-tested `resolveSourceIdsForUser()`
   (`packages/db/src/queries.ts:721-732`, tests in `queries.identity-scope.test.ts`) into the actual
   per-request auth path so each logged-in user's session resolves to their assigned
   clients/sources — this closes the "dead code" gap the audit found.
3. Restrict any remaining static tokens (`API_TOKENS`/`API_PRINCIPALS`) to **non-human, service-to-
   service** principals only (e.g. MCP clients, internal scripts) — never issue one as a staff
   member's day-to-day interactive credential.
4. Configure Entra (or whichever IdP) conditional access to require MFA for the web app's
   registration.

### References

- OIDC verification: `packages/core/src/oidc-auth.ts`
- Scope resolution: `packages/db/src/queries.ts:721-732`; `packages/core/src/access-control.ts`
- Current (to-be-replaced) static-token BFF path: `apps/web/src/lib/rag-api.ts`,
  `apps/web/src/app/api/chat/route.ts`
- Documented known gap: `docs/plans/2026-06-21-prelaunch-hardening-plan.md:182`

### Verification checklist

- [ ] User A logged into the web UI cannot retrieve documents from a source exclusively assigned to
      user B (test via the web UI, not just direct API calls with a manually-scoped token)
- [ ] IdP admin console confirms MFA/conditional access is enforced for the web app's registration
- [ ] Audit `API_PRINCIPALS`: no named individual (marcus, chris, etc.) has a bare static token used
      for interactive login — migrate any such principal to OIDC
- [ ] `resolveSourceIdsForUser` has a real call site (not just tests) after this phase

### Anti-pattern guards

- Do NOT ship this as "internal only, come back to it later" if multiple staff with _different_
  client-access levels will use the web UI before this lands — that's exactly the scenario CR-5
  exists to prevent.
- Do NOT build a second, parallel scoping mechanism — reuse `resolveSourceIdsForUser` and
  `AuthorizationScope` rather than inventing new access-control code.

---

## Phase 3 — Encryption at rest and in transit (CR-6, CR-7)

**Goal:** Close the encryption gaps with the lowest-engineering-cost correct answer — prefer
provider-managed encryption over building custom crypto.

> **Status update (2026-09-07): the CR-7 in-transit half is CLOSED.** `?sslmode=no-verify` is set on
> `DATABASE_URL` across all five services (PR #59); verified in production as 7/7 client backends
> `ssl = t` on TLSv1.3, zero plaintext, via `pg_stat_ssl` joined to `pg_stat_activity`, and the
> worker's boot warning no longer prints. Step 3 below is retained as the record of what was done
> and why. **CR-6 (encryption at rest) remains open** and is the only unfinished half of this phase.
>
> ⚠ **`no-verify` encrypts but does not authenticate the server.** It skips certificate
> verification, so it does not defend against an on-path attacker who can intercept the connection
> and present their own certificate. Full verification would require distributing the
> `postgres-ssl` image's CA to every client — later hardening, not a launch gate (see
> `docs/PILOT-LAUNCH-STATUS.md`). Whether that residual exposure is acceptable depends on the
> network path between app and database; record the answer here when it is settled.

### What to implement

1. Confirm with the current Postgres hosting provider (Railway-managed Postgres, or whichever is in
   production) whether volumes are encrypted at rest by default — most managed Postgres offerings
   are. Document that confirmation in writing (support ticket/docs link) as the CR-6 control rather
   than building app-level AES-256-GCM from scratch, unless the confirmation comes back negative.
2. If confirmation is negative or ambiguous, evaluate migrating to a provider with encryption
   at rest documented by default, or add an encrypted volume at the infra layer.
3. Add `?sslmode=no-verify` to the production `DATABASE_URL` — this covers the pool, pg-boss and
   migrations, whereas the `DATABASE_SSL` flag (`packages/core/src/config.ts:18-24`) only configures
   the app pool. Do **not** use `sslmode=require`: `pg-connection-string` >= 2.10 aliases it to
   `verify-full`, which fails outright against the self-signed cert Railway's `postgres-ssl` image
   serves, rather than encrypting (`packages/runtime/src/postgres-tls.ts:8-13`; the runtime already
   warns on this at boot, `packages/runtime/src/index.ts:144-156`).
   ⚠ That value is for the **node-postgres** services only. Anything using **libpq** — `pg_dump` in
   `services/backup`, `psql`, the restore procedure — rejects `no-verify` as an invalid sslmode and
   fails to connect; use `sslmode=require` there, which for libpq means encrypt-without-verifying.
   Do not copy a `DATABASE_URL` between the two stacks (`env.example:53-58`,
   `services/backup/backup.sh:25-35`).
4. Add a startup validation (alongside the existing `PARSER_SECRET` fail-loud pattern,
   `config.ts:228-237`) that rejects `http://` URLs for any external service config
   (`PARSER_URL`, API base URLs, etc.) when `NODE_ENV=production`.

### Verification checklist

- [ ] Written confirmation on file that the Postgres volume is encrypted at rest
- [x] `?sslmode=no-verify` set on the production `DATABASE_URL`; connection actually negotiates TLS
      — **done 2026-09-07 (PR #59)**, verified as 7/7 backends `ssl = t` on TLSv1.3 with
      `pg_stat_ssl` joined to `pg_stat_activity`, not by trusting the variable (setting a Railway
      variable does not reliably restart the service)
- [ ] Startup fails loudly if a production `http://` URL is configured (new test)
- [ ] `testssl` scan of all public endpoints shows no plaintext HTTP

### Anti-pattern guards

- Do NOT build custom app-level encryption for the whole corpus if provider-managed encryption at
  rest already covers it — that's needless complexity and a real place to introduce bugs.

---

## Phase 4 — Retention/purge scheduling and audit-log hardening (CR-18, CR-10)

**Goal:** Turn today's manual, on-demand, whole-source purge into a real scheduled retention
policy, and hardening the existing audit log into something that actually satisfies "independent
aggregator" + alerting.

### What to implement

1. **Retention config (start simple):** add a single configurable `RETENTION_YEARS` policy applied
   uniformly for MVP, rather than per-document `retain_until` dates — defer granular
   per-filing-date retention to Phase 7 (growth). Add the column/config and a migration following
   the existing hand-authored-migration pattern (`packages/db/drizzle/0002_documents_original_storage.sql`
   is the template — Drizzle can't diff certain index/trigger structures cleanly).
2. **Scheduled purge job:** add a new pg-boss job type alongside the existing `sync_source` job
   (`apps/worker/src/handlers/sync-source.ts` is the pattern to copy;
   `JOB_NAMES` in `apps/worker/src/main.ts:7`). It should find documents/chunks past retention and
   hard-delete them, reusing the existing cascade-delete logic
   (`packages/services/src/sources.ts:120-124`, FK `onDelete: "cascade"`) at per-document rather
   than per-source granularity.
3. **Log every purge** into the existing audit trail (ties this phase to CR-10 directly).
4. **Ship audit log rows off-host:** add an export job (or wire to a managed logging service) so
   `auditLog`/`ingestLog` rows survive independently of the primary Postgres instance.
5. **Basic anomaly alerting:** flag a single principal retrieving an unusually large number of
   documents in a short window, and after-hours access; route to Sentry (already wired,
   `packages/core/src/config.ts:176-180`) or a dedicated alert channel.

### References

- Existing manual purge to extend: `packages/services/src/sources.ts:120-124`;
  `apps/api/src/routes/sources.ts:101-123`; MCP tool `apps/mcp/src/tools/purge-source.ts`
- Existing scheduled-job pattern to copy: `apps/worker/src/handlers/sync-source.ts`
- Audit tables: `packages/db/src/schema.ts:307-338` (`auditLog`), `:346-378` (`ingestLog`)

### Verification checklist

- [ ] A document with a past retention date is fully gone (markdown row AND embedding vector) after
      the scheduled job runs
- [ ] Purge actions appear in the audit log
- [ ] Audit rows are present in the off-host destination even when simulating primary DB
      unavailability (conceptual restore-drill style test)
- [ ] Simulated bulk pull triggers an alert

### Anti-pattern guards

- Do NOT delete-then-fail — a partial purge that removes text but leaves the embedding vector (or
  vice versa) fails the requirement; keep it transactional per document.
- Do NOT build per-filing-date retention granularity for MVP — that's real added complexity;
  ship the simple uniform policy first (Phase 7 revisits this if growth requires it).

---

## Phase 5 — Vendor register and breach IR runbook (CR-9, CR-16, CR-17)

**Goal:** Produce the documentation artifacts that don't yet exist at all.

### What to implement

1. **Vendor register**: create `docs/compliance/VENDOR-REGISTER.md`, one row per external
   dependency — vendor, service, DPA status/link, §7216 ack status, data region, last-reviewed
   date, next-review-due date. Cover every host in `EGRESS_ALLOWED_HOSTS` plus infra vendors
   (Railway, Microsoft Graph/SharePoint, object storage provider, Sentry if enabled).
2. **Breach IR runbook**: write `docs/compliance/BREACH-IR-RUNBOOK.md` — detection sources (Sentry
   alerts, Phase 4's anomaly alerts), a 30-day clock (use the **strictest** applicable state
   deadline — CA/CO/FL/WA all require 30 days as of 2026, per Phase 0 research), FTC notification
   portal step, **IRS Stakeholder Liaison parallel notice step** (CR-17), and the QI as incident
   commander.

### Verification checklist

- [ ] Register covers every current vendor with a review-due date
- [ ] Runbook reviewed via an annual tabletop exercise (schedule this, don't just write it)

### Anti-pattern guards

- Do NOT try to build a full 50-state breach-notification matrix yourself — every source consulted
  in Phase 0 declined to generalize this; **[COUNSEL]** should build/maintain the actual matrix.
  The runbook's job is process (who does what, in what order, by when), not the legal matrix
  itself.

---

## Phase 6 — Org/process items (CR-11, CR-12, CR-15, CR-19, CR-20)

**Goal:** Close the non-code requirements. These can run in parallel with Phases 1-5.

### What to do

1. **CR-11**: firm formally designates a Qualified Individual (owner/partner); document name +
   responsibilities; confirm Sentry/alert routing (already implemented) actually reaches them.
2. **CR-12**: adopt/adapt **IRS Pub 5708's official WISP template** (confirmed to exist, see Phase
   0.3) naming this RAG system explicitly, cross-referencing Phase 5's vendor register.
3. **CR-15**: stand up annual staff training on system limitations and AI use, explicitly
   incorporating **IRS OPR Alert 2026-19** (verify all AI facts/citations; "augment not replace";
   the new billing-transparency expectation if the firm bills for AI-assisted time savings).
4. **CR-19**: document reliance on cloud/object-store providers' deletion guarantees; add a
   decommission checklist (request/retain deletion certificates) to the ops runbook.
5. **CR-20**: confirm the Postgres provider's automated backup schedule; perform and document one
   manual restore drill (restore last backup to a scratch environment, verify integrity) before
   go-live, then repeat quarterly/annually.

### Verification checklist

- [ ] WISP document exists, names the system, reviewed annually
- [ ] Training records exist for all staff with system access
- [ ] Restore drill log exists with date + integrity check result

---

## Phase 7 — Growth-triggered reassessment (do NOT build proactively)

Revisit these **only when a specific trigger fires** — building them now is disproportionate for a
~20-person firm's internal tool:

- **SOC 2 Type II** — reassess if the system is ever productized/sold externally, not for internal
  use at this scale.
- **Annual penetration testing** — currently exempt under FTC Safeguards Rule while under 5,000
  consumers, **but count cumulatively including former clients with retained data** (Phase 0.3
  finding) — recount this periodically as the firm's retained-client population grows, not just
  once.
- **Formal per-document `retain_until` / data-class taxonomy** — Phase 4 ships a simple uniform
  retention policy; revisit granular per-filing-date retention if regulatory or client-contract
  requirements demand it.
- **CR-14 real review-queue/approval workflow** — only needed if a direct-to-client send/export
  feature is ever added to the product. Today the system has no such path, so the disclaimer alone
  is the appropriate control (see Phase 0's CR-13/14 findings). **If an export/send feature is ever
  built, it must ship with review-gating from day one, not bolted on after.**
- **TRI scanner hardening** — expand beyond regex/proximity matching (e.g., a secondary ML-based
  PII detector, or SSN-without-separator detection with tuned false-positive handling) if false
  negatives become a real observed problem.
- **Vertex AI / regional-endpoint migration** — if CR-3's DPA-language approach proves insufficient
  for a specific client or auditor, migrate from the direct Gemini API to Vertex AI's regional
  endpoints, which do support explicit region pinning.

---

## Final Phase — Counsel sign-off gate + verification

Before any phase's controls are relied upon for real client production data, confirm:

- [ ] **[COUNSEL]** DPA sufficiency for §7216 + GLBA simultaneously (Phase 1.2)
- [ ] **[COUNSEL]** Auxiliary-services exception NOT relied upon without a formal legal opinion
      (only relevant if Phase 1.1's self-hosted-embedding path is abandoned)
- [ ] **[COUNSEL]** State breach-notification matrix reviewed for the firm's actual client geography
      (Phase 5)
- [ ] **[COUNSEL]** Circular 230 / IRS OPR Alert 2026-19 implications reviewed for firm policy
      (Phase 6)
- [ ] All Phase 1-6 verification checklists above are checked off
- [ ] `pnpm eval`, `pnpm typecheck`, `pnpm test` green; anti-pattern greps (per
      `docs/PLAN-SHAREPOINT-READINESS.md` Phase G style) return nothing bad
- [ ] Full control-matrix re-audit: re-run the Phase 0 discovery process and confirm every MVP-list
      item (CR-1, CR-12, CR-8, CR-6/7, CR-4, CR-16, CR-13, CR-5, CR-18) is now ✅, not 🟡 or ❌

---

## Suggested execution order across sessions

```
Phase 1 (DPA + config) ──┐
Phase 3 (encryption)     ├─→ can run in parallel, independent of each other
Phase 6 (org/process)    ┘
        │
        ▼
Phase 2 (web UI auth — biggest lift, highest priority)
        │
        ▼
Phase 4 (retention/purge + audit hardening)
        │
        ▼
Phase 5 (vendor register + breach runbook)
        │
        ▼
Final Phase (counsel sign-off + re-audit)
        │
        ▼
Phase 7 (growth — only on trigger, not proactively)
```

Phase 1 is the most urgent — it unblocks the currently-live production outage (`/ask`/`/search`
500ing) and is a prerequisite for treating any of the rest of this plan as more than theoretical,
since real client data is already flowing through the system today.
