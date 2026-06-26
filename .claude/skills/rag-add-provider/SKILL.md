---
name: rag-add-provider
description: Step-by-step playbook for extending rag-system with a new pluggable provider — a connector (SharePoint/Gmail/etc.), an embedding provider, or an auth provider. All three follow the same shape: implement the interface from @rag/core, register it in the factory, document env. Use when adding/scaffolding a new connector, embedding model, or auth strategy. Triggers on phrases like "add a connector", "new embedding provider", "add auth provider", "register a provider", "support <source/model/IdP>".
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Extending rag-system with a new provider

Every extensible surface in this repo is an interface in `@rag/core` plus a factory
registration. Pick the row, follow the four steps, respect the caveats. **Do not copy
interface code into this file — read the canonical interface before implementing.**

| Provider type | Interface (read first)                                  | Implement under                         | Register in                                  | Document in                            |
| ------------- | ------------------------------------------------------- | --------------------------------------- | -------------------------------------------- | -------------------------------------- |
| **Connector** | `Connector` — `packages/core/src/interfaces.ts`         | `packages/connectors/src/<name>/`       | `packages/connectors/src/index.ts`           | `docs/CONNECTORS.md` + `env.example`   |
| **Embedding** | `EmbeddingProvider` — `packages/core/src/interfaces.ts` | `packages/rag/src/embeddings/<name>.ts` | `packages/rag/src/embeddings/factory.ts`     | `docs/ARCHITECTURE.md` + `env.example` |
| **Auth**      | `AuthProvider` — `packages/core/src/auth.ts`            | `packages/core/src/<name>.ts`           | `packages/core/src/auth-provider-factory.ts` | `env.example`                          |

## The four steps (same for all three)

1. **Read the interface** in the file above and an existing sibling implementation for the
   house style. Implement the new provider against the interface — nothing more.
2. **Add the implementation** in the "Implement under" location.
3. **Register it** in the factory/index file so the factory can construct it by name.
4. **Document** the new env vars / model / credentials in the "Document in" file(s).

Then verify: `pnpm --filter @rag/<pkg> typecheck && pnpm --filter @rag/<pkg> test`.

## Provider-specific caveats (these cause real bugs)

- **Connector** — delta sync is driven by the `cursor` passed to `list()`, **not** a separate
  method. Implement `validate`, `list`, `fetch`. Microsoft Graph connectors (SharePoint/Outlook)
  share one Graph quota — retry with backoff on 429; stage bulk re-syncs.
- **Embedding** — embeddings are **immutable per (provider, model, dimensions)**. Changing the
  model means re-embedding the corpus. If dimensions differ from 768 (Gemini default), you must
  also change the `chunks.embedding` `vector(768)` column AND drop/rebuild the HNSW index
  (`packages/db`). Mixed-model collections are detectable because `chunks` records the model used.
- **Auth** — **fail closed.** `authenticate(credential)` returns `Principal | null`; return `null`
  for anything you can't positively authenticate and **never throw** for a bad credential. Keep
  env parsing OUT of `@rag/core` — config shape goes in `AuthProviderConfig`, env→config wiring
  goes in `buildAuthProvider` (`packages/runtime/src/index.ts`).

## Do not

- Duplicate search/ask logic — it lives once in `@rag/services` and is shared by api + mcp.
- Import `pg`/`drizzle-orm` directly — go through `@rag/db` typed query functions.
- Creep Python outside `services/parser-py/`.
