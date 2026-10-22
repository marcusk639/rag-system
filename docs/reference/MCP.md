---
title: MCP server reference
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: What the @rag/mcp server exposes (six tools and one resource), how each transport authenticates and scopes a session, and how to connect Claude Desktop or Claude Code.
read_when: Connecting an agent to the corpus, changing an MCP tool, or reviewing MCP auth.
supersedes: [MCP.md]
code:
  [
    apps/mcp/src/main.ts,
    apps/mcp/src/server.ts,
    apps/mcp/src/tools/,
    apps/mcp/src/transports/http.ts,
    apps/mcp/src/tool-error.ts,
  ]
---

# MCP server reference

`@rag/mcp` is the agent-facing surface. It registers six tools (`search_documents`, `ask`, `get_document`, `list_sources`, `trigger_sync`, `purge_source`) and one resource template, `documents://{id}`. There is no feedback tool.

There are two transports:

- **`stdio`** (the default) runs with an admin, all-access scope, because the local client spawns the process and there is no credential to scope against.
- **Streamable HTTP** authenticates a Bearer credential on every request, using the same `AuthProvider` as the HTTP API, and binds each session to that credential's scope.

The tools call the same `@rag/services` functions as [API.md](./API.md), so retrieval, scoping, the metadata allowlist and the refusal string are identical.

## Transports

| Setting               | Default                         | Notes                                                          |
| --------------------- | ------------------------------- | -------------------------------------------------------------- |
| `MCP_TRANSPORT`       | `stdio`                         | `stdio` or `http`                                              |
| `MCP_HTTP_PORT`       | `MCP_HTTP_PORT ?? PORT ?? 3001` | `packages/core/src/config.ts`. Railway injects `PORT`          |
| `MCP_ALLOWED_ORIGINS` | empty                           | Comma-separated exact Origin allow-list for the HTTP transport |
| `MCP_MAX_SESSIONS`    | `1000`                          | Cap on live HTTP sessions held in memory                       |

`loadConfig` is shared with the API, so the MCP process needs the same core env: `DATABASE_URL`, the embedding provider's settings and key, and a non-empty `API_TOKENS`. `API_TOKENS` must be set even on stdio, which never reads it, because the config schema requires at least one token. Set `GENERATION_PROVIDER` and `GENERATION_MODEL` to enable `ask`. At boot, the server checks the embedding dimensions and the required search indexes, and it refuses to start if either check fails.

### stdio

The process speaks JSON-RPC on stdout. pino writes to stderr (fd 2), so anything else printed to stdout would corrupt the protocol. The session gets `ADMIN_SCOPE` (`apps/mcp/src/main.ts`). This is the only unscoped path in the system, and it is correct only while stdio stays a local, single-user channel.

### Streamable HTTP

`startHttp` (`apps/mcp/src/transports/http.ts`) mounts these routes:

| Route         | Purpose                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `POST /mcp`   | JSON-RPC from the client. A request without `mcp-session-id` must be `initialize` |
| `GET /mcp`    | Server-to-client SSE stream for an existing session                               |
| `DELETE /mcp` | Ends a session                                                                    |
| `GET /health` | `{"status":"ok"}`, no auth                                                        |

Every `/mcp` request passes a guard before it reaches the SDK:

1. **Origin.** If an `Origin` header is present, it must exactly match an entry in `MCP_ALLOWED_ORIGINS`. Otherwise the guard returns 403. When the list is empty, every request that carries an `Origin` is rejected. Non-browser clients send no `Origin` and pass. This is the DNS-rebinding defence.
2. **Bearer.** The credential is passed to `buildAuthProvider(config, logger)`, the same composite of static tokens, OIDC and internal-scope JWT that the API uses. A missing or rejected credential gets 401. `API_PRINCIPALS`, `API_ENFORCE_SCOPING` and the `OIDC_*` settings therefore apply to `rag-mcp` exactly as they do to `rag-api`.
3. **Session scope.** On `initialize`, the transport resolves that request's credential to an `AuthorizationScope` and builds a dedicated `McpServer` bound to it. If resolution fails, the scope falls back to `DENY_ALL_SCOPE`, which returns zero results; it never falls back to admin. The scope is fixed at `initialize`. Later requests in the session must still pass the Bearer check, but they don't change the scope.
4. **Capacity.** A new `initialize` when `MCP_MAX_SESSIONS` sessions are live gets 503 "Server at session capacity; retry later". A session is released when it is closed.

JSON bodies are limited to 4 MB. Token issuance and principal setup are in [ACCESS-CONTROL.md](../operations/ACCESS-CONTROL.md).

## Tools

Every tool handler is wrapped in `guardToolHandler` (`apps/mcp/src/tool-error.ts`). A thrown error becomes an `isError` result with `structuredContent: { error: { code, message } }`. The message is echoed only for the audited `ECHOABLE_ERROR_CODES`, the same rule the HTTP error handler uses (see [API.md](./API.md#error-codes)). Other errors get generic text, so connection strings and provider bodies never reach the agent. A new tool must use the same wrapper.

The tool descriptions tell the model to treat returned document text as data, not instructions.

| Tool               | Annotations                                                       | Scope rule                                                 |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `search_documents` | `readOnlyHint`                                                    | Retrieval confined to the session scope                    |
| `ask`              | `readOnlyHint`                                                    | Retrieval confined to the session scope                    |
| `get_document`     | `readOnlyHint`                                                    | Out-of-scope id gives the same "not found" as a missing id |
| `list_sources`     | `readOnlyHint`                                                    | Lists only sources in scope                                |
| `trigger_sync`     | `destructiveHint: false`, `idempotentHint`, `openWorldHint: true` | "not found" for an out-of-scope source                     |
| `purge_source`     | `destructiveHint`, `idempotentHint`                               | "not found" for an out-of-scope source                     |

Every tool except `trigger_sync` also sets `openWorldHint: false`.

### search_documents

| Input       | Type                                 | Default         | Notes                                                            |
| ----------- | ------------------------------------ | --------------- | ---------------------------------------------------------------- |
| `query`     | string, at least 1 char              | none            | Required                                                         |
| `topK`      | int, 1–50                            | `DEFAULT_TOP_K` | 12 unless configured. MCP's max is 50; HTTP `/search` allows 100 |
| `sourceIds` | uuid[]                               | all in scope    | Narrows within the session scope                                 |
| `filter`    | `Record<string, string \| string[]>` | none            | Same bounded `filterSchema` as HTTP                              |

The text content is a numbered list: title, heading path, page, relative score, and a 300-character excerpt. `structuredContent` is `{ results }`, with the same shape as the HTTP `/search` results. Each call writes an `audit_log` row with `channel: "mcp"` and `principalSubject: null`. The subject is null because the session keeps only the scope, not the principal.

### ask

| Input       | Type                        | Default         | Notes                                                                            |
| ----------- | --------------------------- | --------------- | -------------------------------------------------------------------------------- |
| `question`  | string, at least 1 char     | none            | Required                                                                         |
| `topK`      | int, 1–30 (`MAX_ASK_TOP_K`) | `DEFAULT_TOP_K` |                                                                                  |
| `sourceIds` | uuid[]                      | all in scope    |                                                                                  |
| `filter`    | metadata filter             | none            |                                                                                  |
| `history`   | `{role, content}[]`         | none            | At most 12 turns of at most 4000 chars; used only to rewrite the retrieval query |

The text content starts with `⚠ <disclaimer>`, then the answer, then a `Sources:` footer. Each footer line carries the URL, or the document id when no URL is exposable. When the original is stored, the line adds `download: /documents/<id>/download`; when the document has a class, it adds `Class <X>`.

`structuredContent` is `{ answer, citations, retrievedCount, reviewStatus, disclaimer, answerId }`. Citations have the same shape as HTTP `/ask` citations.

- With no generator configured, the tool returns `isError` with a hint to use `search_documents` instead.
- When retrieval finds nothing, the answer is exactly "The available documents do not contain enough information to answer that."
- A question containing taxpayer identifiers can be refused with `COMPLIANCE_VIOLATION`.

### get_document

Input: `documentId` (uuid). The text content is a markdown header (title, id, sourceId, mimeType, modified date) followed by the full markdown body. `structuredContent.document` has `id`, `sourceId`, `externalId`, `title`, `mimeType`, `sizeBytes`, `sourceModifiedAt`, the allowlisted `metadata`, and `markdown`. An id that is missing or out of scope returns `isError` "Document <id> not found."

### list_sources

No inputs. Returns `{ sources: [{ id, kind, name, lastSyncedAt }] }`, limited to the session scope. `config` is never included.

### trigger_sync

| Input      | Type                        | Default         |
| ---------- | --------------------------- | --------------- |
| `sourceId` | uuid                        | none            |
| `mode`     | `"full"` \| `"incremental"` | `"incremental"` |

Returns `{ jobId, ingestionId, sourceId, mode }` straight away; the worker does the sync. Repeat triggers behave the same as HTTP sync: a second trigger queues behind the active job. See [API.md](./API.md#post-sourcesidsync).

### purge_source

Input: `sourceId` (uuid). It calls `purgeSource`, the same function as `DELETE /sources/:id`. That removes the source, its documents, chunks, ingestion history and pending uploads, plus the stored originals. Returns `{ sourceId, name, purged: true }`. This can't be undone. An admin session, stdio included, can purge any source.

## Resource: documents://{id}

The server registers the `ResourceTemplate` `documents://{id}`, which has no list callback. Reading it returns the document's markdown body as `text/markdown`. It enforces the same scope rule as `get_document`: an out-of-scope id gets the same "not found" as a missing one. Errors go through `guardResourceHandler`, so a resource read can't leak internals either.

## Connecting a client

Build first: `pnpm build` produces `apps/mcp/dist/main.js`. The paths and values below are placeholders.

### Claude Desktop (stdio)

Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or the equivalent file on your OS:

```json
{
  "mcpServers": {
    "rag": {
      "command": "node",
      "args": ["/absolute/path/to/rag-system/apps/mcp/dist/main.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "DATABASE_URL": "postgres://rag:rag@localhost:5432/rag",
        "GEMINI_API_KEY": "<key>",
        "API_TOKENS": "unused-on-stdio",
        "GENERATION_PROVIDER": "gemini",
        "GENERATION_MODEL": "gemini-2.5-flash"
      }
    }
  }
}
```

`EMBEDDING_PROVIDER` defaults to `gemini`. If the index was built with another provider, set the same provider, model and dimensions the worker used, because embeddings are immutable per model. Leave out the two `GENERATION_*` lines for a search-only server.

### Claude Code

Over stdio:

```bash
claude mcp add rag \
  --env MCP_TRANSPORT=stdio \
  --env DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
  --env GEMINI_API_KEY=<key> \
  --env API_TOKENS=unused-on-stdio \
  -- node /absolute/path/to/rag-system/apps/mcp/dist/main.js
```

Against a deployed HTTP server:

```bash
claude mcp add --transport http rag https://<mcp-host>/mcp \
  --header "Authorization: Bearer <credential>"
```

These forms match the examples in `claude mcp add --help` as of 2026-10-21. Both were checked against that help text, but neither was run against a live server.

## Choosing MCP or the HTTP API

The MCP server suits agents: the tools describe themselves, and the text results are written for a model to read. The HTTP API suits applications. It has stable JSON contracts, streaming (`/ask/stream`), uploads, downloads and feedback, none of which MCP exposes. Both surfaces authenticate the same way, and over HTTP both are scoped per credential.
