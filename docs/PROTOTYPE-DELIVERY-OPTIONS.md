# Getting the KB assistant usable — options, ranked

**Written:** 2026-08-01 · **Context:** this is a **prototype**, and that changes
the answer. **Status:** decision doc, not a record of work done.

> **The headline.** The Azure-subscription blocker
> ([`TWK-LAUNCH-STATUS.md`](./TWK-LAUNCH-STATUS.md) P1 #4) blocks the **Teams
> bot**. It does **not** block shipping a usable prototype. The web app needs no
> Azure subscription, and its sign-in needs no admin consent.

---

## What "legally protected" means for a prototype

**Protection comes from scoping the data, not from more paperwork.** The
compliance load on this system is driven almost entirely by _what is in the
index_ and _who can reach it_ — not by how polished the deployment is.

**Verified in production 2026-08-01:**

| Source                            | Kind       | `data_class` | Docs    |
| --------------------------------- | ---------- | ------------ | ------- |
| `TWK SharePoint — Knowledge Base` | sharepoint | `general`    | **844** |
| `TWK RAGTestSite`                 | sharepoint | `general`    | 14      |
| `TWK CPA Firm`                    | sharepoint | `general`    | 0       |

Everything indexed comes from **SharePoint**; there is no Onvio content and no
QuickBooks data. That connection scope is a fact and still holds.

> ### ⛔ CORRECTED 2026-08-03 — the "no client files" half was wrong
>
> This passage previously read _"Everything indexed is **internal SharePoint
> knowledge-base content — Class A/B**. There are no client files, no Onvio
> content, and no QuickBooks data."_ The Onvio/QuickBooks half stands. **The "no
> client files" and "Class A/B" claims do not.**
>
> The client-identifier screen over all 858 documents (`corpus-analysis/`) found
> **355 flagged**, including per-client billing files under client-named folders,
> engagement letters, client fee/scope deliverables, and one indexed spreadsheet
> holding **522 SSN-shaped values**. See
> [`TWK-LAUNCH-STATUS.md`](./TWK-LAUNCH-STATUS.md) for the full correction and
> [`superpowers/plans/2026-08-03-kb-content-boundary.md`](./superpowers/plans/2026-08-03-kb-content-boundary.md)
> for the remediation.
>
> **Consequence for this document specifically:** the three bullets immediately
> below argued that §7216, Circular 230, and GLBA do not attach _because_ the
> corpus contains no client data. That reasoning no longer holds on its own. The
> option ranking is unaffected — it turns on Azure subscriptions and consent
> scopes, not on corpus contents — but **guardrail 2 below ("Class A/B sources
> only") is now a remediation target rather than a description of the current
> state**, and the "none of it needs counsel" conclusion should not be relied on
> until the content audit closes.

The original reasoning, retained because it is still correct for a corpus that
_has_ been cleaned:

- **IRC §7216 is not triggered** by content that contains no taxpayer data. The
  §7216 exposure in the strategy docs attaches to _tax-prep_ use cases (ISS-10,
  ISS-11), not to answering "what's our PTO policy" from an internal SOP.
- **Circular 230 §10.22** concerns the audit trail for practice before the IRS.
  The `audit_log` already records every query and is verified in the backup drill.
- **GLBA** attaches to customer financial information. Internal SOPs are not that.

⚠ **P0 #1 (the content audit) is now a live finding, not an open formality.**
`data_class = general` was the ingestion **default**, not a verified judgment.
The verification has since been run — it was indeed the single highest-value
compliance action available — and **it came back positive**: client-identifying
material is present in the index. What remains has two halves. The **firm-judgment**
half is cheap — Chris or Doug ruling on a document list, not an attorney. The
**remediation** half is engineering: connector exclude-paths, a citation/metadata
fix, and an ingest-time gate. Neither has been executed yet.

**The prototype guardrails that make this defensible:**

1. **Named pilot users only** — not firm-wide, not self-service signup
2. **Class A/B sources only** — do not add Onvio, Z Drive, or client folders. ⚠ **Now a remediation target, not a description of today** — see the correction above
3. **Written scope note** — ⚠ **do not use the original wording below**; it asserts "no client data," which is the falsified claim. Say instead: "internal prototype, SharePoint KB only, N named users, corpus remediation in progress, not for client deliverables or filed positions." Original wording, retained for the record: "internal prototype, no client data, N named users,
   not for client deliverables or filed positions"
4. **Audit logging on** — already is
5. **No tax or accounting judgments** — the system answers _from documents_ and
   cites them; it does not advise (epistemic constraint C2)

That set is achievable this week. ⚠ **Corrected 2026-08-03:** this previously
concluded _"None of it needs counsel, because none of it touches taxpayer
data."_ That conclusion rested on the corpus being clean, which the screen
falsified — see the correction above. Whether counsel is needed is now an open
question that the content audit answers, not one this document can close.

---

## The options, in order of preference

### ✅ Option 1 — Deploy the **web app**, pilot-scoped (RECOMMENDED)

**Unblocked today. No Azure subscription. No admin consent for sign-in.**

`apps/web` is built and has a `Dockerfile` + `railway.json`. Sign-in uses
`openid profile email offline_access` — **all user-consentable delegated
scopes**, so each pilot user approves for themselves at first login. Marcus can
create the app registration himself (`allowedToCreateApps: True`, verified).

| Need                         | Blocked?                                      |
| ---------------------------- | --------------------------------------------- |
| Azure subscription           | **No**                                        |
| Admin consent to sign in     | **No** — user-consentable scopes              |
| Admin consent for admin page | **Yes** — `User.Read.All` app-only, see below |

⚠ **One partial dependency.** `apps/web/src/lib/graph-client.ts` uses **app-only**
Graph (`client_credentials`) for `GET /users/{email}` and `checkMemberGroups` —
that needs **`User.Read.All`** with admin consent. It powers the `/admin/access`
page and the group-claims-overage fallback. **Neither is needed to ask the KB a
question.** For a pilot, assign sources directly and skip the admin UI; the
consent can follow.

**Effort:** hours. **Risk:** low. **Delivers:** the actual capability — ask the
KB, get cited answers, per-user scope, audit-logged.

---

### Option 2 — Wrap the web app as a **Teams personal tab**

**Gets it inside Teams without an Azure Bot resource.**

A Teams **tab** is an app manifest pointing at a hosted URL. Only the
**conversational bot** (@mentions, proactive messages) requires an Azure Bot
resource — and that is the piece needing a subscription. A tab does not.

**Needs:** Option 1 done, a Teams app manifest, and the tenant to permit custom
app upload (a tenant setting — ⚠ **unverified** whether TWK allows it; may need
an admin toggle).

**Trade-off:** no @mention, no proactive notifications. For a prototype whose
goal is "does this answer staff questions usefully," a tab tests that fully.

**Effort:** +half a day on Option 1. **Delivers:** Teams presence, which is most
of the adoption argument (ISS-05 — staff use what is already open).

---

### Option 3 — Full **Teams bot** (the original plan)

**Best UX. Slowest path. Blocked on a purchasing decision.**

Requires an **Azure Bot resource** → an Azure subscription with a payment method
→ Chris. The free F0 tier means **cost is not the obstacle; the missing
subscription is.** Everything else is built: `apps/teams-bot`, 43 unit tests, SSO,
reviewed and merged.

**Do not treat this as the definition of done.** It is a distribution upgrade
over Options 1–2, not a different capability. Sequence it after the prototype has
shown value — which also makes the subscription ask far easier to justify.

**Effort:** small once unblocked. **Blocked on:** Chris + purchasing.

---

### Option 4 — **MCP only** (already live, zero work)

`rag-mcp` is **deployed and Online right now**. Marcus can query the KB through
Claude Code today with no further work.

**Not staff-facing** — it validates retrieval quality, not adoption. Useful as
the harness for P2 #7 (building the CPA eval question set with Doug) and worth
using immediately for that, but it is not the prototype anyone else sees.

---

## Recommended sequence

1. **Option 1 now** — deploy the web app, pilot-scoped to named users
2. **P0 #1 content audit on 858 docs, with Chris/Doug** — the one genuinely
   load-bearing compliance action, and it needs no lawyer
3. **Option 2** once the tab-upload tenant setting is confirmed
4. **Bundle the asks to Chris**: admin consent (`User.Read.All` + backup's
   `Sites.Selected`) **and** the subscription question — one conversation, and
   by then there is a working prototype to point at
5. **Option 3** after the subscription lands

⚠ **What would make this NOT defensible**, and is worth stating so nobody drifts
into it: adding Onvio or client folders to the index, opening it past the named
pilot group, or letting output reach a client deliverable or a filed position.
Any of those would move the system further into §7216 territory, and at that
point counsel sign-off (P0 #2) stops being deferrable. ⚠ **Corrected
2026-08-03:** this originally read "moves the system **from Class A/B** into
§7216 territory," which assumed the corpus was Class A/B to begin with. The
screen falsified that. The warning still stands — these actions still make things
materially worse — but it is no longer a clean boundary the system sits safely
inside.
