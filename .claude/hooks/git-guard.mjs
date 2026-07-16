#!/usr/bin/env node
// PreToolUse hook: keeps the allowlisted git commands within their intended
// semantics (.claude/settings.json). Blocks:
//   1. --output on git log/diff/show  — file-write escape from read-only allows
//   2. --no-verify on git commit      — bypasses the pre-commit guards
//   3. -f/--force on git add          — overrides .gitignore (e.g. staging .env)
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(data).tool_input?.command ?? "";
  } catch {
    process.exit(0);
  }
  const seg = "[^\\n|;&]*";
  const rules = [
    {
      re: new RegExp(`\\bgit\\b${seg}\\b(log|diff|show)\\b${seg}--output`),
      msg: "--output on git log/diff/show writes files; the allowlist treats these commands as read-only.",
    },
    {
      re: new RegExp(`\\bgit\\b${seg}\\bcommit\\b${seg}(\\s--no-verify|\\s-[a-zA-Z]*n[a-zA-Z]*\\b)`),
      msg: "commit with --no-verify/-n skips the pre-commit secret/size guards.",
    },
    {
      re: new RegExp(`\\bgit\\b${seg}\\badd\\b${seg}(\\s-[a-zA-Z]*f|\\s--force)`),
      msg: "git add -f/--force overrides .gitignore (can stage .env and other ignored files).",
    },
  ];
  for (const { re, msg } of rules) {
    if (re.test(cmd)) {
      console.error(`Blocked: ${msg}`);
      process.exit(2);
    }
  }
});
