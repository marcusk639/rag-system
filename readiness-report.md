---
generated: 2026-07-15
level: 1
level_name: Bare
score: 19
total: 36
stack: node-typescript-pnpm-monorepo
monorepo: true
pillars:
  style-validation: { pass: 1, total: 4 }
  testing: { pass: 3, total: 5 }
  git-hooks: { pass: 0, total: 5 }
  documentation: { pass: 7, total: 9 }
  agent-config: { pass: 2, total: 5 }
  code-quality: { pass: 2, total: 3 }
  dev-environment: { pass: 3, total: 3 }
  agentic-workflow: { pass: 1, total: 2 }
---

# Harness Readiness Report

**Project:** rag-system (TypeScript pnpm monorepo — 4 apps, 8 packages, e2e suite, Python parser sidecar)
**Level:** 1 / 5 (Bare)
**Score:** 19 / 36 criteria passing

> Level 2 is blocked by a single criterion: no repo-committed formatter config. Linter and test runner both exist and work. Level 3 is blocked by the complete absence of git hooks (0/5).

## Pillar Scores

Style & Validation ██░░░░ 1/4
Testing ████░░ 3/5
Git Hooks ░░░░░░ 0/5
Documentation █████░ 7/9
Agent Configuration ██░░░░ 2/5
Code Quality ████░░ 2/3
Dev Environment ██████ 3/3
Agentic Workflow ███░░░ 1/2

## Monorepo Breakdown (testing, per unit)

| Unit                | Tests                          | Notes                                                         |
| ------------------- | ------------------------------ | ------------------------------------------------------------- |
| packages/core       | 175 passed (11 files / 14 src) | Densest coverage; auth, access-control, config, OIDC          |
| packages/rag        | 85 passed (10 files / 18 src)  | Embeddings, chunking, retrieval, generation                   |
| tests/e2e           | 78 passed (15 specs)           | Real docker Postgres + parser; incl. retrieval-eval metrics   |
| apps/web            | 39 passed (7 files / 39 src)   | lib-only unit tests; components delegated to e2e; 1 stub file |
| packages/connectors | 38 passed (6 files / 24 src)   | gmail/gdrive/outlook connectors have **no unit tests**        |
| apps/api            | 35 passed (4 files / 11 src)   | Route + auth-scope + rate-limit tests                         |
| packages/ingestion  | 33 passed (3 files / 5 src)    | 618-line pipeline suite                                       |
| apps/worker         | 28 passed (3 files / 6 src)    | All 3 handlers covered                                        |
| packages/services   | 27 passed (3 files / 7 src)    | ask/sources/documents; search indirect                        |
| packages/db         | 21 passed (5 files / 7 src)    | 1240-line queries.ts only partially covered                   |
| apps/mcp            | 21 passed (6 files / 11 src)   | All 6 tools + server                                          |
| packages/runtime    | **0 tests** (0 files / 2 src)  | `--passWithNoTests` masks the gap in buildCoreDeps            |
| services/parser-py  | 16 pytest tests exist          | **Never run by root `pnpm test` or any CI workflow**          |

Total: 580 TS tests / 74 files, all passing (after `pnpm -r build`).

## Passing

- ✓ Linter configured — root flat `eslint.config.js` (typescript-eslint) + `pnpm lint`; apps/web via `next lint`; enforced in CI
- ✓ Test runner configured — Vitest 2.1.9 in all 12 testable units, root `pnpm test` fans out
- ✓ Test colocation — 73 test files sit beside sources in `src/` throughout
- ✓ Tests pass — 580/580 (requires `pnpm -r build` first; see failing notes)
- ✓ CLAUDE.md exists — root (170 lines) + 5 nested (apps/web, 4 connectors)
- ✓ Commands section — all 16 documented scripts verified to exist in package.json
- ✓ Architecture section — 7-step pipeline, layering ground rules, 15-row concern→path table
- ✓ Critical Gotchas — "Things that will trip you up": 7 specific, non-obvious items
- ✓ Code Review Checklist — `.claude/agents/rag-reviewer.md` with 9 enforceable architectural rules
- ✓ No doc drift — all 24 spot-checked paths from CLAUDE.md exist on disk
- ✓ Content quality — dense, copy-paste-ready, config quirks and ordering constraints documented
- ✓ `.claude/settings.json` exists — tiered allow/ask/deny permissions
- ✓ Deny list — blocks `git push --force`, `git reset --hard`, `rm -rf`, `docker compose down -v`, `Read(.env)`
- ✓ No hardcoded secrets — zero matches for key patterns across all source
- ✓ Consistent code style — uniform kebab-case, named exports, zod boundaries, pino logging, mirrored app layouts
- ✓ env.example — 382 lines, every variable documented with rationale and security notes
- ✓ Build/dev commands documented and functional — 1:1 doc↔script match
- ✓ Dependencies install cleanly — `pnpm install --frozen-lockfile` exits 0, 15 projects
- ✓ Workflow system present — Superpowers plugin enabled + active use (docs/superpowers/ plans and specs)

## Failing

- ✗ Formatter configured — no prettier/black config anywhere in the repo; formatting exists only in the user's personal global Claude hook
- ✗ Lint-on-commit — no husky, no lint-staged, no pre-commit framework
- ✗ No-default-exports rule — eslint-plugin-import not installed; no equivalent rule
- ✗ Coverage threshold — no @vitest/coverage-* installed anywhere; coverage has never been measured
- ✗ TDD enforcement — no repo-committed TDD rule file (`.claude/rules/tdd.md`)
- ✗ Pre-commit hook — `.git/hooks/` has only samples; no `.husky/`
- ✗ Pre-push hook — none; tests run only post-push in CI
- ✗ Secret scanning at commit time — agent-side write guard only; human `git commit` path unguarded
- ✗ File size limits enforced mechanically — 800-line cap is prose-only
- ✗ Smart test caching — no pre-push SHA cache
- ✗ Quality gates documented in-repo — size/complexity limits live only in user-global rules
- ✗ Auto-generated doc sections — no `<!-- AUTO -->` markers, no generate/validate-docs scripts
- ✗ Allow list git coverage — zero read-only git commands allowed (status/diff/log all prompt)
- ✗ Path-scoped rules — no `.claude/rules/` directory with `globs:` frontmatter
- ✗ Enforcement hierarchy — repo conventions enforced only by user-global hooks + CI, nothing repo-committed
- ✗ No source files over 300 lines — 11 non-test violations; worst: `packages/db/src/queries.ts` (1240), `services/parser-py/app/main.py` (738), `packages/core/src/config.ts` (652)
- ✗ Session-start validation — no SessionStart hook or validate-on-start instruction
