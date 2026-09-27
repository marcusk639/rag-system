#!/usr/bin/env node
// File-size guard: enforces the repo's 800-line ceiling on source files
// (see .claude/rules/quality-gates.md).
//
// Modes:
//   - staged (default in pre-commit): checks the staged content of staged files.
//   - tree: checks every tracked file's working-tree content. Used when nothing
//     is staged, or when --all is passed.
//
// The tree fallback exists because a staged-only check silently passes when
// run outside a commit — it inspects zero files and reports success, which is
// how a 258-line overage once reached a branch that reported "all gates green".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_LINES = 800;
const INCLUDE = [
  /^apps\/[^/]+\/src\/.+\.(ts|tsx)$/,
  /^packages\/[^/]+\/src\/.+\.(ts|tsx)$/,
  /^services\/parser-py\/app\/.+\.py$/,
];
const EXCLUDE = [
  /\.generated\.ts$/,
  // Grandfathered pre-existing violation. Do NOT add entries; shrink this list.
  /^packages\/db\/src\/queries\.ts$/, // refactor tracked separately
];

function stagedFiles() {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACM"],
    { encoding: "utf-8" },
  );
  return out.trim().split("\n").filter(Boolean);
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf-8" });
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

function workingContent(file) {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null; // binary, deleted, or unreadable — skip
  }
}

const forceAll = process.argv.includes("--all");
const staged = forceAll ? [] : stagedFiles();
const useStaged = staged.length > 0;
const files = useStaged ? staged : trackedFiles();
const readContent = useStaged ? stagedContent : workingContent;
const mode = useStaged ? "staged" : "tree";

const violations = [];
let checked = 0;
for (const file of files) {
  if (!INCLUDE.some((re) => re.test(file))) continue;
  if (EXCLUDE.some((re) => re.test(file))) continue;
  const content = readContent(file);
  if (content === null) continue;
  checked++;
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

console.log(
  `check-file-sizes: ${checked} file(s) checked (${mode} mode), none over ${MAX_LINES} lines.`,
);
