# CPA RAG Knowledge Base — Implementation & Compliance Spec

> ## ⛔ HISTORICAL (marked 2026-08-03) — no longer the authoritative plan
>
> This document called itself _"the authoritative master plan."_ It was, on
> 2026-06-08. It is not now, and three other documents have since made the same
> claim over overlapping ground. **Current authority:**
> [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md) for what is true,
> [`plans/2026-06-26-launch-readiness-consolidated.md`](./plans/2026-06-26-launch-readiness-consolidated.md)
> for priority and sequencing, and
> [`superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md`](./superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md)
> for the platform direction.
>
> **Still valuable, and not superseded:** its requirements catalog (FR/NFR) and
> its framing of §7216 as an architecture-shaping constraint rather than a
> checklist item. **Known stale:** §1 says the `local` embedding provider
> _"currently throws"_ — it shipped long ago, and under
> `COMPLIANCE_MODE=client-data` it is not merely the default but **mandatory**:
> `packages/rag/src/embeddings/factory.ts` throws if any other provider is
> configured in that mode.

> Defines WHAT must be true (requirements + compliance controls + a compliant architecture) and
> sequences the FULL build. It composes three companion docs — read them
> alongside:
>
> - `CPA-KB-ADOPTION-PLAN.md` — the functional build phases (cited here for step-level detail).
> - `AUTH-AND-SESSIONS-RESEARCH.md` — BFF auth + multi-channel session storage.
> - `CPA-COMPLIANCE-REQUIREMENTS.md` — the regulatory catalog + CR-1..CR-20 control matrix.
>
> **This is not legal advice.** Items tagged **[COUNSEL]** require a tax attorney before go-live.
> Authored 2026-06-08. Every API/file reference verified against the code on 2026-06-07.

---

## 1. The decision that shapes the architecture (read first)

A RAG system sends document text to an embedding model and a generation model. For a CPA firm, **the
moment taxpayer return information (TRI) reaches an external embedding/LLM endpoint, that is a §7216
disclosure** — there is no incidental carve-out and no AI-specific IRS guidance (see
`CPA-COMPLIANCE-REQUIREMENTS.md`). Therefore the architecture is **TRI-egress-zero by default**:

1. **Embeddings are self-hosted.** TRI is vectorized on the firm's own infrastructure; vectors never
   leave it. `rag-system` declares a `local` embedding provider but it currently throws — **building
   it is Phase A and is on the critical path.**
2. **Generation uses a US-region enterprise LLM with a signed DPA (no-train, zero-retention)** — or is
   also self-hosted. **[COUNSEL]** must confirm the DPA satisfies §7216 + GLBA simultaneously.
3. **Every external egress is allow-listed and TRI-scanned** at the boundary; an unverified provider
   fails closed (no call).

This default replaces `rag-system`'s out-of-the-box Gemini embeddings. Do not ingest real client data
until Phase A + the compliance gate (Phase H) are complete.

---

## 2. Requirements catalog

### Functional requirements (FR)

- **FR-1** Ingest firm documents from SharePoint (primary), plus Outlook/Gmail/Drive — delta sync.
- **FR-2** Parse all common formats (pdf/docx/xlsx/pptx/images incl. scanned) to clean markdown.
- **FR-3** Chunk + embed; hybrid dense+sparse retrieval (RRF); optional reranking.
- **FR-4** Grounded, **cited** answers via an `/ask` API and an MCP agent surface.
- **FR-5** Web chat UI; **Microsoft Teams** bot; **SMS** line (restricted — see CR-13/CR-1).
- **FR-6** Multi-turn, multi-channel chat with server-side session memory + history-aware retrieval.
- **FR-7** Operator (non-developer) can add a source, run a sync, and see status without editing JSON.
- **FR-8** Foundation for future automations: every channel and automation calls the same governed
  retrieval layer (HTTP `/ask` + MCP tools), never the DB directly.

### Non-functional requirements (NFR)

- **NFR-1** Postgres-centric (one DB: pgvector + tsvector + pg-boss + sessions). No second datastore.
- **NFR-2** Strict TypeScript; parameterized queries; ≥ existing 316-test coverage maintained.
- **NFR-3** Retrieval quality measured by an eval harness (recall@k / nDCG@k) before/after tuning.
- **NFR-4** Resumable, idempotent ingestion (content-hash short-circuit).

### Compliance requirements (CR-1..CR-20)

Defined in full in `CPA-COMPLIANCE-REQUIREMENTS.md` (control + verification each). Mapped to phases in
§4 below. Mandatory-before-client-data subset: CR-1, CR-4, CR-5, CR-6, CR-7, CR-8, CR-12, CR-13, CR-16,
CR-18.

---

## 3. Compliant target architecture

```
                        ┌────────────── Firm infrastructure (TRI never leaves) ──────────────┐
 SharePoint/Outlook ──▶ │ connectors ──▶ parser sidecar ──▶ chunker ──▶ SELF-HOSTED EMBEDDER │
 /Gmail/Drive           │                                                   │ (vectors)        │
                        │                          Postgres (encrypted at rest)               │
                        │   pgvector chunks · tsvector · pg-boss jobs · chat_sessions/messages │
                        │                          ▲                          │               │
                        │             hybrid RRF retrieval (ACL-enforced)      │               │
                        │                          │                          ▼               │
                        │   ┌─ HTTP API (/search,/ask,/sessions) ─┐   ┌─ MCP server (tools) ─┐ │
                        └───┼──────────────┬──────────────────────┼───┴──────────────────────┘ │
                            │              │                      │                            │
   BFF (Next.js, server)◀──┘   Teams adapter            SMS adapter (restricted)               │
   PropelAuth + MFA           (Entra SSO + MFA)         (allowlist + Twilio Verify)             │
        │                          │                          │                                │
   Web chat UI                 MS Teams                  SMS (non-confidential only)            │
                                                                                                │
   Generation LLM: US-region enterprise API w/ DPA (no-train) ── OR self-hosted ── allow-listed │
   egress only; TRI-scan at boundary; structured audit logs ▶ independent aggregator/SIEM ──────┘
```

Controls embedded: ACL fail-closed (CR-5) in retrieval SQL; encryption at rest/transit (CR-6/7); MFA at
every human entry (CR-8); human-in-the-loop disclaimer + review queue (CR-13/14); audit logging (CR-10);
retention/purge jobs (CR-18); vendor allow-list + DPA gate (CR-2/3/4); breach detection (CR-16).

---

## 4. Phase plan (functional build interleaved with compliance controls)

Each phase is self-contained for a fresh chat context: what to build (copy-from-source framing),
references, acceptance criteria (incl. the CR-ids it satisfies), and anti-pattern guards. Phases A–C
gate real client data. Functional detail for the non-compliance phases lives in
`CPA-KB-ADOPTION-PLAN.md` (cited per phase) — this spec adds the compliance build and acceptance bar.

### Phase A — §7216 architecture: self-hosted embeddings + egress control (CRITICAL PATH)

**Satisfies:** CR-1, CR-3, CR-4 (partial). **Gate:** blocks all real client data.

- **Build the local embedding provider.** `packages/rag/src/embeddings/` declares a `local` provider
  that throws today — implement it with `transformers.js`/a local model (e.g., `bge-small`, 768d) and
  register it in `factory.ts:16-45`. Set `EMBEDDING_PROVIDER=local` as the firm default; keep the
  dimension guard from adoption-plan Phase 2 (H3) so the vector column matches.
- **Egress allow-list + TRI scanner at the boundary.** A small module that (a) only permits outbound
  calls to allow-listed, US-region hosts, and (b) runs a TRI-pattern pre-flight (SSN/EIN/named-amount)
  before any external generation call; fail-closed if a non-allow-listed host or unverified vendor.
- **Generation provider decision.** Default to a US-region enterprise LLM with a signed DPA (no-train,
  zero-retention), configured via `GENERATION_PROVIDER`/`GENERATION_MODEL`; record the DPA. **[COUNSEL]**
- **Documentation refs:** `AUTH-AND-SESSIONS-RESEARCH.md` (egress); `CPA-COMPLIANCE-REQUIREMENTS.md`
  CR-1..CR-4; `env.example`; `packages/core/src/config.ts:75-153`.
- **Acceptance:**
  - [ ] `EMBEDDING_PROVIDER=local` produces 768-d vectors with no network egress (assert via egress test).
  - [ ] An external generation call to a non-allow-listed host is blocked (test).
  - [ ] TRI-pattern scanner blocks a document containing a synthetic SSN from external send (test).
  - [ ] DPA for the generation vendor stored; config refuses to boot in "client-data" mode without it.
- **Anti-patterns:** ❌ leaving Gemini/OpenAI as the embedding default; ❌ any external call not behind the allow-list; ❌ treating embedding vectors of TRI as non-TRI.

### Phase B — Access control, PII redaction, identity→scope (land hardening on `main`)

**Satisfies:** CR-5, CR-2 (vendor-ack gate scaffold). **Gate:** blocks real client data.

- Execute **`CPA-KB-ADOPTION-PLAN.md` Phase 1** in full (merge `feat-hardening-cpa-blockers`: fail-closed
  `AuthorizationScope`, `API_PRINCIPALS`, `metadata-policy` PII redaction, MCP per-session scope; add the
  `staff_client_assignments` / `source_client_assignments` mapping + `resolveSourceIdsForUser`).
- **Acceptance:** adoption-plan Phase 1 checklist, plus:
  - [ ] Two tokens → disjoint results; empty scope → zero results (CR-5 fail-closed).
  - [ ] `/search` and `/ask` strip `from`/`to`/`subject` PII for scoped callers (CR maps to §7216 minimisation).
- **Anti-patterns:** as adoption-plan Phase 1 (no optional scope, enforce in SQL not as filter, soft-delete grants).

### Phase C — Latent-breakage + parser auth

**Satisfies:** NFR integrity; CR-7 (parser auth leg). Execute **adoption-plan Phase 2** (C1 index-drift
guard, H3 dim-guard, C2 parser shared-secret). **Acceptance:** adoption-plan Phase 2 checklist.

### Phase D — Infrastructure hardening: encryption, TLS, MFA

**Satisfies:** CR-6, CR-7, CR-8. **Gate:** blocks real client data.

- **At rest (CR-6):** enable Postgres encryption (managed-service TDE or disk-level); app-level
  AES-256-GCM on `chat_messages.content` (per `AUTH-AND-SESSIONS-RESEARCH.md` Part 2). Key in env→KMS.
- **In transit (CR-7):** enforce TLS 1.2+ on every hop (connectors→parser→DB→API→channels→generation);
  `sslmode=require` on Postgres; CI check rejecting plaintext HTTP on data endpoints.
- **MFA (CR-8):** PropelAuth/IdP MFA on the web UI; Entra conditional-access MFA for Teams; MFA on
  DB/admin and CI secrets. No in-office exception (Pub 5708 2024).
- **Acceptance:**
  - [ ] `testssl`/scan shows TLS 1.2+ only on all endpoints; CI blocks an HTTP data path (test).
  - [ ] `chat_messages.content` is ciphertext at rest (inspect raw row).
  - [ ] IdP logs show MFA challenge for every human login; no human-interactive bypass.
- **Anti-patterns:** ❌ plaintext HTTP anywhere on a data path; ❌ MFA exceptions; ❌ encryption key in the DB or repo.

### Phase E — Server-side chat sessions (multi-channel) + audit logging

**Satisfies:** FR-6; CR-10 (audit), CR-6 (transcript encryption). Execute **adoption-plan Phase 5**
(3 Drizzle tables, stateful `/sessions`, history-aware rewrite), and add:

- **Audit logging (CR-10):** structured retrieval/answer logs (user, ts, doc/client id, query hash)
  shipped to an **independent** aggregator/SIEM; ≥3yr retention; anomaly alerts (bulk export, after-hours).
- **Acceptance:** adoption-plan Phase 5 checklist, plus:
  - [ ] Every retrieval emits an audit record to the off-host aggregator (test).
  - [ ] A simulated bulk-export fires an alert (test).
- **Anti-patterns:** ❌ logs only on the app host; ❌ logging message content into the audit log; ❌ JSON-array messages.

### Phase F — Retrieval eval harness + reranking

**Satisfies:** NFR-3, FR-3. Execute **adoption-plan Phases 3–4** (eval baseline; reranking only if
nDCG@k improves). **Acceptance:** adoption-plan Phases 3–4 checklists; numbers in `docs/EVAL-BASELINE.md`.

### Phase G — Channels with human-in-the-loop: Web (BFF), Teams, SMS

**Satisfies:** FR-4, FR-5; CR-13, CR-14, CR-8 (channel auth), CR-1 (SMS restriction).

- Execute **adoption-plan Phase 6** (web client via **BFF** — no browser token, server-computed
  `sourceIds`) and **Phase 7** (Teams via Entra SSO + scoped principal; SMS allow-list + Twilio Verify +
  non-confidential sources only).
- **Human-in-the-loop (CR-13/14) — add to all channels:** a **non-dismissible disclaimer** on every
  AI answer ("AI-generated; not reviewed by a licensed tax professional"); a **review queue** so no
  output touching a tax position reaches a client or a filing without a logged "reviewed by [CPA]"
  record; outputs labeled "Draft — requires practitioner review"; **no direct client→AI response path.**
- **Acceptance:** adoption-plan Phases 6–7 checklists, plus:
  - [ ] Disclaimer present and non-dismissible on every channel (UI/bot/SMS test).
  - [ ] An answer touching a tax position is held in the review queue until a CPA approves (workflow test).
  - [ ] SMS principal cannot retrieve any client-engagement source (test returns nothing).
  - [ ] No browser/Teams/SMS path supplies its own `sourceIds`; scope is server-computed.
- **Anti-patterns:** ❌ client-confidential data over SMS; ❌ direct client-to-AI advice; ❌ admin token in a channel; ❌ multi-tenant Teams bot registration (deprecated 2025-07-31).

### Phase H — Compliance gate: §7216 sign-off, WISP, retention/purge, breach runbook, vendor register

**Satisfies:** CR-2, CR-9, CR-11, CR-12, CR-15, CR-16, CR-17, CR-18, CR-19, CR-20. **Hard gate: no real
client data before this passes.** Extends **adoption-plan Phase 8**.

- **§7216 sign-off (CR-1/2/3/4) [COUNSEL]:** confirmed embedding self-host + generation DPA; vendor
  written §7216 notice on file; config refuses "client-data mode" if any vendor ack/DPA missing.
- **WISP (CR-12):** RAG system + components + vendors named in the firm's WISP (Pub 5708 template);
  name the **Qualified Individual** (CR-11) as security-alert recipient + change approver.
- **Retention + purge (CR-18/19):** `retain_until` per document type/filing date; scheduled pg-boss job
  **hard-deletes source chunks AND their embedding vectors**; `DELETE /sources/:id` + `purgeSource`;
  `purgeByPrincipal` for transcripts; purge events logged; backups on a retention schedule with
  documented secure-disposal.
- **Breach runbook (CR-16/17):** detection alerts → QI paged; 30-day FTC clock tracker + portal; state
  matrix; **IRS Stakeholder Liaison** parallel step; annual tabletop.
- **Vendor register (CR-9) + staff AI-limitations training (CR-15); backup restore drill (CR-20).**
- **Acceptance:**
  - [ ] Config cannot enter client-data mode without DPA + §7216 ack present (test).
  - [ ] `purgeByPrincipal`/`purgeSource` removes source chunks **and** pgvector rows; verified by spot-audit.
  - [ ] WISP names the system + QI; breach tabletop completed; vendor register populated; restore drill logged.
- **Anti-patterns:** ❌ ingesting client data before this gate; ❌ soft-delete only for purge; ❌ relying on the auxiliary-services exception without a legal opinion.

### Phase I — Operator UX

**Satisfies:** FR-7. Execute **adoption-plan Phase 8 OPT-E** (config validation + "test connection",
ingestion status view, per-source credentials for multiple client tenants). **Acceptance:** operator
adds a source + runs a sync + sees status without editing JSON.

### Phase J — Decommission `cpa-backend` + final verification

Execute **adoption-plan Phase 9**, plus the full-compliance final check below.

---

## 5. Final verification (functional + compliance acceptance)

- [ ] `pnpm typecheck && pnpm test && pnpm eval` green; eval meets the Phase F bar.
- [ ] **TRI-egress-zero:** automated test proves embeddings run locally and no external call carries TRI (CR-1).
- [ ] `grep -rn "enforcedSourceIds" apps/api apps/mcp` — ACL on every retrieval path; empty scope = deny (CR-5).
- [ ] Encryption at rest + TLS 1.2+ verified; MFA on every human entry (CR-6/7/8).
- [ ] Every answer carries a non-dismissible disclaimer; tax-position outputs gated by CPA review (CR-13/14).
- [ ] `purgeByPrincipal` removes chunks + vectors; retention job runs; audit logs land off-host (CR-18/10).
- [ ] WISP names the system + QI; breach runbook + tabletop done; vendor register + DPAs on file (CR-12/11/16/9).
- [ ] End-to-end: ingest SharePoint → ask via web, Teams, SMS → grounded, cited, ACL-scoped answers
      (SMS only on non-confidential sources); no process depends on `cpa-backend`.
- [ ] **[COUNSEL]** sign-offs recorded: §7216 path, vendor DPA sufficiency, applicable state laws.

---

## 6. Critical path & sequencing

```
A (self-host embeddings + egress) ─┐
B (ACL + identity→scope) ──────────┼─▶ gate real data
C (latent breakage) ───────────────┤
D (encryption + TLS + MFA) ────────┘
        │
E (sessions + audit) ──▶ G (channels: BFF web, Teams, SMS + human-in-loop)
        │                         ▲
F (eval + rerank) ────────────────┘
        │
H (compliance gate: §7216 sign-off, WISP, retention/purge, breach) ──▶ FIRST REAL CLIENT DATA
        │
I (operator UX) ──▶ J (decommission + final verification)
```

**A, B, C, D are prerequisites for everything and for any real client data. H is the hard go/no-go gate
before client engagement data enters the system. Phases E/F and G/I can overlap once A–D land.**

> Estimating: this is a multi-month build for one or two engineers (the bulk is A, B, D, E, G, H). Do
> not commit to a date until Phase A (local embeddings) is spiked — it is the least-proven piece and the
> one that unblocks compliant ingestion.
