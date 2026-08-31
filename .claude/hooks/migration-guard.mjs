#!/usr/bin/env node
// PreToolUse Edit/Write guard: protects files that agents must never hand-edit.
//
// Blocks:
//   1. Editing an ALREADY-COMMITTED Drizzle migration (packages/db/drizzle/*.sql).
//      Applied migrations are immutable — changing one silently corrupts the
//      migration chain for anyone (or any deploy) that already ran it. Creating
//      a NEW, not-yet-tracked migration file is allowed.
//   2. Any Edit/Write to pnpm-lock.yaml — it is generated; use `pnpm install` /
//      `pnpm add`, never a hand-edit.
//
// Fails OPEN on unparseable stdin (a malformed payload must not brick Edit/Write).
// Exit 2 blocks the tool call and shows the message to the model.

import { execFileSync } from "node:child_process";

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    process.exit(0);
  }
  const fp = input?.tool_input?.file_path;
  if (typeof fp !== "string" || fp.length === 0) process.exit(0);

  const block = (msg) => {
    process.stderr.write(`Blocked (migration-guard): ${msg}\n`);
    process.exit(2);
  };

  // 1. Lockfile — generated, never hand-edited.
  if (/(^|\/)pnpm-lock\.yaml$/.test(fp)) {
    block(
      "pnpm-lock.yaml is generated — run `pnpm install`/`pnpm add` instead of editing it.",
    );
  }

  // 2. Committed migration — immutable once applied.
  if (/(^|\/)packages\/db\/drizzle\/[^/]+\.sql$/.test(fp)) {
    let tracked = false;
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", fp], {
        stdio: "ignore",
        cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      });
      tracked = true; // exit 0 ⇒ the path is tracked (committed)
    } catch {
      tracked = false; // non-zero ⇒ untracked (a brand-new migration) — allow
    }
    if (tracked) {
      block(
        `${fp} is a committed migration; applied migrations are immutable. ` +
          `Author a NEW migration (next 00NN_*.sql + a _journal.json entry) instead of editing this one.`,
      );
    }
  }
});
