# @rag/worker

pg-boss worker process. Consumes ingestion jobs queued by the API/MCP server and runs the full pipeline: connector fetch → parser → chunker → embedder → DB write.

## What it does

For every `rag.sync_source` job pulled from pg-boss:

1. Load the source row from `sources`.
2. Build the right connector (SharePoint / GDrive / Gmail / Outlook) via `@rag/connectors`.
3. Call `runIngestion()` from `@rag/ingestion` to walk the source, parse each document, chunk, embed, and upsert into Postgres.
4. Persist the new delta cursor on the source row so the next run is incremental.
5. Record the run in `ingestion_jobs` for human-readable history.

Failures throw — pg-boss retries 3× with exponential backoff. A persistent failure marks the `ingestion_jobs` row `failed` with the error message.

## Run

```bash
# from repo root
pnpm dev:worker                # tsx watch
# or
pnpm --filter @rag/worker start
```

The worker is a regular Node process — no port to bind, no HTTP server. It blocks on pg-boss until SIGTERM.

## Scaling

The worker is horizontal: run N replicas pointing at the same Postgres. pg-boss distributes jobs across them automatically. Each replica processes up to `WORKER_CONCURRENCY` documents in parallel within a single page of a sync.

Knobs:

| Env var                   | Default | What it does                                                         |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `WORKER_CONCURRENCY`      | `4`     | Max docs in flight per worker (drives parser + embedder concurrency) |
| `WORKER_POLL_INTERVAL_MS` | `2000`  | How often the worker polls pg-boss for new jobs                      |
| `CHUNK_SIZE`              | `800`   | Target tokens per chunk                                              |
| `CHUNK_OVERLAP`           | `120`   | Overlap tokens between adjacent chunks                               |

## Shutdown

Handles `SIGTERM` and `SIGINT` gracefully:

1. Stops pg-boss with `{ graceful: true }` — finishes in-flight jobs, refuses new ones.
2. Closes the DB pool.
3. Exits 0.

In Kubernetes, give the pod `terminationGracePeriodSeconds: 300` (or your longest expected job duration) so big syncs complete on rollout.

## Observability

The worker logs structured JSON via pino. Recommended fields to surface in your log aggregator:

- `level=error` — failed jobs, source loads, connector errors
- `level=info msg="sync completed"` — per-run summary (`documentsProcessed`, `chunksCreated`)
- `level=info msg="document ingested"` — per-doc detail

For queue health, query pg-boss directly:

```sql
SELECT state, COUNT(*) FROM pgboss.job
WHERE name = 'rag.sync_source'
GROUP BY state;
```

## Failure modes

| Failure                          | Behavior                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Connector auth expired           | `ConnectorAuthError` → job fails → retried with backoff → fails permanently after retryLimit. Operator rotates secret and re-enqueues. |
| Source rate-limit (429)          | `ConnectorTransientError` → job retried with backoff.                                                                                  |
| Parser sidecar down              | `ParserError` for each document → job fails → retries. Restart sidecar.                                                                |
| Embedding API quota exceeded     | `EmbeddingError` → retried → eventually fails. Either wait for reset or switch providers.                                              |
| Worker crashes mid-page          | Cursor was not committed → next worker re-enumerates the page. Content-hash dedupe makes already-processed docs no-ops.                |
| Concurrent worker on same source | `pg-boss singletonKey: sync:${sourceId}` prevents enqueuing duplicates from the API side.                                              |
