import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./migration-guard.mjs", import.meta.url));
// Run from the repo root so the hook's `git ls-files` resolves paths.
const REPO = fileURLToPath(new URL("../../", import.meta.url));

function run(tool, file_path) {
  try {
    execFileSync("node", [HOOK], {
      input: JSON.stringify({ tool_name: tool, tool_input: { file_path } }),
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    });
    return 0;
  } catch (e) {
    return e.status ?? -1;
  }
}

const BLOCK = [
  ["Edit", "pnpm-lock.yaml", "root lockfile"],
  ["Write", `${REPO}pnpm-lock.yaml`, "abs lockfile"],
  // 0000_init.sql is a committed migration in this repo → tracked → block.
  ["Edit", `${REPO}packages/db/drizzle/0000_init.sql`, "committed migration (abs)"],
  ["Edit", "packages/db/drizzle/0000_init.sql", "committed migration (rel)"],
];

const ALLOW = [
  // brand-new, untracked migration file — creating one is the sanctioned path.
  ["Write", `${REPO}packages/db/drizzle/9999_brand_new.sql`, "new untracked migration"],
  // schema + journal edits are needed WHEN authoring a migration — must pass.
  ["Edit", `${REPO}packages/db/src/schema.ts`, "schema.ts (needed for new tables)"],
  ["Edit", `${REPO}packages/db/drizzle/meta/_journal.json`, "journal (needed for new migration)"],
  // ordinary source/docs
  ["Edit", `${REPO}packages/services/src/ask.ts`, "normal source"],
  ["Write", `${REPO}docs/NEW.md`, "doc"],
  ["Edit", `${REPO}apps/api/src/routes/feedback.ts`, "route"],
];

let fail = 0;
for (const [tool, fp, label] of BLOCK) {
  const got = run(tool, fp);
  if (got !== 2) {
    console.error(`FAIL (should BLOCK, got ${got}): ${label}  ::  ${tool} ${fp}`);
    fail = 1;
  }
}
for (const [tool, fp, label] of ALLOW) {
  const got = run(tool, fp);
  if (got !== 0) {
    console.error(`FAIL (should ALLOW, got ${got}): ${label}  ::  ${tool} ${fp}`);
    fail = 1;
  }
}
try {
  execFileSync("node", [HOOK], { input: "not json", stdio: ["pipe", "ignore", "ignore"] });
} catch {
  console.error("FAIL: malformed stdin should fail OPEN (exit 0)");
  fail = 1;
}

if (!fail) console.log(`ok — ${BLOCK.length} block + ${ALLOW.length} allow + fail-open all pass`);
process.exit(fail);
