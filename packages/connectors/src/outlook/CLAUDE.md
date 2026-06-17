# Outlook connector

Message-based (mail) connector over the Microsoft Graph API. Implements the `Connector` interface (`validate`/`list`/`fetch`) from `@rag/core`.

- `client.ts` — Graph API calls; `config.ts` — credential/env parsing; `index.ts` — the `Connector` impl.
- **Shares the Microsoft Graph quota with the SharePoint connector** — bulk re-syncs of both at once will hit 429s faster. Retries with backoff live in the shared helpers; stage large syncs.
- Delta sync uses an opaque base64(JSON) cursor via the shared `../util/cursor.ts` (`CursorCodec`); paging via `../util/paginate.ts`. Don't hand-roll either.
- Registered in `../factory.ts` and `../index.ts`.

<claude-mem-context>

</claude-mem-context>
