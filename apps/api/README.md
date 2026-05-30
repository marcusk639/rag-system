# @rag/api

Fastify HTTP API for the RAG system. Exposes source management, retrieval, and grounded Q&A.

## Run

```bash
# from repo root
pnpm install
pnpm db:migrate
pnpm dev:api          # nodemon-like restart via tsx watch
# or
pnpm --filter @rag/api start  # built dist/main.js
```

Listens on `${API_HOST}:${API_PORT}` (default `0.0.0.0:3000`).

## Auth

Every endpoint except `/health` and `/ready` requires `Authorization: Bearer <token>`. The valid tokens are the comma-separated `API_TOKENS` env var. Rotate by editing env and restarting.

## Endpoints

| Method | Path                | Purpose                                                  |
| ------ | ------------------- | -------------------------------------------------------- |
| GET    | `/health`           | Liveness probe (no auth)                                 |
| GET    | `/ready`            | Readiness — verifies DB is reachable (no auth)           |
| POST   | `/sources`          | Create a source (connector config goes in `config` JSON) |
| GET    | `/sources`          | List all sources                                         |
| GET    | `/sources/:id`      | Get one source                                           |
| POST   | `/sources/:id/sync` | Enqueue an ingestion job (returns `jobId`)               |
| GET    | `/documents/:id`    | Full document row (parsed markdown + metadata)           |
| POST   | `/search`           | Hybrid retrieval (no LLM)                                |
| POST   | `/ask`              | RAG generation with citations                            |

## Examples

Create a SharePoint source and trigger a full sync:

```bash
TOKEN=dev-token-change-me

curl -sX POST http://localhost:3000/sources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "sharepoint",
    "name": "Marketing site",
    "config": { "siteId": "contoso.sharepoint.com,..." }
  }' | jq

# Returns: { "id": "...", ... }

curl -sX POST http://localhost:3000/sources/<id>/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}' | jq
```

Search:

```bash
curl -sX POST http://localhost:3000/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "what is our PTO policy",
    "topK": 6
  }' | jq
```

Ask:

```bash
curl -sX POST http://localhost:3000/ask \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is our PTO policy and how do I request time off?"
  }' | jq
```

Filter by metadata (only docs whose `metadata.author = "alice"`):

```bash
curl -sX POST http://localhost:3000/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Q3 strategy",
    "filter": { "author": "alice" }
  }' | jq
```

## Error envelope

All errors return:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

| Code                        | HTTP | Meaning                                        |
| --------------------------- | ---- | ---------------------------------------------- |
| `VALIDATION_ERROR`          | 400  | Bad request body / params                      |
| `UNAUTHORIZED`              | 401  | Missing or invalid bearer token                |
| `NOT_FOUND`                 | 404  | Resource doesn't exist                         |
| `CONNECTOR_AUTH_ERROR`      | 502  | Upstream source rejected credentials           |
| `CONNECTOR_TRANSIENT_ERROR` | 503  | Upstream source unavailable / rate-limited     |
| `PARSER_ERROR`              | 502  | Parser sidecar failed                          |
| `EMBEDDING_ERROR`           | 502  | Embedding provider failed                      |
| `GENERATION_NOT_CONFIGURED` | 503  | `/ask` called but no `GENERATION_PROVIDER` set |
| `INTERNAL_ERROR`            | 500  | Unhandled — check logs                         |
