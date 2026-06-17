# Google Drive connector

File-based connector over the Google Drive API. Implements the `Connector` interface (`validate`/`list`/`fetch`) from `@rag/core`.

- `client.ts` — Drive API calls; `config.ts` — credential/env parsing; `index.ts` — the `Connector` impl.
- Binary files are fetched and handed to the **Python parser sidecar** for markdown conversion — there is no local `parse.ts` here (unlike gmail).
- Delta sync uses an opaque base64(JSON) cursor via the shared `../util/cursor.ts` (`CursorCodec`); paging via `../util/paginate.ts`. Don't hand-roll either.
- Registered in `../factory.ts` and `../index.ts`.

<claude-mem-context>

</claude-mem-context>
