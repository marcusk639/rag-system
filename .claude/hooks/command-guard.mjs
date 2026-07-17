#!/usr/bin/env node
// PreToolUse Bash guard: hard-blocks DESTRUCTIVE commands anywhere in the
// command string, regardless of flag order, bundling, or position after a
// `&&`/`;`/`|`. This closes the gap the prefix-based deny list in
// settings.json cannot cover (that list only matches a command's *prefix*, so
// `cd x && rm -rf y`, `rm -fr y`, or a psql `DROP DATABASE` all slip past it).
//
// Complements git-guard.mjs (which owns git-flag specifics like --no-verify).
// Fails OPEN on unparseable stdin — a malformed hook payload must never brick
// every Bash call. Exit 2 blocks the tool call and shows the message to the model.
//
// Policy: hard-block both the catastrophic class (rm -rf, DROP DATABASE, dd)
// and the recoverable-but-destructive class (git clean, git restore worktree,
// docker volume rm, TRUNCATE). If a block is genuinely needed, run it yourself
// outside the agent.

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(data).tool_input?.command ?? "";
  } catch {
    process.exit(0); // fail open on non-JSON / harness contract drift
  }
  if (typeof cmd !== "string" || cmd.length === 0) process.exit(0);

  const SEG = "[^\\n|;&]*"; // "within one command segment" (don't cross &&/;/|)
  const block = (msg) => {
    process.stderr.write(
      `Blocked (command-guard): ${msg}\n` +
        `This destructive command is denied for agents. If it is genuinely needed, run it yourself.\n`,
    );
    process.exit(2);
  };

  // --- Regex rules (each tested against the whole command string) ---
  const rules = [
    // A. Filesystem destruction
    [new RegExp(`\\brm\\b${SEG}\\s-[a-zA-Z]*r`, "i"), "recursive rm (rm -r / -rf) deletes directory trees"],
    [/\brm\b[^\n|;&]*--recursive/i, "recursive rm (--recursive)"],
    [/\bfind\b[^\n|;&]*-delete\b/i, "find -delete performs bulk deletion"],
    [/\bfind\b[^\n|;&]*-exec\s+rm\b/i, "find -exec rm performs bulk deletion"],
    [/\bdd\b[^\n|;&]*\bof=/i, "dd of= does a raw disk/file overwrite"],
    [/\bmkfs\b/i, "mkfs formats a filesystem"],
    [/\bshred\b/i, "shred irreversibly destroys files"],
    [/\btruncate\b[^\n|;&]*-s\s*0\b/i, "truncate -s 0 empties a file"],
    [new RegExp(`\\bch(mod|own)\\b${SEG}\\s-[a-zA-Z]*R`, "i"), "recursive chmod/chown -R"],
    // B. Destructive SQL (unambiguous DDL, or any destructive verb through psql)
    [/\bdrop\s+(database|schema|table|index|column)\b/i, "SQL DROP (database/schema/table/index/column)"],
    // C. Destructive docker
    [new RegExp(`\\bdocker(-compose)?\\b${SEG}\\bdown\\b${SEG}(-v\\b|--volumes)`, "i"), "docker down -v removes volumes (your DB data)"],
    [/\bdocker\s+volume\s+(rm|prune)\b/i, "docker volume rm/prune deletes volume data"],
    [/\bdocker\s+system\s+prune/i, "docker system prune bulk-deletes resources"],
    [new RegExp(`\\bdocker\\b${SEG}\\brm\\b${SEG}\\s-[a-zA-Z]*f`, "i"), "docker rm -f force-removes a container"],
    // D. History / work-destroying git (git-guard.mjs owns the commit/add-flag cases)
    [new RegExp(`\\bgit\\b${SEG}\\breset\\b${SEG}--hard`, "i"), "git reset --hard discards commits/worktree"],
    [new RegExp(`\\bgit\\b${SEG}\\bclean\\b${SEG}\\s-[a-zA-Z]*f`, "i"), "git clean -f deletes untracked files (incl. scratch/ledger)"],
    [/\bgit\s+checkout\s+(--\s+)?\.(\s|$)/i, "git checkout . discards all worktree changes"],
    [/\bgit\s+checkout\s+--\s+\S/i, "git checkout -- <path> discards worktree changes"],
    [new RegExp(`\\bgit\\s+branch\\b${SEG}\\s-D\\b`, "i"), "git branch -D force-deletes a branch"],
    [new RegExp(`\\bgit\\s+branch\\b${SEG}--delete${SEG}--force`, "i"), "git branch --delete --force"],
    [new RegExp(`\\bgit\\s+worktree\\s+remove\\b${SEG}(\\s-f\\b|--force)`, "i"), "git worktree remove --force"],
    [/\bgit\s+stash\s+(clear|drop)\b/i, "git stash clear/drop deletes stashed work"],
    [new RegExp(`\\bgit\\b${SEG}\\bpush\\b${SEG}(--force(?!-with-lease)|\\s-f\\b)`, "i"), "git push --force/-f rewrites remote history (use --force-with-lease)"],
    [/\bgit\s+filter-(branch|repo)\b/i, "git filter-branch/filter-repo rewrites history"],
  ];
  for (const [re, msg] of rules) {
    if (re.test(cmd)) block(msg);
  }

  // --- Code-expressed rules (clearer than a single regex) ---

  // Any destructive verb reaching Postgres via psql (covers `docker exec … psql`,
  // `psql $DATABASE_URL -c "…"`). Read-only psql (\d, SELECT) passes.
  if (/\bpsql\b/i.test(cmd) && /\b(drop|truncate|delete\s+from|alter\s+table\b[\s\S]*\bdrop)\b/i.test(cmd)) {
    block("destructive SQL (DROP/TRUNCATE/DELETE/ALTER…DROP) executed through psql");
  }

  // `git restore` of the WORKTREE discards changes. Allow only staged-restore
  // (unstage), which is non-destructive; block worktree restore.
  if (/\bgit\s+restore\b/i.test(cmd)) {
    const stagedOnly = /--staged/i.test(cmd) && !/--worktree/i.test(cmd);
    if (!stagedOnly) {
      block("git restore of the worktree discards changes (only 'git restore --staged' to unstage is allowed)");
    }
  }
});
