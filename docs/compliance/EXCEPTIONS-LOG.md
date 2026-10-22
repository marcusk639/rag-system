---
title: Compliance exceptions log
status: living-tracker
last_verified: 2026-10-21
verified_against: db0ceae
answers: Every recorded departure from a stated compliance control, gate or operating rule, who authorised it, why, and whether it is still in effect.
read_when: Assessing what has actually reached a vendor or left the firm's infrastructure, preparing a counsel packet, or before relaxing another control.
supersedes: [PLAN-CPA-COMPLIANCE.md Phase 1 status update (2026-07-04)]
code: [packages/runtime/src/index.ts, packages/core/src/config.ts]
---

# Compliance exceptions log

This log records each time production departed from a stated compliance control, gate or operating rule. Entries are
dated, in date order, and never rewritten. A later development is added under the entry as a dated follow-up. Quoted
text is verbatim from the source named, including paths and status words that have since changed. **Two entries are
still in effect:** the 2026-07-04 decision to run `COMPLIANCE_MODE=none`, and the 2026-09-07
`GENERATION_TRI_POLICY=warn` decision. Current values live in [CONTROL-STATUS.md](CONTROL-STATUS.md).

Add an entry before, or at the time of, the departure. Give the date, who authorised it, the control departed from,
the scope, the reason, how to revert it, and the follow-ups it creates.

| Date       | Exception                                                                     | In effect                      |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------ |
| 2026-07-04 | Egress enabled before DPA verification; `COMPLIANCE_MODE` left at `none`      | `none` still in effect         |
| 2026-07-04 | The Phase A gate (no firm documents before client-data mode) was not followed | Consequences open with counsel |
| 2026-09-07 | `GENERATION_TRI_POLICY=warn` in production                                    | Yes                            |
| 2026-10-02 | Access control found unenforced at the API; remediated the same day           | Remediated                     |
| 2026-10-02 | Restore drill copied an unencrypted production dump to a workstation          | One-off; artifact destroyed    |

## 2026-07-04: egress enabled before DPA verification, COMPLIANCE_MODE left at none

- **Authorised by:** the user (owner), explicitly, as recorded at the time.
- **Control departed from:** "Do NOT set `EGRESS_ALLOWED_HOSTS` in production before the DPA is actually confirmed"
  (the plan's Phase 1 anti-pattern guard), and the plan to run real firm documents only under
  `COMPLIANCE_MODE=client-data`.
- **Scope as stated:** an internal demonstration for primary stakeholders already authorised to view all data.

Recorded verbatim in the Phase 1 status update of
[`archive/plans/PLAN-CPA-COMPLIANCE.md`](../archive/plans/PLAN-CPA-COMPLIANCE.md):

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

And from the same plan's anti-pattern guards:

> **Exception
> on record for 2026-07-04:** enabled ahead of confirmation under explicit user authorization,
> scoped to internal-stakeholder demo use only — see the status update above. This guard still
> applies to any further widening of access (new users, external clients, production-for-real use).

**Follow-ups.**

- 2026-08-04: Cloud Billing on the backing project was verified as active (Tier 1, prepay). The Cloud DPA therefore
  applied to the July traffic, and free-tier terms did not
  ([vendor-dpa-google-gemini.md](vendor-dpa-google-gemini.md)).
- 2026-10-01: production still ran `COMPLIANCE_MODE=none` with Gemini embeddings
  ([scope-conformance-2026-09-30.md](scope-conformance-2026-09-30.md) §6). The local-embedding switch (Phase 1.1)
  hasn't happened, and the DPA hasn't had counsel review. That review was the plan's precondition for re-enabling
  client-data mode. The protections in place since then are listed in [CONTROL-STATUS.md](CONTROL-STATUS.md).
- The guard above still applies to any widening of access. Gate 1 approved the rebuilt corpus for staff use on
  2026-10-02, and production carries three scoped principals, but no exception records a widening beyond the
  demo audience. UNVERIFIED: whether anyone other than the operator has queried production since; settle from
  `audit_log` principals.

## 2026-07-04: the Phase A gate was not followed

- **Control departed from:** the gate in the Phase A completion record (2026-06-27) of
  [`archive/plans/2026-06-26-phase-a-7216-architecture.md`](../archive/plans/2026-06-26-phase-a-7216-architecture.md):

> **Phase A technical gate: GREEN.** Firm documents may not enter the pipeline until the Sept build window when:
>
> 1. A real signed DPA is filed as `docs/compliance/vendor-dpa-<vendor>.md`
> 2. `COMPLIANCE_MODE=client-data` is set in the production `.env`
> 3. **[COUNSEL]** confirms §7216 + GLBA adequacy

- **What happened:** on 2026-07-04 the system ingested the firm's SharePoint knowledge base under
  `COMPLIANCE_MODE=none`, with Gemini embeddings. None of the three conditions held: the DPA file was provisional,
  client-data mode was off, and counsel had not reviewed anything. Unlike the egress entry above, no record shows
  this gate being consciously set aside.
- **Consequence:** the [DPA record](vendor-dpa-google-gemini.md) counts 844 documents ingested that day (49 flagged
  for TRI) and three `/ask` calls, all by the operator. A screen on 2026-08-01 found client-identifying material in
  the corpus, including one spreadsheet with 522 SSN-shaped and 518 EIN-shaped values. Embedding sends the text to
  the vendor, so this was a disclosure event. The July `audit_log` rows have no embedding provider or model, because
  those columns were added on 2026-07-09, so no audit row records which embedder touched the corpus.
- **Follow-ups.** The whole index was purged on 2026-08-03
  ([records/PURGE-RECORD-2026-08-03.md](records/PURGE-RECORD-2026-08-03.md)). That stops further exposure but does not
  reach the July disclosure. The content-safety layers in [CONTENT-SAFETY-DESIGN.md](CONTENT-SAFETY-DESIGN.md) were
  built in response, and the corpus was rebuilt as 47 screened, Class A documents. **Whether the disclosure is
  reportable is an open counsel question**, and no document records an answer
  ([CONTROL-STATUS.md](CONTROL-STATUS.md#open-legal-and-process-items)).

## 2026-09-07: GENERATION_TRI_POLICY=warn in production

- **Authorised by:** the operator, on 2026-09-07, as a §7216 disclosure decision.
- **Control departed from:** the code default `block` (`packages/core/src/config-schema.ts` `triPolicy`), which is
  deliberate so that "the permissive setting must be chosen by a human rather than 'inherited by saying nothing'".
- **Scope:** `rag-api` and `rag-mcp`. Identifying patterns (SSN, unformatted SSN, EIN) still throw under any policy
  (`packages/rag/src/generation/generator.ts` `runPreFlight`). Only contextual patterns, such as a form number near
  a dollar figure, become advisory, and each hit is still logged (`generation.tri.warned`). TRI-bearing context
  chunks are still dropped before the model sees them.
- **Revert:** set `GENERATION_TRI_POLICY=block`, or unset it. `COMPLIANCE_MODE=client-data` forces `block` regardless
  (`packages/runtime/src/index.ts` `resolveTriPolicy`).

From the P0 gate 0 record in `launch/LAUNCH-STATUS.md` (as of commit `db0ceae`), verbatim:

> Measured before and after with the same instrument
> (`scripts/check-kb-grounding.mjs`, 51 questions, 0 errors both runs):
>
> - Answered: **33/51 → 51/51**
> - Blocked by the guard: **18 → 0**
> - Self-retrieval: 29/30 (96.7%) → **43/47 (91.5%)**
> - Refusal on out-of-corpus: 3/3 → **4/4**
> - Invalid citations: 0 → 0

> **What `warn` does not weaken.** `896170e` (2026-08-03) split TRI policy by
> pattern class for exactly this case. Identifying patterns (SSN / unformatted
> SSN / EIN) **throw regardless of policy** and are untouched; that class was
> tightened again afterwards by `19a7542`. A sweep of all 17 blocked documents
> found **0 containing an identifying pattern**. `warn` also fires
> `onTriDetected`, so every contextual hit is audited rather than silently
> allowed — verified live:
> `marker="generation.tri.warned" triPatterns=["1099+amount"]`.
>
> ⚠ **Scope of that evidence:** the sweep scanned stored (post-redaction)
> markdown — exactly the text the retriever chunks and the guard scans. It says
> what can reach the model, not what is in the original SharePoint files.
>
> **This is a §7216 disclosure decision**, made by the operator on 2026-09-07 —
> which is what the `block` default exists to force. To revert: set
> `GENERATION_TRI_POLICY=block` (or unset it). `COMPLIANCE_MODE=client-data`
> overrides it to `block` upstream regardless.

The same record found that three documents (6% of the corpus) carried a contextual trigger and caused about 36% of
questions to fail, because the guard scans the whole assembled prompt, including every retrieved chunk. The scanned
corpus had a 36.8% contextual false-positive rate ([scope-conformance-2026-09-30.md](scope-conformance-2026-09-30.md)
§3).

## 2026-10-02: access control found unenforced at the API, remediated the same day

- **Control departed from:** CR-5 least privilege, and scope-contract §3.3.1–3.3.2 (every query authenticated to a
  named user; role determines what can be queried).
- **Found:** 2026-10-01, while preparing the scope-conformance record. Nobody had authorised it; three settings
  compounded, and the service booted cleanly without logging any of it.
- **Remediated:** 2026-10-02, by the operator.

From [scope-conformance-2026-09-30.md](scope-conformance-2026-09-30.md) §0.4, verbatim:

> - `API_ENFORCE_SCOPING` unset → `false`, so a plain `API_TOKENS` bearer resolved to
>   all-corpus admin. `env.example:178-183`: _"Default false keeps API_TOKENS=admin …
>   Recommended: set true in production."_
> - `AUTH_PROVIDER=composite` with `OIDC_ISSUER`/`OIDC_AUDIENCE` both unset.
> - **A variable-name mismatch disabled BFF scope verification entirely.**
>   `packages/core/src/config.ts:683` reads `INTERNAL_SCOPE_JWT_SECRETS` (plural); the
>   value set on `rag-api` was `INTERNAL_SCOPE_JWT_SECRET` (**singular**), a name read
>   only by `apps/web`. `auth-provider-factory.ts:76-84` adds the scope verifier only
>   when that list is non-empty, so it was skipped. The web BFF's per-user assertions
>   could not be verified.

> 1. `INTERNAL_SCOPE_JWT_SECRETS` set on `rag-api` to the same key the BFF signs with,
>    confirmed by comparing SHA-256 digests without exposing either value.
> 2. `API_ENFORCE_SCOPING=true` on `rag-api` and `rag-mcp`. The precondition
>    `env.example` names was already satisfied: both carry three scoped principals with
>    explicit `allowedSourceIds` plus one `isAdmin` principal.
> 3. `packages/runtime/src/index.ts` now logs the verifiers the chain actually built and
>    warns when `composite` collapses to static-token only (PR #75, three tests).

> ```
> auth chain built  provider="composite"  verifiers=["static-token","internal-scope"]  enforceScoping=true
> ```

**Still open after the remediation:** `rag-mcp` is static-token only by design, OIDC is unset at both services,
access is per-user source grants rather than roles, and SharePoint per-document ACLs aren't enforced (finding S-5).
`scripts/check-kb-grounding.mjs` and `pnpm eval:gold` must now present the `isAdmin` principal's token; a plain token
returns nothing, which looks like an empty knowledge base. Before 2026-10-02, any holder of a plain API token could
query the whole corpus. The record states that `audit_log` shows no user other than the operator ever queried the
system ([GATE-1-CONTENT-AUDIT.md](GATE-1-CONTENT-AUDIT.md) §6, asserted rather than re-verified).

## 2026-10-02: restore drill copied an unencrypted production dump to a workstation

- **Rule departed from:** the restore-drill guidance that predates this drill
  ([`archive/history/BACKUP-RESTORE-DRILL.md`](../archive/history/BACKUP-RESTORE-DRILL.md)), verbatim:

> - **Keep production data inside Railway.** The production leg streams
>   `pg_dump | psql` over `railway ssh` — never to disk, never to a laptop. The KB is
>   Class A/B and POL-01 is still unadopted; a dump file in `~/Downloads` is a
>   compliance problem the drill has no reason to create.

- **What happened**, from the evidence appendix of
  [BACKUP-AND-RECOVERY.md](../operations/BACKUP-AND-RECOVERY.md#evidence), verbatim:

> **2026-10-02, restore of a scheduled artifact.** Artifact `backups/kb-2026-10-01T080156Z.sql.gz` (1.2 MiB), written
> by the cron with no human involvement; 31 artifacts were present, daily and unbroken from 2026-09-01 to 2026-10-01.
> It was downloaded with the service's own credentials and restored into a throwaway `pgvector/pgvector:pg16` container
> on port 55433 under `ON_ERROR_STOP=1`. Then the container and the artifact were destroyed; production was never
> written to.

> The unencrypted artifact existed on a workstation only for the drill.

- **What the artifact held:** the full knowledge-base text (47 documents, 210 chunks) and 132 `audit_log` rows, which
  carry staff identities and question hashes. The nightly dumps are unencrypted by a reasoned deferral
  ([BACKUP-AND-RECOVERY.md](../operations/BACKUP-AND-RECOVERY.md#encryption)).
- **Why it was done:** the same restored copy served the Gate 1 content audit, whose procedure says to point the
  worksheet generator at a restored copy rather than production, because the production database is reachable only
  inside Railway ([GATE-1-CONTENT-AUDIT.md](GATE-1-CONTENT-AUDIT.md) §2.1).
- **Authorisation:** none recorded. UNVERIFIED that the artifact was securely deleted rather than just removed;
  the record says only "destroyed".
- **To avoid a repeat:** run drills and audits inside Railway, for example in a throwaway service on the private
  network. The current guidance is in [BACKUP-AND-RECOVERY.md](../operations/BACKUP-AND-RECOVERY.md#what-the-backups-protect).
