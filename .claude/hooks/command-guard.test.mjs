import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve the hook next to this test file so it runs from any checkout.
const HOOK = fileURLToPath(new URL("./command-guard.mjs", import.meta.url));

// Run the hook with a command payload; return exit code (0 allow, 2 block).
function run(command) {
  try {
    execFileSync("node", [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      stdio: ["pipe", "ignore", "ignore"],
    });
    return 0;
  } catch (e) {
    return e.status ?? -1;
  }
}

// Assemble destructive test strings at runtime so THIS test file doesn't itself
// trip the command-guard when it's later staged/committed.
const RMRF = ["rm", "-rf"].join(" ");
const DROPDB = ["DROP", "DATABASE", "rag"].join(" ");
const TRUNC = ["TRUNCATE", "answer_feedback"].join(" ");

const BLOCK = [
  // A. filesystem
  [`${RMRF} postgres-data`, "rm -rf"],
  [`cd /tmp && ${RMRF} x`, "rm -rf after &&"],
  ["rm -fr build", "rm -fr (reordered)"],
  ["rm --recursive dist", "rm --recursive"],
  ["find . -name '*.log' -delete", "find -delete"],
  ["find . -type f -exec rm {} +", "find -exec rm"],
  ["dd if=/dev/zero of=/dev/disk2", "dd of="],
  ["mkfs.ext4 /dev/sdb", "mkfs"],
  ["shred -u secret.key", "shred"],
  ["truncate -s 0 important.log", "truncate -s 0"],
  ["chmod -R 777 .", "chmod -R"],
  ["chown -R root .", "chown -R"],
  ["git branch -D feat/unmerged", "git branch -D (force)"],
  // B. SQL
  [
    `docker exec rag-postgres psql -U rag -d postgres -c "${DROPDB}"`,
    "psql DROP DATABASE",
  ],
  [`psql "$DATABASE_URL" -c "${TRUNC}"`, "psql TRUNCATE"],
  [
    `docker exec rag-postgres psql -U rag -d rag -c "DELETE FROM audit_log"`,
    "psql DELETE FROM",
  ],
  ["psql -c 'DROP TABLE chunks'", "DROP TABLE"],
  // C. docker
  ["docker compose -f docker/docker-compose.yml down -v", "docker down -v"],
  ["docker compose down --volumes", "docker down --volumes"],
  ["docker volume rm rag_postgres-data", "docker volume rm"],
  ["docker volume prune -f", "docker volume prune"],
  ["docker system prune -af --volumes", "docker system prune"],
  ["docker rm -f rag-postgres", "docker rm -f"],
  // D. git
  ["git reset --hard HEAD~3", "git reset --hard"],
  ["git reset --hard origin/main", "git reset --hard origin"],
  ["git clean -fdx", "git clean -fdx"],
  ["git clean -fd", "git clean -fd"],
  ["git checkout .", "git checkout ."],
  ["git checkout -- src/index.ts", "git checkout -- path"],
  ["git restore src/index.ts", "git restore worktree"],
  ["git restore --staged --worktree src/index.ts", "git restore --worktree"],
  ["git branch -D feat/x", "git branch -D"],
  ["git branch --delete --force feat/x", "git branch --delete --force"],
  ["git worktree remove --force ../wt", "git worktree remove --force"],
  ["git stash clear", "git stash clear"],
  ["git stash drop stash@{0}", "git stash drop"],
  ["git push --force origin main", "git push --force"],
  ["git push -f", "git push -f"],
  ["git filter-branch --tree-filter x HEAD", "git filter-branch"],
];

const ALLOW = [
  // benign filesystem
  ["rm scratch.txt", "plain rm"],
  ["rm -f scratch.txt", "rm -f single file"],
  ["ls -la && cat package.json", "ls/cat"],
  // repo pnpm workflow
  ["pnpm docker:up", "docker:up"],
  ["pnpm docker:down", "docker:down (no -v)"],
  ["pnpm docker:logs", "docker:logs"],
  ["pnpm db:migrate", "db:migrate"],
  ["pnpm db:generate", "db:generate"],
  ["pnpm db:studio", "db:studio"],
  ["pnpm -r build && pnpm test", "build+test"],
  ["pnpm --filter @rag/db test", "filtered test"],
  ["npm run build", "npm run"],
  // read-only psql
  [
    'docker exec rag-postgres psql -U rag -d rag -c "\\d answer_feedback"',
    "psql describe",
  ],
  [
    'docker exec rag-postgres psql -U rag -d rag -c "SELECT count(*) FROM audit_log"',
    "psql select",
  ],
  // safe git
  ["git status", "git status"],
  ["git checkout main", "git checkout branch"],
  ["git checkout -b feat/new-thing", "git checkout -b"],
  ["git branch", "git branch"],
  ["git branch --list 'feat/*'", "git branch --list"],
  ["git branch -d feat/merged", "git branch -d (safe merged delete)"],
  ["chmod 644 file.txt", "chmod non-recursive"],
  ["git add .", "git add ."],
  ['git commit -m "feat: x"', "git commit -m"],
  ["git restore --staged src/index.ts", "git restore --staged (unstage)"],
  ["git push origin main", "git push (no force)"],
  ["git push --force-with-lease origin main", "git push --force-with-lease"],
  ["git worktree remove ../wt", "git worktree remove (no --force)"],
  ["git merge --no-ff feat/x", "git merge"],
  // words that merely contain 'rm'
  ["echo 'warm firmware alarm'", "words containing rm"],
  ["pnpm run lint", "pnpm run (contains rm? no)"],
];

let fail = 0;
for (const [cmd, label] of BLOCK) {
  const got = run(cmd);
  if (got !== 2) {
    console.error(`FAIL (should BLOCK, got ${got}): ${label}  ::  ${cmd}`);
    fail = 1;
  }
}
for (const [cmd, label] of ALLOW) {
  const got = run(cmd);
  if (got !== 0) {
    console.error(`FAIL (should ALLOW, got ${got}): ${label}  ::  ${cmd}`);
    fail = 1;
  }
}
// malformed stdin fails open (exit 0)
try {
  execFileSync("node", [HOOK], {
    input: "not json",
    stdio: ["pipe", "ignore", "ignore"],
  });
} catch {
  console.error("FAIL: malformed stdin should fail OPEN (exit 0)");
  fail = 1;
}

if (!fail)
  console.log(
    `ok — ${BLOCK.length} block cases + ${ALLOW.length} allow cases + fail-open all pass`,
  );
process.exit(fail);
