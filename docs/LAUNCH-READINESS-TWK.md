# Launch Readiness — TWK CPA Firm

**Date:** 2026-10-08
**Scope of audit:** code-first review of authorization, confidentiality boundaries,
ingestion gating, egress posture, deployment/operability, observability, data
lifecycle, auditability, and admin onboarding. Retrieval-quality and gold-set/eval
work was explicitly out of scope.
**Branch audited:** `fix/gate-citation-source-urls` (3 files uncommitted) against
`main` @ `8784d7a`.

---

## 1. Verdict

**Not yet — but the gap is small and mostly configuration, not construction.** The
confidentiality architecture here is genuinely good: scope is a mandatory positional
argument into retrieval so a route cannot forget it, forbidden documents are
indistinguishable from missing ones on every fetch-by-id surface, the metadata
allowlist is default-deny and closes both carriers of the source URL, and the Teams
channel path uses the member intersection rather than the asker's own grants. What
stands between this and a safe launch is three things: one leak fix that is written
but **still uncommitted**, a set of `env.example` defaults that are correct for dev
and wrong for a firm holding client data (`API_ENFORCE_SCOPING=false` is the
dangerous one — it makes every static token an all-corpus admin), and the absence of
any operational signal that would tell TWK the system has stopped working. Shortest
path to yes: land B1, set the four launch-posture env values in B2/B3 and verify them
from the startup log rather than the dashboard, then put a healthcheck and one
alerting path on the worker. P6 is not a defect but it is the question most likely to
derail the launch socially: as gated today the system **refuses to index
client-engagement material**, so someone must confirm that firm-internal content is
what TWK actually expects to query.

**Blockers: 3. Pre-launch: 7. Post-launch: 3. Accepted: 3.** _(as first written — see
below for the current count)_

> **Revised twice on 2026-10-08. Current state: 1 open blocker.**
>
> - **§1a** (live Railway values read) — B2 resolved, B3 confirmed and narrowed, new
>   blocker B4 found. Net 3.
> - **§1b** (post-merge) — **B1 resolved and deployed** (PR #112, `fe8d999`); **B4 fix
>   deployed but not yet proven**; **B3 is the only blocker still open**, and is a
>   one-variable change. Two new findings added: N1 (`document.title` carries the email
>   subject — latent, gates enabling the email connectors) and N2 (tests are excluded
>   from typecheck repo-wide).

---

## 1a. Revision 2026-10-08 (live Railway values read)

Production variables for `rag-api`, `rag-mcp`, `rag-worker`, and `rag-web`
(`production` environment, project `rag-system`) have now been read. Variable _names_
per service are in the session scratchpad at `railway-var-names.txt`; a full value dump
was deliberately **not** taken — those services hold `DATABASE_URL`, `API_TOKENS`, the
Entra client secret and the JWT secrets, and secrets should not be written to disk to
answer an audit question.

**B2 — RESOLVED, not a blocker.** `rag-api` and `rag-mcp` both have
`API_ENFORCE_SCOPING=true`, `AUTH_PROVIDER=composite`, and a non-empty
`INTERNAL_SCOPE_JWT_SECRETS`. The static-token path is therefore fail-**closed** (a plain
`API_TOKENS` token resolves to deny-all, not admin) and the internal-scope verifier is
present, so the web BFF's per-user assertions are genuinely verified. `API_PRINCIPALS` is
set (527 chars — several entries). Residual item, not a blocker: `rag-web`'s singular
`INTERNAL_SCOPE_JWT_SECRET` must be one of the values in `rag-api`'s plural
`INTERNAL_SCOPE_JWT_SECRETS`. Both are 64 chars, consistent with one shared secret, but I
did not compare values. One successful signed-in web query proves it; a 401 on every web
query is the symptom if they have drifted.

**B3 — CONFIRMED LIVE, and sharper than written below.** `COMPLIANCE_MODE=none`,
`EMBEDDING_PROVIDER=gemini`, `GENERATION_PROVIDER=gemini` (`gemini-flash-latest`), so
document text and questions do reach `generativelanguage.googleapis.com`. The egress
allow-list is correctly minimal rather than the template default: `rag-api` allows only
`generativelanguage.googleapis.com`, `rag-worker` only that plus
`ollama.railway.internal`. **The sharp part:** an `ollama` service is deployed and Online,
`CONTENT_SCAN_BASE_URL=http://ollama.railway.internal:11434/v1` and
`CONTENT_SCAN_MODEL=qwen2.5:3b` are both configured on `rag-worker` — and
`CONTENT_SCAN_PROVIDER=none`. The self-hosted semantic scanner is fully provisioned,
running, and switched off. Layer 1.5 is the only thing that catches a client name in
prose, which pattern redaction structurally cannot see
(`packages/ingestion/src/classify-document.ts:25-27`). The fix is one value:
`CONTENT_SCAN_PROVIDER=ollama`.

**B3 partial correction — `GENERATION_TRI_POLICY=warn` is defensible.** I implied this
was permissive. Reading `packages/core/src/config-schema.ts:338-353` closely, `warn`
proceeds only for _contextual_ matches — **identifying matches still throw**. The schema
comment notes `warn` is the right setting for an internal-SOP corpus because the
contextual patterns false-positive there, which is exactly the Phase 1 corpus (P6). Treat
it as a reasonable explicit decision; just confirm it was one.

**NEW B4 — `rag-mcp` has no `EGRESS_ALLOWED_HOSTS` while using Gemini embeddings
(BLOCKER, probable).** An empty or missing value is **deny-all**, not unrestricted:
`EgressPolicy.fromEnv` filters empty entries and `assertAllowed` throws for any host not
in the set (`packages/core/src/egress-policy.ts:30-38,58-60`). `rag-mcp` runs
`MCP_TRANSPORT=http` with `EMBEDDING_PROVIDER=gemini` and no allow-list, so every query
that embeds should fail with `EGRESS_BLOCKED`. **Confidence: probable, not verified** — I
confirmed the policy semantics and the missing variable, but not that the MCP embedding
path calls `assertAllowed` (it may build the policy from config rather than env).
**What would settle it:** one `search_documents` or `ask` call against the deployed MCP
endpoint, or grepping the `rag-mcp` logs for `EGRESS_BLOCKED`. If it is broken, the MCP
surface has been non-functional in production rather than leaking — a correctness
blocker, not a confidentiality one.

**Also confirmed from the live values:**

- `AUDIT_LOG_CONTENT` is unset on every service, so **P2 is live** — no question/answer
  text is retained.
- `WEB_AUTH_MODE` is unset, so the **P5 static-fallback bypass is not active**.
- `RAG_ADMINS_GROUP_ID` is set on `rag-web`, so the admin gate is functional rather than
  failing closed to "nobody is admin".
- There is **no `rag-teams-bot` service** — the Teams bot is not deployed. That answers
  §4 Q4 and removes the Teams surface from the launch perimeter (B1 still matters for the
  web and MCP citation renderers).
- A `rag-web-test` service exists. Confirm it does not point at the production database.

## 1b. Revision 2 — 2026-10-08, post-merge

**B1 RESOLVED and deployed.** PR #112 merged as `fe8d999` (4 commits); all four CI checks
passed against the exact merged commit. Railway auto-deployed on merge, and `rag-api`
restarted at 21:43 UTC running the gate — verified from its boot log, which also shows
`verifiers=["static-token","internal-scope"] enforceScoping=true`, independently
confirming the B2 resolution in §1a from the authoritative source.

Review of that PR turned up a second, unrelated hole worth recording here, because it is
the same class of defect the audit was looking for: **`sanitizeRetrievalResults` was
deletable from `packages/services/src/ask.ts:449` with ZERO tests failing repo-wide.**
Verified by mutation — with the call removed, `@rag/services` stayed 70/70 and the whole
non-e2e workspace suite stayed green. That gate strips author/from/to/subject/path/extra
from every `/ask` response. The cause was a blank shared fixture
(`ask.test-harness.ts:19-20` sets `url: undefined`, `metadata: {}`), so no test had
anything to strip and `ask.test.ts`'s `toEqual` against the raw array passed for that
reason alone. The drift ran in the dangerous direction: a change to the shared
`isSourceUrlExposable` predicate is caught by two suites, but removing a **call site** was
caught by none. Now covered by a seam test, mutation-verified in both directions.

**B4 — fix deployed, NOT yet proven.** `rag-mcp` restarted on a fresh container at
21:43:55 UTC, so it picked up `EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com`.
The boot log does not print the allow-list, so closing this still needs one real
`search_documents`/`ask` call against the endpoint, or a grep of `rag-mcp` logs for
`EGRESS_BLOCKED` once queries have run through it.

**B3 — STILL OPEN, and now the only remaining blocker.** Setting
`CONTENT_SCAN_PROVIDER=ollama` on `rag-worker` was refused twice by the sandbox
(`[Production Deploy]`, then `[Modify Shared Resources]`), so it has not been applied. It
remains a one-variable change: the ollama service is deployed and Online,
`CONTENT_SCAN_BASE_URL=http://ollama.railway.internal:11434/v1` and
`CONTENT_SCAN_MODEL=qwen2.5:3b` are already set, and `ollama.railway.internal` is already
in the worker's egress allow-list. Read the caveat before applying: it changes ingest
**classification**, not just logging, so documents that newly trip semantic
client-context detection escalate to Class C and are quarantined — the index can shrink
on the next sync. It will not re-screen the existing 47 documents, because an unchanged
content hash short-circuits re-ingest; screening the current corpus is a deliberate
forced re-ingest and should be expected to drop some of the 47.

### New finding — N1: `document.title` is an un-gated second carrier of the email subject (PRE-LAUNCH, latent)

`packages/connectors/src/gmail/index.ts:313-314` sets `title: subject` immediately
followed by `subject` — the identical string in both fields (also `:332`;
`outlook/index.ts:254` and `:275` do the same). `metadata-policy.ts:50` strips `subject`
because an email subject line is "frequently taxpayer-identifying", but `title` is
explicitly allowlisted and flows raw into both `Citation.title` and search results.

This is the **third instance of one pattern**, which is the finding that matters more than
any single instance: `metadata.path` → `document.url` (B1, fixed), `metadata.url` →
`document.url` (fixed earlier), and now `metadata.subject` → `document.title`. Stripping a
field while an identically-valued sibling stays exposed is the recurring shape of
confidentiality bug in this codebase. When auditing a stripping allowlist here, search for
other fields assigned the **same source value** — do not check only the field being
stripped.

**Latent, not live:** the index is 47 documents, all Class A firm-internal SOPs, so no
email connector is contributing content. Treat as a hard gate on enabling the Gmail or
Outlook connector, not on this launch.

### New finding — N2: test files are excluded from typecheck repo-wide (POST-LAUNCH)

Every package tsconfig sets `"exclude": ["**/*.test.ts"]` (e.g.
`packages/services/tsconfig.json`), and vitest strips types rather than checking them. So
a type error inside a test is invisible to `pnpm typecheck` and to CI's `quality` job.
Demonstrated: `ServiceDeps` is referenced 11 times in `packages/services/src/ask.test.ts`
with no import of it anywhere in the file, while typecheck reports Done for that package.

Consequence for this audit: type annotations in tests are documentation, never enforcement.
Any test relying on types for its safety guarantee — fixture builders, `satisfies`,
discriminated unions — is unverified. Not a launch blocker; it does mean CI green is
weaker evidence than it appears.

---

---

## 2. Findings table

| ID  | Title                                                                             | Severity    | Area                | Anchor                                                                        |
| --- | --------------------------------------------------------------------------------- | ----------- | ------------------- | ----------------------------------------------------------------------------- |
| B1  | Citation source-URL class gate is written but uncommitted; leak is live on `main` | BLOCKER     | Confidentiality     | `packages/rag/src/generation/prompt-context.ts:214`                           |
| B2  | `API_ENFORCE_SCOPING=false` default makes every static token an all-corpus admin  | BLOCKER     | Authorization       | `env.example:194`, `packages/core/src/access-control.ts:189-196`              |
| B3  | Shipped egress/compliance defaults send client text to third-party APIs unscanned | BLOCKER     | Egress / compliance | `env.example:400,419,429`, `packages/ingestion/src/classify-document.ts:9-17` |
| P1  | MCP surface writes `principalSubject: null` — no per-user attribution             | PRE-LAUNCH  | Auditability        | `apps/mcp/src/tools/ask.ts:102`                                               |
| P2  | `AUDIT_LOG_CONTENT=none` default retains no question/answer text                  | PRE-LAUNCH  | Auditability        | `env.example:639`, `packages/core/src/config-schema.ts:224`                   |
| P3  | MCP stdio grants `ADMIN_SCOPE` unconditionally                                    | PRE-LAUNCH  | Authorization       | `apps/mcp/src/main.ts:59-67`                                                  |
| P4  | No worker healthcheck, no metrics, no sync-failure surface or alert               | PRE-LAUNCH  | Observability       | `apps/worker/railway.json:7-10`                                               |
| P5  | `WEB_AUTH_MODE=static-fallback` collapses all users to one shared principal       | PRE-LAUNCH  | Authorization       | `apps/web/src/lib/rag-api.ts:70-85`                                           |
| P6  | Class C/D quarantine refuses client-engagement material by design                 | PRE-LAUNCH  | Product scope       | `packages/ingestion/src/classify-document.ts:106-123`                         |
| P7  | Automated PITR restore is broken; only a manual root procedure exists             | PRE-LAUNCH  | Backup / DR         | `CLAUDE.md` Railway-Postgres note, `docs/BACKUP-SCHEDULE-RUNBOOK.md`          |
| L1  | Generation spend is untracked and unbounded per-firm                              | POST-LAUNCH | Cost                | `apps/api/src/routes/ask.ts:184`                                              |
| L2  | `audit_log.channel` is caller-asserted for `api`/`teams`                          | POST-LAUNCH | Auditability        | `apps/api/src/routes/ask.ts:36-50`                                            |
| L3  | `DEPLOYMENT-TARGET.md` states a data-sensitivity posture the code contradicts     | POST-LAUNCH | Docs accuracy       | `docs/DEPLOYMENT-TARGET.md` §Rationale                                        |
| A1  | Railway vs local/CI Postgres image divergence                                     | ACCEPTED    | Deployment          | `CLAUDE.md`                                                                   |
| A2  | `DocumentClass` collapses C and D at the ingest gate                              | ACCEPTED    | Ingestion           | `packages/ingestion/src/classify-document.ts:123`                             |
| A3  | Rate-limit bucket key reads an unverified JWT `sub`                               | ACCEPTED    | Abuse control       | `apps/api/src/server.ts:58-63`                                                |

---

## 3. Findings detail

### B1 — Citation source-URL class gate is written but uncommitted (BLOCKER)

**What is wrong.** `buildCitations` on `main` sets `url: document.url`
unconditionally. Citations are built from the **raw** `RetrievalResult`, not from the
sanitized one, so the class gate in `sanitizeRetrievalResult` never reaches them. The
connector URL is the SharePoint `webUrl`, which embeds the folder path — the same
client-named path (`Clients/Smith Family/2024`) that `metadata.path` is deliberately
stripped for.

**Evidence (verified).** `git diff main` shows the gate as an uncommitted working-tree
change to `packages/rag/src/generation/prompt-context.ts` (`- url: document.url` →
`+ ...(isSourceUrlExposable(...) ? { url } : {})`). I traced the three render paths
that consume it: web citation chips via the `done` SSE frame
(`apps/web/src/lib/stream-chat.ts:21`), the Teams card's clickable action
(`apps/teams-bot/src/cards.ts`), and the MCP `Sources` footer, which prints
`c.url` directly (`apps/mcp/src/tools/ask.ts:69`). `sanitizeRetrievalResult` already
gates **both** carriers correctly (`packages/core/src/metadata-policy.ts:141-148`) —
the hole was only ever the citation path.

**Concrete failure for TWK.** A staff member scoped to one engagement asks a question;
the answer's citation footer hands them a clickable SharePoint link whose URL spells
out another client's name and folder. The chunk text was correctly withheld; the link
leaks the client relationship anyway. It renders identically in Teams, where it is a
one-click OpenUrl action.

**Smallest fix.** Commit and merge the branch. The code is correct — including the
fail-closed treatment of an absent or unrecognized `docClass`, which matters because
`DocumentMetadata` is `.passthrough()` and is never zod-parsed on the read path. No
further change needed.

---

### B2 — `API_ENFORCE_SCOPING=false` makes every static token an all-corpus admin (BLOCKER)

**What is wrong.** `resolvePrincipal` returns `{ kind: "admin" }` for any token in
`API_TOKENS` unless `enforceScoping` is on. `env.example:194` ships
`API_ENFORCE_SCOPING=false`, and the schema default is also `false`
(`packages/core/src/config-schema.ts:92`). With enforcement **on**, the same token
instead resolves to `{ kind: "scoped", allowedSourceIds: [] }` — deny-all. The flag is
therefore the switch between fail-open and fail-closed for the whole static-token path.

**Evidence (verified).** `packages/core/src/access-control.ts:189-196` is the branch.
`packages/runtime/src/index.ts:107-135` documents the adjacent trap and warns about it
at startup: `composite` silently drops the internal-scope verifier when
`INTERNAL_SCOPE_JWT_SECRETS` (plural, read by the API) is empty, and the singular
`INTERNAL_SCOPE_JWT_SECRET` is read **only** by `apps/web`
(`apps/web/src/lib/scope-token.ts:16`) and `apps/teams-bot`
(`apps/teams-bot/src/config.ts:15`). The mitigation is a `logger.warn`, not a refusal
to boot.

**Concrete failure for TWK.** Any holder of a plain API token — an eval script, a
one-off curl, an MCP client, a copied value in someone's shell history — reads the
entire corpus across every engagement, and the audit row records
`principalSubject: null` because only BFF-minted tokens carry a subject
(`apps/api/src/routes/ask.ts:70`). Nothing fails; the service boots clean. Per the
repo's own operational history this combination ran for weeks undetected.

**Smallest fix.** Set `API_ENFORCE_SCOPING=true` and grant admin only via an explicit
`API_PRINCIPALS` entry with `isAdmin: true`. Then verify from the startup log line
`auth chain built … verifiers=[…] enforceScoping=…` — not from the Railway variables
pane, which is what made this invisible before. Note the operational consequence the
runtime comments flag: with enforcement on, any tooling presenting a plain token
returns **zero results**, which reads like an empty knowledge base rather than an
authorization failure.

---

### B3 — Shipped egress/compliance defaults send client text to third parties unscanned (BLOCKER)

**What is wrong.** The template defaults are the permissive dev posture:
`CONTENT_SCAN_PROVIDER=none` (`env.example:400`), `COMPLIANCE_MODE=none`
(`:419`), and `EGRESS_ALLOWED_HOSTS=generativelanguage.googleapis.com,api.openai.com`
(`:429`). In that posture document text is embedded and generated against third-party
APIs with no semantic scanner in front of it.

**Evidence (verified).** `COMPLIANCE_MODE=client-data` is the coupled hard gate: it
refuses `CONTENT_SCAN_PROVIDER=none` (`packages/core/src/config.ts:445`), requires a
DPA file on disk (`:427-434`), and forces `EMBEDDING_PROVIDER=local`
(`packages/rag/src/embeddings/factory.ts:25-27`). The header of
`packages/ingestion/src/classify-document.ts:9-17` records what the permissive posture
already cost once: a source declared `general` → Class A, "all 858 documents were
treated as public regardless of what they actually contained… that is how a
spreadsheet with 522 Social-Security-shaped values reached a third-party embedding
API."

**UNVERIFIED.** I cannot read the live Railway variables from the repo, so I do not
know whether production already sets `client-data`. **What would settle it:** the
`rag-api` / `rag-worker` startup logs, or `railway variables` for those services.
If production matches `env.example`, this is live.

**Concrete failure for TWK.** Client workpaper text crosses to Google/OpenAI under
whatever their standard terms are, with no DPA gate asserted and no scanner able to
catch a client name in prose. That is the §7216 exposure the compliance mode exists to
prevent.

**Smallest fix.** Confirm the live values. For a client-data launch set
`COMPLIANCE_MODE=client-data` and accept its consequences: local ONNX embeddings with
weights pre-warmed at image build, a durable `HF_CACHE_DIR`, a self-hosted scanner,
and `EGRESS_ALLOWED_HOSTS` empty unless a signed DPA covers each host. If TWK instead
accepts third-party egress for Class A/B only, record that as a written decision with
the DPA references — do not leave it as an unexamined default.

---

### P1 — MCP surface has no per-user attribution (PRE-LAUNCH)

**What is wrong.** The MCP `ask` and `search_documents` tools write
`principalSubject: null` into `audit_log`, because `buildServer` threads only an
`AuthorizationScope` and `AuthorizationScope` — unlike the HTTP route's `Principal` —
does not carry a subject.

**Evidence (verified).** `apps/mcp/src/tools/ask.ts:102` sets it to `null` with a
comment saying exactly why; `apps/mcp/src/server.ts:83-101` confirms only `scope` is
passed to the tool registrations. The HTTP side does populate it
(`apps/api/src/routes/ask.ts:70`) but **only** for scoped principals — an admin
principal also records `null`.

**Concrete failure for TWK.** Asked "who queried the Henderson engagement last
quarter", the firm can answer for web and Teams users but not for anything that came
through MCP or any admin token. The row exists; the identity does not.

**Smallest fix.** Thread the `Principal` (not just its derived scope) into
`buildServer` and the tool registrations, and populate `principalSubject` from it.
Separately, stop discarding the subject for admin principals.

---

### P2 — Audit log retains no question or answer text by default (PRE-LAUNCH)

**What is wrong.** `AUDIT_LOG_CONTENT=none` (`env.example:639`, schema default `none`
at `packages/core/src/config-schema.ts:224`) means `audit_log` keeps a SHA-256
`question_hash` and the retrieved chunk/doc ids, but not the question or the answer.

**Evidence (verified).** `resolveAuditContent(contentPolicy, question, answer)` is the
only thing that adds text to the row (`apps/api/src/routes/ask.ts:81`).

**Concrete failure for TWK.** A hash cannot be read back. If a partner needs to show
what the system told staff about a client — a review, a dispute, a malpractice
question — the record is a hash and a list of chunk UUIDs.

**Smallest fix.** Decide deliberately. `AUDIT_LOG_CONTENT=full` makes the log
reconstructable but turns `audit_log` into another copy of client-derived text, which
then needs the same retention and access treatment as the corpus. Either value is
defensible; the default being chosen by accident is not.

---

### P3 — MCP stdio grants admin scope unconditionally (PRE-LAUNCH)

**What is wrong.** The stdio transport passes `ADMIN_SCOPE` with no credential at all.
It is a documented, deliberate decision — the comment at
`apps/mcp/src/main.ts:60-66` is explicit that the client spawns the process and there
is no token to scope against.

**Evidence (verified).** `apps/mcp/src/main.ts:67`. The reasoning holds _only_ while
the process points at a local or non-production database, which nothing enforces.

**Concrete failure for TWK.** A developer (or anyone who can run the binary) points a
local MCP client at the production `DATABASE_URL` and reads the entire firm corpus
with no scope, no credential, and `principalSubject: null` in the audit trail.

**Smallest fix.** Refuse stdio when the configured database is the production one — or
require an explicit `MCP_STDIO_ALLOW_ADMIN=true` that production never sets. The
decision is sound for local dev; it needs a guard that keeps it local.

---

### P4 — Nothing would tell TWK the system has stopped working (PRE-LAUNCH)

**What is wrong.** Three gaps compound: `apps/worker/railway.json` declares no
`healthcheckPath` (api/mcp/web all do), so Railway only restarts the worker if the
process _exits_ — a worker hung on a stuck pg-boss job looks healthy forever. There is
no `/metrics` endpoint and no `prom-client` anywhere in the repo. And the `sources`
table carries only `cursor` and `lastSyncedAt` — **no status or error column** — so a
failed sync leaves a silently stale timestamp.

**Evidence (verified).** `apps/worker/railway.json:7-10` vs `apps/api/railway.json:7`.
A repo-wide search for `prom-client` and `/metrics` returns nothing. The `sources`
table definition in `packages/db/src/schema.ts` has no status field; per-attempt
status lives only in `ingestion_jobs` (`status`, `error`), which no surface or alert
reads. `SENTRY_DSN` is unset by default (`env.example:144`), and
`apps/worker/src/handlers/sync-source.ts:296` explicitly declines to alert per attempt.

**Concrete failure for TWK.** SharePoint delta sync starts failing on a Graph throttle
or an expired credential. Staff keep asking questions and keep getting answers — from a
corpus that stopped updating weeks ago. The first signal is a partner noticing an
answer is stale, which is both the worst way to find out and the one that damages
trust in the tool permanently.

**Smallest fix.** Three small things: add `healthcheckPath` to the worker (it needs a
trivial HTTP listener), set `SENTRY_DSN`, and surface last-sync-failure per source —
either a column on `sources` or a panel reading `ingestion_jobs` — with one alert when
a source's last successful sync exceeds its expected interval.

---

### P5 — The emergency static-fallback collapses every user into one principal (PRE-LAUNCH)

**What is wrong.** With `WEB_AUTH_MODE=static-fallback`, `getSession` and
`getScopeToken` are never called and every request is served the single shared
`RAG_API_STATIC_FALLBACK_TOKEN`.

**Evidence (verified).** `apps/web/src/lib/rag-api.ts:70-85`. It is clearly labelled
temporary, it fails closed when the token is unset (structured 500), and every served
request emits a `console.warn`. But the warn is the only control.

**Concrete failure for TWK.** Entra sign-in breaks on a Friday, an operator flips the
flag to keep the firm working, and every staff member silently inherits one principal's
scope — all-corpus admin, if B2 is unresolved — with no per-user attribution for the
entire window. The flag then stays on, because nothing forces it off.

**Smallest fix.** Pre-provision the fallback token as a **scoped, non-admin**
`API_PRINCIPALS` entry limited to firm-internal sources, so the bypass degrades
capability rather than confidentiality. Pair it with a dated reminder to remove it.

---

### P6 — Client-engagement material is refused at ingest by design (PRE-LAUNCH)

**What is wrong.** Not a defect — a scope question that will surface as one.
`classifyDocument` escalates to Class C on a client-context path _or_ a semantic
client-identifying finding, and to D on any SSN/EIN/routing/card identifier; anything
reaching C or D is quarantined and throws `ClassBlockedError`. Phase 1 indexes A and B
only. An undeclared source fails closed to `D`, quarantining everything beneath it.

**Evidence (verified).** `packages/ingestion/src/classify-document.ts:106-123` (the
escalation and `quarantine: docClass === "C" || docClass === "D"`),
`packages/ingestion/src/pipeline.ts:235` (`deps.sourceDocClass ?? "D"`), and
`pipeline.ts:471` (the C/D throw). `pipeline.ts:414-418` even logs an
`ingest.all_quarantined` marker for the case where a whole run is refused.

**Concrete failure for TWK.** Staff are told there is a knowledge base over the firm's
documents. They ask about a client engagement and get nothing, because the folder path
`Clients/<Name>/2024` escalated every document in it to Class C. The gate is working
exactly as designed; the expectation is what is wrong, and it will read to users as "the
tool is broken."

**Smallest fix.** No code change. Decide and communicate the Phase 1 corpus explicitly:
firm-internal policy, procedure, templates, research, regulatory material (eCFR) —
_not_ client workpapers. If client material is in fact the goal, that is a Phase 2
conversation about Class C handling, not a config toggle.

---

### P7 — Automated point-in-time restore is broken (PRE-LAUNCH)

**What is wrong.** WAL archiving to the `rag-documents` bucket is live and backups are
proven restorable, but the Railway Postgres image's **automated** PITR restore fails
(err 088) and wedges the volume into a crash loop. Restores work only via a manual root
procedure.

**Evidence (verified from repo documentation, not re-tested).** The Railway-Postgres
note in `CLAUDE.md` and `docs/BACKUP-SCHEDULE-RUNBOOK.md`. `services/backup/railway.json`
sets `restartPolicyType: NEVER`, consistent with a one-shot backup container.

**Concrete failure for TWK.** On data loss, recovery requires the one person who has
executed the manual runbook. Recovery time is "however long that person takes to be
available," which is not an answer a firm can give a client.

**Smallest fix.** Have someone other than the author execute the manual restore against
a scratch volume, end to end, and time it. That converts an untested runbook into a
known RTO and proves the document is followable. Do this before launch, not after the
first incident.

---

### L1 — Generation spend is untracked (POST-LAUNCH)

Per-credential rate limits exist and are sensibly tighter on the LLM paths (10/min on
`/ask` and `/ask/stream`, `apps/api/src/routes/ask.ts:184`; 60/min global), which bounds
abuse. But nothing aggregates token spend, so there is no answer to "what is this
costing" and no alert on a runaway loop within the limit. **Becomes urgent** when a
user-facing agent or a scheduled job starts calling `/ask` programmatically.

### L2 — `audit_log.channel` is caller-asserted (POST-LAUNCH)

`channelFromRequest` reads the `X-RAG-Channel` header and defaults to `api`. The code
correctly excludes `mcp` from the accepted set so that value cannot be spoofed, and the
comment is honest that `api` vs `teams` is attribution rather than authentication — both
BFFs present the same shared-secret-minted token, so the API genuinely cannot tell them
apart. Fine as documented; worth knowing before anyone treats the channel column as
evidence. `apps/api/src/routes/ask.ts:36-50`.

### L3 — A deployment doc asserts a sensitivity posture the code contradicts (POST-LAUNCH)

`docs/DEPLOYMENT-TARGET.md` is correctly banner-marked as superseded on its deployment
claim, but its rationale table still reads "Data sensitivity: LOW–MODERATE (firm
work-product)". `packages/core/src/access-control.ts:5-9` describes the same corpus as
"client emails, tax workpapers, engagement documents" where "different staff/partners
are walled off from clients they don't work." The code's view is the correct one. Fix the
table so nobody reasons from the stale line.

### A1 / A2 / A3 — Accepted tradeoffs

- **A1** Railway runs `postgres-ssl:16.14` while local/CI run `pgvector/pgvector:pg16`.
  Documented as intentional in `CLAUDE.md`, along with the glibc/collation reindex
  hazard on any image bump. Leave it alone.
- **A2** `DocumentClass` keeps C and D distinct in the enum but collapses them at the
  gate (`quarantine: docClass === "C" || docClass === "D"`). Flagged in `CLAUDE.md`'s
  effort-calibration section: any change letting C through lets D through. Accepted
  while Phase 1 indexes neither.
- **A3** The rate-limit bucket key parses an **unverified** JWT `sub`. The comment at
  `apps/api/src/server.ts:58-71` reasons it correctly — a forged `sub` only lets an
  attacker dodge their own limit — and explains why the naive byte-offset alternative is
  worse (internal-scope tokens share an identical 48-char prefix). Sound as written.

---

## 4. Facts I need from you

1. **Live values of `COMPLIANCE_MODE`, `CONTENT_SCAN_PROVIDER`, `EMBEDDING_PROVIDER`,
   `EGRESS_ALLOWED_HOSTS`, `API_ENFORCE_SCOPING`, and `AUDIT_LOG_CONTENT` on the Railway
   services.** B2 and B3 are either live blockers or already-closed, and the repo cannot
   tell me which. The startup log line `auth chain built …` settles the auth half.
2. **Which connectors TWK will actually enable at launch**, and each source's declared
   `data_class`. This decides whether P6 bites on day one.
3. **Is a DPA on file** for any third-party embedding/generation host you intend to keep
   in `EGRESS_ALLOWED_HOSTS`?
4. **Is `apps/teams-bot` deployed?** It has a `railway.json` and is single-instance-only
   by construction (`MemoryStorage` for the SSO exchange, `apps/teams-bot/src/index.ts:53-56`),
   but `docs/DEPLOYMENT-TARGET.md` lists only api/mcp/web as deployed services.
5. **Who is the day-one admin**, and have they used `/admin/access` to grant a real
   staff assignment? The UI and its authorization are sound; what I cannot verify is
   whether anyone has exercised it.
6. **Expected user count and query volume**, to judge whether the 10/min per-credential
   `/ask` limit is generous or tight for TWK.

---

## 5. Explicitly checked and found sound

- **Bearer auth fails closed.** `createAuthHook` 401s on a missing/non-Bearer header
  and on `authenticate()` returning `null`; only `/health` and `/ready` are exempt, by
  exact path match (`apps/api/src/auth.ts:44-63`).
- **Scope is structurally unforgettable.** `AuthorizationScope` is a mandatory
  positional argument to `Retriever.search`, and `scopeFromRequest` centralizes the
  `DENY_ALL_SCOPE` fallback so `/search` and `/ask` cannot diverge
  (`apps/api/src/routes/authz.ts`).
- **`effectiveSourceFilter` can only narrow.** Admin-null, empty-set-fail-closed, and
  caller-filter-intersection semantics are all correct; a disjoint caller filter yields
  zero rows rather than an error (`packages/core/src/access-control.ts:262-282`).
- **Forbidden is indistinguishable from missing** on all three fetch-by-id boundaries:
  `GET /documents/:id`, `/documents/:id/download`
  (`packages/services/src/documents.ts:31,64`), and the MCP `documents://{id}` resource,
  which mirrors the missing-id throw exactly (`apps/mcp/src/server.ts:55-57`).
- **Metadata allowlist is default-deny and closes both URL carriers.**
  `sanitizeRetrievalResult` destructures `document.url` out and re-adds it only when the
  class gate passes, explicitly because it is a second carrier of `metadata.url` that the
  field allowlist never reached (`packages/core/src/metadata-policy.ts:136-150`).
- **Teams channel answers use the member intersection, never the asker's own grants**,
  with the branch deliberately confined to one function to prevent a second copy
  (`apps/teams-bot/src/scope.ts:63-92`).
- **Entra sign-in fails closed on a missing `oid`** — it throws rather than letting
  `token.oid` go undefined, and handles the groups-overage indirect-claim case
  (`apps/web/src/lib/auth.ts:29-46`).
- **Admin authorization is sound in both directions.** `isAdmin` returns `false` when
  `RAG_ADMINS_GROUP_ID` is unset (`apps/web/src/lib/admin-check.ts:14`), and **all six**
  admin server actions call `requireAdmin()` first, which rejects an absent session before
  the group check — correctly treating a server action as an independently-callable
  endpoint (`apps/web/src/app/admin/access/actions.ts:34-41`).
- **Tombstone deletions no longer leak past the cursor.** A failed tombstone reconcile
  fails the page _before_ the cursor is persisted, so the deletion is retried rather than
  skipped — a previously-known defect that is fixed in current code
  (`packages/ingestion/src/pipeline.ts:323-366`).
- **Unclassified sources fail closed to `D`**, not to `A`
  (`packages/ingestion/src/pipeline.ts:235`).
- **Redacted documents cannot be downloaded as originals** — a second independent check
  beyond ingestion clearing storage (`packages/services/src/documents.ts:67-80`), and the
  `Content-Disposition` filename is stripped of CR/LF, quotes, and path separators
  (`:95-101`).
- **The internal-scope verifier pins `HS256` explicitly** to defeat `alg: none` and
  algorithm-swap, enforces ≥64-char secrets at signing time, supports multi-secret
  rotation, and refuses to construct with zero secrets rather than silently rejecting
  everything (`packages/core/src/internal-scope-auth.ts:31-36,66-98`).
- **`API_PRINCIPALS` parsing fails loudly** on malformed JSON, bad entry shape, a
  non-boolean `isAdmin`, and — notably — a duplicate token, which would otherwise
  silently ignore the second scope (`packages/core/src/access-control.ts:93-160`).
- **Startup asserts guard the corpus.** All three backend apps assert embedding
  dimensions and the HNSW/GIN index existence before serving, so a stray regenerate that
  dropped an index crash-loops instead of silently degrading retrieval to sequential scans
  (`apps/mcp/src/main.ts:28,45`).
- **SSE error payloads do not echo arbitrary errors** — only `EGRESS_BLOCKED` and
  `COMPLIANCE_VIOLATION`, both config-level rather than data-level, with everything else
  flattened to a generic message (`apps/api/src/routes/ask.ts:105-115`).
- **A client that disconnects mid-stream still audits the answer** that was generated and
  paid for, and stops the model rather than letting it finish
  (`apps/api/src/routes/ask.ts:131-160`).
- **The MCP channel value cannot be spoofed** via `X-RAG-Channel`
  (`apps/api/src/routes/ask.ts:36-44`).
- **Non-dismissible practitioner-review disclaimer** is attached to every answer on both
  the web and Teams surfaces, carried as `reviewStatus`/`disclaimer` from the service
  rather than assembled per-surface (`packages/services/src/ask.ts:435,452`;
  `apps/web/src/components/chat-interface/chat-interface.tsx:160`;
  `apps/teams-bot/src/cards.ts:70-73`).
