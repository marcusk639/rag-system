# MCP Reference

The `@rag/mcp` server exposes the RAG system as an [MCP](https://modelcontextprotocol.io) server — any MCP-capable client (Claude Desktop, Claude Code, Cline, Continue, etc.) can search and ask questions against the indexed corpus.

## Transports

| Transport | When to use                                                      |
| --------- | ---------------------------------------------------------------- |
| `stdio`   | Single-user desktop clients (Claude Desktop). Default.           |
| `http`    | Shared/remote agents. Mounts a Streamable HTTP server on `/mcp`. |

Choose with `MCP_TRANSPORT=stdio` or `MCP_TRANSPORT=http` (env). HTTP port is `MCP_HTTP_PORT` (default 3001).

## Adding to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rag": {
      "command": "node",
      "args": ["/absolute/path/to/rag-system/apps/mcp/dist/main.js"],
      "env": {
        "DATABASE_URL": "postgres://rag:rag@localhost:5432/rag",
        "GEMINI_API_KEY": "...",
        "PARSER_URL": "http://localhost:8000",
        "API_TOKENS": "unused-for-mcp",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

Build first (`pnpm build`) so `apps/mcp/dist/main.js` exists.

## Adding to Claude Code

```bash
claude mcp add rag node /absolute/path/to/rag-system/apps/mcp/dist/main.js \
  --env DATABASE_URL=... \
  --env GEMINI_API_KEY=... \
  --env PARSER_URL=...
```

## Tools

### `search_documents`

Hybrid (dense + sparse) retrieval. Returns ranked chunks with citation metadata.

**Inputs**:

| Field       | Type                                 | Default | Notes                             |
| ----------- | ------------------------------------ | ------- | --------------------------------- |
| `query`     | string                               | —       | Natural-language or keyword query |
| `topK`      | int (1–50)                           | 8       | Max chunks to return              |
| `sourceIds` | string[] (uuid)                      | all     | Restrict search to these sources  |
| `filter`    | `Record<string, string \| string[]>` | none    | Match against document metadata   |

**Returns**: a numbered markdown list as `text` content plus the raw `results` array as `structuredContent`.

### `get_document`

Fetch the full parsed markdown + metadata of a single document. Use after `search_documents` when the chunk excerpts aren't enough context.

**Inputs**: `documentId` (uuid).

### `list_sources`

List all sources configured in the system. Use this to discover what's searchable and to get source IDs for `sourceIds` filtering.

**Inputs**: none.

### `trigger_sync`

Enqueue an ingestion job for a source. Returns the pg-boss job id. The actual sync happens asynchronously in the worker.

**Inputs**:

| Field      | Type                      | Default         |
| ---------- | ------------------------- | --------------- |
| `sourceId` | string (uuid)             | —               |
| `mode`     | `"full" \| "incremental"` | `"incremental"` |

### `ask`

Retrieval-augmented generation. Returns a grounded answer with `[N]` citations.

**Inputs**: same as `search_documents` but with `question` instead of `query`.

**Returns**: the answer as `text` content; `{ answer, citations, retrievedCount }` as `structuredContent`.

Returns an MCP error if `GENERATION_PROVIDER` / `GENERATION_MODEL` are not configured.

## Resources

The server registers a `documents://` resource template:

```
documents://{id}
```

Reading this URI returns the document's parsed markdown as `text/markdown` content. Useful for clients that want to render a full document in their UI rather than rely on tool responses.

## Why MCP vs. just the HTTP API

The HTTP API and MCP server expose largely the same capabilities (search, ask, source management). They serve different consumers:

- **HTTP API**: your applications, scripts, batch jobs. Bearer-token auth. Stable JSON contracts.
- **MCP**: AI agents. Self-describing tools with rich descriptions the model can read to decide which tool to call. No auth at the protocol level (the transport is the security boundary — stdio is per-process, HTTP should be behind a reverse proxy or firewall).

If you're building an agent that needs to occasionally search a knowledge base, MCP is the right fit. If you're shipping a backend service that always queries the same way, the HTTP API is faster and cheaper.

## Logging

The MCP stdio transport reserves stdout for the protocol. The server's pino logger writes to stderr (file descriptor 2) by default, so client logs in Claude Desktop, etc., capture them.

## Tool design notes

- Tool descriptions are written assuming the model has never seen them before. They explain when to use the tool, what it returns, and any non-obvious behavior (e.g. that `search_documents` is hybrid, not pure semantic).
- All tool inputs are validated with zod via the SDK. Bad inputs return MCP errors with structured messages.
- `search_documents` returns BOTH a markdown text block (for the model to read directly) and `structuredContent` (for clients that want raw data). This pattern is recommended by the MCP spec.
