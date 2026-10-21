---
title: Connectors
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: What each source connector needs (credentials, env, source config), how it syncs and handles deletions, and the contract a new connector must meet.
read_when: Registering a source, setting connector credentials, debugging a sync, or writing a connector.
supersedes:
  [
    CONNECTORS.md,
    ECFR-CONNECTOR-SPIKE.md,
    PLAN-KB-SYNC.md (connector gotchas only),
  ]
code:
  [
    packages/core/src/interfaces.ts,
    packages/connectors/src/factory.ts,
    packages/connectors/src/,
    packages/connectors/src/util/errors.ts,
    packages/ingestion/src/queue.ts,
    apps/worker/src/deps.ts,
  ]
---

# Connectors

A connector enumerates documents from one external system. Seven source kinds exist:

- `sharepoint` and `outlook` (Microsoft Graph)
- `gdrive` and `gmail` (Google)
- `git-markdown` (a local git clone)
- `ecfr-part4` (the govinfo eCFR bulk XML)
- `custom` (browser uploads)

Each connector validates its own source `config` with a zod schema at construction. Credentials live in env vars that every source of that kind shares, never in `config`. Only SharePoint and git-markdown report deletions, so with the other connectors a document removed at the source stays indexed.

You register a source with `POST /sources` ([API.md](./API.md#post-sources)) and start a sync with `POST /sources/:id/sync`. The production SharePoint procedure is in [SHAREPOINT-RUNBOOK.md](../operations/SHAREPOINT-RUNBOOK.md). The Entra permission choices for a fresh tenant are in [FRESH-DEPLOY-GUIDE.md](../operations/FRESH-DEPLOY-GUIDE.md).

## The Connector interface

`Connector` and `ConnectorListResult` are defined in `packages/core/src/interfaces.ts`:

```ts
interface Connector {
  readonly kind: string;
  validate(): Promise<void>; // cheap credential and config check
  list(options?: ConnectorListOptions): Promise<ConnectorListResult>;
  fetch(externalId: string): Promise<SourceDocument>;
}

interface ConnectorListResult {
  documents: SourceDocument[];
  nextCursor: string | null;
  done: boolean; // nothing more to return right now
  deletions?: string[]; // externalIds the source reports as removed
  skippedOversize?: number; // observability only
}
```

Delta sync is driven by the cursor passed to `list()`; there is no separate delta method. The pipeline persists each returned cursor and runs one page per job, re-enqueuing itself until `done`. The ingestion side is described in [ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

## Summary by kind

| Kind           | Credentials (env)                                                                                       | Delta cursor                                            | Deletions reported    | Content handed to the pipeline            |
| -------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------- | ----------------------------------------- |
| `sharepoint`   | `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`                                                      | Per-drive Graph `@odata.deltaLink`s, in one JSON cursor | yes                   | Raw file bytes                            |
| `outlook`      | same `MS_*` app registration                                                                            | Graph `@odata.deltaLink` (messages delta)               | no                    | Body as `text/plain`; attachments raw     |
| `gdrive`       | `GOOGLE_SERVICE_ACCOUNT_JSON`, or `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` | Drive `startPageToken`, then `changes.list`             | no                    | Raw bytes; Workspace files exported first |
| `gmail`        | same Google credentials                                                                                 | Gmail `historyId`, then `history.list`                  | no                    | Body as `text/plain`; attachments raw     |
| `git-markdown` | none                                                                                                    | `HEAD` commit SHA                                       | yes (from `git diff`) | Raw markdown                              |
| `ecfr-part4`   | none                                                                                                    | The `last-modified` response header                     | no                    | One document per CFR section              |
| `custom`       | an object store (`OBJECT_STORE_PROVIDER=s3` and its settings)                                           | Staged `pending_uploads` rows                           | no                    | The uploaded bytes                        |

The `MS_*` variables are read by **rag-worker** (the connectors) and **rag-web**. rag-web reuses the same app registration for its `/admin/access` email-to-object-id lookup and the group-overage check. Every file goes through the Python parser sidecar, including mail bodies; see [Content and the parser sidecar](#content-and-the-parser-sidecar).

## sharepoint

Reads files from the document libraries of one SharePoint site through Microsoft Graph, using client credentials and the `https://graph.microsoft.com/.default` scope. The app token isn't user-scoped: it sees everything the app has been granted, whoever uploaded a file.

### Entra app permissions

Grant these as **Application** permissions on Microsoft Graph, then grant admin consent:

| Permission       | Why                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `Sites.Read.All` | Enumerate the site and its drives                                                                        |
| `Files.Read.All` | Download file content                                                                                    |
| `User.Read.All`  | Not used by the connector. `apps/web` uses it for the `/admin/access` lookup and the group-overage check |
| `Mail.Read`      | Only if you also use the `outlook` connector                                                             |

The least-privilege alternative is to grant `Sites.Selected` **instead of both** `Sites.Read.All` and `Files.Read.All`. A SharePoint admin then grants the app `read` on each source site (`POST /sites/{site-id}/permissions`). Don't keep `Files.Read.All` alongside `Sites.Selected`: on its own it covers every site and OneDrive in the tenant, which cancels the scoping. The procedure is in [FRESH-DEPLOY-GUIDE.md](../operations/FRESH-DEPLOY-GUIDE.md).

### Source config

`SharePointConfigSchema` is in `packages/connectors/src/sharepoint/config.ts`:

| Field          | Required | Default | Meaning                                                                                                   |
| -------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `siteId`       | yes      | none    | Composite Graph site id `"<hostname>,<site-guid>,<web-guid>"`. All three parts are required               |
| `driveId`      | no       | none    | Limits the sync to one document library. **If you leave it out, every library on the site is enumerated** |
| `folderPath`   | no       | none    | A subfolder, **relative to the drive root**. Ignored unless `driveId` is also set                         |
| `excludePaths` | no       | `[]`    | Case-insensitive path fragments that are never downloaded or indexed                                      |
| `maxFileBytes` | no       | 50 MB   | Files larger than this are skipped and counted in `skippedOversize`                                       |

```json
{
  "siteId": "<tenant>.sharepoint.com,<site-guid>,<web-guid>",
  "driveId": "b!<drive-id>",
  "folderPath": "Knowledge Base",
  "excludePaths": ["/clients/", "archive"]
}
```

To get the `siteId`, call `GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{site-path}` with an app-only token and take the `id` field. You can sanity-check its format with `^[^,]+,[a-f0-9-]+,[a-f0-9-]+$`. The runbook shows how to resolve it from inside the worker container.

### Scoping gotchas

- **`folderPath` is relative to the drive root.** If `driveId` is the "Documents" (Shared Documents) library, write `"Knowledge Base"`, not `"Documents/Knowledge Base"`.
- **`folderPath` needs `driveId`.** `initialDeltaUrl` (`sharepoint/index.ts`) applies the folder only to the configured drive, because the folder may not exist in sibling libraries. If you set `folderPath` without `driveId`, the folder is silently dropped and every library is walked.
- **The folder takes effect only on a cursor-less sync.** Later delta syncs follow the scope the first sync established. After you change `driveId` or `folderPath`, run `{"mode":"full"}`.
- **Grant access before you sync.** A scoped principal sees nothing from a new source until the source id is in its allowed set. Grant access first, or `/ask` from those users returns the refusal string. See [ACCESS-CONTROL.md](../operations/ACCESS-CONTROL.md).

### excludePaths

`excludePaths` holds case-insensitive substrings of an item's library path. A matching file is never downloaded or indexed. The list is added on top of the built-in client-content denylist (`DEFAULT_EXCLUDED_PATH_FRAGMENTS` in `packages/core/src/content-safety.ts`, which includes fragments such as `engagement letter` and `billing analysis`). An excluded item is reported as a deletion, so a copy indexed before the exclusion was added gets removed. Put firm-specific folder names here, in source config, not in code.

SharePoint is the only connector that sets `metadata.path`. For every other kind, the pipeline logs `ingest.path_unavailable`, and path-based exclusion has no effect.

### Sync behaviour

- The cursor is a JSON object that tracks a queue of drives still to walk, the drive in progress with its next link, and a completed `@odata.deltaLink` per drive. Treat it as opaque.
- `externalId` is `<driveId>:<itemId>`.
- Graph deletions and excluded paths both come back in `deletions`, and the pipeline removes those documents and their chunks.
- SharePoint and Outlook share one Graph throttling quota, so stage bulk re-syncs of the two.

## outlook

Reads mail and attachments through Microsoft Graph. It uses the same `MS_*` app registration as SharePoint, plus the `Mail.Read` application permission with admin consent.

`OutlookConfigSchema` is in `outlook/config.ts`:

| Field                | Required | Default | Meaning                                    |
| -------------------- | -------- | ------- | ------------------------------------------ |
| `userId`             | yes      | none    | Mailbox owner: a UPN or an Entra object id |
| `folderId`           | no       | none    | A well-known folder name or a folder id    |
| `filter`             | no       | none    | OData `$filter` applied to the delta query |
| `includeAttachments` | no       | `true`  | Emits each attachment as its own document  |
| `maxBodyBytes`       | no       | 10 MB   | Body truncation cap                        |
| `maxAttachmentBytes` | no       | 25 MB   | Per-attachment cap                         |

```json
{
  "userId": "mailbox@example.com",
  "folderId": "inbox",
  "includeAttachments": true
}
```

Each message becomes a document with subject, from, to, importance and conversation id in its metadata. Those fields are stored, but the metadata allowlist keeps them out of API responses. HTML bodies are converted to plain text in the connector (`htmlToText`, `util/html.ts`). The cursor is the Graph `@odata.deltaLink` for `/users/{id}/messages/delta`.

## gdrive

Reads files from Google Drive.

### Credentials

There are two options:

- **Service account (recommended for an organisation).** Enable the Drive API, create a JSON key, and set `GOOGLE_SERVICE_ACCOUNT_JSON`. For organisation-wide read, configure domain-wide delegation with scope `https://www.googleapis.com/auth/drive.readonly`, and set `impersonateUser` in the source config.
- **OAuth refresh token (personal accounts).** Create OAuth web credentials, run a one-off consent flow for the same scope, and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`.

### Source config

`GDriveConfigSchema` is in `gdrive/config.ts`:

| Field             | Required | Default | Meaning                                                           |
| ----------------- | -------- | ------- | ----------------------------------------------------------------- |
| `folderId`        | no       | none    | Folder to read. **Direct children only**                          |
| `mimeTypes`       | no       | none    | MIME allow-list                                                   |
| `query`           | no       | none    | Drive search query, applied to the initial sync                   |
| `impersonateUser` | no       | none    | Delegated user, for a service account with domain-wide delegation |
| `maxFileBytes`    | no       | 50 MB   | Size cap                                                          |

```json
{
  "folderId": "<folder-id>",
  "mimeTypes": ["application/pdf", "application/vnd.google-apps.document"]
}
```

### Behaviour

- Docs, Sheets and Slides are exported to `.docx`, `.xlsx` and `.pptx`, and Drawings to PNG. Folders and shortcuts are skipped.
- `folderId` becomes the clause `'<id>' in parents`, which matches only the folder's direct children; Drive has no recursive-descendant operator. If the content is spread across nested subfolders, register each subfolder as its own source, or leave `folderId` out and scope with `query` or `mimeTypes`. The schema comment says "and its descendants"; the code does not do that.
- Trashed files are excluded. Removals in `changes.list` are skipped (`includeRemoved: false`), so **a file deleted or trashed in Drive stays in the index** until the source is purged or a full sync rebuilds it.

## gmail

Reads messages and attachments from one mailbox. It uses the same Google credentials as Drive, with scope `https://www.googleapis.com/auth/gmail.readonly`: domain-wide delegation for a service account, or offline access for a refresh token.

`GmailConfigSchema` is in `gmail/config.ts`:

| Field                | Required | Default | Meaning                                                                    |
| -------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `userId`             | no       | `"me"`  | `"me"` is the OAuth user; with domain-wide delegation, a Workspace address |
| `labelIds`           | no       | none    | Restrict to these label ids                                                |
| `query`              | no       | none    | Gmail search syntax, applied to the initial sync                           |
| `includeAttachments` | no       | `true`  | Emits each attachment as its own document                                  |
| `impersonateUser`    | no       | none    | Delegated subject, for a service account                                   |
| `maxBodyBytes`       | no       | 10 MB   | Body truncation cap                                                        |
| `maxAttachmentBytes` | no       | 25 MB   | Per-attachment cap                                                         |

```json
{
  "userId": "me",
  "labelIds": ["INBOX"],
  "query": "newer_than:30d -from:noreply",
  "includeAttachments": true
}
```

- The connector walks the MIME tree and prefers a `text/plain` part. If there isn't one, it converts the `text/html` part with `htmlToText`.
- The message body is emitted as `text/plain`. Subject, from, to, date, thread id and label ids are stored in metadata but don't leave the API.
- Attachments get the external id `<messageId>/<attachmentId>` and a `parentMessageId`.
- The cursor is the `historyId`. The first sync uses `messages.list`, and later syncs use `history.list`.

## git-markdown

Reads markdown files from a local git clone. It was built for the veteran-disability resources repository. YAML frontmatter (for example `topic`, `last_verified`, `volatility`) is passed through unchanged into `metadata.extra`.

| Field        | Required | Default   | Meaning                                                 |
| ------------ | -------- | --------- | ------------------------------------------------------- |
| `repoPath`   | yes      | none      | Absolute path, on the worker's filesystem, to the clone |
| `extensions` | no       | `[".md"]` | Repo-relative path suffixes to ingest                   |

```json
{ "repoPath": "/srv/repos/<markdown-repo>", "extensions": [".md"] }
```

The connector shells out to the system `git`. It never fetches, so keep the clone up to date yourself, for example with a periodic `git pull`, or new commits won't be seen. The cursor is the `HEAD` SHA, and changed and deleted files come from `git diff` between SHAs. Errors aren't mapped to `ConnectorAuthError` or `ConnectorTransientError`; a bad path or a corrupt repository fails as a plain error.

## ecfr-part4

Reads 38 CFR Part 4 (Schedule for Rating Disabilities) from the govinfo.gov **bulk XML** mirror of eCFR, `https://www.govinfo.gov/bulkdata/ECFR/title-<title>/ECFR-title<title>.xml`. It filters to one part locally and emits one document per section. No auth is needed. `packages/connectors/src/ecfr-part4/index.ts` links to this section.

| Field   | Required | Default | Meaning     |
| ------- | -------- | ------- | ----------- |
| `title` | no       | `38`    | CFR title   |
| `part`  | no       | `"4"`   | Part number |

```json
{ "title": 38, "part": "4" }
```

### Document structure

In the bulk XML, the part's `DIV5` is nested under `DIV1` (title) and `DIV3` (chapter), and section `DIV8` elements sit under an intermediate `DIV6` (subpart). Neither is a direct child of its logical parent. The connector searches the parsed tree recursively for the `DIV5` with `TYPE="PART"` and a matching `N`. It then collects every `DIV8` with `TYPE="SECTION"` beneath that. Each section's `N` attribute starts with `"§ "` (for example `N="§ 4.130"`); the connector strips the prefix to get the `externalId` (`"4.130"`).

### Sync behaviour

- Every request sends a realistic browser `User-Agent` (`USER_AGENT` in `index.ts`).
- The cursor is the response's `last-modified` header. When the header hasn't changed since the last sync, `list()` returns no documents.
- 429 and 5xx responses map to `ConnectorTransientError`, and the job retries under the worker's policy (see [Errors and retries](#errors-and-retries)).
- There is **no REST fallback**. The bulk file is the only data source.

### Why bulk XML and not the eCFR REST API

On 2026-07-07, a spike (`scripts/spike-ecfr-rate-limits.ts`) compared the two sources. The decision rule was to use bulk XML if any request returned 429, sent a `retry-after` header, or took longer than 10 s.

- `titles.json` returned 200 in 253 ms.
- All ten full-title REST requests (`https://www.ecfr.gov/api/versioner/v1/full/{date}/title-38.xml`) returned **503**, taking between 3.2 s and **40.2 s**, with no `retry-after` header.
- A follow-up request with the correct latest issue date (2026-06-15) also returned 503, in 3.4 s.

The latency exceeded the threshold, so bulk XML was chosen. The spike did not determine whether the 503s came from server overload or bot protection triggered by its header-less, back-to-back requests. That is why the connector sends a browser `User-Agent` even to govinfo.gov.

The REST `full` endpoint's `part` parameter doesn't filter on the server; it always returns the whole title. Either way, the connector fetches the whole title once per sync and filters locally.

UNVERIFIED: the comment in `index.ts` says the REST API is unreliable "regardless of headers". No recorded test sent REST requests with a browser `User-Agent`. A single REST request with that header would settle whether REST is usable.

## custom

`custom` is the browser-upload connector. `POST /sources/:id/documents` ([API.md](./API.md#post-sourcesiddocuments)) writes the original file to the object store and records a `pending_uploads` row. The next sync's `CustomConnector` (`custom/index.ts`) claims the staged uploads and hands them to the pipeline.

`createConnector` refuses the `custom` kind. The worker builds it directly in `apps/worker/src/deps.ts`, together with its staging store and object store. Uploads need an object store configured; without one, the upload route returns 503 `STORAGE_NOT_CONFIGURED`. The config can be `{}`.

## Content and the parser sidecar

Connectors hand the pipeline bytes and a MIME type. `ingestOne` (`packages/ingestion/src/pipeline.ts`) sends **every** document to the parser sidecar's `/parse` endpoint, including mail bodies.

The mail connectors are the one exception to "hand over raw bytes":

- Gmail and Outlook choose a body part, convert HTML to plain text in the connector (`htmlToText`), and emit `text/plain`.
- Their attachments are passed through raw, like any other file.

Don't add more in-connector decoding without a reason of that kind. Office and PDF extraction belongs in the sidecar.

## Errors and retries

`mapApiError` (`packages/connectors/src/util/errors.ts`) classifies remote failures:

| Failure                     | Error                     | HTTP surface |
| --------------------------- | ------------------------- | ------------ |
| 401 or 403                  | `ConnectorAuthError`      | 502          |
| 429, 5xx or a network error | `ConnectorTransientError` | 503          |
| anything else               | the original error        | 500          |

Connectors don't retry in-process. A failed page fails its pg-boss job, and the job retries with `retryLimit: 3`, `retryDelay: 60` and `retryBackoff: true` (`enqueueSync` in `packages/ingestion/src/queue.ts`), whatever the error class. A Graph `Retry-After` header is captured and appended to the error message ("retry-after Ns"), but the worker **doesn't honour it**: the next attempt waits for pg-boss's backoff, not for the header.

## Adding a connector

Follow the six steps in the root [`CLAUDE.md`](../../CLAUDE.md) ("Adding a new connector"). The `rag-add-provider` skill walks through them. This repo also expects the following:

- Add the new kind to `SourceKind` in `packages/core/src/types.ts`. The API's `POST /sources` validates against it, and `createConnector`'s exhaustive `switch` won't compile until the new case exists. This is in addition to `sourceKindEnum` and its migration.
- Put the zod config schema in `<name>/config.ts` and parse it in the constructor.
- Use the shared `util/cursor.ts` (`makeCursorCodec`) and `util/paginate.ts` rather than writing your own, and map remote errors with `mapApiError`.

The contract every connector must meet:

- `list()` is driven only by the cursor: no state on the instance, and the same cursor returns the same documents.
- Use the source's server-side delta API where one exists, so that a sync costs O(changes) rather than O(n).
- Report source deletions in `deletions` when the API exposes them. Say in this doc when it doesn't.
- Hand over raw bytes; the mail-body exception is the only one (see [Content and the parser sidecar](#content-and-the-parser-sidecar)).
- Never log tokens or full document bodies at `info`. Use `debug`.

Test the cursor and pagination logic directly with recorded fixtures, as `.claude/rules/tdd.md` requires. Include a cursor round-trip: ingest, store the cursor, then list again with it, which must return no new documents. The e2e suite covers connectors only as a black box.
