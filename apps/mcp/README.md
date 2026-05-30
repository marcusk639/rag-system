# @rag/mcp

Model Context Protocol server for the RAG system. This is the agent-facing
surface — Claude Desktop, IDE agents, and any other MCP-capable client can
search and ask questions against the indexed corpus through this server.

## Transports

Two transports are supported, chosen by `MCP_TRANSPORT`:

| Transport | When to use                                                                           |
| --------- | ------------------------------------------------------------------------------------- |
| `stdio`   | Local agents that spawn the server as a child process (e.g. Claude Desktop). Default. |
| `http`    | Remote/shared deployments. Streamable HTTP per MCP spec, mounted at `/mcp`.           |

For `stdio`, all logs are written to **stderr** because stdout carries the
JSON-RPC protocol frames.

## Running locally

```bash
# build the workspace once
pnpm install
pnpm --filter @rag/mcp build

# stdio (the default — sits idle waiting for a client to attach)
pnpm --filter @rag/mcp start

# HTTP on port 3001
MCP_TRANSPORT=http MCP_HTTP_PORT=3001 pnpm --filter @rag/mcp start
```

For development with hot reload: `pnpm dev:mcp`.

The server expects a Postgres database with the RAG schema applied
(`pnpm db:migrate`) and a running worker for `trigger_sync` jobs to make
progress.

## Claude Desktop configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the equivalent path on your OS:

```json
{
  "mcpServers": {
    "rag": {
      "command": "node",
      "args": ["/absolute/path/to/rag-system/apps/mcp/dist/main.js"],
      "env": {
        "DATABASE_URL": "postgres://rag:rag@localhost:5432/rag",
        "EMBEDDING_PROVIDER": "gemini",
        "EMBEDDING_MODEL": "text-embedding-004",
        "EMBEDDING_DIMENSIONS": "768",
        "GEMINI_API_KEY": "your-key",
        "PARSER_URL": "http://localhost:8000",
        "API_TOKENS": "ignored-but-required-by-config-schema",
        "MCP_TRANSPORT": "stdio",
        "GENERATION_PROVIDER": "gemini",
        "GENERATION_MODEL": "gemini-2.5-flash"
      }
    }
  }
}
```

Restart Claude Desktop. The `rag` server should appear with five tools and a
`documents://{id}` resource template.

## Tools

### `search_documents`

Hybrid (dense vector + sparse BM25) search across all ingested documents.
Returns ranked chunks with citation metadata.

| Input       | Type                               | Notes                                        |
| ----------- | ---------------------------------- | -------------------------------------------- |
| `query`     | string                             | Required.                                    |
| `topK`      | int, 1–50                          | Default 8.                                   |
| `sourceIds` | uuid[]                             | Optional. Restrict to specific sources.      |
| `filter`    | Record<string, string \| string[]> | Optional. Matches against document metadata. |

Structured output: `{ results: RetrievalResult[] }`.

### `get_document`

Fetch the full normalized markdown of a single document by id. Use after
`search_documents` to pull surrounding context.

| Input        | Type | Notes     |
| ------------ | ---- | --------- |
| `documentId` | uuid | Required. |

### `list_sources`

List every registered ingestion source. No inputs. Returns
`{ sources: { id, kind, name, lastSyncedAt }[] }`.

### `trigger_sync`

Enqueue a background ingestion job (returns the pg-boss job id).

| Input      | Type                        | Notes                    |
| ---------- | --------------------------- | ------------------------ |
| `sourceId` | uuid                        | Required.                |
| `mode`     | `"full"` \| `"incremental"` | Default `"incremental"`. |

### `ask`

Retrieve + generate. Returns a cited answer. Requires
`GENERATION_PROVIDER` + `GENERATION_MODEL` to be configured; otherwise
returns `isError`.

| Input       | Type                               | Notes                        |
| ----------- | ---------------------------------- | ---------------------------- |
| `question`  | string                             | Required.                    |
| `topK`      | int, 1–50                          | Default 8.                   |
| `sourceIds` | uuid[]                             | Optional source restriction. |
| `filter`    | Record<string, string \| string[]> | Optional metadata filter.    |

Structured output: `{ answer, citations, retrievedCount }`.

## Resources

| URI template       | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `documents://{id}` | Read a single document by uuid; returned as markdown. |

## Environment

This app reads its configuration via `@rag/core`'s `loadConfig()`. The
relevant env vars are documented in the repo-root `env.example`. The
MCP-specific ones are:

- `MCP_TRANSPORT` — `stdio` (default) or `http`
- `MCP_HTTP_PORT` — listening port when transport is `http` (default `3001`)
- `LOG_LEVEL` — pino level (default `info`)
