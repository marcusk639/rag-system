# @rag/e2e

End-to-end integration suite for the RAG system. Spins up the real ingestion
pipeline, real Postgres + pgvector, and the real parser-py sidecar, then drives
the system through critical paths using in-memory fakes for connectors,
embeddings, and generation.

## What "E2E" means here

There is no browser to test. "E2E" is the entire backend chain:

```
FakeConnector → parser-py (HTTP) → CompositeChunker → FakeEmbedder → Postgres
                                                                ↓
                                                         Retriever → /search, /ask
```

External providers (Gemini/OpenAI, Microsoft Graph, Google APIs) are replaced
with deterministic fakes so the suite is hermetic and free.

## Running locally

```bash
pnpm docker:up        # postgres + parser-py
pnpm e2e              # runs the whole suite (boots docker if not already up)
```

The global setup will:

1. Ensure `docker-compose` is up (set `E2E_SKIP_DOCKER_UP=1` if you manage
   services yourself).
2. Wait for Postgres + the parser to be ready.
3. Apply the bootstrap migration (idempotent).

Specs truncate every application table at `beforeEach`, so each spec runs
against a clean slate.

## Layout

```
src/
├── env.ts                  # config + DATABASE_URL/PARSER_URL defaults
├── setup/global-setup.ts   # vitest globalSetup: docker + wait + migrate
├── fakes/
│   ├── fake-connector.ts   # in-memory Connector emitting fixed docs
│   ├── fake-embedder.ts    # deterministic BoW → 768-dim vector
│   ├── fake-generator.ts   # echoes question + context, records calls
│   └── factories.ts        # markdownDoc / plainTextDoc / csvDoc builders
├── helpers/
│   ├── db.ts               # truncateAll, createCustomSource, query helpers
│   ├── ingestion.ts        # runOneIngestion (pipeline w/o pg-boss)
│   └── api.ts              # buildTestApi + inject() with bearer token
└── specs/
    ├── ingestion.spec.ts        # connector → DB happy path
    ├── idempotency.spec.ts      # no-op on unchanged, replace on update
    ├── retrieval.spec.ts        # hybrid search ranking + filters
    ├── spreadsheet.spec.ts      # CSV → TableChunker (validates v0)
    └── api.spec.ts              # /health, /sources, /search, /ask
```

## Environment variables

| Name                 | Default                                 | Purpose                              |
| -------------------- | --------------------------------------- | ------------------------------------ |
| `E2E_DATABASE_URL`   | `postgres://rag:rag@localhost:5432/rag` | Override DB target                   |
| `E2E_PARSER_URL`     | `http://localhost:8000`                 | Override parser-py URL               |
| `E2E_PGBOSS_SCHEMA`  | `pgboss_e2e`                            | Isolate pg-boss tables from dev      |
| `E2E_SKIP_DOCKER_UP` | unset                                   | Set `1` in CI to skip docker-compose |

`DATABASE_URL` and `PARSER_URL` (without the `E2E_` prefix) are accepted as
fallbacks so CI can reuse the project's standard env names.

## Adding a new spec

1. Drop a file under `src/specs/<feature>.spec.ts`.
2. Open the DB once in `beforeAll`, close in `afterAll`.
3. Truncate in `beforeEach` so the test corpus is whatever this spec ingests.
4. Build a `FakeConnector` with the documents you want indexed.
5. Drive ingestion with `runOneIngestion(db, sourceId, connector)`.
6. Assert against the public surface (DB queries, HTTP responses, retriever
   results) — never against pipeline internals.

## What this suite does NOT cover

- **Real OAuth connectors.** SharePoint/GDrive/Gmail/Outlook are network-bound
  and require live credentials. They have their own unit tests; an integration
  pass against real tenants is a follow-up.
- **Real Gemini/OpenAI embeddings.** Provider drift would make this suite
  flaky. A small "smoke against real provider" run can be wired separately,
  gated behind a CI secret.
- **MCP stdio JSON-RPC.** The MCP server is a separate transport; a dedicated
  harness that spawns the process and pipes JSON-RPC is a v2 add.
- **pg-boss enqueue + worker drain.** `/sources/:id/sync` enqueues a job; the
  worker is a separate process. We test ingestion via `runIngestion()`
  directly because that's the meaningful behaviour.

## Flake handling

If a single spec starts to flake, the recipe is:

1. Run it 10× in isolation:
   ```bash
   pnpm --filter @rag/e2e exec vitest run --repeat-each=10 src/specs/<spec>.ts
   ```
2. If the flake is timing-bound, prefer waiting for a concrete condition
   (DB row count, response code) over `setTimeout`.
3. If the flake survives, quarantine with `it.skip(...)` and an issue link —
   never quarantine silently.
