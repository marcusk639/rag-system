# TRI identifying patterns need an exemption mechanism — design needed

**Status:** open, needs a design decision before implementation
**Raised by:** PR #35 review (finding 6), 2026-08-31
**Owner:** unassigned
**Blocks:** nothing today; becomes urgent the first time a real corpus trips it

## The problem

`TRI_IDENTIFYING_LABELS` (`packages/core/src/tri-scanner.ts`) hard-blocks
regardless of `GENERATION_TRI_POLICY`. That is deliberate and correct — the
whole point of the identifying/contextual split is that no leniency calibrated
for SOP false positives should cover a real tax identifier.

The consequence is a policy lattice with a hole:

| Policy  | Contextual patterns | Identifying patterns |
| ------- | ------------------- | -------------------- |
| `block` | blocks              | blocks               |
| `warn`  | warns, proceeds     | **blocks**           |
| `off`   | no scan             | **no scan**          |

There is no position meaning _"warn on contextual, block on identifiers, but
tolerate this one known false positive."_ The only escape from a
false-positive identifying match is `off`, which disables the entire scan —
including real SSN detection across the whole corpus.

## Why that matters in practice

The EIN pattern is `/\b\d{2}[-\s]\d{7}\b/` — any two digits, a separator, seven
digits. It matches a vendor account number, a reference code, a phone fragment,
or an OCR'd figure formatted `12-3456789`.

Failure shape: one SOP contains such a string. It is chunked and retrievable.
Because a prompt bundles roughly twelve chunks, **every question whose retrieval
pulls that chunk in fails with a 422** — permanently, since `warn` cannot cover
it. The operator's only remedies today are to edit or delete the source
document, or to set `GENERATION_TRI_POLICY=off` and lose SSN detection
everywhere. One document can poison a whole topic area.

`SSN-unformatted` (added in #36) has the same shape and a known collision: a
9-digit bank routing number near the words "TIN" or "Social Security", which is
exactly what a vendor W-9 note looks like. Its false-positive rate on a real
corpus is **unmeasured** — it post-dates the 858-document screen that justifies
the split.

## Options to weigh

Neither has been chosen. They are not mutually exclusive.

**A. Per-label exemptions.** A `TRI_ALLOWED_PATTERNS`-style config listing
labels (or label + document/source scope) that downgrade from blocking to
warning.

- Keeps the regexes broad, which is the safe direction for detection.
- Failure mode is a config that quietly disables a real guard, so it needs an
  audit-log entry on every exempted match and probably a scope narrower than
  global.
- Question to settle: is the exemption per-label, per-source, or per-document?
  Global-per-label is the easy build and the weakest control.

**B. Tighten the patterns with a proximity requirement.** Require an EIN to sit
near "EIN" / "Employer ID" / "FEIN", the way the contextual patterns already
require an adjacent dollar figure — the same technique `SSN-unformatted`
already uses.

- No new config surface, no way to misconfigure it.
- Trades recall for precision: an EIN in a bare table cell with no nearby label
  stops matching. Whether that is acceptable is a §7216 judgment.
- The existing test fixture (`"Employer ID 12-3456789 on file."`) already
  carries that context, so it would still pass — which means the current tests
  would **not** catch the recall loss. New fixtures are needed first.

**C. Do nothing until it bites.** Defensible: no real corpus has tripped it yet.
The cost of being wrong is a topic area that fails permanently with a message
that does not explain itself, discovered by a user rather than by us.

## What to do before choosing

1. **Measure.** Run the pattern set over the current corpus and count
   identifying-label matches, then hand-inspect them. The split's own
   justification came from exactly this kind of screen (858 documents), and the
   two newest patterns have never been screened. Without that number this is
   speculation.
2. **Decide the failure the system should prefer** — a false block (a question
   that cannot be answered) or a false pass (an identifier disclosed to a
   third-party model). §7216 pushes hard toward the former, which argues for B
   plus a measured recall check rather than A.
3. Whichever is chosen, the operator-facing error should say which label fired
   and what the remedy is. Today a 422 arrives with pattern labels in the
   message but no guidance, and the person who sees it is a staff member asking
   a bookkeeping question.

## Related

- `packages/core/src/tri-scanner.ts` — patterns and `TRI_IDENTIFYING_LABELS`
- `packages/rag/src/generation/generator.ts` — `runPreFlight`, where the block
  is thrown
- `packages/runtime/src/index.ts` — `resolveTriPolicy`, the `client-data`
  override
- `env.example` — `GENERATION_TRI_POLICY` operator guidance
- PR #36 added the identifying/contextual split and `SSN-unformatted`
- PR #35 set the default policy to `block`, which raises the cost of a false
  positive on the contextual side but does not change the identifying side
