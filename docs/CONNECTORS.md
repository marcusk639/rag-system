# Connectors

A **connector** is a class that knows how to enumerate documents from one external system. Connectors implement the `Connector` interface from `@rag/core`:

```ts
interface Connector {
  readonly kind: string;
  validate(): Promise<void>;
  list(options?: ConnectorListOptions): Promise<ConnectorListResult>;
  fetch(externalId: string): Promise<SourceDocument>;
}
```

The system ships four connectors out of the box: SharePoint, Google Drive, Gmail, Outlook. This document covers what each one needs to authenticate and what its source `config` JSON should look like.

---

## Microsoft SharePoint

Reads files from a SharePoint site's document libraries. Uses the Microsoft Graph `delta` endpoint for incremental sync.

### App registration

1. Go to https://entra.microsoft.com → **App registrations** → **New registration**.
2. Name it (e.g. "RAG Ingestion"), Single tenant.
3. Note the **Application (client) ID** and **Directory (tenant) ID**.
4. **Certificates & secrets** → **New client secret** → copy the value once.
5. **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**:
   - `Sites.Read.All`
   - `Files.Read.All`
6. **Grant admin consent** for the tenant.

### Environment

```env
MS_TENANT_ID=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
```

### Source config

```json
{
  "siteId": "contoso.sharepoint.com,abc123...,def456...",
  "driveId": "b!xyz...", // optional — omit to ingest all document libraries
  "folderPath": "Marketing/2026" // optional — restrict to subfolder
}
```

To find the `siteId`, GET `https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{site-path}`.

### Notes

- The connector requests `https://graph.microsoft.com/.default` scope via client-credentials. The app token is not user-scoped — it sees everything the app has been granted, regardless of which user uploaded the file.
- 429 responses are mapped to `ConnectorTransientError`. The worker honors `retryAfter` via pg-boss backoff.
- The delta cursor is the `@odata.deltaLink` URL Graph returns. It's opaque — we just store it and pass it back.

---

## Google Drive

Reads files from Drive. Supports both service-account (preferred for org-wide) and OAuth refresh-token auth.

### Auth option A: service account (recommended for organizations)

1. Create a service account in Google Cloud Console.
2. Enable the **Google Drive API** on the project.
3. Generate a JSON key.
4. (For org-wide read) configure **domain-wide delegation** in Google Workspace Admin and grant scope `https://www.googleapis.com/auth/drive.readonly`.

```env
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

### Auth option B: OAuth refresh token (for personal accounts)

1. Create OAuth 2.0 credentials in Google Cloud Console (Web application).
2. Run a one-shot flow to obtain a refresh token with scope `https://www.googleapis.com/auth/drive.readonly`.

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

### Source config

```json
{
  "folderId": "1Abc...", // optional — root folder to walk
  "mimeTypes": ["application/pdf", "application/vnd.google-apps.document"], // optional filter
  "query": "modifiedTime > '2026-01-01'" // optional Drive query
}
```

### Notes

- Google Workspace docs (Docs, Sheets, Slides) are exported to `.docx` / `.xlsx` / `.pptx` for parsing.
- The cursor is a Drive `startPageToken`. First sync walks `files.list`; subsequent syncs use `changes.list`.
- Trashed files are skipped automatically; deletions are surfaced as separate "removed" entries the pipeline can act on.

---

## Gmail

Reads messages and attachments from a Gmail mailbox.

### Auth

Same Google credentials as Drive (different scope):

- Service account requires domain-wide delegation with `https://www.googleapis.com/auth/gmail.readonly`.
- OAuth refresh token requires offline access with the same scope.

### Source config

```json
{
  "userId": "me", // for OAuth, "me" is the authenticated user
  "labelIds": ["INBOX", "Label_123"], // optional — restrict to labels
  "query": "newer_than:30d -from:noreply", // optional Gmail search syntax
  "includeAttachments": true // default true — attachments become their own documents
}
```

### Notes

- Each message becomes a `SourceDocument` with `metadata.subject`, `.from`, `.to`, `.date`, `.threadId`, `.labelIds`.
- Attachments are yielded as separate documents with `externalId = ${messageId}/${attachmentId}` and `metadata.parentMessageId` set.
- The cursor is Gmail's `historyId`. Initial sync uses `messages.list`; subsequent syncs use `history.list`.
- HTML bodies are stripped to plaintext before parsing (the parser sidecar handles formatting).

---

## Microsoft Outlook

Reads mail and attachments via Microsoft Graph. Reuses the SharePoint MSAL credentials.

### App registration

Same app registration as SharePoint. Add this Application permission:

- `Mail.Read`

(Grant admin consent.)

### Source config

```json
{
  "userId": "alice@contoso.com", // UPN or object id of the mailbox
  "folderId": "AAMkAGI...", // optional — restrict to a folder
  "filter": "isRead eq false", // optional OData $filter
  "includeAttachments": true // default true — attachments become their own documents (same as Gmail)
}
```

### Notes

- Each message becomes a `SourceDocument` with `metadata.subject`, `.from`, `.to`, `.importance`, `.conversationId`.
- Attachments yielded separately (same `parentMessageId` pattern as Gmail).
- Cursor is Graph's `@odata.deltaLink` for `/users/{id}/messages/delta`.

---

## Git Markdown

Reads markdown files from a local git clone, using the current commit SHA as the delta
cursor. Built specifically for ingesting `veteran-disability-ai-resources` — its
frontmatter (`topic`, `last_verified`, `volatility`) is passed through into
`metadata.extra` unchanged.

### Requirements

The `repoPath` must be a local clone the ingestion worker's filesystem can read (this
connector shells out to the system `git` binary — no network credentials needed).

### Source config

```json
{
"repoPath": "/Users/marcusklein/dev/veteran-disability-ai-resources",
"extensions": [".md"]
}
```

### Notes

- No auth — this is a local filesystem/git operation, not a remote API, so there is no
  `ConnectorAuthError`/`ConnectorTransientError` path; any failure (bad path, corrupt
  repo) propagates as a plain error.
- The clone must be kept up to date (e.g. a periodic `git pull`) for `trigger_sync` to
  see new commits — this connector does not fetch from a remote itself.

---

## Adding a new connector

1. **Implement the interface.** Create `packages/connectors/src/<name>/index.ts` exporting a class implementing `Connector` from `@rag/core`.
2. **Add a config schema.** In `<name>/config.ts`, define a zod schema for the connector-specific `config` JSON and validate at construction time.
3. **Register it.** Add a case to `packages/connectors/src/factory.ts` mapping a new `SourceKind` value.
4. **Extend the enum.** Add the new kind to `sourceKindEnum` in `packages/db/src/schema.ts` and to the matching Drizzle migration / `0000_init.sql` migration file.
5. **Document it here.** OAuth setup, config example, gotchas.

### Connector contract — what's required

- `list()` MUST be cursor-driven. Stateless on the connector instance (the cursor is the only state). Same cursor → same documents.
- `list()` SHOULD use server-side delta APIs when the source offers them. Otherwise sync becomes O(n) on every run instead of O(changes).
- Errors MUST be classified: 401/403 → `ConnectorAuthError`, 429/5xx → `ConnectorTransientError`. Anything else propagates.
- Document content MUST be raw bytes — let the parser sidecar handle extraction. Don't pre-decode HTML or strip Office XML inside the connector.
- Sensitive data (tokens, full document bodies) MUST NOT be logged at info level. Use `logger.debug` for those.

### Recommended testing

- Unit-test `list()` with a recorded fixture response (HTTP mock).
- Integration-test against a real source with a small folder/label scope.
- Test the cursor round-trip: ingest, store cursor, ingest again with stored cursor — must return zero new documents.
