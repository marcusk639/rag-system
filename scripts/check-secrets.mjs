#!/usr/bin/env node
// Pre-commit secret scan: blocks commits whose staged files contain
// API-key/token/private-key material. Zero dependencies.

import { execFileSync } from "node:child_process";

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

let blocked = false;
for (const file of stagedFiles()) {
  if (ALLOWLIST.some((re) => re.test(file))) continue;
  const content = stagedContent(file);
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

if (blocked) {
  console.error(
    "\n  Remove secrets before committing. Use .env for local secrets.\n",
  );
  process.exit(1);
}
