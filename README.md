# RAG System

A generic, source-agnostic Retrieval-Augmented Generation service. Ingests documents from SharePoint, Google Drive, Gmail, and Outlook (extensible to anything else), parses every common format into clean markdown, stores embeddings + metadata in Postgres with pgvector, and exposes retrieval through both an HTTP API and an MCP server for AI agents.

## What's inside

```
rag-system/
├── apps/
│   ├── api/                Fastify HTTP API (search, ask, manage sources)
│   ├── mcp/                MCP server for external agents (stdio + HTTP)
│   ├── web/                Next.js chat UI (BFF over the HTTP API)
│   └── worker/             pg-boss worker for async ingestion
├── packages/
│   ├── core/               Shared types, interfaces, errors
│   ├── db/                 Drizzle schema, migrations, queries (pgvector)
│   ├── rag/                Embeddings, chunking, hybrid retrieval
│   ├── ingestion/          Pipeline orchestration (fetch → parse → chunk → embed → store)
│   ├── connectors/         SharePoint, Google Drive, Gmail, Outlook
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
| Embeddings       | Gemini `text-embedding-004` (free) by default       | High quality, generous free tier. Provider-pluggable.                                          |
| Document parsing | Python sidecar (MarkItDown + Unstructured)          | Best-in-class quality for `.doc`, scanned PDFs, complex Office docs.                           |
| API framework    | Fastify                                             | Fast, schema-first, first-class TypeScript.                                                    |
| Agent surface    | MCP via `@modelcontextprotocol/sdk`                 | Standard protocol — any MCP-capable agent (Claude, IDEs, etc.) can use it.                     |
| Chunking         | Markdown-aware recursive splitter                   | Respects document structure (headings, lists, code blocks). Configurable size + overlap.       |
| Retrieval        | Hybrid dense (pgvector) + sparse (tsvector) via RRF | Dense alone misses keyword/identifier queries; hybrid recovers them.                           |

## Status

Greenfield scaffold. See task list in chat for the build sequence. Each package has its own `README.md` describing the module's contract.
