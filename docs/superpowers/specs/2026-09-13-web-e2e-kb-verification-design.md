# Design: browser e2e verification of the KB through the web app

**Date:** 2026-09-13
**Status:** approved design, not yet implemented
**Scope:** a Playwright suite in `apps/web/` that proves retrieval, citation
resolution, and query-appropriate context through the real UI.

## Why this exists

`scripts/check-kb-grounding.mjs` already verifies the KB's three core properties
against a deployed instance: citation validity, self-retrieval, and out-of-corpus
refusal. It runs at the HTTP API level.

Nothing verifies the **web app**. There is no browser test infrastructure in
`apps/web/` at all — `package.json` has vitest only. So a regression that drops
citations between the BFF response and the rendered chips, breaks the auth gate,
or renders a refusal as an empty bubble would ship green.

That gap is the entire justification for this suite. Assertions that merely
re-test KB properties already covered by the grounding check are not worth their
wall-clock; see "What we deliberately do not assert".

## Decisions taken

| Decision  | Choice                                                   | Rejected alternative and why                                                                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer     | Browser e2e for `apps/web`                               | Deepening the API-level grounding check — cheaper, but structurally cannot see the UI layer, which is the actual gap                                                                                                                                                                                                                      |
| Test auth | Mint a NextAuth session cookie signed with `AUTH_SECRET` | `WEB_AUTH_MODE=static-fallback` — trivial to stand up, but it is a production break-glass override; a suite running in it never exercises per-user session → scope-token → scope-threaded retrieval, so a scope-leak regression would pass. Real Entra sign-in — highest fidelity but needs a tenant account, CI secrets, and MFA screens |
| Target    | Local stack, seeded fixture corpus                       | Deployed Railway KB — real data, but shifts under us, cannot run in CI, and spends production Gemini quota per run                                                                                                                                                                                                                        |
| Generator | Real LLM, three chat requests                            | Stub — deterministic and free, but refusal and grounding are properties of the model's response, so stubbing removes the things we set out to verify                                                                                                                                                                                      |
| Embedder  | `EMBEDDING_PROVIDER=local` (ONNX)                        | Gemini — costs quota per run. `FakeEmbedder` (the `runOneIngestion` default) — deterministic but semantically meaningless, so self-retrieval would only prove the sparse channel works                                                                                                                                                    |

## Architecture

### Reuse, don't rebuild

`tests/e2e/src/setup/global-setup.ts` already brings docker-compose up, waits for
Postgres and the parser, and applies migrations. `tests/e2e/src/helpers/ingestion.ts`
exposes `runOneIngestion` for seeding. Both are reused directly.

```
Playwright globalSetup
  └─ call tests/e2e global-setup  → docker up, migrations applied
  └─ seed fixture corpus          → runOneIngestion(db, sourceId, connector, { embedder })
Playwright webServer
  └─ next start (apps/web) against that stack
Playwright specs
  └─ session-cookie fixture → drive the real UI
```

New code is the Playwright config, the auth fixture, the fixture corpus, and the
specs. No new stack management.

### Location

`apps/web/e2e/`, as its own Playwright project.

Not inside `tests/e2e`: that suite runs vitest with `singleFork` and
`fileParallelism: false` because every spec shares one Postgres. Playwright
brings its own runner and worker model; colocating them would mean one runner
driving the other. Colocating with the app under test also matches how the repo
already scopes tests (`foo.ts` → `foo.test.ts`).

### Auth fixture

A Playwright fixture signs a NextAuth session JWT with `AUTH_SECRET` and sets it
via `context.addCookies()` before the first navigation.

This exercises the genuine path: `middleware.ts` reads `req.auth`, the BFF route
handlers mint a per-user scope token, and retrieval is scope-threaded. The only
thing skipped is the Entra handshake, which is Microsoft's code, not ours.

The fixture takes the user identity as a parameter so a later spec can assert two
users see different scoped results without new infrastructure.

### Embedder coherence — load-bearing

`runOneIngestion`'s own docstring warns that the embedder used to seed **must**
match the one used to query, or dense scores compare vectors from two different
embedding spaces and are meaningless. The Playwright globalSetup and the API the
web app talks to therefore both pin `EMBEDDING_PROVIDER=local`. A mismatch here
does not fail loudly — it silently degrades retrieval to the sparse channel and
makes assertion 2 pass for the wrong reason.

## What we assert

Every assertion is an invariant. None matches answer prose, because the generator
is nondeterministic. **The fixtures supply their own ground truth**, which is what
removes the need for a golden corpus.

1. **Citation resolution.** For every citation chip rendered, `/api/documents/[id]`
   returns 200 and its title matches the chip's text. Catches a fabricated
   citation at the layer the user actually sees.

2. **Self-retrieval.** A fixture document contains a distinctive nonce phrase that
   appears nowhere else in the corpus. Ask the question only that document can
   answer; assert it appears among the citations. The corpus is its own oracle —
   no hand-authored expected answer.

3. **Out-of-corpus refusal.** Ask something absent from the corpus. Assert the UI
   renders a refusal **and zero citations**. A refusal that still cites documents
   is confabulation, and citation count is the objective half of that check.

4. **Query-appropriate context.** Two fixtures on clearly distinct topics. A
   query specific to A must cite A and must not cite B. This is the "accurate
   context based on their query" property, expressed as a precision check that
   does not need a relevance label.

5. **UI faithfulness.** Intercept the `/api/chat` response; assert the set of
   citations it returned equals the set rendered as chips. This is the assertion
   the API-level grounding check structurally cannot make, and the main reason
   this suite exists.

### What we deliberately do not assert

- **Answer wording or quality.** Nondeterministic; `pnpm eval` and
  `eval-faithfulness.spec.ts` own that.
- **Properties already covered by `scripts/check-kb-grounding.mjs`** beyond what
  is needed to reach the UI assertions. Duplicating them costs wall-clock and
  gives two places to update.
- **Entra sign-in itself.** Out of scope by the auth decision above.

## Fixture corpus

Exactly two short markdown documents, committed under `apps/web/e2e/fixtures/`.

Two is the minimum that satisfies every assertion: each carries its own nonce
phrase (assertion 2), and their disjoint topics give assertion 4 its A/B pair.
Assertion 3 needs no fixture — it asks about something absent.

That maps onto **three chat requests** per run, which is the whole generator
cost: one nonce question (which assertions 1, 2 and 5 all observe), one
out-of-corpus question (3), and one topic-A query (4).

Constraints:

- Each carries a nonce phrase unique in the corpus (assertion 2).
- Two are topically disjoint (assertion 4).
- **No `1099`+amount or `W2`+amount co-occurrence.** The generation-time TRI guard
  scans the whole assembled input — question plus every retrieved chunk — so a
  trigger in any top-k chunk refuses the answer. Three real documents carrying
  such a span caused ~36% of production questions to fail
  (`docs/PILOT-LAUNCH-STATUS.md`). A fixture that trips this would fail the suite
  for a reason unrelated to retrieval, and the failure would look like a
  retrieval bug.

## Changes to production code

`data-testid` attributes on the assistant message, the citation chip, and the
refusal/error states in `apps/web/src/components/chat-interface/`. The chat UI has
none today.

The alternative is selecting on rendered prose, which is exactly the
nondeterministic surface this design avoids everywhere else.

## Error handling and failure modes

| Failure                     | Expected behaviour                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker unavailable          | `global-setup` already fails with an actionable message and honours `E2E_SKIP_DOCKER_UP=1`                                                                                                                                         |
| Generator API error / quota | Spec fails with the provider's error surfaced, not a timeout — the request is awaited explicitly                                                                                                                                   |
| Streaming never completes   | Explicit timeout on the citation chips appearing; citations arrive at stream end via `onDone`, so an absent chip set means either no citations or a broken stream. The two are distinguished by assertion 5's intercepted response |
| Embedder mismatch           | Not silently tolerated — globalSetup asserts the configured provider matches what seeded the corpus                                                                                                                                |

## Testing this suite

The specs are the tests. Their own correctness is checked by mutation: delete the
citation-rendering block and assertion 5 must fail; seed the nonce into both
fixtures and assertion 4 must fail. Any assertion that survives its mutation is
not pinning what it claims.

## Out of scope

- Admin pages (`/admin/access`, `/admin/docs-gap-digest`)
- Upload and ingestion flows through the UI
- Multi-user scope isolation — the auth fixture is built to allow it later
- Running against the deployed Railway KB — a possible later config of the same specs
