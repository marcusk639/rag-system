# Documentation Review: PR #60 — sslmode guidance in the compliance docs

**Reviewed:** 2026-09-07 · **Documents:** 4 (`PLAN-CPA-COMPLIANCE.md`, `CPA-KB-IMPLEMENTATION-SPEC.md`, `CPA-KB-ADOPTION-PLAN.md`, `AUTH-AND-SESSIONS-RESEARCH.md`)
**Reviewer:** documentation-review skill (orchestrated `document-analyst` agents, findings validated against source before inclusion)
**Rubric:** `references/rubric.md`

## Summary

The technical correction in PR #60 is sound — every factual claim in the new text verifies against the codebase, and the passages read coherently in place. Two problems survive it. First, `PLAN-CPA-COMPLIANCE.md` now presents a control that PR #59 **closed in production the same day** as an open, unchecked TODO, with a knock-on stale row in its Phase 0 audit table. Second, all four docs recommend `sslmode=no-verify` as a §7216/GLBA compliance control without disclosing that it encrypts but does **not** authenticate the server — a caveat `main` already carries at `docs/PILOT-LAUNCH-STATUS.md:380-382`.

## Scores

| Document                        | Type              | Score | One-line verdict                                                             |
| ------------------------------- | ----------------- | ----- | ---------------------------------------------------------------------------- |
| `PLAN-CPA-COMPLIANCE.md`        | Plan / spec       | 6/10  | Technically accurate fix undermined by presenting a closed control as open.  |
| `AUTH-AND-SESSIONS-RESEARCH.md` | Proposal/analysis | 6/10  | Bare value swap in the one doc whose genre is sourced rationale.             |
| `CPA-KB-IMPLEMENTATION-SPEC.md` | Plan / spec       | 8/10  | Correct and well-explained; inherits only the missing-authentication caveat. |
| `CPA-KB-ADOPTION-PLAN.md`       | Plan / spec       | 8/10  | Terse pointer matches house style; needs a section anchor.                   |

## Findings

### HIGH

1. **Currency / staleness** — `docs/PLAN-CPA-COMPLIANCE.md` @ lines 304-308 (Phase 3 item 3) and 316-318 (unchecked verification box) — presents `?sslmode=no-verify` as work still to do. PR #59 closed it in production on 2026-09-07 (`7/7 client backends ssl = t`, TLSv1.3, zero plaintext). A reader executing Phase 3 fresh, or running the Final Phase re-audit at line 478, gets no signal it is done. The document already has a precedent for exactly this: the "Status update (2026-07-04)" callout at line 147. **Fix:** add a matching status callout recording closure per PR #59, tick the box, and note CR-6 (at rest) as the remaining open half.

2. **Accuracy / overclaim** — `docs/AUTH-AND-SESSIONS-RESEARCH.md` @ line 250, the "Encryption:" bullet — `sslmode=no-verify` is presented as an interchangeable layer of §7216 defence-in-depth beside full-disk and AES-256-GCM, with no rationale and no statement of what it gives up. This is the one document whose defining trait is decision → rationale → Sources for every other choice it makes, and it is the doc the other three cite as canonical for transcript-encryption compliance, so the omission propagates. **Fix:** add the rationale plus the authentication trade-off.

### MEDIUM

3. **Accuracy / incomplete security claim (all four docs)** — `PLAN-CPA-COMPLIANCE.md:304-308`, `CPA-KB-IMPLEMENTATION-SPEC.md:166-167`, `CPA-KB-ADOPTION-PLAN.md:320`, `AUTH-AND-SESSIONS-RESEARCH.md:250` — each explains (or points at) _why `require` fails_, which is a **compatibility** justification, but none states what `no-verify` **forfeits**: server-certificate validation, and so no protection against an on-path attacker. `CPA-KB-IMPLEMENTATION-SPEC.md:250` compounds it with "TLS 1.2+ **verified**", which a reader may take as certificate verification — precisely what is disabled. `main` already carries the correct caveat at `docs/PILOT-LAUNCH-STATUS.md:380-382`. **Fix:** state the residual exposure once in `PLAN-CPA-COMPLIANCE.md` Phase 3 (the canonical source); the docs that point there inherit it.

4. **Internal consistency** — `docs/PLAN-CPA-COMPLIANCE.md` @ line 51 (Phase 0 control matrix, CR-7 row) — still reads 🟡 "`DATABASE_SSL` supported but **optional, unset by default** … No enforcement on other hops." This now contradicts the corrected Phase 3 text _and_ production reality. Phase 0 is marked COMPLETE and is the document's audited baseline, so a reader trusting the table alone gets a stale assessment. **Fix:** update the row or add a forward-pointer to the Phase 3 status callout.

### LOW

5. **Citations** — `docs/PLAN-CPA-COMPLIANCE.md` @ lines 306-308 — the `pg-connection-string >= 2.10` / `verify-full` claim carries no citation, unlike almost every other bullet in this citation-heavy doc. It is verifiable at `packages/runtime/src/postgres-tls.ts:8-13`. **Fix:** append that reference.

6. **Reference validity** — `docs/CPA-KB-ADOPTION-PLAN.md` @ line 320 — points at `docs/PLAN-CPA-COMPLIANCE.md` (509 lines) with no section anchor; the explanation is in Phase 3. **Fix:** say "Phase 3".

7. **Coverage gap / cross-reference** — all four docs — none mentions that `no-verify` is a `pg-connection-string` value that **libpq rejects outright**, so `pg_dump`, `psql` and the restore procedure need `sslmode=require` instead. This is well documented at `env.example:53-58` and `services/backup/backup.sh:25-35` (PR #58) but not reachable from these compliance docs, where a reader configuring backups would land. **Fix:** one cross-reference from `PLAN-CPA-COMPLIANCE.md` Phase 3. _(Downgraded from the analyst's framing — the fact is documented repo-wide, only the link is missing.)_

## Cross-Document Findings

- **Contradiction:** `PLAN-CPA-COMPLIANCE.md:51` vs `:304-308` — same control, two states.
- **Inconsistent depth for one fact:** full rationale in the spec, a pointer in the adoption plan, nothing in the research doc. The first two are defensible on document type and house style; the third is not.
- **SSOT:** `PLAN-CPA-COMPLIANCE.md` Phase 3 is the de facto canonical explanation and should carry the complete statement (why `require` fails, what `no-verify` forfeits, the libpq divergence) so the others can stay terse pointers.
- **Missing cross-reference:** none of the four links `docs/PILOT-LAUNCH-STATUS.md`, which holds the current closed status and the authentication caveat.

## Open Questions

- Does the app↔Postgres connection traverse a segment where a third party could intercept it, or is the MITM exposure accepted because the path is inside Railway's private network? This determines whether "encryption in transit satisfies CR-7" is fully accurate or only literally true. Not stated in any of the four documents.
- Does `apps/teams-bot`'s separately-copied `DATABASE_URL` (commit `fad42d4`) need naming in Phase 3, which currently says "the production `DATABASE_URL`" in the singular?
- Was `PLAN-CPA-COMPLIANCE.md` deliberately left out of the PR #59 closure pass, or simply missed?

## Recommended Action Plan

1. Add the Phase 3 status callout, tick the checkbox, fix the line 51 CR-7 row — addresses findings 1 and 4.
2. State the authentication trade-off once in Phase 3, and add the rationale + trade-off to `AUTH-AND-SESSIONS-RESEARCH.md:250` — addresses findings 2 and 3.
3. Add the `postgres-tls.ts` citation, the Phase 3 anchor, and the libpq cross-reference — addresses findings 5, 6 and 7.
4. Settle the network-path question above; it is the only one requiring a human decision.
