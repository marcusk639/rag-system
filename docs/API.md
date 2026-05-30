# HTTP API Reference

Full reference for the `@rag/api` Fastify server. Companion to [`apps/api/README.md`](../apps/api/README.md), which has quick-start examples.

## Conventions

- All request and response bodies are JSON unless noted.
- Every endpoint except `/health` and `/ready` requires `Authorization: Bearer <token>`.
- Error responses always use the envelope `{ "error": { "code": "...", "message": "..." } }`.
- Timestamps are ISO 8601 strings with timezone.

## Endpoints

### `GET /health`

**Auth**: none.

**Response 200**:

```json
{ "status": "ok" }
```

Used by load balancers and orchestrators to verify the process is alive.

---

### `GET /ready`

**Auth**: none.

Verifies the database is reachable. Returns 503 if `SELECT 1` fails.

**Response 200**:

```json
{ "status": "ready" }
```

**Response 503**:

```json
{ "status": "not-ready", "error": "..." }
```

---

### `POST /sources`

Register a new source for ingestion. The `config` blob is opaque to the API — the connector validates it at use time.

**Body**:

```json
{
  "kind": "sharepoint",
  "name": "Marketing site",
  "config": { "siteId": "contoso.sharepoint.com,..." }
}
```

| Field    | Type                                                           | Required | Notes                                                    |
| -------- | -------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| `kind`   | `"sharepoint" \| "gdrive" \| "gmail" \| "outlook" \| "custom"` | yes      | Picks the connector implementation                       |
| `name`   | string (1–120)                                                 | yes      | Human-readable; shown in citations / dashboards          |
| `config` | object                                                         | yes      | Connector-specific; see [CONNECTORS.md](./CONNECTORS.md) |

**Response 201**: the created `Source` row.

---

### `GET /sources`

**Response 200**:

```json
{
  "sources": [
    {
      "id": "uuid",
      "kind": "sharepoint",
      "name": "Marketing site",
      "config": { ... },
      "cursor": null,
      "lastSyncedAt": "2026-02-27T15:00:00Z",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

---

### `GET /sources/:id`

**Response 200**: the Source row.
**Response 404**: source not found.

---

### `POST /sources/:id/sync`

Enqueue an ingestion job. Returns immediately; the worker process picks up the job from pg-boss.

**Body**:

```json
{ "mode": "full" }
```

| Field  | Type                      | Default         | Notes                                                                                                  |
| ------ | ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `mode` | `"full" \| "incremental"` | `"incremental"` | `"full"` resets the cursor and re-enumerates everything; `"incremental"` uses the stored delta cursor. |

**Response 202**:

```json
{
  "jobId": "pg-boss-job-uuid",
  "ingestionId": "ingestion-jobs-row-uuid",
  "mode": "full"
}
```

Note: pg-boss dedupes by `singletonKey = sync:${sourceId}` — calling sync twice while one is in flight returns an error (see below) instead of stacking jobs.

**Response 500** when a sync is already running:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "enqueueSync: pg-boss rejected (likely duplicate sync running for ...)"
  }
}
```

---

### `GET /documents/:id`

**Response 200**: the full document row including `markdown`, `metadata`, `mimeType`, `sourceModifiedAt`, etc. Use this when an LLM caller wants more than the retrieved chunk.

**Response 404**: document not found.

---

### `POST /search`

Hybrid (dense + sparse) retrieval. No LLM call.

**Body**:

```json
{
  "query": "vacation policy",
  "topK": 6,
  "sourceIds": ["uuid", "uuid"],
  "filter": { "author": "alice", "category": ["hr", "policy"] }
}
```

| Field       | Type                                 | Default         | Notes                                                                                                            |
| ----------- | ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `query`     | string (1–1000)                      | —               | The search query                                                                                                 |
| `topK`      | int (1–100)                          | `DEFAULT_TOP_K` | Number of chunks to return                                                                                       |
| `sourceIds` | string[]                             | all             | Restrict search to these sources                                                                                 |
| `filter`    | `Record<string, string \| string[]>` | none            | Each key matches against `documents.metadata->>key`. Array values are OR-matched; multiple keys are AND-matched. |

**Response 200**:

```json
{
  "results": [
    {
      "text": "...chunk text...",
      "score": 1.0,
      "denseScore": 0.84,
      "sparseScore": 0.12,
      "document": {
        "id": "uuid",
        "title": "Employee Handbook 2026",
        "sourceId": "uuid",
        "sourceKind": "sharepoint",
        "url": "https://...",
        "metadata": { ... }
      },
      "chunk": {
        "id": "uuid",
        "ordinal": 12,
        "headingPath": ["Time Off", "Vacation"],
        "page": 14
      }
    }
  ]
}
```

`score` is the normalized RRF score in [0, 1] (top result is always 1.0). `denseScore` / `sparseScore` are the raw retriever scores, useful for debugging which retriever surfaced a result.

---

### `POST /ask`

Retrieve + generate. Requires `GENERATION_PROVIDER` and `GENERATION_MODEL` to be configured.

**Body**:

```json
{
  "question": "What is our PTO policy?",
  "topK": 6,
  "sourceIds": ["uuid"],
  "filter": { "category": "hr" }
}
```

Same `topK` / `sourceIds` / `filter` semantics as `/search`.

**Response 200**:

```json
{
  "answer": "Full-time employees accrue 15 days per year [1]. Requests must be submitted 2 weeks in advance [2].",
  "citations": [
    {
      "index": 1,
      "documentId": "uuid",
      "title": "Employee Handbook 2026",
      "url": "https://...",
      "chunkId": "uuid",
      "score": 1.0
    },
    {
      "index": 2,
      "documentId": "...",
      "title": "...",
      "chunkId": "...",
      "score": 0.83
    }
  ],
  "retrieved": [
    /* same shape as /search results */
  ]
}
```

The `[N]` markers in `answer` correspond to the `index` field in `citations`.

If retrieval returns zero chunks, the endpoint short-circuits — no LLM call is made, and the response is:

```json
{
  "answer": "The available documents do not contain enough information to answer that.",
  "citations": [],
  "retrieved": []
}
```

**Response 503**:

```json
{
  "error": {
    "code": "GENERATION_NOT_CONFIGURED",
    "message": "Generation is not configured. Set GENERATION_PROVIDER and GENERATION_MODEL to enable /ask."
  }
}
```

## Rate limits

The server itself does not enforce rate limits — front it with a reverse proxy (NGINX, Envoy) or an API gateway if you need them. Embedding and generation providers do their own rate limiting; their 429 responses bubble up as `EMBEDDING_ERROR` 502.

## CORS

Not enabled by default. Add `@fastify/cors` if browser clients call the API directly.
