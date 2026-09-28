# Email draft — asking IT about Teams custom app upload

**Status:** DRAFT, not sent · **Written:** 2026-09-13

Covers requirement #6 in [`TEAMS-MVP-REQUIREMENTS.md`](./TEAMS-MVP-REQUIREMENTS.md):
whether the tenant permits custom Teams app upload. That has never been verified
either way, and it is the only Teams requirement that could **invalidate** the
plan rather than merely delay it — if sideloading is disallowed and cannot be
worked around, the Azure subscription does not help.

It is also the cheapest item on the list: one question, answerable today,
needing nothing bought or built.

Send this **separately** from the Azure subscription ask. Different owners,
different urgency, and this one should not wait behind a purchasing decision.

---

## The draft

> **Subject:** Permission to upload an internal Teams app (knowledge-base assistant)
>
> Hi [name],
>
> I'd like to make an internal knowledge-base assistant available in Teams and
> need to know whether our tenant allows custom app upload before I go any
> further.
>
> **What it is:** a bot called "Knowledge Base Bot" that answers staff questions
> from our own SharePoint knowledge base — "what's the SOP for X", "where does Y
> live" — and cites the documents it used. It's built and running internally;
> the web version has been live since August.
>
> **What I'm asking:** can staff (or, to start, just me) upload a custom Teams
> app in our tenant? I believe this is controlled in two places in the Teams
> admin centre — an org-wide setting for whether custom apps are allowed at all,
> and a per-user app setup policy for who may upload one. I'd need whichever
> applies.
>
> **If sideloading is disabled as a matter of policy** — which is a reasonable
> default — the alternative works just as well for us: you upload the app
> package to the org app catalogue on our behalf and scope it to a named group.
> I'd send you a single `.zip`. Happy to do it that way if you'd prefer.
>
> **Details you'll probably want:**
>
> - **Permissions requested:** `identity` (so it knows who's asking, which is how
>   answers are scoped to each person's access) and `messageTeamMembers`.
>   Nothing else.
> - **No external domains.** The app declares none, so there's no embedded
>   third-party content.
> - **Data:** questions and answers stay within our infrastructure; every query
>   is audit-logged. The indexed content is internal firm SOPs only — no client
>   files.
> - **Scope:** personal chat plus team/group chat.
> - **Pilot only:** a named handful of us to start, not firm-wide.
>
> Could you let me know which of these is the case?
>
> 1. Custom app upload is allowed — I'll proceed.
> 2. It's disabled, but you can publish the app to the catalogue for us.
> 3. It's disabled and that's a policy we'd need to discuss.
>
> Thanks,
> Marcus

---

## Before sending

- **Add the firm name** if IT expects it. It is absent here deliberately: CI
  fails the build when the tenant name appears in any tracked file.
- **The admin-centre wording is hedged on purpose.** Microsoft renames those
  toggles regularly, so the two controls are described by function rather than
  by a menu path that may since have changed.
- **Keep the three-way close.** Option 2 is what turns a potential dead end into
  a scheduling question. If sideloading is off for sound policy reasons, an
  admin-published catalogue app reaches the same destination.

## Facts behind the claims

Each detail in the email is checked against the app manifest, not assumed:

| Claim in the email  | Source                                                        |
| ------------------- | ------------------------------------------------------------- |
| App name            | `apps/teams-bot/manifest/manifest.json` → `name`              |
| Two permissions     | same file → `permissions: ["identity", "messageTeamMembers"]` |
| No external domains | same file → `validDomains: []`                                |
| Three chat scopes   | same file → `bots[0].scopes`                                  |
| Every query audited | `audit_log`, `channel = 'teams'`                              |

If the manifest changes before this is sent, re-check the table.

## Outcome

Record the answer here when it arrives, then update requirement #6 in
`TEAMS-MVP-REQUIREMENTS.md`.

| Field        | Value |
| ------------ | ----- |
| Sent         |       |
| To           |       |
| Reply        |       |
| Which option |       |
| Follow-up    |       |
