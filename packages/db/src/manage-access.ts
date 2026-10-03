#!/usr/bin/env tsx
/**
 * CLI for per-user source access. A thin front-end over the same typed queries
 * the admin UI uses -- it owns no SQL of its own.
 *
 * WHY A CLI WHEN THE ADMIN UI EXISTS
 *
 * `apps/web/src/app/admin/access/` has had admin-gated grant/revoke since
 * 2026-07-10 and is the normal path. This exists for the cases that UI cannot
 * serve: scripting a batch of grants, and operating when the web app is down or
 * the operator has no admin session. It is deliberately NOT a second
 * implementation -- it calls `grantSourceAccess`, `revokeSourceAccess`,
 * `resolveSourceIdsForUser`, `listSourceAssignmentHistoryForStaff`,
 * `listSources` and `clientRoutedGrantsForSource`, with bound parameters
 * rather than interpolation. The first four carry row semantics already proven
 * in `tests/e2e/src/specs/access-grants.spec.ts`; `clientRoutedGrantsForSource`
 * is new here and is covered by
 * `tests/e2e/src/specs/client-routed-grants.spec.ts` instead.
 *
 * WHAT IT ADDS over calling those functions directly
 *
 * 1. `revoke` warns when access SURVIVES the revoke. Access can also arrive via
 *    `staff_client_assignments` -> `source_client_assignments`, which
 *    `resolveSourceIdsForUser` honours but `revokeSourceAccess` cannot touch. A
 *    bare "done" there would read as "access removed" while the user still
 *    retrieves the source.
 * 2. Exit codes a script can branch on (below), so a failed revoke is never
 *    mistaken for an idempotent no-op.
 * 3. `check`, which reports the scope the BFF and the Teams bot will actually
 *    resolve -- both go through `resolveSourceIdsForUser`, so a revoke here
 *    changes Teams access too.
 *
 * It does NOT manage `API_PRINCIPALS`, the env-var list behind direct API/MCP
 * token access. That list has no foreign key, so it can name a source id that
 * no longer exists; `parsePrincipalsConfig` validates JSON shape only. These
 * tables cannot hold a dead id under the current FKs: `source_id` carries ON
 * DELETE CASCADE, so deleting a source takes its grant rows with it. That is
 * why `check`'s `<NO SUCH SOURCE>` branch is belt-and-braces, not a path
 * reached today -- it would matter only if a future table joined into the
 * resolve UNION without that FK. The cascade is not a safety net either:
 * deleting and recreating a source under a new uuid removes the grants, which
 * from outside looks the same as never having had access.
 *
 * EXIT CODES
 *   0 success · 1 no-op · 2 usage · 3 operational · 4 needs attention
 *
 * HOW TO RUN IT -- the two forms are not interchangeable
 *
 * Inside a deployed container, as COMPILED JS:
 *   node node_modules/@rag/db/dist/manage-access.js check --user <id>
 *
 * The runtime stage is plain `node:22-slim` with no pnpm, and
 * `pnpm deploy --prod` prunes the `tsx` that the package script shells out to.
 * So `pnpm --filter @rag/db access` CANNOT work there -- the same trap
 * `apps/worker/Dockerfile` records for the migrate command, which "could never
 * have worked against this image" and went unnoticed for ~7 weeks. Migrations
 * run as `node node_modules/@rag/db/dist/migrate.js` for this reason
 * (apps/worker/railway.json), and this follows that precedent.
 *
 * Locally, where devDependencies exist, the package script is the convenience:
 *   pnpm --filter @rag/db access -- sources
 *   pnpm --filter @rag/db access -- check  --user <idp-user-id>
 *   pnpm --filter @rag/db access -- list   --user <id> [--revoked]
 *   pnpm --filter @rag/db access -- grant  --user <id> --source <uuid> --by <admin>
 *   pnpm --filter @rag/db access -- revoke --user <id> --source <uuid>
 */

import { createDb } from "./client.js";
import {
  clientRoutedGrantsForSource,
  grantSourceAccess,
  listSourceAssignmentHistoryForStaff,
  listSources,
  resolveSourceIdsForUser,
  revokeSourceAccess,
} from "./queries.js";

const EXIT = {
  OK: 0,
  NOOP: 1,
  USAGE: 2,
  OPERATIONAL: 3,
  ATTENTION: 4,
} as const;

/**
 * Thrown rather than exiting, so `parseArgs` can be unit-tested without
 * stubbing `process.exit`. `main` converts it to EXIT.USAGE. Everything that
 * is genuinely a usage problem must go through here, or it lands in
 * `main().catch` and gets reported as EXIT.OPERATIONAL instead.
 */
export class UsageError extends Error {}

const HELP = `Usage (in a container, compiled):
  node node_modules/@rag/db/dist/manage-access.js <command> [flags]
Usage (locally, via the package script):
  pnpm --filter @rag/db access -- <command> [flags]

Commands:
  sources
  check  --user <id>
  list   --user <id> [--revoked]
  grant  --user <id> --source <uuid> --by <admin>
  revoke --user <id> --source <uuid>

Connection: --url <conn> or DATABASE_URL.
Exit: 0 ok · 1 no-op · 2 usage · 3 operational · 4 needs attention`;

function die(msg: string): never {
  throw new UsageError(msg);
}

const VALUE_FLAGS: Record<string, string[]> = {
  sources: ["url"],
  check: ["url", "user"],
  list: ["url", "user"],
  grant: ["url", "user", "source", "by"],
  revoke: ["url", "user", "source"],
};
const BOOL_FLAGS: Record<string, string[]> = {
  sources: [],
  check: [],
  list: ["revoked"],
  grant: [],
  revoke: [],
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Unknown flags are rejected rather than ignored: silently dropping a mistyped
 * flag is how a typo'd `--url` would target production instead of the intended
 * database.
 */
export function parseArgs(argv: string[]) {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    process.exit(EXIT.OK);
  }
  const valueFlags = VALUE_FLAGS[cmd];
  const boolFlags = BOOL_FLAGS[cmd];
  if (!valueFlags || !boolFlags) die(`unknown command '${cmd}'.\n${HELP}`);
  const allowed = new Set([...valueFlags, ...boolFlags]);
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (!tok.startsWith("--")) die(`unexpected argument '${tok}'.\n${HELP}`);
    if (tok.includes("=")) die(`use '--flag value', not '${tok}'.\n${HELP}`);
    const name = tok.slice(2);
    if (!allowed.has(name)) {
      die(
        `unknown flag '--${name}' for '${cmd}'. Allowed: ${[...allowed]
          .map((f) => `--${f}`)
          .join(" ")}\n${HELP}`,
      );
    }
    if (boolFlags.includes(name)) {
      bools.add(name);
      continue;
    }
    const val = argv[i + 1];
    // An empty value is rejected here rather than downstream: `--by "$ADMIN"`
    // with an unset variable is realistic in the scripted use this exists for,
    // and would otherwise write granted_by = '' into the audit trail.
    if (val === undefined || val === "" || val.startsWith("--")) {
      die(`--${name} needs a non-empty value.\n${HELP}`);
    }
    if (values.has(name)) die(`--${name} given more than once.\n${HELP}`);
    values.set(name, val);
    i++;
  }
  return { cmd, values, bools };
}

const requireUuid = (v: string, what: string) =>
  UUID_RE.test(v) ? v : die(`${what} must be a uuid, got '${v}'`);

/**
 * `StaffSourceAssignmentHistoryRow` declares these as `Date`, but the driver
 * returns strings at runtime. The admin UI survives it by wrapping in
 * `new Date(...)` -- see `SourceAccessHistoryForm` in
 * apps/web/src/app/admin/access/access-forms.tsx (the sibling
 * `AccessHistoryForm` renders CLIENT assignments, a different row type). That
 * wrap is why the declared type's being wrong went unnoticed; this does the
 * same. Nothing in-tree asserts the runtime type either way, so a regression
 * test belongs with a fix to the declaration, not here.
 */
const stamp = (v: Date | string | null): string =>
  v === null ? "" : new Date(v).toISOString().slice(0, 16).replace("T", " ");

async function main() {
  const { cmd, values, bools } = parseArgs(process.argv.slice(2));
  const url = values.get("url") ?? process.env.DATABASE_URL;
  if (!url) die("no connection string. Pass --url or set DATABASE_URL.");

  let target = "<unparseable connection string>";
  try {
    const u = new URL(url);
    target = `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    // Keep going: createDb will fail with its own message if the URL is bad.
  }

  const { db, close } = createDb(url, { max: 2 });
  try {
    switch (cmd) {
      case "sources": {
        const rows = await listSources(db);
        if (rows.length === 0) {
          console.log("no sources");
          break;
        }
        for (const s of rows) console.log(`${s.id}  ${s.kind}  ${s.name}`);
        break;
      }

      case "check": {
        const user = values.get("user") ?? die("check needs --user <id>");
        // The scope the web BFF and the Teams bot will actually resolve.
        const ids = await resolveSourceIdsForUser(db, user);
        console.log(`user:   ${user}`);
        console.log(`target: ${target}`);
        if (ids.length === 0) {
          console.log(
            "resolves to: [] -- DENY-ALL. This user retrieves nothing.",
          );
          console.log(
            "(an empty scope is the fail-closed case, not unrestricted access)",
          );
          process.exit(EXIT.ATTENTION);
        }
        const all = await listSources(db);
        const byId = new Map(all.map((s) => [s.id, s.name]));
        let dead = 0;
        console.log(`resolves to ${ids.length} source id(s):`);
        for (const id of ids) {
          const via = (await clientRoutedGrantsForSource(db, user, id)).length
            ? "via client assignment"
            : "direct grant";
          const name = byId.get(id);
          if (name) console.log(`  ${id}  ${name}  (${via})`);
          else {
            dead++;
            console.log(`  ${id}  <NO SUCH SOURCE>  (${via})`);
          }
        }
        if (dead > 0) process.exit(EXIT.ATTENTION);
        break;
      }

      case "list": {
        const user = values.get("user") ?? die("list needs --user <id>");
        const history = await listSourceAssignmentHistoryForStaff(db, user);
        console.log(
          "# DIRECT grants only -- client-routed access is not shown.",
        );
        console.log("# Use 'check --user <id>' for a user's effective scope.");
        const rows = bools.has("revoked")
          ? history
          : history.filter((h) => h.revokedAt === null);
        if (rows.length === 0) {
          console.log(
            bools.has("revoked")
              ? "no assignments"
              : "no ACTIVE assignments (use --revoked to include revoked rows)",
          );
          break;
        }
        for (const h of rows) {
          const state = h.revokedAt
            ? `REVOKED ${stamp(h.revokedAt)}`
            : "active";
          console.log(
            `${h.sourceId}  granted ${stamp(h.grantedAt)} by ${h.grantedBy}  ${state}`,
          );
        }
        break;
      }

      case "grant": {
        const user = values.get("user") ?? die("grant needs --user <id>");
        const sourceId = requireUuid(
          values.get("source") ?? die("grant needs --source <uuid>"),
          "--source",
        );
        const by =
          values.get("by") ??
          die("grant needs --by <admin-id> (granted_by is the audit trail)");
        // The FK would reject a dead id anyway; checking first buys a legible
        // error and the source name for the confirmation line.
        const known = (await listSources(db)).find((s) => s.id === sourceId);
        if (!known) {
          die(
            `source ${sourceId} does not exist. Run 'sources' to list live ids.`,
          );
        }
        console.log(`target: ${target}`);
        await grantSourceAccess(db, { userId: user, sourceId, grantedBy: by });
        console.log(`granted ${user} -> ${sourceId} (${known.name})`);
        break;
      }

      case "revoke": {
        const user = values.get("user") ?? die("revoke needs --user <id>");
        const sourceId = requireUuid(
          values.get("source") ?? die("revoke needs --source <uuid>"),
          "--source",
        );
        console.log(`target: ${target}`);
        const before = await listSourceAssignmentHistoryForStaff(db, user);
        const active = before.find(
          (h) => h.sourceId === sourceId && h.revokedAt === null,
        );
        await revokeSourceAccess(db, { userId: user, sourceId });

        const stillVia = await clientRoutedGrantsForSource(db, user, sourceId);
        if (!active) {
          const prior = before.find((h) => h.sourceId === sourceId);
          console.log(
            prior
              ? `no change: already revoked ${stamp(prior.revokedAt)}`
              : `no direct grant has ever existed for ${user} -> ${sourceId}`,
          );
        } else {
          console.log(
            `revoked ${user} -> ${sourceId} (row kept, revoked_at set)`,
          );
        }
        if (stillVia.length > 0) {
          console.log(
            `WARNING: ${user} STILL has access to ${sourceId} via client ` +
              `assignment(s) ${stillVia.map((c) => `'${c}'`).join(", ")}. ` +
              "This tool manages direct grants only.",
          );
          process.exit(EXIT.ATTENTION);
        }
        if (!active) process.exit(EXIT.NOOP);
        break;
      }
    }
  } finally {
    await close();
  }
}

/**
 * Only run when executed directly. Without this guard, importing the module
 * — as `manage-access.test.ts` does to reach `parseArgs` — runs the whole CLI
 * as an import side effect, which prints help and then calls `process.exit`,
 * failing the package's test run. The unit test is what surfaced it.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    // A usage problem must not be reported as operational: a caller that
    // branches on exit 3 would retry a malformed command forever.
    process.exit(err instanceof UsageError ? EXIT.USAGE : EXIT.OPERATIONAL);
  });
}
