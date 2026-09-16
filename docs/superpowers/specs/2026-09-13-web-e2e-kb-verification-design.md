# Design: browser e2e verification of the KB through the web app

**Date:** 2026-09-13
**Status:** revised after plan review; ready for an implementation plan
**Scope:** a Playwright suite that proves retrieval, citation resolution, and
grounded answers through the real web UI.

## Why this exists

`scripts/check-kb-grounding.mjs` already verifies the KB's core properties
against a deployed instance — citation validity, self-retrieval, out-of-corpus
refusal — at the HTTP API level.

Nothing verifies the **web app**. `apps/web` has no browser test infrastructure:
`package.json` has vitest only, and there is not one `data-testid` across its 50
source files. A regression that drops citations between the BFF response and the
rendered chips, breaks the auth gate, or renders a refusal as an empty bubble
ships green today.

## What the first draft got wrong

Kept deliberately. Four claims did not survive contact with the repo, and each
would have cost a day to discover mid-implementation.

| Claim                                                  | Reality                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Reuse the `tests/e2e` stack; no new stack management" | That harness never binds a port — `tests/e2e/src/helpers/api.ts:20`: _"The app does NOT bind a port — every test runs via Fastify's inject API."_ The BFF calls `RAG_API_URL` over HTTP, so a listening `apps/api` is a **fourth process** this design must own |
| "Mint a session cookie signed with `AUTH_SECRET`"      | Auth.js v5 **JWE-encrypts** it (`alg: dir`, `enc: A256CBC-HS512`), keyed by HKDF over `AUTH_SECRET` **salted with the cookie name**. "Signed" is wrong and the salt binding is mandatory                                                                        |
| "Query A cites A and not B"                            | `DEFAULT_TOP_K=12` against two fixtures retrieves both every time, and `filterCitationsToAnswer` means citations reflect what the model _chose_ to cite — nondeterministic model behaviour, the exact surface this design forbids elsewhere                     |
| "`EMBEDDING_PROVIDER=local`"                           | `config.ts:633` defaults the model provider-independently to `gemini-embedding-001`, handing a Gemini id to the ONNX loader. Crashes on first `embed()`                                                                                                         |

A fifth, worse, was missing entirely: **a fixture user retrieves nothing.** See
"Access grant".

## Decisions

| Decision   | Choice                                                            | Rejected, and why                                                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer      | Browser e2e                                                       | Deepening the API-level check cannot see the UI layer, which is the gap                                                                                                                                                                                                                                                               |
| Test auth  | Mint an Auth.js session cookie                                    | `WEB_AUTH_MODE=static-fallback` is a production break-glass override; a suite inside it never exercises per-user session → scope-token → scope-threaded retrieval, so a scope-leak regression passes green. Real Entra sign-in needs a tenant account, CI secrets, MFA screens                                                        |
| Target     | Local stack, seeded fixture corpus                                | The deployed Railway KB shifts under us, cannot gate CI, and spends production quota                                                                                                                                                                                                                                                  |
| Generator  | Ollama (OpenAI-compatible), local                                 | `gemini` was the first choice, to match production — but it contradicts the reason the local stack was chosen at all, dragging a CI secret, quota spend and network flakiness back into a suite justified on being hermetic. Stubbing is the other extreme: it removes refusal behaviour entirely. See "Why not the production model" |
| Embedder   | `local` (ONNX) **with `EMBEDDING_MODEL=Xenova/bge-base-en-v1.5`** | Gemini costs quota per run. `FakeEmbedder` is semantically meaningless, so self-retrieval would only prove the sparse channel works                                                                                                                                                                                                   |
| Location   | New package `tests/web-e2e`                                       | `apps/web/e2e/` drags `pg`, `undici`, `@rag/db`, `@rag/ingestion` — transitively `@huggingface/transformers` and the AWS/OpenAI/Anthropic SDKs — into the Next.js dependency graph                                                                                                                                                    |
| TRI policy | `GENERATION_TRI_POLICY=warn`                                      | `block` is not what production runs, and under it a TRI block is indistinguishable from a genuine refusal                                                                                                                                                                                                                             |

## Architecture

### Four processes, not two

```
1. docker-compose   Postgres + parser       (reuses tests/e2e global-setup)
2. apps/api         Fastify, LISTENING      ← the first draft omitted this entirely
3. apps/web         next start              BFF → RAG_API_URL
4. Playwright       drives the browser
```

Process 2 is new: the Playwright globalSetup must start it, health-check it, and
tear it down. Use `apps/api`'s **`start`** script (compiled `dist/`), never `dev`
— `dev` runs `tsx watch --env-file-if-exists=../../.env`, which would silently
load the developer's real `.env` (real keys, real `DATABASE_URL`) into a suite
whose whole premise is hermeticity.

**On reusing `@rag/e2e`: copy, don't import.** An earlier draft treated this as
free. It is not: that package has no `main`, no `exports` and no build script, so
it is not consumable; pnpm symlinks it into `node_modules`, where Playwright's
TypeScript transform does not reach; and its `globalSetup` is a _vitest_
signature, not Playwright's. Making it importable means an exports map, a build
step, and knock-on changes to build ordering and the pre-push hook.

The cheaper, more honest trade is to duplicate the ~40 lines of docker-wait plus
`applyMigrations` into the Playwright globalSetup. Duplication here beats
reshaping the build graph to avoid it.

### Environment matrix

All required; the suite asserts each is set before booting anything.

> ⚠ **Harness-only, and production-hostile.** These are written for a machine
> where `127.0.0.1` really is the Ollama host. On Railway `127.0.0.1` is the
> container itself, and `EGRESS_ALLOWED_HOSTS` _replaces_ rather than merges — so
> copying this block into a deployed service drops
> `generativelanguage.googleapis.com` and fails every embedding call, stopping
> ingestion and answering alike. Never set these on a deployed service.

| Variable                                                                     | Value                               | Why it matters                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                               | e2e Postgres                        | Web, API and seeding must share one database                                                                                                                                                                                                                                                                                            |
| `RAG_API_URL`                                                                | `http://localhost:<api port>`       | The BFF has no other way to reach the API                                                                                                                                                                                                                                                                                               |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL`                                     | `local` / `Xenova/bge-base-en-v1.5` | Provider alone leaves a Gemini model id in place                                                                                                                                                                                                                                                                                        |
| `CHUNK_SIZE`                                                                 | `512`                               | Configures the API/worker, where the local provider caps at 512. **It does not reach the seeder** — `runOneIngestion` never reads env, taking `overrides?.chunkSize ?? 800`. Pass `{ chunkSize: 512 }` at the call site too, or seeded chunks exceed the model's limit and are silently truncated                                       |
| `GENERATION_PROVIDER`                                                        | `openai`                            | Required for a self-hosted endpoint. `gemini` with a `GENERATION_BASE_URL` set **throws at startup**                                                                                                                                                                                                                                    |
| `GENERATION_MODEL`                                                           | `llama3.1:8b`                       | The name the Ollama server exposes, not a HuggingFace id                                                                                                                                                                                                                                                                                |
| `GENERATION_BASE_URL`                                                        | `http://127.0.0.1:11434/v1`         | Ollama's OpenAI-compatible endpoint. Note the `/v1`                                                                                                                                                                                                                                                                                     |
| `EGRESS_ALLOWED_HOSTS`                                                       | `127.0.0.1`                         | Deny-by-default allow-list validating the host actually called; omit it and every answer is `EGRESS_BLOCKED` (503)                                                                                                                                                                                                                      |
| `GENERATION_TRI_POLICY`                                                      | `warn`                              | Matches production; stops TRI blocks masquerading as refusals                                                                                                                                                                                                                                                                           |
| `AUTH_SECRET`                                                                | ≥32 chars                           | Derives the session-cookie encryption key                                                                                                                                                                                                                                                                                               |
| `AUTH_URL` or `AUTH_TRUST_HOST`                                              | set                                 | Under `next start`, `NODE_ENV=production` makes `trustHost` false and `auth()` errors on every navigation                                                                                                                                                                                                                               |
| `AUTH_ENTRA_*`                                                               | dummy values                        | Harmless belt-and-braces. The justification an earlier draft gave — "`@auth/core` asserts on provider config at init" — is **false**: the only init-time provider assertion fires when a provider has neither issuer nor endpoints, and `auth.ts` always supplies an issuer template. Keep the dummies; do not reason from that premise |
| `INTERNAL_SCOPE_JWT_SECRET` (web) **and** `INTERNAL_SCOPE_JWT_SECRETS` (API) | same ≥64-char value                 | Two variables, not one: the web BFF reads the **singular** (`apps/web/src/lib/scope-token.ts:16`), the API reads the **plural** comma-separated list (`config.ts:663`). Each entry validates `.min(64)`. Set only one and the other side cannot mint or verify                                                                          |
| `API_TOKENS`                                                                 | any non-empty value                 | `z.array(z.string()).min(1)` (`config.ts:74`). Unset → empty array → zod throws → `apps/api` exits 1 before it ever listens, and every later failure is noise                                                                                                                                                                           |
| `API_PORT` and the web `PORT`                                                | two distinct ports                  | Both default to 3000 (`config.ts:649`, and `next start`). Left unset they collide: `EADDRINUSE`, or worse, the BFF proxying to itself                                                                                                                                                                                                   |

### Auth fixture

Produce the cookie with `encode` from `next-auth/jwt` — never a hand-rolled JWT:

- The token is JWE-encrypted; the key is HKDF over `AUTH_SECRET` with
  **salt = the cookie name**, and `salt` has no default in `encode`, so it must
  be passed explicitly.
- The cookie is `authjs.session-token` on `http://localhost` — no `__Secure-`
  prefix, and note `authjs.`, not NextAuth v4's `next-auth.`.
- The payload must carry **`oid`**: `rag-api.ts` gates on `session?.oid`.

The fixture takes the identity as a parameter, so multi-user scope isolation is a
later spec rather than new infrastructure.

**Guard assertion:** one spec asserts the minted cookie yields 200 from a gated
route, so a future Auth.js bump fails in one obvious place rather than as five
mysterious failures.

### Access grant — without this the suite proves nothing

`getScopeAssertionToken(oid)` → `resolveSourceIdsForUser(db, oid)`, which reads
**only** `staff_client_assignments` / `staff_source_assignments`. A fresh fixture
user has neither, and an empty scope is fail-closed by design
(`packages/core/src/oidc-auth.ts:94-98`: _"An empty union is intentional
fail-closed (scoped to nothing => zero rows), NOT all-access"_).

The failure mode is the dangerous kind: retrieval returns zero rows,
`askQuestion` short-circuits to `EMPTY_ANSWER` with no citations, assertions 1, 2
and 4 fail — and **assertion 3 passes for entirely the wrong reason.** Green, and
proving nothing.

globalSetup therefore seeds a grant for the fixture `oid` against the fixture
source, and **asserts `resolveSourceIdsForUser` is non-empty before any spec runs.**

### Embedder coherence

`runOneIngestion` defaults to `FakeEmbedder`, and its docstring warns that the
seeding and querying embedders must match or dense scores compare different
embedding spaces. That failure is silent: hybrid retrieval still matches on the
sparse channel, so self-retrieval would pass for the wrong reason.

The catch is concrete — `chunks.embedding_provider` and `chunks.embedding_model`
(`packages/db/src/schema.ts:213-214`) record what seeded each chunk. globalSetup
asserts those columns match the configured provider.

## Generation: standing up Ollama

### Why not the production model

`gemini` was the first choice, on the reasoning that matching production makes
refusal behaviour authentic. That reasoning does not survive scrutiny: it
reintroduces a CI secret, quota spend, and network flakiness into a suite whose
entire justification was hermeticity. The two decisions contradicted each other.

An earlier version of this section claimed assertions 0, 1 and 4 have **no**
dependence on the model. That was wrong, and it contradicted this document's own
reason for dropping the A/B precision assertion: `filterCitationsToAnswer` sits
between retrieval and the rendered chips, keeping only citations whose `[N]`
markers the model actually emitted. The model gates whether any chip exists.

Worse, that dependence fails **open**. With zero markers there are no chips, so
"every chip resolves" is `[].every(...)` — true — and "done-frame citations equal
rendered chips" is zero equals zero. Two assertions would have gone green while
checking nothing: the same fail-open trap this document identifies for the access
grant, reintroduced one section later.

### Measured, not argued

Rather than reason about whether an 8B model emits `[N]`, it was measured: the
real `SYSTEM_PROMPT`, through the real `OpenAIGenerator`, against local Ollama,
with the real `filterCitationsToAnswer` applied to the output.

| Case                   | Runs | ≥1 citation | Exact refusal sentence | Refusal carrying a citation |
| ---------------------- | ---- | ----------- | ---------------------- | --------------------------- |
| Answerable question    | 8    | **8/8**     | 0/8                    | —                           |
| Out-of-corpus question | 6    | **6/6**     | **6/6**                | **6/6**                     |

Three conclusions, two of which overturn earlier claims here:

1. **Marker compliance is not the risk it looked like.** 8/8 on the answerable
   path. The globalSetup compliance gate stays — as a cheap guard, not as
   mitigation for a likely failure.
2. **A correct refusal carries a citation.** 6/6, deterministically, because
   branch C instructs it: _"If any retrieved document is plausibly adjacent, add
   one line: `Closest related material: <title> [N]`"_ (`generator.ts:57`). The
   earlier "refusal renders with zero citations" assertion would have failed
   **100% of the time on correct behaviour**.
3. **Generation is not a wall-clock problem.** ~5s per call, so three chat
   requests is ~15s. An earlier revision corrected "three requests is the whole
   cost" to "plausibly minutes each"; the measurement lands nearer the original.

Scope caveat: one question per category, 14 calls, one model, a fabricated
two-document context. Enough to retire a risk and pin a 6/6 deterministic
behaviour; not enough to claim a precise long-run compliance rate.

Fidelity — whether the _production_ model refuses well — remains owned by
`scripts/check-kb-grounding.mjs`, which measured 3/3 against the deployed KB.

### Setup

`docs/LOCAL-GENERATION.md` documents this path; it exists for deployments that
cannot use a hosted API at all. Note that doc's own caveat: the server shapes it
lists are documented defaults, "not exercised in this environment" — so treat the
first run as the thing that proves it.

```bash
# 1. Install (macOS; see ollama.com for Linux/CI packages)
brew install ollama

# 2. Start the server — listens on 127.0.0.1:11434
ollama serve &

# 3. Pull the model. ~4.7GB for llama3.1:8b; this is the slow step,
#    and the one CI must cache.
ollama pull llama3.1:8b

# 4. Verify the OpenAI-compatible surface answers, not just that the port is open
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.1:8b","messages":[{"role":"user","content":"reply with OK"}]}' \
  | head -c 200
```

Then the four variables in the matrix above. Two traps worth stating:

- **`GENERATION_PROVIDER` must be `openai`, not `ollama`.** There is no ollama
  provider; the endpoint is consumed through the OpenAI-compatible client.
  `gemini` plus a base URL throws at startup by design.
- **`GENERATION_API_KEY` stays unset.** A placeholder is sent automatically
  because the OpenAI SDK requires a non-empty value. Precedence is deliberate: a
  configured `GENERATION_BASE_URL` gets the placeholder and **never** inherits the
  embedding provider's key, on the grounds that a self-hosted endpoint is not
  verifiably yours. Do not "fix" a perceived missing key by setting
  `GEMINI_API_KEY`.

### Verifying it is actually local

Remove `127.0.0.1` from `EGRESS_ALLOWED_HOSTS`, restart, and ask a question: it
must fail `EGRESS_BLOCKED` (503). If it still answers, generation is not going
where you think it is.

## What we assert

Invariants only; none matches answer prose, because the generator is
nondeterministic. **The fixtures are their own oracle** — that is what removes the
need for a golden corpus.

Every citation assertion must **first assert the chip set is non-empty**. With
zero markers the per-chip checks are vacuously true, so without that guard they
fail open — see "Measured, not argued".

0. **Preconditions, asserted in globalSetup before any spec runs.** Three, each
   closing a fail-open surface found the hard way:
   - the minted cookie yields 200 from a gated route;
   - `resolveSourceIdsForUser(FIXTURE_OID)` is non-empty;
   - one canned ask through the API returns `citations.length > 0`, failing with
     _"the configured generation model did not emit [N] markers — citation
     assertions cannot be trusted"_.

   Then, as a spec: minted cookie → `GET /api/sources` returns 200 and lists the
   fixture source. If this fails, every later failure is noise.

1. **Citation resolution.** Assert at least one chip rendered, then that every
   chip's document id resolves via `/api/documents/[id]` to 200 with a matching
   title. Catches fabricated citations at the layer the user actually sees.

2. **Self-retrieval.** A fixture carries a nonce phrase unique in the corpus. Ask
   what only it can answer; assert it is cited.

3. **Out-of-corpus refusal.** Ask something absent; assert the answer contains the
   exact branch-C sentence, _"The available documents do not contain enough
   information to answer that."_, and that the `stream-error` element is absent.

   **Citations are explicitly permitted here** — measured 6/6, because the prompt
   instructs the model to append `Closest related material: <title> [N]`. Asserting
   zero citations would fail on correct behaviour every time. The absent-error
   check is what stops a TRI block masquerading as a refusal: both yield no chips,
   so citation count cannot tell them apart.

4. **UI faithfulness.** Assert the chip set is non-empty, then that it equals the
   citations in the SSE `done` frame. Honest framing: the component maps citations
   to chips without filtering, so this catches the `length > 0` guard and key
   collisions — real, but narrower than the first draft claimed.

### Dropped: query-appropriate context

"Query A cites A, not B" is unsound here. `DEFAULT_TOP_K=12` over two fixtures
retrieves both regardless of query, and citations are filtered to what the model
chose to cite — so the assertion tests model behaviour, which this design forbids
everywhere else. Deferred to future work as a **retrieval-rank** assertion (A
outranks B in `retrieved`) rather than citation exclusion.

### Reading the stream without breaking it

`page.route()` + `route.fetch()` buffers the whole body, destroying the streaming
under test and exercising a path users never hit. Instead an init script wraps
`window.fetch` and `tee()`s the response body: one branch to the app, one
accumulated for the test. The app consumes a genuine unbuffered stream; the test
sees identical bytes.

## Changes to production code

Two of these are attributes; two are real changes. Calling all four "attributes"
understated the largest unscoped item in this design.

- `assistant-message`, `citation-chip` — genuinely just attributes on existing
  elements.
- `stream-error` — **needs new structure.** There is no error element today; the
  error path appends into the same content string
  (``updateMessage(assistantId, { appendContent: `\n\n_Error: ${message}_` })``),
  so a stream error and a refusal are literally the same DOM node with different
  prose. Assertion 3 requires telling them apart, which means lifting error
  rendering out of `message.content` into its own element — and deciding what
  becomes of the existing markdown-italic convention.
- `refusal` — **needs a classification decision.** Something must decide an answer
  _is_ a refusal. Matching the `EMPTY_ANSWER` constant is the only non-circular
  option; classifying by "zero citations" would make assertion 3 circular and is
  wrong anyway, since measured refusals carry a citation. Note this duplicates a
  judgement the service layer already makes — worth deciding deliberately whether
  refusal classification belongs in the web layer at all.

`apps/web` has none today, so this introduces a convention. The alternative is
selecting on rendered prose — the nondeterministic surface avoided everywhere else.

## CI and the pre-push hook

`.husky/pre-push:15` runs `pnpm -r build && pnpm -r --filter '!@rag/e2e' run test`,
excluding `@rag/e2e` only. A `test` script in a new package would boot docker,
download a 430 MB ONNX model and spend LLM quota **on every push**.

The package therefore exposes `test:browser`, not `test`, and the pre-push filter
widens to `'!@rag/*e2e'`. One nuance: `pnpm` silently skips packages without the
named script, so exposing `test:browser` is the actual protection — the widened
filter is belt-and-braces against a future accidental `test` script.

CI runs it as its own job needing **no secrets at all**. But secret-free is not
network-free, and the two should not be blurred: on a cold cache the job still
pulls ~430 MB from `huggingface.co` and ~4.7 GB from Ollama's registry, and those
downloads do **not** go through `EgressPolicy` (transformers.js uses its own
fetch). So the "drop 127.0.0.1 and confirm EGRESS_BLOCKED" check proves the
_generation call_ is local, not that the suite is hermetic end to end.

What the job needs is therefore caches rather than secrets: a HuggingFace cache,
an Ollama model cache, and a Playwright browser-install step. Uncached those
dominate; cached they are close to free.

## Acceptance criteria

- Assertions 0–4 pass against the seeded corpus via one command.
- Each fails under its mutation: delete the citation-rendering block → 4 fails;
  remove the access grant → 0 fails; point the seeder at `FakeEmbedder` → the
  coherence assertion fails. An assertion surviving its mutation is not pinning
  what it claims.
- `pnpm -r run test` and the pre-push hook do **not** invoke it.
- **Wall clock.** Generation is measured, not guessed: ~5s per call on local CPU,
  so the three chat requests cost ~15s. This budget has now been wrong twice in
  both directions — the first draft ignored setup entirely, and the correction
  overshot to "plausibly minutes each" for local inference. The measurement lands
  nearer the first.

  Setup dominates instead: cold, the run pays two model downloads (430 MB ONNX +
  ~4.7 GB `llama3.1:8b`) plus docker start.

  **Warm (measured).** `pnpm --filter @rag/web-e2e test:browser` alone — docker
  containers, the Ollama model, and the HF embedding weights already warm,
  workspace already built — ran twice back to back at 10.65s and 11.17s wall
  clock, both exit 0, 11/11 passing. The full local pipeline (`pnpm install
--frozen-lockfile && pnpm -r build && playwright install --with-deps
chromium && test:browser`, everything still cache-warm so install/build/
  browser-install were all no-ops or near-instant) measured 29.82s wall
  clock, exit 0. Both numbers are far under the ~10-minute budget.

  **Cold (estimated, not measured).** This task ran in a local dev worktree
  with Postgres/parser containers and the Ollama model already shared across
  concurrent sessions, and the harness's own sandbox policy blocks `rm -rf`
  — so a true from-scratch run (empty `node_modules`, no Docker images
  pulled, no Ollama binary, no model weights) could not be safely reproduced
  here without risking other worktrees' running containers or re-pulling
  ~5 GB this machine already has cached. The figure below is a documented
  estimate, not a measurement, and should be replaced with the real number
  from the first actual `web-e2e.yml` CI run: pnpm install (cold, ~1–3 min)
  - docker image pull/parser build (~1–2 min) + Ollama install script
    (~15–30s) + `ollama pull llama3.1:8b` at typical GH Actions bandwidth
    (~3–5 min for ~4.7 GB) + HF ONNX download (~430 MB, well under 1 min) +
    clean workspace build (~1–2 min) + Playwright chromium install (~30–40s)
  - the ~11s measured test run ⇒ roughly **8–14 minutes**, most likely
    landing near 10–12. Warm is already measured at well under a minute, so
    the ~10-minute budget in this criterion applies there and is met with
    large margin; if cold alone is the concern, the caches this workflow adds
    (HuggingFace + Ollama) are what collapse it to the warm number on every
    run after the first. If a real run ever pushes warm over ~10 minutes, the
    lever is a smaller generation model — not dropping assertions, and not
    returning to a hosted key.

## Out of scope

- Admin pages; upload and ingestion through the UI
- Multi-user scope isolation — the auth fixture is shaped to allow it
- Query-appropriate context — see "Dropped"
- Running against the deployed Railway KB — a later config of the same specs
