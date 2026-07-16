---
globs:
  ["apps/**/src/**/*.ts", "apps/**/src/**/*.tsx", "packages/**/src/**/*.ts"]
---

# Test-Driven Development

New features and bug fixes in this repo are test-first:

1. Write the failing test next to the source file (`foo.ts` → `foo.test.ts` in the same directory — colocation is the repo convention, 73 existing examples).
2. Run it and confirm it fails for the right reason: `pnpm --filter @rag/<pkg> test -- <name>`.
3. Implement the minimal change to pass. Refactor after green.

Repo-specific expectations:

- Bug fixes MUST start with a regression test reproducing the bug.
- Do not use `--passWithNoTests` to dodge coverage for new packages — `packages/runtime` is the existing gap, don't add more.
- Connector changes: unit-test cursor/pagination/delta logic directly; the e2e suite only covers connectors black-box.
- Retrieval-affecting changes (chunking, embeddings, RRF, parser, prompts) additionally require the eval harness: dispatch the `retrieval-eval-runner` agent or run `pnpm eval` before shipping.
