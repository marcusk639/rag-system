# Gmail connector

Message-based connector over the Gmail API. Implements the `Connector` interface (`validate`/`list`/`fetch`) from `@rag/core`.

- `client.ts` — Gmail API calls; `config.ts` — credential/env parsing; `index.ts` — the `Connector` impl.
- **Has a local `parse.ts`** — email messages (headers + body + attachments) are converted to markdown here, NOT routed through the Python file parser. This is the one connector with inline parsing.
- Delta sync uses an opaque base64(JSON) cursor via the shared `../util/cursor.ts` (`CursorCodec`); paging via `../util/paginate.ts`. Don't hand-roll either.
- Registered in `../factory.ts` and `../index.ts`.
