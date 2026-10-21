---
title: HTTP API reference
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: Every route the @rag/api Fastify server exposes, with auth, rate limits, request and response shapes, and the error-code to HTTP-status map.
read_when: Calling the HTTP API, changing a route, or debugging a status code or error envelope.
supersedes: [API.md]
code:
  [
    apps/api/src/server.ts,
    apps/api/src/auth.ts,
    apps/api/src/error-handler.ts,
    apps/api/src/routes/,
    packages/core/src/validation.ts,
    packages/services/src/,
  ]
---

# HTTP API reference

The `@rag/api` server (Fastify, default port 3000) exposes 14 routes: two unauthenticated probes, source management, document fetch and download, retrieval (`/search`), grounded answers (`/ask`, `/ask/stream`), and answer feedback. Every route except `/health` and `/ready` needs `Authorization: Bearer <credential>`. A global rate limit of 60 requests per minute applies per credential, with tighter per-route limits on `/ask`, `/ask/stream`, sync and purge. Every error uses the envelope `{ "error": { "code", "message" } }`.

Each route is a thin adapter over `@rag/services`. The MCP server calls the same service functions; see [MCP.md](./MCP.md). How to run the server is in the root [`CLAUDE.md`](../../CLAUDE.md) (`pnpm dev:api`).

## Endpoint summary

| Method | Path                      | Auth         | Rate limit | Purpose                                                  |
| ------ | ------------------------- | ------------ | ---------- | -------------------------------------------------------- |
| GET    | `/health`                 | none         | exempt     | Liveness probe                                           |
| GET    | `/ready`                  | none         | exempt     | Readiness: the database answers a ping                   |
| POST   | `/sources`                | admin only   | 60/min     | Register a source                                        |
| GET    | `/sources`                | any          | 60/min     | List the sources the caller can see                      |
| GET    | `/sources/:id`            | in scope     | 60/min     | Get one source                                           |
| DELETE | `/sources/:id`            | in scope     | **6/min**  | Purge a source and everything ingested from it           |
| POST   | `/sources/:id/sync`       | in scope     | **6/min**  | Enqueue an ingestion job                                 |
| POST   | `/sources/:id/documents`  | in scope     | 60/min     | Upload one file into a `custom` source                   |
| GET    | `/documents/:id`          | in scope     | 60/min     | Full parsed document (markdown and allowlisted metadata) |
| GET    | `/documents/:id/download` | in scope     | 60/min     | Original file bytes as an attachment                     |
| POST   | `/search`                 | any (scoped) | 60/min     | Hybrid retrieval, no LLM call                            |
| POST   | `/ask`                    | any (scoped) | **10/min** | Retrieval and grounded generation                        |
| POST   | `/ask/stream`             | any (scoped) | **10/min** | Same as `/ask`, streamed as server-sent events           |
| POST   | `/feedback`               | any          | 60/min     | Record a helpful or not-helpful vote on an answer        |

"In scope" means the caller is admin or the source is in its allowed set. Otherwise the route returns 404, never 403, so the caller can't learn that the source exists. "Any (scoped)" means retrieval is confined to the caller's allowed sources.

## Conventions

- Bodies are JSON, except the multipart upload and the file download.
- The request body limit is 25 MB (`bodyLimit` in `apps/api/src/server.ts`).
- Timestamps are ISO 8601 strings with a timezone.
- Validation uses zod (`fastify-type-provider-zod`). A schema failure returns 400 `VALIDATION_ERROR`, with the field path in the message.
- No route ever returns a source's `config` blob. It can hold site, folder and mailbox identifiers and credential-like values, so `toPublicSource` (`packages/db/src/queries.ts`) strips it on create, list and get.

## Authentication and scoping

`createAuthHook` (`apps/api/src/auth.ts`) reads the bearer credential and passes it to the `AuthProvider` built by `buildAuthProvider` (`packages/runtime/src/index.ts`). Under `AUTH_PROVIDER=composite`, the default, the verifiers are tried in this order:

| Verifier       | Credential                                                                         | Resolves to                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| static-token   | A value from `API_TOKENS` or a `token` in `API_PRINCIPALS`                         | `API_TOKENS` give admin (deny-all when `API_ENFORCE_SCOPING=true`); `API_PRINCIPALS` entries give their `allowedSourceIds`, or admin with `isAdmin` |
| oidc           | An IdP JWT (only when `OIDC_ISSUER` and `OIDC_AUDIENCE` are set)                   | Admin if a claim value is in `OIDC_ADMIN_CLAIMS`; otherwise the union of `OIDC_SCOPE_MAP` entries                                                   |
| internal-scope | An HS256 JWT signed by the web BFF (only when `INTERNAL_SCOPE_JWT_SECRETS` is set) | Its `sub` and `allowedSourceIds` claims; the token expires after 60 s                                                                               |

A credential that no verifier accepts gets 401 `UNAUTHORIZED` ("Missing bearer token" or "Invalid bearer token"). Retrieval routes then turn the principal into an `AuthorizationScope` (`scopeFromRequest` in `apps/api/src/routes/authz.ts`). A caller's `sourceIds` filter can only narrow inside that scope, never widen it. A scoped principal with an empty set sees nothing. The principal model, the DB-backed grants the web app uses, and how to issue tokens are in [ACCESS-CONTROL.md](../operations/ACCESS-CONTROL.md). The env vars are annotated in `env.example`.

## Rate limits

Rate limiting uses `@fastify/rate-limit`, registered in `buildServer` (`apps/api/src/server.ts`).

| Scope                                           | Limit         | Where set                                    |
| ----------------------------------------------- | ------------- | -------------------------------------------- |
| Every route except `/health`, `/ready`          | 60 per minute | `server.ts`                                  |
| `POST /ask`, `POST /ask/stream`                 | 10 per minute | `routes/ask.ts` route `config.rateLimit`     |
| `POST /sources/:id/sync`, `DELETE /sources/:id` | 6 per minute  | `routes/sources.ts` route `config.rateLimit` |

The bucket key is the JWT `sub` claim when the bearer is a JWT, then the first 48 characters of a non-JWT token, then the client IP. The `sub` is read before verification. That is acceptable for bucketing, because a forged `sub` only escapes the forger's own limit. When a limit is exceeded, the server returns 429 with code `CLIENT_ERROR`.

## Request limits

| Limit                                | Value                                                                           | Source                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `topK` default                       | `DEFAULT_TOP_K`, 12 unless configured                                           | `packages/core/src/config-schema.ts` `defaultTopK`            |
| `/search` `topK` max; `query` length | 100; 1–1000 chars                                                               | `routes/search.ts` `SearchBody`                               |
| `/ask` `topK` max; `question` length | 30 (`MAX_ASK_TOP_K`); 1–2000 chars                                              | `packages/core/src/validation.ts`, `routes/ask.ts` `AskBody`  |
| `history`                            | at most 12 turns, each at most 4000 chars                                       | `validation.ts` `MAX_HISTORY_TURNS`, `MAX_HISTORY_TURN_CHARS` |
| `filter`                             | at most 20 keys (key ≤ 64 chars); at most 50 values per key (value ≤ 256 chars) | `validation.ts` `filterSchema`                                |
| Source `name`                        | 1–120 chars                                                                     | `routes/sources.ts` `CreateSourceBody`                        |
| Upload                               | one file, at most 25 MB                                                         | `server.ts` multipart `limits`                                |
| Feedback `comment`                   | at most 1000 chars                                                              | `routes/feedback.ts` `FeedbackBody`                           |

## Error codes

`STATUS_BY_CODE` (`apps/api/src/error-handler.ts`) maps each `RagError.code` to a status. Any code not in the map returns 500.

| Code                        | Status | Raised by                                                                      |
| --------------------------- | ------ | ------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`          | 400    | Schema failure, malformed JSON, bad upload (wrong kind, MIME type, empty file) |
| `UNAUTHORIZED`              | 401    | Auth hook (missing or rejected credential)                                     |
| `FORBIDDEN`                 | 403    | `POST /sources` from a non-admin principal                                     |
| `NOT_FOUND`                 | 404    | Unknown or out-of-scope id; unknown route                                      |
| `SYNC_ALREADY_RUNNING`      | 409    | pg-boss declined the sync insert (see [sync](#post-sourcesidsync))             |
| `COMPLIANCE_VIOLATION`      | 422    | The TRI screen refused the question or prompt (`triPolicy=block`)              |
| `CLIENT_ERROR`              | 4xx    | Other Fastify client errors, e.g. 413 oversized upload, 429 rate limit         |
| `INTERNAL_ERROR`            | 500    | Anything unrecognised                                                          |
| `CONNECTOR_AUTH_ERROR`      | 502    | Connector credentials rejected                                                 |
| `PARSER_ERROR`              | 502    | Parser sidecar failure                                                         |
| `EMBEDDING_ERROR`           | 502    | Embedding provider failure, including its 429s                                 |
| `GENERATION_NOT_CONFIGURED` | 503    | `/ask` or `/ask/stream` with no generation provider                            |
| `STORAGE_NOT_CONFIGURED`    | 503    | Upload with no object store configured                                         |
| `EGRESS_BLOCKED`            | 503    | The egress allow-list refused the provider host (`EGRESS_ALLOWED_HOSTS`)       |
| `CONNECTOR_TRANSIENT_ERROR` | 503    | Connector source throttled or unavailable                                      |

The code is always returned. The message is echoed only for the audited codes in `ECHOABLE_ERROR_CODES` (`packages/core/src/errors.ts`): `VALIDATION_ERROR`, `NOT_FOUND`, `SYNC_ALREADY_RUNNING`, `COMPLIANCE_VIOLATION`, `EGRESS_BLOCKED`, `GENERATION_NOT_CONFIGURED` and `STORAGE_NOT_CONFIGURED`. Other codes get fixed text: "Upstream service error" for 502, "Service temporarily unavailable" for 503 and "Internal server error" otherwise. The real message is logged, and 5xx errors are sent to Sentry. The MCP server applies the same echo rule.

## Endpoints

### GET /health and GET /ready

`/health` returns `200 {"status":"ok"}` while the process is up. `/ready` pings the database. It returns `200 {"status":"ready"}`, or `503 {"status":"not-ready","error":"database unavailable"}`. The error text is fixed and does not carry the driver error.

### POST /sources

Admin only. Registers a source. The API doesn't inspect `config`; the connector validates it with its zod schema when a sync runs.

```json
{
  "kind": "sharepoint",
  "name": "Staff knowledge base",
  "config": { "siteId": "<host>,<site-guid>,<web-guid>", "driveId": "b!..." }
}
```

`kind` is one of `sharepoint`, `gdrive`, `gmail`, `outlook`, `custom`, `git-markdown`, `ecfr-part4` (`SourceKind` in `packages/core/src/types.ts`). The `config` shape for each kind is in [CONNECTORS.md](./CONNECTORS.md).

Returns **201** with the source row minus `config`: `id`, `kind`, `name`, `cursor`, `lastSyncedAt`, `createdAt`, `updatedAt`, `dataClass`. You can't set `dataClass` through this route; new sources get `general`. The class values and what they gate are described in the root [`CLAUDE.md`](../../CLAUDE.md) and [ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

### GET /sources

Returns **200** `{ "sources": [ <source row minus config>, ... ] }`. An admin sees every source. A scoped caller sees only the sources in its allowed set, and an empty scope gets `[]`.

### GET /sources/:id

Returns **200** with one source row minus `config`. Returns 404 if the source doesn't exist or is outside the caller's scope. `:id` must be a UUID, otherwise the route returns 400.

### DELETE /sources/:id

Permanently deletes the source. The database cascade removes its documents, chunks, ingestion jobs and pending uploads. Then `purgeSource` (`packages/services/src/sources.ts`) deletes each stored original from the object store. If a bucket delete fails, it is logged with marker `purge.object_orphaned` and the request still succeeds. Returns **204** with no body, or 404 if the source is unknown or out of scope.

### POST /sources/:id/sync

Enqueues a background sync and returns at once. The worker does the work (see [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) for the queue). A JSON body is required, and `{}` is valid.

| Field  | Type                        | Default         | Notes                                                                     |
| ------ | --------------------------- | --------------- | ------------------------------------------------------------------------- |
| `mode` | `"full"` \| `"incremental"` | `"incremental"` | `full` ignores the stored cursor and re-enumerates; `incremental` uses it |

Returns **202** with `{ "jobId": "<pg-boss id>", "ingestionId": "<ingestion_jobs id>", "mode": "full" }`. `triggerSync` is the only code that creates `ingestion_jobs` rows.

A second sync for the same source does **not** return an error. The `rag.sync_source` queue runs under pg-boss's `singleton` policy, which allows one _active_ job per `singletonKey` (`sync:<sourceId>`). A new trigger is queued behind the active job and returns 202. The route returns 409 `SYNC_ALREADY_RUNNING` only when pg-boss returns no job id for the insert (`enqueueSync` in `packages/ingestion/src/queue.ts`). In that case the `ingestion_jobs` row it just created is deleted. Returns 404 if the source is unknown or out of scope.

### POST /sources/:id/documents

Uploads one file into a `custom` source (`multipart/form-data`, one file part).

1. The route checks the source's kind, that an object store is configured, the MIME type, the size, and that the file isn't empty.
2. It writes the bytes to the object store at `uploads/<sourceId>/<uuid>` and records a `pending_uploads` row.
3. It enqueues an incremental sync. On the worker, the `custom` connector claims the staged file and ingests it like any other document.

Accepted MIME types (`ALLOWED_UPLOAD_MIME`): PDF, `.docx`, `.doc`, `.xlsx`, `.xls`, `.pptx`, `.ppt`, `text/plain`, `text/markdown`, `text/csv`, `text/html`.

Returns **202** with the sync result plus `documentId` (the new `externalId`) and `filename`. Errors:

- 400 for a non-`custom` source, an unsupported type, an empty file, or a request with no file
- 413 `CLIENT_ERROR` for a file over 25 MB
- 503 `STORAGE_NOT_CONFIGURED` when no object store is configured
- 404 when the source is unknown or out of scope

### GET /documents/:id

Returns **200** with the stored document row. It includes `markdown`, `title`, `sourceId`, `externalId`, `mimeType`, `sourceModifiedAt` and `sizeBytes`. `metadata` has passed through the allowlist (`sanitizeMetadata` in `packages/core/src/metadata-policy.ts`). Only these fields survive: `title`, `url`, `mimeType`, `sizeBytes`, `createdAt`, `modifiedAt`, `docClass`. `url` survives only when `docClass` is `A`. A missing document and an out-of-scope one both return the same 404, so a caller can't probe for existence.

### GET /documents/:id/download

Streams the original bytes with `Content-Type` and `Content-Disposition: attachment; filename="<sanitised title>"`. Returns 404, with the same scope rule as above, when:

- the document has no stored original
- no object store is configured
- identifiers were redacted from it at ingest (`metadata.redactedIdentifierCount > 0`)

### POST /search

Hybrid dense and sparse retrieval with no LLM call. The design is in [ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

```json
{
  "query": "vacation policy",
  "topK": 6,
  "sourceIds": ["<uuid>"],
  "filter": { "category": ["hr", "policy"] }
}
```

`filter` matches `documents.metadata->>key`. Values for one key are OR-ed and separate keys are AND-ed. If a generator is configured, the query is TRI-screened under its policy before it is embedded, so `/search` can also return 422 `COMPLIANCE_VIOLATION`. The service fetches twice `topK` candidates, removes near-identical copies of the same passage, and then truncates to `topK`.

Returns **200** `{ "results": [ ... ] }`. Each result looks like this:

```json
{
  "text": "...chunk text...",
  "score": 1.0,
  "denseScore": 0.84,
  "sparseScore": 0.12,
  "keywordCoverage": 0.5,
  "document": {
    "id": "<uuid>",
    "title": "Employee Handbook",
    "sourceId": "<uuid>",
    "sourceKind": "sharepoint",
    "hasOriginal": true,
    "metadata": { "mimeType": "application/pdf", "docClass": "A" }
  },
  "chunk": {
    "id": "<uuid>",
    "ordinal": 12,
    "headingPath": ["Time Off", "Vacation"],
    "page": 14
  }
}
```

- `score` is the RRF score divided by the top score in this result set, so the top hit is always 1.0. It ranks results within one response; it is not an absolute relevance measure.
- `denseScore` and `sparseScore` are the raw scores from each retriever, which show which arm surfaced a result.
- `keywordCoverage` is the fraction of the query's lexemes present in the chunk.
- `rerankScore` appears only when a reranker ran.
- `document.url` appears only for Class A documents.

### POST /ask

Retrieval followed by grounded generation. It requires `GENERATION_PROVIDER` and `GENERATION_MODEL`; without them it returns 503 with this body:

```json
{
  "error": {
    "code": "GENERATION_NOT_CONFIGURED",
    "message": "Generation is not configured. Set GENERATION_PROVIDER and GENERATION_MODEL to enable /ask."
  }
}
```

The body takes `question`, plus `topK`, `sourceIds` and `filter` as on `/search`, plus an optional `history`. `history` is an array of `{ "role": "user" | "assistant", "content": string }`. It is used only to rewrite a follow-up into a standalone retrieval query; the answer is always generated from `question`.

Response **200**:

```json
{
  "answer": "Full-time staff accrue 15 days per year [1].",
  "citations": [
    {
      "index": 1,
      "documentId": "<uuid>",
      "title": "Employee Handbook",
      "downloadable": true,
      "chunkId": "<uuid>",
      "chunkIds": ["<uuid>", "<uuid>"],
      "score": 1.0,
      "modifiedAt": "2026-01-15",
      "docClass": "A",
      "url": "https://..."
    }
  ],
  "retrieved": [],
  "reviewStatus": "draft_requires_practitioner_review",
  "disclaimer": "Draft — AI-generated and may be inaccurate. Requires review by a qualified practitioner before use.",
  "answerId": "<uuid>"
}
```

| Citation field | Notes                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| `index`        | Matches an `[N]` marker in `answer`. Only citations the answer actually uses are returned |
| `chunkId`      | Best-ranked chunk from that document                                                      |
| `chunkIds`     | Every chunk from that document that went into the prompt, in order                        |
| `score`        | Normalised score of the best chunk (relative, 0–1)                                        |
| `downloadable` | True when the original is stored; fetch it with `GET /documents/:id/download`             |
| `modifiedAt`   | `YYYY-MM-DD`, present only when the document metadata has a date                          |
| `docClass`     | Present only when the document has a class                                                |
| `url`          | Present only for Class A documents                                                        |

`retrieved` has the same shape as the `/search` results. `reviewStatus` and `disclaimer` are set by the server on every answer (`REVIEW_STATUS` and `ANSWER_DISCLAIMER` in `packages/services/src/ask.ts`). AI output is a draft that a qualified practitioner must review, so clients must not drop these fields. `answerId` is the key that `/feedback` takes.

If nothing is left after retrieval and the relevance floor, no LLM call is made. The response is then `answer: "The available documents do not contain enough information to answer that."` with empty `citations` and `retrieved`, the same `reviewStatus` and `disclaimer`, and an `answerId`.

The question is screened for taxpayer identifiers before retrieval, and the assembled prompt is screened before it goes to an external provider. Under `triPolicy=block`, either screen returns 422 `COMPLIANCE_VIOLATION`. See [CONTENT-SAFETY-DESIGN.md](../compliance/CONTENT-SAFETY-DESIGN.md).

### POST /ask/stream

`/ask/stream` takes the same body, runs the same pipeline, and has the same 10/min limit as `/ask`. The answer arrives as `text/event-stream`.

- A request with no generator returns the JSON 503 before streaming starts. So do validation, auth and rate-limit failures.
- Once streaming has started, the status is already 200, so any later failure arrives as an `error` event.

| Event   | `data`                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `token` | A JSON-encoded string chunk of the answer                                                                                                     |
| `done`  | `{ citations, retrieved, reviewStatus, disclaimer, answerId }`                                                                                |
| `error` | `{ "message": "Generation failed." }`, or `{ code, message }` for `EGRESS_BLOCKED` and `COMPLIANCE_VIOLATION` only (`STREAMABLE_ERROR_CODES`) |

When retrieval finds nothing, the stream sends the fixed refusal string as one `token` event, followed by `done`. If the client disconnects, the server stops pulling from the model. The answer generated so far is still written to the audit log. `apps/web` (`src/lib/stream-chat.ts`) is the consumer of this stream.

### POST /feedback

```json
{
  "answerId": "<uuid>",
  "rating": "helpful",
  "comment": "optional, at most 1000 chars"
}
```

`rating` is `helpful` or `not_helpful`. Returns **204**.

- The voter's identity comes from the authenticated principal's `subject`, never from the body. Admin and static-token callers have no subject, so their identity is recorded as null.
- Votes are upserted on `(answer_id, principal_subject)` with `NULLS NOT DISTINCT` (migration `0018_answer_feedback.sql`). A repeat vote replaces the earlier one, and all null-subject votes on an answer share one row.
- `answerId` isn't checked against any stored answer.

## X-RAG-Channel header

This header is for audit attribution, not authentication. Callers that present the same BFF-minted token can't be told apart, so the value is whatever the caller asserts.

| Route                 | Accepted values                     | Default | Recorded in               |
| --------------------- | ----------------------------------- | ------- | ------------------------- |
| `/ask`, `/ask/stream` | `api`, `teams`                      | `api`   | `audit_log.channel`       |
| `/feedback`           | `teams` (anything else means `web`) | `web`   | `answer_feedback.channel` |
| `/search`             | header ignored                      | `api`   | `audit_log.channel`       |

`mcp` is rejected on HTTP. Only the MCP server writes that channel, so an HTTP caller can't spoof it. Every successful `/search`, `/ask` and `/ask/stream` call writes an `audit_log` row: the question hash, the retrieved source, document and chunk ids, and the model. Whether the row also keeps the question or answer text depends on `AUDIT_LOG_CONTENT`. The audit write never blocks the response.

## CORS

CORS isn't enabled. The browser surface is `apps/web`, which calls this API server-side through its BFF routes; see [`apps/web/CLAUDE.md`](../../apps/web/CLAUDE.md).
