# @rag/connectors

External-source connectors for the RAG ingestion pipeline. Each connector implements
the `Connector` interface from `@rag/core` (`validate`, `list`, `fetch`) and is
constructed via the `createConnector` factory:

```ts
import { createConnector } from "@rag/connectors";

const connector = createConnector(
  { id: source.id, kind: source.kind, config: source.config },
  { microsoft: cfg.microsoft, google: cfg.google },
  logger,
);

await connector.validate();
const page = await connector.list({ cursor: source.cursor, maxItems: 50 });
```

## Connectors

| Kind         | Module                       | Auth                                          | Delta API                            |
| ------------ | ---------------------------- | --------------------------------------------- | ------------------------------------ |
| `sharepoint` | `src/sharepoint/`            | MSAL client-credentials (Microsoft Graph)     | `/drives/{id}/root/delta`            |
| `gdrive`     | `src/gdrive/`                | Service account JSON _or_ OAuth refresh token | `changes.list` + `getStartPageToken` |
| `gmail`      | `src/gmail/`                 | Same Google credentials as Drive              | `history.list` keyed by `historyId`  |
| `outlook`    | `src/outlook/` (reuses MSAL) | Same Microsoft credentials as SharePoint      | `/users/{id}/messages/delta`         |

All cursors are opaque base64-encoded JSON blobs the worker persists in
`sources.cursor`. Passing the same cursor back yields the next page deterministically.

## Per-connector setup

### SharePoint

App registration with **application** permissions:
`Sites.Read.All`, `Files.Read.All`. Grant admin consent in Entra.

Required env:

- `MS_TENANT_ID`
- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`

Per-source config (JSONB):

```json
{
  "siteId": "contoso.sharepoint.com,abc-123,def-456",
  "driveId": "b!...", // optional — walks all libraries when omitted
  "folderPath": "Marketing/2024" // optional — only used when driveId is set
}
```

### Google Drive

Either set `GOOGLE_SERVICE_ACCOUNT_JSON` (preferred for org-wide ingestion with
domain-wide delegation) or all of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN`.

Per-source config:

```json
{
  "folderId": "1AbC...", // optional
  "mimeTypes": ["application/pdf"],
  "query": "name contains 'spec'",
  "impersonateUser": "owner@example.com" // service-account DWD only
}
```

Google Workspace docs/sheets/slides are auto-exported to docx/xlsx/pptx so the
parser sidecar can handle them.

### Gmail

Same Google credentials. Read-only scope (`gmail.readonly`).

```json
{
  "userId": "me",
  "labelIds": ["INBOX"],
  "query": "is:unread newer_than:30d",
  "includeAttachments": true,
  "impersonateUser": "user@example.com"
}
```

Each message yields one SourceDocument. Attachments yield additional
SourceDocuments with `externalId = "${messageId}/${attachmentId}"`.

### Outlook

Reuses the SharePoint MSAL client. App needs `Mail.Read` application permission.

```json
{
  "userId": "user@tenant.com",
  "folderId": "Inbox", // optional well-known name or id
  "filter": "receivedDateTime ge 2024-01-01T00:00:00Z"
}
```

Attachments follow the same `${messageId}/${attachmentId}` convention as Gmail.

## Error contract

- 401/403 from any API → `ConnectorAuthError` (worker stops the source, alerts).
- 429 / 5xx / network errors → `ConnectorTransientError` (worker retries with backoff).
- Bad config → `ValidationError` from `@rag/core`.

See `src/util/errors.ts` for the centralized mapper.
