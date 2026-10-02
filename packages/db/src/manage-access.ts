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
 * `resolveSourceIdsForUser` and `listSourceAssignmentHistoryForStaff`, so the
 * row semantics are the ones already proven in
 * `tests/e2e/src/specs/access-grants.spec.ts` and the parameters stay bound
 * rather than interpolated.
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
 * tables cannot hold a dead id -- `source_id` is an FK with ON DELETE CASCADE --
 * but note that a purge recreating a source under a new uuid cascades the grants
 * away, which from outside looks the same as never having had access.
 *
 * EXIT CODES
 *   0 success · 1 no-op · 2 usage · 3 operational · 4 needs attention
 *
 * Usage (from the repo root):
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

const HELP = `Usage:
  access -- sources
  access -- check  --user <id>
  access -- list   --user <id> [--revoked]
  access -- grant  --user <id> --source <uuid> --by <admin>
  access -- revoke --user <id> --source <uuid>

Connection: --url <conn> or DATABASE_URL.
Exit: 0 ok · 1 no-op · 2 usage · 3 operational · 4 needs attention`;

function die(msg: string, code: number = EXIT.USAGE): never {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
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
function parseArgs(argv: string[]) {
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
    if (val === undefined || val.startsWith("--")) {
      die(`--${name} needs a value.\n${HELP}`);
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
 * returns strings at runtime (verified). The admin UI survives this by wrapping
 * in `new Date(...)` at access-forms.tsx:229; this does the same. The declared
 * type is wrong rather than this code being paranoid -- worth fixing in
 * queries.ts separately, not in this file.
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
              `assignment '${stillVia[0]}'. This tool manages direct grants only.`,
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

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(EXIT.OPERATIONAL);
});
