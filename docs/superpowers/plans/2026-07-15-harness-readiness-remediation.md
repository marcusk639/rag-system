# Harness Readiness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move rag-system from harness readiness Level 1 (Bare) to Level 3+ (Enforced) per `readiness-report.md` — repo-committed formatting, commit/push-time enforcement, agent-config completeness, coverage measurement, and doc accuracy fixes.

**Architecture:** All enforcement moves from the developer's personal `~/.claude` config into the repo so every contributor and every agent gets it: prettier config + husky/lint-staged hooks at the repo root, two zero-dependency guard scripts in `scripts/`, path-scoped agent rules in `.claude/rules/`, and a pytest job in CI. No application code changes.

**Tech Stack:** prettier 3, husky 9, lint-staged 15, vitest 2.1 (`@vitest/coverage-v8`), GitHub Actions, Node 22, pnpm 9.12.0.

## Global Constraints

- Package manager is pinned: `packageManager: "pnpm@9.12.0"`, Node `>=22.0.0`. All installs via `pnpm add -D -w <pkg>` at the workspace root.
- Root `package.json` has `"type": "module"` — new Node scripts in `scripts/` MUST be ESM (`import`, not `require`). Use the `.mjs` extension.
- Never edit `.env` or `pnpm-lock.yaml` directly (blocked by the user's global hooks; lockfile updates happen via `pnpm add`/`pnpm install`).
- Commit message format: `<type>: <description>` with types feat/fix/refactor/docs/test/chore/perf/ci. No attribution footers.
- File size ceiling for the guard script is **800 lines** (the repo's existing documented cap), not the harness default 300. Exactly one existing file exceeds it: `packages/db/src/queries.ts` (1240 lines) — it is grandfathered via an exclude list, not refactored in this plan.
- Prettier uses **default settings** (`{}` config) — the codebase was formatted by a default-settings prettier hook, so this minimizes the one-time reformat diff.
- The e2e suite (`tests/e2e`) requires local Docker; nothing in this plan may add it to pre-commit, pre-push, or the coverage workspace.
- After each task, `pnpm lint` and `pnpm test` must still pass (run `pnpm -r build` first on a fresh checkout — that gotcha is itself fixed in Task 6).

---

### Task 1: Repo-committed Prettier (unblocks Level 2)

**Files:**

- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `package.json` (root — add devDependency + 2 scripts)
- Modify: `.github/workflows/ci.yml` (add format check step)

**Interfaces:**

- Produces: root scripts `format` (`prettier --write .`) and `format:check` (`prettier --check .`) — Task 3's lint-staged and Task 10's doc updates rely on prettier being installed at the root.

- [ ] **Step 1: Install prettier at the workspace root**

```bash
cd /Users/marcusklein/dev/rag-system
pnpm add -D -w prettier@^3.4.2
```

Expected: `package.json` devDependencies gains `"prettier": "^3.4.2"`, lockfile updated by pnpm.

- [ ] **Step 2: Create `.prettierrc.json`**

```json
{}
```

(Empty object = prettier defaults: 2-space indent, double quotes, semicolons, 80-col. This matches how the codebase has been formatted to date.)

- [ ] **Step 3: Create `.prettierignore`**

```
node_modules
dist
build
.next
.turbo
coverage
pnpm-lock.yaml
postgres-data
*.generated.ts
packages/db/drizzle
services/parser-py
.test-passed
```

- [ ] **Step 4: Add scripts to root `package.json`**

In the `"scripts"` block, after the `"lint"` entry, add:

```json
"format": "prettier --write .",
"format:check": "prettier --check .",
```

- [ ] **Step 5: Run the one-time formatting pass and verify nothing breaks**

```bash
pnpm format
pnpm lint
pnpm -r build && pnpm test
```

Expected: prettier rewrites some files (possibly many — this is the one-time normalization); lint passes; all 580 tests pass.

- [ ] **Step 6: Verify `format:check` is green**

```bash
pnpm format:check
```

Expected: "All matched files use Prettier code style!" exit 0.

- [ ] **Step 7: Add format check to CI**

In `.github/workflows/ci.yml`, insert between the `Lint` and `Unit tests` steps:

```yaml
- name: Format check
  run: pnpm format:check
```

- [ ] **Step 8: Commit**

```bash
git add .prettierrc.json .prettierignore package.json pnpm-lock.yaml .github/workflows/ci.yml
git commit -m "chore: add repo-committed prettier config and CI format check"
# Then commit the reformat separately so it's easy to skip in blame:
git add -A
git commit -m "style: one-time prettier normalization pass"
```

---

### Task 2: Guard scripts — secret scan and file-size check

**Files:**

- Create: `scripts/check-secrets.mjs`
- Create: `scripts/check-file-sizes.mjs`

**Interfaces:**

- Produces: `node scripts/check-secrets.mjs` and `node scripts/check-file-sizes.mjs` — both scan **git staged files only**, exit 1 with a `BLOCKED:` message on violation, exit 0 otherwise. Task 3's pre-commit hook invokes both.

- [ ] **Step 1: Create `scripts/check-secrets.mjs`**

```js
#!/usr/bin/env node
// Pre-commit secret scan: blocks commits whose staged files contain
// API-key/token/private-key material. Zero dependencies.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PATTERNS = [
  { regex: /sk-or-[\w-]{3,}/, description: "OpenRouter API key" },
  { regex: /sk-ant-[\w-]{3,}/, description: "Anthropic API key" },
  { regex: /AKIA[0-9A-Z]{16}/, description: "AWS access key" },
  {
    regex: /ghp_[A-Za-z0-9_]{10,}/,
    description: "GitHub personal access token",
  },
  { regex: /AIza[0-9A-Za-z_-]{35}/, description: "Google API key" },
  {
    regex: /-----BEGIN\s[\w\s]*?PRIVATE\sKEY-----/,
    description: "Private key block",
  },
];

// Paths where key-shaped strings are legitimately discussed (docs, fixtures).
const ALLOWLIST = [
  /^docs\//,
  /^readiness-report\.md$/,
  /\.test\.(ts|tsx|mjs)$/,
  /^packages\/test-fixtures\//,
];

function stagedFiles() {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACM"],
    {
      encoding: "utf-8",
    },
  );
  return out.trim().split("\n").filter(Boolean);
}

let blocked = false;
for (const file of stagedFiles()) {
  if (ALLOWLIST.some((re) => re.test(file))) continue;
  let content;
  try {
    content = readFileSync(resolve(file), "utf-8");
  } catch {
    continue; // binary or deleted-in-worktree
  }
  const lines = content.split("\n");
  for (const { regex, description } of PATTERNS) {
    lines.forEach((line, i) => {
      if (regex.test(line)) {
        blocked = true;
        console.error(`  BLOCKED: ${description} in ${file}:${i + 1}`);
      }
    });
  }
}

if (blocked) {
  console.error(
    "\n  Remove secrets before committing. Use .env for local secrets.\n",
  );
  process.exit(1);
}
```

- [ ] **Step 2: Create `scripts/check-file-sizes.mjs`**

```js
#!/usr/bin/env node
// Pre-commit file-size guard: blocks commits that stage a source file over
// the repo's 800-line ceiling (see .claude/rules/quality-gates.md).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_LINES = 800;
const INCLUDE = [
  /^apps\/[^/]+\/src\/.+\.(ts|tsx)$/,
  /^packages\/[^/]+\/src\/.+\.(ts|tsx)$/,
  /^services\/parser-py\/app\/.+\.py$/,
];
const EXCLUDE = [
  /\.generated\.ts$/,
  // Grandfathered pre-existing violations. Do NOT add entries; shrink this list.
  /^packages\/db\/src\/queries\.ts$/, // 1240 lines — refactor tracked separately
];

function stagedFiles() {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACM"],
    {
      encoding: "utf-8",
    },
  );
  return out.trim().split("\n").filter(Boolean);
}

const violations = [];
for (const file of stagedFiles()) {
  if (!INCLUDE.some((re) => re.test(file))) continue;
  if (EXCLUDE.some((re) => re.test(file))) continue;
  let content;
  try {
    content = readFileSync(resolve(file), "utf-8");
  } catch {
    continue;
  }
  const lines = content.endsWith("\n")
    ? content.split("\n").length - 1
    : content.split("\n").length;
  if (lines > MAX_LINES) violations.push({ file, lines });
}

if (violations.length > 0) {
  console.error(`\n  BLOCKED: file(s) exceed ${MAX_LINES} lines:`);
  for (const v of violations) console.error(`    ${v.file}: ${v.lines} lines`);
  console.error(
    "\n  Split the file before committing (see CLAUDE.md file-organization rules).\n",
  );
  process.exit(1);
}
```

- [ ] **Step 3: Verify the secret scan blocks a violation**

```bash
printf 'const key = "sk-ant-abc123def456";\n' > packages/core/src/leak-fixture.ts
git add packages/core/src/leak-fixture.ts
node scripts/check-secrets.mjs; echo "exit=$?"
```

Expected: `BLOCKED: Anthropic API key in packages/core/src/leak-fixture.ts:1` and `exit=1`.

- [ ] **Step 4: Verify the file-size guard blocks a violation**

```bash
python3 -c "print('// filler\n' * 801, end='')" > packages/core/src/big-fixture.ts
git add packages/core/src/big-fixture.ts
node scripts/check-file-sizes.mjs; echo "exit=$?"
```

Expected: `BLOCKED: file(s) exceed 800 lines` listing `packages/core/src/big-fixture.ts: 801 lines`, `exit=1`.

- [ ] **Step 5: Clean up fixtures and verify both pass clean**

```bash
git reset packages/core/src/leak-fixture.ts packages/core/src/big-fixture.ts
rm packages/core/src/leak-fixture.ts packages/core/src/big-fixture.ts
git add scripts/check-secrets.mjs scripts/check-file-sizes.mjs
node scripts/check-secrets.mjs && node scripts/check-file-sizes.mjs; echo "exit=$?"
```

Expected: no output, `exit=0` (the two `.mjs` scripts themselves are staged but match no include/secret pattern).

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: add staged-file secret scan and file-size guard scripts"
```

---

### Task 3: Pre-commit hook (husky + lint-staged)

**Files:**

- Create: `.husky/pre-commit`
- Modify: `package.json` (root — devDependencies, `prepare` script, `lint-staged` block)

**Interfaces:**

- Consumes: `scripts/check-secrets.mjs`, `scripts/check-file-sizes.mjs` (Task 2), prettier (Task 1).
- Produces: a working `.husky/` directory — Task 4 adds its pre-push hook alongside.

- [ ] **Step 1: Fix pnpm PATH for non-interactive shells (one-time machine setup)**

The readiness audit found bare `pnpm` is not on PATH in non-interactive shells despite the `packageManager` pin. Git hooks run non-interactively, so enable corepack:

```bash
corepack enable
pnpm --version
```

Expected: `9.12.0`. If `corepack` itself is missing, run `npm install -g corepack` first. (This is machine setup, not a repo change — hooks below still use `npx --no-install` as a PATH-independent fallback for node_modules binaries.)

- [ ] **Step 2: Install husky and lint-staged**

```bash
pnpm add -D -w husky@^9.1.7 lint-staged@^15.3.0
pnpm exec husky init
```

Expected: `.husky/pre-commit` created (containing the default `npm test` — replaced next step) and `"prepare": "husky"` added to root package.json scripts.

- [ ] **Step 3: Write `.husky/pre-commit`**

Replace the file's entire contents with:

```bash
npx --no-install lint-staged
node scripts/check-secrets.mjs
node scripts/check-file-sizes.mjs
```

- [ ] **Step 4: Add the lint-staged config to root `package.json`**

Add as a top-level key (sibling of `"scripts"`):

```json
"lint-staged": {
  "*.{ts,tsx,js,jsx,json,md,css,yml,yaml}": "prettier --write",
  "*.{ts,tsx}": "eslint --fix --no-warn-ignored"
}
```

(`--no-warn-ignored` prevents eslint 9 from failing on `apps/web` files, which the root flat config intentionally ignores — they are linted by `next lint`.)

- [ ] **Step 5: Verify the hook fires and blocks**

```bash
printf 'const key = "sk-ant-abc123def456";\n' > packages/core/src/leak-fixture.ts
git add packages/core/src/leak-fixture.ts
git commit -m "test: should be blocked"; echo "exit=$?"
git reset packages/core/src/leak-fixture.ts && rm packages/core/src/leak-fixture.ts
```

Expected: lint-staged runs, then `BLOCKED: Anthropic API key ...`, commit refused, `exit=1`, and `git log -1 --oneline` does NOT show "test: should be blocked".

- [ ] **Step 6: Verify a clean commit passes the hook**

```bash
git add .husky/pre-commit package.json pnpm-lock.yaml
git commit -m "chore: add pre-commit hook with lint-staged, secret scan, and size guard"
```

Expected: lint-staged + both guards run and pass; commit lands.

---

### Task 4: Pre-push hook with SHA-cached test run

**Files:**

- Create: `.husky/pre-push`
- Modify: `.gitignore` (add `.test-passed`)

**Interfaces:**

- Consumes: `.husky/` from Task 3; root `pnpm test` / `pnpm -r build`.
- Produces: `.test-passed` cache file convention (single line: HEAD SHA of the last commit whose full suite passed locally).

- [ ] **Step 1: Create `.husky/pre-push`**

```bash
# Full local suite before push, skipped when HEAD already passed.
HEAD_SHA=$(git rev-parse HEAD)
CACHED_SHA=""
if [ -f .test-passed ]; then
  CACHED_SHA=$(tr -d '[:space:]' < .test-passed)
fi

if [ -n "$HEAD_SHA" ] && [ "$HEAD_SHA" = "$CACHED_SHA" ]; then
  echo "pre-push: tests already passed for $HEAD_SHA — skipping."
  exit 0
fi

echo "pre-push: running build + unit tests (e2e excluded)..."
pnpm -r build && pnpm test && echo "$HEAD_SHA" > .test-passed
```

(Note: `pnpm test` = `pnpm -r run test` = unit tests only. `tests/e2e` has its own `test` script but requires Docker — it is part of the recursive run only in `tests/e2e`; if Docker is down its globalSetup fails. Check: if `pnpm test` from root currently includes tests/e2e and that is unacceptable for offline pushes, change the hook's test command to `pnpm -r --filter '!@rag/e2e' run test` and note it in the hook comment. Verify which behavior root `pnpm test` has before finalizing — run it once with Docker stopped.)

- [ ] **Step 2: Add the cache file to `.gitignore`**

Append under the `# Build outputs` section:

```
.test-passed
```

- [ ] **Step 3: Verify cache-miss path runs the suite**

```bash
rm -f .test-passed
git push --dry-run origin main 2>&1 | head -20
```

Expected: "pre-push: running build + unit tests" followed by the build and 580 passing tests, then `.test-passed` exists containing `git rev-parse HEAD`.

- [ ] **Step 4: Verify cache-hit path skips**

```bash
git push --dry-run origin main 2>&1 | head -3
```

Expected: `pre-push: tests already passed for <sha> — skipping.` in under a second.

- [ ] **Step 5: Commit**

```bash
git add .husky/pre-push .gitignore
git commit -m "chore: add pre-push hook running build+tests with SHA cache"
```

---

### Task 5: Agent settings — allow read-only git, invalidate test cache on commit

**Files:**

- Modify: `.claude/settings.json`

**Interfaces:**

- Consumes: nothing. Produces: nothing downstream — standalone config change.

- [ ] **Step 1: Add git commands to the allow list**

In `.claude/settings.json` `permissions.allow`, append after `"Bash(pnpm --filter:*)"`:

```json
"Bash(git status)",
"Bash(git status:*)",
"Bash(git diff:*)",
"Bash(git log:*)",
"Bash(git show:*)",
"Bash(git branch:*)",
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(pnpm format)",
"Bash(pnpm format:check)",
"Bash(node scripts/check-secrets.mjs)",
"Bash(node scripts/check-file-sizes.mjs)"
```

(`git push` stays under `ask`; force-push and `reset --hard` stay under `deny`. Do NOT add `git checkout`/`git restore` — they can discard work and should keep prompting.)

- [ ] **Step 2: Validate JSON and verify no deny-rule regressions**

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('valid')"
grep -c "git push --force" .claude/settings.json
```

Expected: `valid`, and `1` (deny rule untouched).

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "chore: allow read-only git and format commands in agent settings"
```

---

### Task 6: Fix the clean-checkout test trap

**Files:**

- Modify: `package.json` (root — add `test:fresh` script)
- Modify: `CLAUDE.md` (Common commands + Things that will trip you up)

**Interfaces:**

- Produces: root script `test:fresh` = `pnpm -r build && pnpm -r run test`.

- [ ] **Step 1: Add the script**

In root `package.json` scripts, after `"test"`:

```json
"test:fresh": "pnpm -r build && pnpm -r run test",
```

- [ ] **Step 2: Document the trap in CLAUDE.md**

In the `## Common commands` block, after the `pnpm test` line, add:

```
pnpm test:fresh               # build then test — REQUIRED on a fresh clone (tests resolve workspace deps via dist/)
```

In `## Things that will trip you up`, add a bullet:

```markdown
- **`pnpm test` fails on a fresh clone.** Tests resolve workspace packages via their built `dist/` entry points, so an unbuilt checkout errors with `Failed to resolve entry for package "@rag/core"`. Run `pnpm test:fresh` (or `pnpm -r build` first). CI builds before testing, so this only bites locally.
```

- [ ] **Step 3: Verify the script works**

```bash
pnpm test:fresh 2>&1 | tail -5
```

Expected: recursive build then all tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json CLAUDE.md
git commit -m "docs: add test:fresh script and document build-before-test requirement"
```

---

### Task 7: Run parser pytest suite in CI

**Files:**

- Modify: `.github/workflows/ci.yml` (add a `parser` job)

**Interfaces:**

- Consumes: `services/parser-py/requirements-dev.txt` (which `-r`-includes `requirements.txt`), `services/parser-py/tests/`.

- [ ] **Step 1: Verify the suite passes locally first**

```bash
cd services/parser-py
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt -q
.venv/bin/python -m pytest tests/ -v
cd ../..
```

Expected: 16 tests pass. If any fail, STOP and report — fix the tests before gating CI on them.

- [ ] **Step 2: Add the CI job**

Append to `.github/workflows/ci.yml` (sibling of the `quality` job):

```yaml
parser:
  runs-on: ubuntu-latest
  timeout-minutes: 10
  defaults:
    run:
      working-directory: services/parser-py
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-python@v5
      with:
        python-version: "3.12"
        cache: pip
        cache-dependency-path: services/parser-py/requirements-dev.txt

    - name: Install dependencies
      run: pip install -r requirements-dev.txt

    - name: Run pytest
      run: python -m pytest tests/ -v
```

(If the parser's Dockerfile pins a different Python minor version, match it — check `services/parser-py/Dockerfile` `FROM` line and use that version instead of 3.12.)

- [ ] **Step 3: Validate workflow syntax**

```bash
npx --yes yaml-lint .github/workflows/ci.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('valid')"
```

Expected: `valid`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run parser-py pytest suite in CI"
```

---

### Task 8: Path-scoped agent rules (.claude/rules/)

**Files:**

- Create: `.claude/rules/tdd.md`
- Create: `.claude/rules/quality-gates.md`

**Interfaces:**

- Consumes: the 800-line guard from Task 2 (the rule documents what the hook enforces — keep the numbers in sync).

- [ ] **Step 1: Create `.claude/rules/tdd.md`**

```markdown
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
```

- [ ] **Step 2: Create `.claude/rules/quality-gates.md`**

```markdown
---
globs:
  [
    "apps/**/*.ts",
    "apps/**/*.tsx",
    "packages/**/*.ts",
    "services/parser-py/**/*.py",
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
```

- [ ] **Step 3: Verify frontmatter parses**

```bash
head -4 .claude/rules/tdd.md .claude/rules/quality-gates.md
```

Expected: each shows `---` / `globs: [...]` / `---` frontmatter.

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/
git commit -m "chore: add path-scoped TDD and quality-gate rules for agents"
```

---

### Task 9: Coverage tooling with a measured baseline threshold

**Files:**

- Create: `vitest.workspace.ts`
- Create: `vitest.config.ts` (root)
- Modify: `package.json` (root — devDependency + `test:coverage` script)

**Interfaces:**

- Consumes: existing per-package vitest setups (apps/web has its own `vitest.config.ts` with the `@/` alias — the workspace file must pick it up, not override it).
- Produces: root script `test:coverage` = `vitest run --coverage`.

- [ ] **Step 1: Install the coverage provider**

```bash
pnpm add -D -w @vitest/coverage-v8@^2.1.8
```

(Version must match the workspace's vitest 2.1.x — a 3.x coverage package will refuse to load.)

- [ ] **Step 2: Create `vitest.workspace.ts`**

```ts
// Unit-test projects only. tests/e2e is excluded (requires Docker) and runs
// via `pnpm e2e`; examples/ are not part of the quality gate.
export default ["packages/*", "apps/*"];
```

- [ ] **Step 3: Create root `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**", "packages/*/src/**"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.generated.ts",
        "**/dist/**",
      ],
      // Thresholds are set to the measured baseline (Step 5) minus a small
      // buffer, then ratcheted up over time. They exist to prevent regression,
      // not to claim the 80% target is met today.
      thresholds: {
        lines: 0, // REPLACED IN STEP 5 with measured baseline - 5
        functions: 0, // REPLACED IN STEP 5
        branches: 0, // REPLACED IN STEP 5
        statements: 0, // REPLACED IN STEP 5
      },
    },
  },
});
```

- [ ] **Step 4: Add the script and run the baseline measurement**

Add to root `package.json` scripts after `"test:fresh"`:

```json
"test:coverage": "vitest run --coverage",
```

Then:

```bash
pnpm -r build
pnpm test:coverage 2>&1 | tail -25
```

Expected: all workspace unit suites run under the workspace config and a coverage summary table prints `% Lines / % Funcs / % Branches / % Stmts` totals. If apps/web tests fail under workspace mode (alias resolution), add `"!apps/web"` to the workspace array, note it in a comment, and re-run — do not silently drop other projects.

- [ ] **Step 5: Set thresholds from the measured baseline**

Take the four "All files" percentages from Step 4's output, subtract 5 from each, round down to an integer, and replace the four `0` values in `vitest.config.ts`. Example: if the run reports `Lines 62.4%`, set `lines: 57`.

- [ ] **Step 6: Verify thresholds pass and would catch a regression**

```bash
pnpm test:coverage 2>&1 | tail -5
```

Expected: exit 0, no threshold errors. Then temporarily set `lines: 99` in `vitest.config.ts`, re-run, and confirm it FAILS with `ERROR: Coverage for lines (…) does not meet global threshold (99%)`. Restore the real value and re-run to green.

- [ ] **Step 7: Commit**

```bash
git add vitest.workspace.ts vitest.config.ts package.json pnpm-lock.yaml
git commit -m "test: add coverage tooling with baseline-derived thresholds"
```

---

### Task 10: Documentation accuracy fixes

**Files:**

- Modify: `CLAUDE.md` (apps/web visibility, eval:real, hooks-conventions section)
- Modify: `README.md` (stale "What's inside" tree)
- Delete: `apps/web/src/lib/env.test.ts` (stub test)

**Interfaces:**

- Consumes: hooks from Tasks 3–4 (the CLAUDE.md conventions section is rewritten to describe them).

- [ ] **Step 1: Delete the stub test**

```bash
git rm apps/web/src/lib/env.test.ts
pnpm --filter @rag/web test
```

Expected: apps/web suite passes with 38 tests across 6 files (was 39/7 — only the `1 + 1` stub is gone). It asserted nothing about the codebase; apps/web's test infrastructure is proven by the 6 real suites.

- [ ] **Step 2: Make apps/web visible in root CLAUDE.md**

In the `## Where to find things` table, add a row:

```markdown
| Web chat UI (Next.js) | `apps/web/` — see `apps/web/CLAUDE.md` for auth model and server-only credential rules |
```

In the architectural ground rule that reads "All three apps (api/mcp/worker) build `CoreDeps` from it", change to:

```markdown
The three backend apps (api/mcp/worker) build `CoreDeps` from it. The fourth app, `apps/web`, is a Next.js frontend that consumes the HTTP API instead — it never touches `CoreDeps`; see `apps/web/CLAUDE.md`.
```

- [ ] **Step 3: Document `eval:real` in the commands block**

After the `pnpm eval` line in `## Common commands`:

```
pnpm eval:real                # eval harness against real providers (needs API keys)
```

Verify the wording against what `tests/e2e/package.json`'s `eval:real` script actually does before committing — adjust the comment if it targets something else.

- [ ] **Step 4: Rewrite the hook-conventions section of CLAUDE.md**

Replace the `## Conventions enforced by hooks (parent repo)` section with:

```markdown
## Conventions enforced mechanically

Repo-committed (every contributor gets these via `pnpm install` → husky):

- Pre-commit: prettier + eslint on staged files (lint-staged), secret scan (`scripts/check-secrets.mjs`), 800-line file cap (`scripts/check-file-sizes.mjs`).
- Pre-push: full `pnpm -r build && pnpm test`, skipped when `.test-passed` matches HEAD.
- Do not edit `.env` files — the template lives at `env.example`.
- Do not edit `pnpm-lock.yaml` by hand — run `pnpm install` to update.
```

- [ ] **Step 5: Fix README's "What's inside" tree**

In `README.md`, update the directory listing to include the missing entries: `apps/web`, `packages/runtime`, `packages/services`, `packages/test-fixtures`. Match the existing tree formatting; one-line descriptions consistent with CLAUDE.md's table (e.g. `runtime — shared dependency-graph wiring (buildCoreDeps)`).

- [ ] **Step 6: Verify no new drift**

```bash
grep -n "eval:real\|test:fresh\|apps/web" CLAUDE.md | head
grep -n "runtime\|test-fixtures" README.md | head
```

Expected: all additions present.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: fix apps/web visibility, stale README tree, and hook conventions; drop stub test"
```

---

## Out of Scope (tracked, not planned here)

- Refactoring `packages/db/src/queries.ts` (1240 lines) — highest-value refactor target; needs its own plan.
- Unit tests for `packages/runtime` (buildCoreDeps) and the gmail/gdrive/outlook connectors.
- Level 4 items: `<!-- AUTO -->` doc generation, drift-validation scripts, SessionStart validation hook.
- `import/no-default-export` eslint rule (needs eslint-plugin-import + a Next.js pages carve-out — bundle with a future lint-hardening pass).
- Narrowing the `Bash(pnpm --filter:*)` allow rule (permission pattern syntax can't express "any filter, safe scripts only" cleanly).

## Verification (after all tasks)

1. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:fresh` — all green.
2. Stage a file containing `sk-ant-test123456` → `git commit` is blocked.
3. `git push --dry-run` twice → first run executes the suite, second skips via `.test-passed`.
4. Re-run `/harness-engineering:readiness` — expect Level 3, with Style & Validation 3/4, Testing 4/5, Git Hooks 5/5, Agent Config 4/5.
