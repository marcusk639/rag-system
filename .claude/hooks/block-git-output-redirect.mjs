#!/usr/bin/env node
// PreToolUse hook: git log/diff/show are allowlisted as read-only in
// .claude/settings.json, but their --output flag writes arbitrary files.
// Block that flag so the read-only allowance stays read-only.
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(data).tool_input?.command ?? "";
  } catch {
    process.exit(0);
  }
  if (/\bgit\b[^\n|;&]*\b(log|diff|show)\b[^\n|;&]*--output/.test(cmd)) {
    console.error(
      "Blocked: --output on git log/diff/show writes files; the allowlist treats these commands as read-only.",
    );
    process.exit(2);
  }
});
