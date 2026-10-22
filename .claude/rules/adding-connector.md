---
paths: ["packages/connectors/**", "packages/db/src/schema.ts"]
---

## Adding a new connector

1. Implement the `Connector` interface from `@rag/core` (`validate`, `list`, `fetch` methods; delta sync is driven by the `cursor` passed to `list()`, not a separate method).
2. Add a subdirectory under `packages/connectors/src/<name>/`.
3. Add a `case` to `packages/connectors/src/factory.ts`. (Optionally also re-export the class from `packages/connectors/src/index.ts` — note `git-markdown` and `ecfr-part4` do not, and work fine, since callers go through `createConnector`.) Exception: `custom` (browser uploads) is deliberately rejected by `createConnector` — the worker builds it directly in `apps/worker/src/deps.ts` with its staging and object stores.
4. Extend `sourceKindEnum` in `packages/db/src/schema.ts` **and** the matching migration.
5. Document OAuth/credential setup in `docs/reference/CONNECTORS.md`.
6. Add env vars to `env.example`.
