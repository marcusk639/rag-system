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
// run outside a commit — it inspects zero files and reports success. That is how
// two files crossed the cap on a branch that reported "all gates green":
// packages/ingestion/src/pipeline.test.ts at 1058, and
// services/parser-py/app/main.py at 845.

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

// A file the check could not read is NOT a pass. Track the two outcomes apart:
// `skipped` is an expected absence (staged path no longer in the index, file
// deleted under us); `unreadable` is a real fault that must fail the gate,
// because silently skipping an oversized file is the bug this script exists to
// prevent.
const skipped = [];
const unreadable = [];

function describe(err) {
  return String(err?.code ?? err?.message ?? err)
    .split("\n")[0]
    .trim();
}

function stagedContent(file) {
  try {
    return execFileSync("git", ["show", `:${file}`], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail = String(err?.stderr ?? err?.message ?? "");
    if (/does not exist|exists on disk, but not in/i.test(detail)) {
      skipped.push(file);
    } else {
      unreadable.push({ file, reason: describe(err) });
    }
    return null;
  }
}

function workingContent(file) {
  try {
    return readFileSync(file, "utf-8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      skipped.push(file);
    } else {
      unreadable.push({ file, reason: describe(err) });
    }
    return null;
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

if (unreadable.length > 0) {
  console.error(
    `\n  BLOCKED: ${unreadable.length} file(s) could not be read, so the ${MAX_LINES}-line check never ran on them:`,
  );
  for (const u of unreadable) console.error(`    ${u.file}: ${u.reason}`);
  console.error(
    "\n  A gate that cannot read a file must not report success.\n",
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`\n  BLOCKED: file(s) exceed ${MAX_LINES} lines:`);
  for (const v of violations) console.error(`    ${v.file}: ${v.lines} lines`);
  console.error(
    "\n  Split the file before committing (see CLAUDE.md file-organization rules).\n",
  );
  process.exit(1);
}

const skipNote =
  skipped.length > 0 ? `, ${skipped.length} skipped (absent)` : "";
console.log(
  `check-file-sizes: ${checked} file(s) checked (${mode} mode)${skipNote}, none over ${MAX_LINES} lines.`,
);
