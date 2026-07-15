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
