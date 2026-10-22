---
title: TRI identifying-pattern exemptions
status: current
last_verified: 2026-10-21
verified_against: ae08541
answers: Why one false-positive identifying TRI match can permanently fail a topic area, what the options are for an exemption mechanism, and what must happen before choosing.
read_when: A question fails with a 422 COMPLIANCE_VIOLATION naming SSN, SSN-unformatted or EIN, an SOP is missing from answers or quarantined as Class D, or when changing TRI_IDENTIFYING_LABELS, the EIN or SSN-unformatted patterns, or GENERATION_TRI_POLICY semantics.
supersedes: [superpowers/plans/2026-08-31-tri-identifying-pattern-exemptions.md]
code:
  [
    packages/core/src/tri-scanner.ts,
    packages/rag/src/generation/generator.ts,
    packages/rag/src/generation/screen-context.ts,
    packages/ingestion/src/classify-document.ts,
    packages/runtime/src/index.ts,
    apps/api/src/error-handler.ts,
    env.example,
  ]
---

# TRI identifying-pattern exemptions

This spec answers what to do when an identifying TRI pattern (taxpayer return information under IRC §7216) fires on
text that isn't a real identifier. **Status on 2026-10-21: an open decision with nothing implemented.** No exemption
mechanism exists, and the EIN pattern is still unanchored. `packages/core/src/tri-scanner.ts` cites this file from
the comment on its `EIN` pattern. The decision is tracked in
[KNOWN-ISSUES — Decisions needed](../KNOWN-ISSUES.md#decisions-needed) as "TRI identifying-pattern exemptions"
(issue KI-SAFE-3). The bottom line is that a false positive doesn't fail loudly any more. At ingest it quarantines
the whole document, and at generation it silently drops the chunk, so the risk is knowledge that quietly goes missing.
It blocks nothing today, and it becomes urgent the first time a real corpus trips it.

The issue was raised by the PR #35 review (finding 6) on 2026-08-31 and recorded in `ad93706`. It has no owner.

## The problem

`TRI_IDENTIFYING_LABELS` in `packages/core/src/tri-scanner.ts` is `SSN`, `SSN-unformatted` and `EIN`. A match on any
of them is treated as must-not-send whatever `GENERATION_TRI_POLICY` says. That behaviour is deliberate and correct:
the point of the identifying/contextual split is that no leniency calibrated for SOP false positives should cover a
real tax identifier ([CONTENT-SAFETY-DESIGN](../compliance/CONTENT-SAFETY-DESIGN.md#identifying-versus-contextual-patterns)).

Generation screens each retrieved chunk separately (`screenGenerationContext` in
`packages/rag/src/generation/screen-context.ts`, since `f6d4b14` on 2026-09-16). A chunk that would block is dropped
from the context, and the answer is built from the clean ones. A `ComplianceError`, which the API maps to
`422 COMPLIANCE_VIOLATION` (`apps/api/src/error-handler.ts`), is thrown only when the question itself matches or no
chunk survives. `runPreFlight` in `generator.ts` then re-scans the assembled prompt as a backstop.

The consequence is a policy lattice with a hole in it:

| Policy  | Contextual match in a chunk | Identifying match in a chunk | Identifying match in the question |
| ------- | --------------------------- | ---------------------------- | --------------------------------- |
| `block` | chunk dropped               | chunk dropped                | 422                               |
| `warn`  | logged, chunk kept          | **chunk dropped**            | **422**                           |
| `off`   | no scan                     | **no scan**                  | **no scan**                       |

No position means "warn on contextual, block on identifiers, but tolerate this one known false positive." The only
escape from a false-positive identifying match is `off`, which disables the whole scan, including real SSN detection
across the corpus. `COMPLIANCE_MODE=client-data` forces `block` (`resolveTriPolicy` in
`packages/runtime/src/index.ts`). The code default is `block`. Production was set to `warn` on 2026-09-07
([LAUNCH-STATUS gate 0](../launch/LAUNCH-STATUS.md#gate-0-tri-policy-is-warn)), which makes the identifying column
the only hard stop in production.

## Why it matters in practice

The EIN pattern is `/\b\d{2}[-\s]\d{7}\b/`: any two digits, a dash or space, then seven digits. It matches a vendor
account number, a reference code, a phone fragment, or an OCR'd figure formatted `12-3456789`. `SSN-unformatted`
(added in PR #36) has a known collision of the same kind. Its pattern is a 9-digit run within 40 characters after
`SSN`, `TIN`, `ITIN` or "social security", and a 9-digit bank routing number next to the word "TIN" fits it. That is
exactly what a vendor W-9 note looks like. Its false-positive rate is **unmeasured**, because it post-dates the
858-document screen that justified the split, and nobody has measured EIN's false-positive rate on the rebuilt
corpus.

Suppose one SOP contains such a string. What happens to it now:

1. **At ingest the whole document disappears.** The pack (`packs/cpa/pack.yaml`) declares the same `ein` and
   `ssn-unformatted` shapes. The string is masked, and `classifyDocument` treats any `ein` or `ssn` finding as
   dispositive, so it escalates the document to Class D and quarantines it. The only trace is an `ingest_log` row; to
   staff, the SOP was simply never synced.
2. **At generation a surviving chunk is dropped silently.** A chunk can still match if it was indexed without the pack
   or if the two pattern sets drift apart. It is removed from every answer's context and logged by
   `onContextDropped`, a server-side warning in `packages/runtime/src/index.ts`. Answers on that topic degrade with no
   notice to the user.
3. **A question that contains the string fails with a 422**, under every policy except `off`.

The original failure shape, where one chunk 422'd every question that retrieved it (about twelve chunks per prompt,
`DEFAULT_TOP_K=12`), is gone. The cost has moved: one document can now vanish from a topic area silently instead of
failing loudly. The operator's only remedies are still to edit or delete the source document, or to set
`GENERATION_TRI_POLICY=off` and lose SSN detection everywhere, and the ingest-side quarantine has no policy switch at
all. Whichever option is chosen must say whether it applies at ingest, at generation, or both.

UNVERIFIED: whether any document in the current corpus has been quarantined for an `ein` or `ssn` hit. A query of
`ingest_log` for `blocked` rows whose reason includes `identifier-found` would settle it.

## Options to weigh

None has been chosen. They aren't mutually exclusive.

**A. Per-label exemptions.** A `TRI_ALLOWED_PATTERNS`-style config listing labels, or label plus document or source
scope, that downgrade from blocking to warning.

- It keeps the regexes broad, which is the safe direction for detection.
- Its failure mode is a config that quietly disables a real guard. It needs an audit-log entry on every exempted
  match, and probably a scope narrower than global.
- To settle: is the exemption per label, per source or per document? Global-per-label is the easiest build and the
  weakest control.

**B. Tighten the patterns with a proximity requirement.** Require an EIN to sit near "EIN", "Employer ID" or "FEIN",
the way the contextual patterns require an adjacent dollar figure and `SSN-unformatted` requires its label.

- It adds no config surface and can't be misconfigured.
- It trades recall for precision: an EIN in a bare table cell with no nearby label stops matching. Whether that is
  acceptable is a §7216 judgement.
- The existing test fixture in `packages/core/src/tri-scanner.test.ts` (`"Employer ID 12-3456789 on file."`) already
  carries the label, so it would still pass. The current tests would **not** catch the recall loss, so new fixtures
  are needed first.

**C. Do nothing until it bites.** This is defensible, since no real corpus is known to have tripped it. The cost of
being wrong is an SOP missing from the index, or a thinner answer, that nobody notices until a user asks why the
assistant doesn't know something.

## What to do before choosing

1. **Measure.** Run the identifying patterns over the current corpus, count the matches per label, and inspect them
   by hand. The split itself was justified by exactly this kind of screen, and the two newest patterns have never been
   screened. Without that number, this is speculation.
2. **Decide which failure the system should prefer:** a false block (a question that can't be answered) or a false
   pass (an identifier disclosed to a third-party model). §7216 pushes hard toward the false block, which argues for B
   plus a measured recall check rather than A.
3. **Make every outcome visible to someone who can act.** This is partly done. The `ComplianceError` message now
   names the identifying labels that fired, says they block regardless of `GENERATION_TRI_POLICY`, and points to
   self-hosted generation or §7216 consent. It still doesn't tell a staff member what to do about a false positive.
   The silent outcomes need the same treatment: a dropped chunk is only a server log line, and a quarantined SOP is
   only an `ingest_log` row. An operator needs to see which document tripped which label.

## Related

- `packages/core/src/tri-scanner.ts`: `TRI_PATTERNS`, `TRI_IDENTIFYING_LABELS`, `identifyingTRIPatterns`.
- `packages/rag/src/generation/screen-context.ts`: `screenGenerationContext`, the per-chunk drop.
- `packages/rag/src/generation/generator.ts`: `runPreFlight`, the whole-prompt backstop.
- `packages/ingestion/src/classify-document.ts`: `CLASS_D_IDENTIFIERS`, the ingest-side escalation.
- `packages/runtime/src/index.ts`: `resolveTriPolicy`, the `client-data` override.
- `env.example`: the `GENERATION_TRI_POLICY` operator guidance.
- PR #36 added the identifying/contextual split (`896170e`) and `SSN-unformatted` (`19a7542`).
- PR #35 set the code default to `block` (`be4eff8`). That raises the cost of a contextual false positive but doesn't
  change the identifying side.
- [sensitive-content-discovery.md](sensitive-content-discovery.md#what-the-slice-deliberately-left-undone): why
  `tri-scanner.ts` was left off the pack engine.
