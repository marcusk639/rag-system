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

`global-setup.ts` is still reused for docker boot and migrations, and
`runOneIngestion` for seeding. Process 2 is new: the Playwright globalSetup must
start it, health-check it, and tear it down.

### Environment matrix

All required; the suite asserts each is set before booting anything.

| Variable                                 | Value                               | Why it matters                                                                                                                           |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                           | e2e Postgres                        | Web, API and seeding must share one database                                                                                             |
| `RAG_API_URL`                            | `http://localhost:<api port>`       | The BFF has no other way to reach the API                                                                                                |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | `local` / `Xenova/bge-base-en-v1.5` | Provider alone leaves a Gemini model id in place                                                                                         |
| `CHUNK_SIZE`                             | `512`                               | `config.ts` caps this for the local provider; `runOneIngestion` does not, so seeded chunks would exceed the model limit and be truncated |
| `GENERATION_PROVIDER`                    | `openai`                            | Required for a self-hosted endpoint. `gemini` with a `GENERATION_BASE_URL` set **throws at startup**                                     |
| `GENERATION_MODEL`                       | `llama3.1:8b`                       | The name the Ollama server exposes, not a HuggingFace id                                                                                 |
| `GENERATION_BASE_URL`                    | `http://127.0.0.1:11434/v1`         | Ollama's OpenAI-compatible endpoint. Note the `/v1`                                                                                      |
| `EGRESS_ALLOWED_HOSTS`                   | `127.0.0.1`                         | Deny-by-default allow-list validating the host actually called; omit it and every answer is `EGRESS_BLOCKED` (503)                       |
| `GENERATION_TRI_POLICY`                  | `warn`                              | Matches production; stops TRI blocks masquerading as refusals                                                                            |
| `AUTH_SECRET`                            | ≥32 chars                           | Derives the session-cookie encryption key                                                                                                |
| `AUTH_URL` or `AUTH_TRUST_HOST`          | set                                 | Under `next start`, `NODE_ENV=production` makes `trustHost` false and `auth()` errors on every navigation                                |
| `AUTH_ENTRA_*`                           | dummy values                        | `@auth/core` asserts on OAuth provider config at init even when unused                                                                   |
| `INTERNAL_SCOPE_JWT_SECRET`              | ≥64 chars                           | Shorter throws; must also appear in the API's `auth.internalScopeSecrets`                                                                |

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

Sorting the assertions by how much they actually depend on model quality:

| Assertion                                             | Dependence on the model                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| 0, 1, 4 — smoke, citation resolution, UI faithfulness | None. Citations come from retrieval; the model only picks which to cite |
| 2 — self-retrieval                                    | Minimal. Any model cites the one document that answers the question     |
| 3 — out-of-corpus refusal                             | Real. A small local model may confabulate where Gemini refuses          |

Only assertion 3 carries fidelity risk, and **that risk is already owned
elsewhere**: `scripts/check-kb-grounding.mjs` runs against the deployed KB with
the production model and measured 3/3 correct refusals. Whether _Gemini_ refuses
well is that script's job. Whether _the UI renders a refusal correctly_ is this
suite's job, and a local model exercises it fine.

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

0. **Precondition smoke.** Minted cookie → `GET /api/sources` returns 200 and
   lists the fixture source. Runs first: if it fails, every later failure is noise.

1. **Citation resolution.** Every rendered chip's document id resolves via
   `/api/documents/[id]` to 200 with a matching title. Catches fabricated
   citations at the layer the user actually sees. _The highest-value assertion._

2. **Self-retrieval.** A fixture carries a nonce phrase unique in the corpus. Ask
   what only it can answer; assert it is cited.

3. **Out-of-corpus refusal.** Ask something absent; assert a refusal renders with
   **zero citations**. Requires distinct refusal and stream-error testids: under a
   TRI block the error path also yields zero citations, so one shared testid would
   let a compliance block masquerade as a refusal.

4. **UI faithfulness.** Compare the citations in the SSE `done` frame to the
   rendered chips. Honest framing: the component maps citations to chips without
   filtering, so this catches the `length > 0` guard and key collisions — real,
   but narrower than the first draft claimed.

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

Four `data-testid` attributes in `apps/web/src/components/chat-interface/`:
`assistant-message`, `citation-chip`, `refusal`, `stream-error`. Refusal and error
must be distinct, per assertion 3.

`apps/web` has none today, so this introduces a convention. The alternative is
selecting on rendered prose — the nondeterministic surface avoided everywhere else.

## CI and the pre-push hook

`.husky/pre-push:15` runs `pnpm -r build && pnpm -r --filter '!@rag/e2e' run test`,
excluding `@rag/e2e` only. A `test` script in a new package would boot docker,
download a 430 MB ONNX model and spend LLM quota **on every push**.

The package therefore exposes `test:browser`, not `test`, and the pre-push filter
widens to `'!@rag/*e2e'`. CI runs it as its own job needing **no secrets at all** —
generation and embedding are both local. What the job does need is caching: a
HuggingFace cache for the 430 MB ONNX embedding model, an Ollama model cache for
the ~4.7 GB `llama3.1:8b` pull, and a Playwright browser-install step. Uncached,
those three dominate the run; cached, they are close to free.

## Acceptance criteria

- Assertions 0–4 pass against the seeded corpus via one command.
- Each fails under its mutation: delete the citation-rendering block → 4 fails;
  remove the access grant → 0 fails; point the seeder at `FakeEmbedder` → the
  coherence assertion fails. An assertion surviving its mutation is not pinning
  what it claims.
- `pnpm -r run test` and the pre-push hook do **not** invoke it.
- **Wall clock, measured on the first real run rather than assumed.** Moving
  generation local traded a secret for latency, and the honest budget changed
  twice: the first draft's "three chat requests is the whole cost" ignored setup
  entirely, and the Gemini-era "under 10 minutes warm" assumed hosted inference.
  With Ollama the three answers run on local CPU and are now a **leading** cost,
  not a rounding error — plausibly minutes each on a CI runner without a GPU.

  Cold, the run also pays two model downloads (430 MB ONNX + ~4.7 GB
  `llama3.1:8b`) plus docker start. So: measure the first green run, record the
  warm and cold numbers here, and treat that as the budget. If warm exceeds ~10
  minutes, the lever is a smaller generation model — not dropping assertions,
  and not going back to a hosted key.

## Out of scope

- Admin pages; upload and ingestion through the UI
- Multi-user scope isolation — the auth fixture is shaped to allow it
- Query-appropriate context — see "Dropped"
- Running against the deployed Railway KB — a later config of the same specs
