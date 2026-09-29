#!/usr/bin/env node
// Secret scan: blocks content containing API-key/token/private-key material.
// Zero dependencies.
//
// Modes: staged (default in pre-commit) checks staged content; tree checks every
// tracked file's working-tree content, used when nothing is staged or with --all.
// A staged-only check silently passes when run outside a commit — it inspects
// zero files and exits 0 — which is how the db-safety fixtures below went
// unscanned for weeks.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { regex: /sk-or-[\w-]{3,}/, description: "OpenRouter API key" },
  { regex: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/, description: "OpenAI API key" },
  // localhost is excluded: env.example, apps/web/env.example, and
  // packages/db/drizzle.config.ts legitimately contain dummy
  // rag:rag@localhost URLs for local development. The exclusion requires a
  // host boundary (`:` or `/`) right after localhost/127.0.0.1 so lookalike
  // hosts (e.g. localhost-tunnel.ngrok.io, 127.0.0.1.xip.io) still match.
  {
    regex:
      /postgres(ql)?:\/\/[\w.-]+:[^@\s"']+@(?!localhost[:/]|127\.0\.0\.1[:/])/,
    description: "Database URL with embedded credentials (non-local host)",
  },
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
  // Fixtures for `assertDestructiveTestTarget`, the guard that refuses to run
  // destructive tests against a non-local database. It must assert on BOTH
  // local URLs (allowed) and deliberately remote ones (rejected), so it
  // necessarily contains non-local credential-shaped strings. Allowlisted by
  // exact path rather than widening the list to every *.spec.ts.
  /^tests\/e2e\/src\/specs\/db-safety\.spec\.ts$/,
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

function stagedContent(file) {
  try {
    return execFileSync("git", ["show", `:${file}`], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null; // binary, deleted, or unreadable — skip
  }
}

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function workingContent(file) {
  try {
    return readFileSync(file, "utf-8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    unreadable.push({ file, reason: String(err?.code ?? err?.message) });
    return null;
  }
}

const unreadable = [];
const forceAll = process.argv.includes("--all");
const staged = forceAll ? [] : stagedFiles();
const useStaged = staged.length > 0;
const files = useStaged ? staged : trackedFiles();
const readContent = useStaged ? stagedContent : workingContent;

let blocked = false;
for (const file of files) {
  if (ALLOWLIST.some((re) => re.test(file))) continue;
  const content = readContent(file);
  if (content === null) continue;
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

if (unreadable.length > 0) {
  console.error(
    `\n  BLOCKED: ${unreadable.length} file(s) could not be read, so they were never scanned:`,
  );
  for (const u of unreadable) console.error(`    ${u.file}: ${u.reason}`);
  blocked = true;
}

if (blocked) {
  console.error(
    "\n  Remove secrets before committing. Use .env for local secrets.\n",
  );
  process.exit(1);
}
