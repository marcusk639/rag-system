# Scope Conformance — live system vs. the §7216/Circular 230/GLBA scope contract

**Prepared:** 2026-09-30 · **Purpose:** close P0 gate #2 (counsel + carrier sign-off)
**Contract under review:** `~/dev/cpa-consulting/docs/rag/compliance-scope.md`
**System under review:** `rag-system` @ `6dc0d70`, live pilot on Railway

> **What this document is.** An engineering conformance record: every rule in the
> scope contract, checked against the running system, with a file/line or measured
> value for each. It exists so counsel spends their hour on legal judgment rather
> than on reverse-engineering an architecture.
>
> **What it is not.** Legal advice, and not a self-certification. Where the system
> diverges from the contract, this document says so plainly. Several rows are
> **UNVERIFIED** — those are stated as unverified rather than assumed compliant,
> because a wrong "compliant" here is worse than an honest gap.

---

## Amended 2026-10-02

Two items changed after this record was first written. Superseded text is kept
rather than replaced, per `docs/compliance/README.md` — a reader of the original
must be able to see what moved.

> **Convention note.** That README says to supersede by adding a newer dated
> file rather than editing an old one. This record has not yet been issued to
> counsel, and duplicating 185 lines to change four rows would serve a reader
> worse than a marked amendment, so it is amended in place. Once issued, the
> add-a-new-file rule applies.

| §     | Was                                                                                 | Now                                                                        |
| ----- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0.2   | "The backup layer that actually runs nightly is unencrypted" — stated as a flat gap | **Overstated.** It is a documented, reasoned deferral. See 0.2 below.      |
| 0.4   | "Access control is not enforced at the API"                                         | **Remediated 2026-10-02.** See 0.4 below.                                  |
| 3.3.1 | DIVERGENT                                                                           | **COMPLIANT** (scope assertions now verified)                              |
| 3.3.2 | DIVERGENT                                                                           | **PARTIAL** (least-privilege enforced; role model and S-5 still divergent) |

---

## 0. Read first — the items that should not wait for the matrix

**0.1 A prior disclosure event reached the vendor.** `docs/compliance/vendor-dpa-google-gemini.md`
records that a 2026-07-04 ingest of 844 documents, which a 2026-08-01 screen later
found to contain **522 SSN-shaped and 518 EIN-shaped values**, was processed by the
Gemini API before the corpus was destroyed on 2026-08-03 (`docs/PURGE-RECORD-2026-08-03.md`).
This predates the TRI scanner gate now in place. It is a historical exposure, not a
current one, and counsel needs it before assessing anything else. _(Cited from the DPA
doc; `PURGE-RECORD` not independently re-read for this pack.)_

**0.2 The nightly backup is unencrypted — deliberately, with a stated reason.**

~~Originally recorded here as a flat gap. That was an overstatement and is corrected.~~

`docs/BACKUP-SCHEDULE-RUNBOOK.md:69` confirms `AGE_RECIPIENT` is unset and the job
warns every run. But `:70-75` gives the reasoning, and it holds: the bucket already
holds the KB's original documents under the same credentials, so the marginal new
exposure is the `audit_log` alone — and "encryption without a firm-controlled home
for the private key trades a disclosure risk for a **total-loss risk**, and a key on
a workstation is not a key that survives the disaster it guards against." The runbook
defers encryption to the SharePoint cutover, when a real key home exists.

Counsel should weigh it as a **considered trade**, not an oversight. Setting
`AGE_RECIPIENT` today would make the one layer that survives a volume wipe less
recoverable in exchange for a greener checkbox.

Still genuinely open, and separate from encryption: no backup layer's retention
window meets a multi-year tax-record expectation (`:488-491`; pgBackRest keeps
"4 fulls, 14 diffs" at `:87`). `:474-491` routes that to counsel as P2 #8.

**0.3 The hosting principal is unconfirmed.** The contract requires self-hosting **or**
"a single-tenant deployment with the firm as the named principal." The deployment is
Railway. Whether the Railway account's named principal is the firm or an individual is
an account/invoice fact outside this codebase and **must be confirmed directly.** If it
is an individual, the contract's hosting condition is not met as written.

**0.4 Access control — was NOT enforced at the API; remediated 2026-10-02.**

**As originally found (2026-10-01).** Three settings compounded so that §3.3.1 and
§3.3.2 were not enforced at the API layer, while the service booted clean and logged
nothing about it:

- `API_ENFORCE_SCOPING` unset → `false`, so a plain `API_TOKENS` bearer resolved to
  all-corpus admin. `env.example:178-183`: _"Default false keeps API_TOKENS=admin …
  Recommended: set true in production."_
- `AUTH_PROVIDER=composite` with `OIDC_ISSUER`/`OIDC_AUDIENCE` both unset.
- **A variable-name mismatch disabled BFF scope verification entirely.**
  `packages/core/src/config.ts:683` reads `INTERNAL_SCOPE_JWT_SECRETS` (plural); the
  value set on `rag-api` was `INTERNAL_SCOPE_JWT_SECRET` (**singular**), a name read
  only by `apps/web`. `auth-provider-factory.ts:76-84` adds the scope verifier only
  when that list is non-empty, so it was skipped. The web BFF's per-user assertions
  could not be verified.

**What changed (2026-10-02).**

1. `INTERNAL_SCOPE_JWT_SECRETS` set on `rag-api` to the same key the BFF signs with,
   confirmed by comparing SHA-256 digests without exposing either value.
2. `API_ENFORCE_SCOPING=true` on `rag-api` and `rag-mcp`. The precondition
   `env.example` names was already satisfied: both carry three scoped principals with
   explicit `allowedSourceIds` plus one `isAdmin` principal.
3. `packages/runtime/src/index.ts` now logs the verifiers the chain actually built and
   warns when `composite` collapses to static-token only (PR #75, three tests).

**Verified from the live startup log, not inferred:**

```
auth chain built  provider="composite"  verifiers=["static-token","internal-scope"]  enforceScoping=true
```

A leaked plain token now authenticates and resolves to **deny-all** rather than admin,
and per-user scope assertions are verified for the first time.

**Still true and still divergent.** `rag-mcp` runs `verifiers=["static-token"]` — the
agent-facing surface is static-token-plus-principals by design, and the new warning
says so on every boot. OIDC remains unconfigured at both services: web and teams-bot
authenticate with signed scope assertions (`apps/teams-bot/src/rag-client.ts:119`),
not OIDC, so the API verifies no Entra token directly. The role model in §3.3.2 is
still per-user source grants rather than roles, and finding S-5 (SharePoint
per-document permissions not enforced) is unchanged.

**Operational consequence.** `scripts/check-kb-grounding.mjs` and `pnpm eval:gold`
must now present the `isAdmin` principal's token. The former plain token will
authenticate and return nothing, which reads as an empty knowledge base rather than
as an authorization failure.

**0.5 The generation model is a floating alias.** Production runs
`GENERATION_MODEL=gemini-flash-latest`, not the `gemini-2.5-flash` recorded in
`vendor-dpa-google-gemini.md` and the pilot docs. A `-latest` alias can change
model version without a deploy, which is awkward for a posture assessed against a
specific model.

**0.6 The contract claims PII detection the system does not perform.** §3.2.3 says
automated detection covers "names, EINs, SSNs, addresses." The implemented scanner set
is `ssn`, `ssn-unformatted`, `ein`, `routing` (ABA checksum), `card` (Luhn), plus
contextual `1099+amount` / `W2+amount`. **There is no name detection and no address
detection.** Counsel should not sign the sentence as written; it needs narrowing to
"structured-identifier detection" before it is accurate.

---

## 1. The three questions for counsel

Per `docs/PILOT-MANUAL-RUNBOOK.md` §2, the sign-off needs written answers to:

1. Is the standard, non-negotiated Google Cloud DPA adequate for processing
   firm-internal SOPs through the Gemini API, given this practice's §7216 / Circular 230
   / GLBA profile? (Vendor position: §3 below.)
2. Does anything in the architecture below need to change to be defensible?
3. Sign-off (or refusal) **in writing** — email or memo, not a phone call.

Carrier notification is a separate track and is not addressed by this document.

---

## 2. Conformance matrix

| §      | Contract rule                                                                        | Status                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2      | Phase 1 operates on Class A + B only                                                 | **PARTIAL**                                                                   | Gate is fail-closed (`pipeline.ts:354-361`, undeclared source → `"D"` → `ClassBlockedError`). But the DB enum collapses C and D into `client_confidential` (`schema.ts:52-58`), mapped to the stricter `"D"` (`classify-source.ts`). C is not a distinct reachable state.                                                                                                                                                                                                                         |
| 3.1    | Named indexes `firm-sop` / `firm-research` / `karbon-templates` with per-role access | **DIVERGENT**                                                                 | Not implemented. Live pilot is **1 source, 47 docs, 47/47 Class A** (`PILOT-LAUNCH-STATUS.md:9-22`). The taxonomy is a naming target, not a structural distinction.                                                                                                                                                                                                                                                                                                                               |
| 3.2.1  | Classification tag set at the connector layer; pipeline refuses unclassified         | **DIVERGENT (mechanism) / COMPLIANT (effect)**                                | Set at the _source_ layer (`schema.ts:98`) plus content-derived escalation (`classify-document.ts:73-111`), not per-connector. Unclassified is refused. Effect is stricter than the contract; mechanism differs.                                                                                                                                                                                                                                                                                  |
| 3.2.2  | No cross-class mixing; `sourceIds` filter on `hybridSearch`                          | **COMPLIANT**                                                                 | `enforcedSourceIds` is a **required** field (`hybrid-search.ts:59`). Empty array short-circuits to zero rows **before touching the DB** (`:94-96`). Non-empty is ANDed as parameterised `doc.source_id IN (...)` (`:133-139`). `null` (unrestricted) only via explicit `isAdmin` grant (`access-control.ts:77-82`).                                                                                                                                                                               |
| 3.2.3  | De-identification: names, EINs, SSNs, addresses                                      | **DIVERGENT**                                                                 | Structured identifiers only — see §0.4. Titles _are_ now a redacted surface (`content-safety.ts:424`, PR #71), but a client **name** in a title still passes because names are not a detected pattern.                                                                                                                                                                                                                                                                                            |
| 3.2.4  | Per-tenant crypto separation for future Class C                                      | **NOT-YET-REQUIRED**                                                          | Class C not in scope for Phase 1 and not reachable (see §2 row).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3.3.1  | Every query authenticated to a named user; SSO via firm IdP                          | **COMPLIANT** (was PARTIAL/UNVERIFIED, then DIVERGENT; remediated 2026-10-02) | Entra SSO gates the web app; the BFF mints a per-request scope assertion bound to the user's Entra `oid`, and the API now verifies it — live startup log reads `verifiers=["static-token","internal-scope"] enforceScoping=true`. Plain tokens no longer grant admin. OIDC still not configured at the API; see §0.4.                                                                                                                                                                             |
| 3.3.2  | Role determines queryable indexes                                                    | **PARTIAL** (was DIVERGENT; least privilege enforced 2026-10-02)              | `API_ENFORCE_SCOPING=true` with three scoped principals carrying explicit `allowedSourceIds`, so least privilege is enforced. But the contract's **role** model still does not exist — access is per-user source grants (`resolveSourceIdsForUser`) — and gating is at whole-source granularity, so SharePoint's own per-document ACLs are still not enforced (finding S-5).                                                                                                                      |
| 4      | Numbered citations; recency caption; class label                                     | **PARTIAL**                                                                   | Citations built server-side from the scope-enforced result set, never trusted from model output (`ask.ts`, `prompt-context.ts`); measured **0 invalid citations across 33 answers** (`corpus-analysis/kb-grounding-report.json`, 2026-09-07). **Recency caption and A/B class label not located — UNVERIFIED.**                                                                                                                                                                                   |
| 5      | Audit log incl. verbatim `query_text` and `answer_text`; 3-year retention            | **DIVERGENT**                                                                 | Stores `questionHash` (SHA-256), **not** verbatim query text; there is **no `answer_text` column** (`schema.ts:345-404`, `logAskEvent`). Cuts both ways: weaker Circular 230 §10.22/§10.35 reconstruction, but no §7216-sensitive text retained. No retention policy exists; `BACKUP-SCHEDULE-RUNBOOK.md:474-491` states retention is an open counsel question. Shipper: `AUDIT_SINK_PROVIDER` **verified unset in production 2026-10-01** → `none` → audit rows never leave firm infrastructure. |
| 6.1a   | Self-hosted or single-tenant with firm as named principal                            | **UNVERIFIED**                                                                | See §0.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6.1b/c | Embedding + generation models under no-train terms                                   | **PARTIAL**                                                                   | `gemini-embedding-001` and `gemini-2.5-flash`, same service. Billing verified 2026-08-04 → Cloud DPA applies → **no-train and zero-retention in force.**                                                                                                                                                                                                                                                                                                                                          |
| 6.1d   | No training on inputs                                                                | **PARTIAL**                                                                   | Status line verbatim: **"BILLING VERIFIED 2026-08-04 — COUNSEL REVIEW STILL OUTSTANDING."** Outstanding per that doc: "CR-3 data residency (still unverified)" and "[COUNSEL] adequacy of the standard, non-negotiated Cloud DPA … (never reviewed)".                                                                                                                                                                                                                                             |
| 6.1e   | TLS 1.2+ in transit                                                                  | **PARTIAL**                                                                   | Postgres runs `sslmode=no-verify` — **encrypted but certificate not verified** — because Railway's image serves a self-signed cert (`env.example:43-58`). Parser `PARSER_SECRET` **is set and enforced** in the pilot (`PHASE-2-RAILWAY-RUNBOOK.md:17,38`).                                                                                                                                                                                                                                       |
| 6.1f   | AES-256 at rest on the Postgres volume                                               | **UNVERIFIED**                                                                | No at-rest claim in-repo for the live Railway volume. The only such guidance covers the **superseded** single-VM path. Depends on Railway's platform guarantee.                                                                                                                                                                                                                                                                                                                                   |
| 6.1g   | Daily, encrypted backups; retention matching audit policy                            | **DIVERGENT**                                                                 | See §0.2. Restore mechanism **is** proven, including `audit_log` row verification (`BACKUP-RESTORE-DRILL.md:5`).                                                                                                                                                                                                                                                                                                                                                                                  |
| 7      | Out-of-scope items not built                                                         | **MOSTLY COMPLIANT**                                                          | Class C/D blocked fail-closed at ingest (`pipeline.ts:90-91,192,359-360`). Staff-facing only, Entra-gated. No fine-tuning. Karbon per-client consent **not traced this pass**; external reachability of `rag-web`/`rag-api` outside the firm tenant **unverified**.                                                                                                                                                                                                                               |

---

## 3. §7216 query gating — what changed, precisely

Production sets `GENERATION_TRI_POLICY=warn` (2026-09-07); the shipped default is
`block` (`env.example:464`). This is the change most likely to be misread, so state it
exactly:

- **Identifying patterns (SSN/EIN, formatted or not) throw regardless of policy.**
  `generator.ts:193` — `if (triPolicy === "block" || identifying.length > 0)` → `ComplianceError`.
- Only **contextual** patterns (a form mention near a dollar figure) become advisory.
- `warn` still emits an audit signal; the code comment: "a permissive policy must still
  be observable."
- TRI-bearing context chunks are **dropped** before the model sees them (`screened.dropped`).
- `COMPLIANCE_MODE=client-data` forces `block` regardless.

**Why it was changed, measured:** a 36.8% contextual false-positive rate on an
all-Class-A SOP corpus. Before/after on the same instrument (51 questions):
answered **33 → 51**, blocked by guard **18 → 0**, refusal on out-of-corpus **3/3 → 4/4**,
invalid citations **0 → 0**. Coverage rose without buying confabulation.

Only three documents (6% of the corpus) carried a trigger and caused ~36% of failures.

---

## 4. What would settle each UNVERIFIED row

| Row                       | Settled by                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| ~~3.3.1 production auth~~ | **SETTLED 2026-10-01, REMEDIATED 2026-10-02** — see §0.4             |
| ~~5 audit shipper~~       | **SETTLED 2026-10-01** — `AUDIT_SINK_PROVIDER` unset → nothing ships |
| 6.1a hosting principal    | Railway account/invoice — who is the named account holder            |
| 6.1f encryption at rest   | Railway's written platform guarantee for volume encryption           |
| 4 recency/class rendering | read the `/ask` response schema and `apps/web` render path           |
| 7 external reachability   | Entra app registration allowed tenant/audience                       |

---

## 5. Changes since the Aug 31 counsel packet

- §7216 guard moved `block` → `warn` in production (2026-09-07) — §3 above.
- Gemini billing tier verified (2026-08-04) → no-train + zero-retention now in force;
  the DPA doc's status line no longer reads "PROVISIONAL — NOT COUNSEL-CONFIRMED".
  `PILOT-LAUNCH-STATUS.md:215` and `PILOT-MANUAL-RUNBOOK.md:45,55` still quote the retired line.
- Corpus rebuilt: 858 → **47 documents**, all Class A, all TRI-screened.
- Conversation history now sent to the model for follow-up rewriting (PR #71) — a new
  data flow not described in the Aug 31 packet.
- Titles became a redacted surface (PR #71).

---

## 6. Production configuration, verified 2026-10-01

`railway variables --service rag-api`, non-secret flags only:

| Key                                      | Value                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `API_ENFORCE_SCOPING`                    | ~~not set, `false`~~ then **`true`** on `rag-api` and `rag-mcp` (2026-10-02)                                     |
| `AUTH_PROVIDER`                          | `composite`                                                                                                      |
| `AUDIT_SINK_PROVIDER`                    | not set → `none`                                                                                                 |
| `GENERATION_TRI_POLICY`                  | `warn`                                                                                                           |
| `COMPLIANCE_MODE`                        | `none` — so the boot-time DPA check (`config.ts:778-782`) does not fire, and TRI policy is not forced to `block` |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | `gemini` / `gemini-embedding-001`                                                                                |
| `GENERATION_MODEL`                       | `gemini-flash-latest`                                                                                            |
| `EGRESS_ALLOWED_HOSTS`                   | `generativelanguage.googleapis.com`                                                                              |

Presence only, values never read: `API_TOKENS` set · `GEMINI_API_KEY` set ·
`PARSER_SECRET` set · `INTERNAL_SCOPE_JWT_SECRETS` ~~unset~~ → **set on `rag-api`** (2026-10-02; still unset on `rag-mcp`, which needs no scope verifier) ·
`OIDC_ISSUER` **unset** · `OIDC_AUDIENCE` **unset**.
