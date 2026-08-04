# RAG System

A generic, source-agnostic Retrieval-Augmented Generation service. Ingests documents from SharePoint, Google Drive, Gmail, Outlook, a local git markdown clone, and the eCFR bulk-XML mirror (extensible to anything else), parses every common format into clean markdown, stores embeddings + metadata in Postgres with pgvector, and exposes retrieval through an HTTP API, an MCP server for AI agents, a Next.js chat UI, and a Microsoft Teams bot.

## What's inside

```
rag-system/
├── apps/
│   ├── api/                Fastify HTTP API (search, ask, manage sources)
│   ├── mcp/                MCP server for external agents (stdio + HTTP)
│   ├── teams-bot/          Microsoft Teams bot (Entra SSO, Adaptive Cards)
│   ├── web/                Next.js chat UI (BFF over the HTTP API)
│   └── worker/             pg-boss worker for async ingestion
├── packages/
│   ├── core/               Shared types, interfaces, errors
│   ├── db/                 Drizzle schema, migrations, queries (pgvector)
│   ├── rag/                Embeddings, chunking, hybrid retrieval
│   ├── ingestion/          Pipeline orchestration (fetch → parse → chunk → embed → store)
│   ├── connectors/         SharePoint, Google Drive, Gmail, Outlook, git-markdown, eCFR
│   ├── runtime/            Shared dependency-graph wiring (buildCoreDeps)
│   ├── services/           Transport-agnostic search/ask/sources/documents logic
│   └── test-fixtures/      Shared fixtures/helpers for tests across packages
├── services/
│   └── parser-py/          Python sidecar — MarkItDown + Unstructured for any format
├── docker/                 Local dev stack (Postgres + parser)
└── docs/                   Architecture, connector setup, API reference, MCP reference
```

## Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env template and fill in API keys (at minimum: GEMINI_API_KEY)
cp env.example .env

# 3. Boot Postgres + Python parser
pnpm docker:up

# 4. Apply database schema
pnpm db:migrate

# 5. Run the API, MCP server, and worker (in separate terminals)
pnpm dev:api
pnpm dev:mcp
pnpm dev:worker
```

See [`docs/`](./docs) for deeper topics:

- [Architecture](./docs/ARCHITECTURE.md) — data flow, components, design tradeoffs
- [Connectors](./docs/CONNECTORS.md) — OAuth setup per provider, writing new connectors
- [API](./docs/API.md) — HTTP endpoint reference
- [MCP](./docs/MCP.md) — agent-facing tool reference
- [Deployment](./docs/DEPLOYMENT.md) — Docker, env vars, scaling

## Why these choices

| Concern          | Choice                                              | Why                                                                                            |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Vector store     | Postgres + pgvector                                 | One database for embeddings, metadata, and job queue. Easy to operate, easy to query with SQL. |
| Job queue        | pg-boss                                             | Rides on Postgres — no extra Redis/RabbitMQ infrastructure.                                    |
| Embeddings       | Gemini `gemini-embedding-001` (768-d) by default    | High quality, generous free tier. Provider-pluggable (`local` ONNX and OpenAI also ship).      |
| Document parsing | Python sidecar (MarkItDown + Unstructured)          | Best-in-class quality for `.doc`, scanned PDFs, complex Office docs.                           |
| API framework    | Fastify                                             | Fast, schema-first, first-class TypeScript.                                                    |
| Agent surface    | MCP via `@modelcontextprotocol/sdk`                 | Standard protocol — any MCP-capable agent (Claude, IDEs, etc.) can use it.                     |
| Chunking         | Markdown-aware recursive splitter                   | Respects document structure (headings, lists, code blocks). Configurable size + overlap.       |
| Retrieval        | Hybrid dense (pgvector) + sparse (tsvector) via RRF | Dense alone misses keyword/identifier queries; hybrid recovers them.                           |
| Reranking        | Optional cross-encoder over the fused pool          | Ships and is tested; **off by default** (`RERANK_PROVIDER=none`). Enable per deployment.       |

## Status

**Deployed and running a scoped pilot** (first deployment: an accounting firm's internal SharePoint knowledge base, ~858 documents). The API, MCP server, worker, and web chat UI run on Railway; the Teams bot is built and merged but not yet deployed.

For what is actually true right now — deployed surfaces, open gates, and known defects — see [`docs/TWK-LAUNCH-STATUS.md`](./docs/TWK-LAUNCH-STATUS.md). Do not treat any `docs/PLAN-*.md` checkbox as a status signal; those are execution guides, not trackers.

A full map of the documentation set is in [`docs/README.md`](./docs/README.md).
