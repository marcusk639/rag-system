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

| Decision   | Choice                                                            | Rejected, and why                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Layer      | Browser e2e                                                       | Deepening the API-level check cannot see the UI layer, which is the gap                                                                                                                                                                                                        |
| Test auth  | Mint an Auth.js session cookie                                    | `WEB_AUTH_MODE=static-fallback` is a production break-glass override; a suite inside it never exercises per-user session → scope-token → scope-threaded retrieval, so a scope-leak regression passes green. Real Entra sign-in needs a tenant account, CI secrets, MFA screens |
| Target     | Local stack, seeded fixture corpus                                | The deployed Railway KB shifts under us, cannot gate CI, and spends production quota                                                                                                                                                                                           |
| Generator  | `gemini`, matching production                                     | Stubbing removes refusal and grounding, which are properties of the model's response — exactly what we set out to verify. Ollama via `GENERATION_BASE_URL` is the offline fallback if CI cannot hold a key; it needs an `EGRESS_ALLOWED_HOSTS` entry and a model pull          |
| Embedder   | `local` (ONNX) **with `EMBEDDING_MODEL=Xenova/bge-base-en-v1.5`** | Gemini costs quota per run. `FakeEmbedder` is semantically meaningless, so self-retrieval would only prove the sparse channel works                                                                                                                                            |
| Location   | New package `tests/web-e2e`                                       | `apps/web/e2e/` drags `pg`, `undici`, `@rag/db`, `@rag/ingestion` — transitively `@huggingface/transformers` and the AWS/OpenAI/Anthropic SDKs — into the Next.js dependency graph                                                                                             |
| TRI policy | `GENERATION_TRI_POLICY=warn`                                      | `block` is not what production runs, and under it a TRI block is indistinguishable from a genuine refusal                                                                                                                                                                      |

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
| `GENERATION_PROVIDER` + `GEMINI_API_KEY` | `gemini`                            | A missing key **disables generation with a warn**, not a throw — every spec then fails as a 503 rather than a config error               |
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
widens to `'!@rag/*e2e'`. CI runs it as its own job with a `GEMINI_API_KEY` secret,
a Playwright browser-install step, and a HuggingFace model cache.

## Acceptance criteria

- Assertions 0–4 pass against the seeded corpus via one command.
- Each fails under its mutation: delete the citation-rendering block → 4 fails;
  remove the access grant → 0 fails; point the seeder at `FakeEmbedder` → the
  coherence assertion fails. An assertion surviving its mutation is not pinning
  what it claims.
- `pnpm -r run test` and the pre-push hook do **not** invoke it.
- Under 10 minutes warm. The first run is dominated by the model download and
  docker cold start, not the three LLM calls — the first draft's "three chat
  requests is the whole cost" understated runtime by an order of magnitude.

## Out of scope

- Admin pages; upload and ingestion through the UI
- Multi-user scope isolation — the auth fixture is shaped to allow it
- Query-appropriate context — see "Dropped"
- Running against the deployed Railway KB — a later config of the same specs
