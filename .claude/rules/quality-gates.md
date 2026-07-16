---
globs:
  [
    "apps/**/*.ts",
    "apps/**/*.tsx",
    "packages/**/*.ts",
    "services/parser-py/app/**/*.py",
  ]
---

# Quality Gates

Mechanically enforced (pre-commit hook — see `scripts/check-file-sizes.mjs` and `scripts/check-secrets.mjs`):

- **800-line hard cap** per source file. The hook blocks commits that stage a violating file. `packages/db/src/queries.ts` is grandfathered; shrink it, never extend the grandfather list.
- **No secrets in source.** API keys, tokens, and private-key blocks block the commit. Secrets belong in `.env` (template: `env.example`).

Advisory targets (not hook-enforced — reviewer judgment):

- 200–400 lines is the healthy file size; approaching 800 means split by responsibility.
- Functions under ~50 lines; nesting under 4 levels.
- Validate all external input at boundaries with zod (repo convention).
- Log via pino, never `console.*` (eslint warns on this already).
