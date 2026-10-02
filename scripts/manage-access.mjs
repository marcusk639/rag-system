#!/usr/bin/env node
/**
 * Grant, revoke and inspect per-user source access.
 *
 * WHY THIS EXISTS
 *
 * `staff_source_assignments` is one of two tables the web BFF consults (via
 * `resolveSourceIdsForUser` in @rag/db) to decide what a signed-in staff member
 * may retrieve. It had schema and migration 0012 but no CLI and no admin route,
 * so onboarding a user meant hand-written SQL. An empty table is not an open
 * door -- it is the fail-closed deny-all case, so every user sees an empty
 * knowledge base.
 *
 * TWO THINGS THIS TOOL DOES NOT MANAGE -- read before trusting a result
 *
 * 1. CLIENT-ROUTED GRANTS. Access can also arrive via
 *    `staff_client_assignments` -> `source_client_assignments`. `check` reports
 *    that path because the BFF honours it, but `grant`/`revoke`/`list` only
 *    touch the direct table. A revoke therefore CANNOT remove client-routed
 *    access; when it finds nothing to do it re-checks that path and says so
 *    explicitly rather than reporting a bare "nothing changed", which would read
 *    as "access removed" when access is still live.
 * 2. `API_PRINCIPALS`, the env-var list behind direct API/MCP token access.
 *    Unlike these tables it has no foreign key, so it CAN hold a source id that
 *    no longer exists -- which is what left two principals pointed at three dead
 *    ids after the 2026-08-03 purge rebuilt the corpus under a new source uuid.
 *    These tables cannot develop that fault: `source_id` carries
 *    `REFERENCES sources(id) ON DELETE CASCADE` (verified by deleting a source
 *    and watching the assignment row go with it).
 *
 * EXIT CODES -- a caller must be able to tell a no-op from a failure
 *
 *   0  success
 *   1  no-op / nothing to do, and nothing is wrong (e.g. already revoked)
 *   2  usage or validation error (bad flag, bad uuid, missing argument)
 *   3  operational failure (psql missing, connection refused, SQL error)
 *   4  a state the caller probably wants to act on: empty scope, dead id, or
 *      access that survives in a table this tool cannot reach
 *
 * `revoke … || echo fine` must not swallow a dropped connection, which is why 1
 * and 3 are separate.
 *
 * SAFETY
 *
 * - Unknown flags are REJECTED. A typo'd `--dry-run` would otherwise run the
 *   mutation for real, and a typo'd `--url` would silently fall through to
 *   DATABASE_URL -- i.e. to production, defeating this file's own advice to
 *   rehearse against a restored copy. Every mutation also prints the resolved
 *   target first.
 * - Revoke is a soft revoke (`revoked_at = now()`), never a DELETE, per the
 *   schema comment: the row is the audit trail.
 * - Grant is idempotent and un-revokes. The unique index on
 *   (user_id, source_id) requires the UPDATE path; a plain INSERT would fail for
 *   anyone previously revoked.
 * - `granted_by` is NOT NULL by design, so `--by` is required.
 * - The connection string is passed via PG* environment variables, never argv,
 *   so the password does not appear in `ps`.
 *
 * Production `DATABASE_URL` resolves rag-postgres.railway.internal, which does
 * not resolve outside Railway's network, and rag-postgres exposes no public URL.
 * Run this from inside Railway; use a restored copy for inspection.
 *
 * Usage:
 *   node scripts/manage-access.mjs sources
 *   node scripts/manage-access.mjs check  --user <idp-user-id>
 *   node scripts/manage-access.mjs list   [--user <id>] [--source <uuid>] [--revoked]
 *   node scripts/manage-access.mjs grant  --user <id> --source <uuid> --by <admin> [--dry-run]
 *   node scripts/manage-access.mjs revoke --user <id> --source <uuid> [--dry-run]
 */

import { execFileSync } from "node:child_process";

const EXIT = { OK: 0, NOOP: 1, USAGE: 2, OPERATIONAL: 3, ATTENTION: 4 };

const die = (msg, code = EXIT.USAGE) => {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
  // Unreachable. Present so `die` is genuinely `never`: every call site uses it
  // in expression position (`flag("user") ?? die(...)`), and if `die` were ever
  // changed to log-and-return, those sites would silently bind `undefined` and
  // `lit(undefined)` would query for a user literally named "undefined" --
  // producing a confident DENY-ALL report about a user never looked up.
  throw new Error(msg);
};

const argv = process.argv.slice(2);
const cmd = argv[0];

const HELP = [
  "Usage:",
  "  manage-access.mjs sources",
  "  manage-access.mjs check  --user <id>",
  "  manage-access.mjs list   [--user <id>] [--source <uuid>] [--revoked]",
  "  manage-access.mjs grant  --user <id> --source <uuid> --by <admin> [--dry-run]",
  "  manage-access.mjs revoke --user <id> --source <uuid> [--dry-run]",
  "",
  "Connection: --url <conn> or DATABASE_URL.",
  "Exit: 0 ok · 1 no-op · 2 usage · 3 operational · 4 needs attention",
].join("\n");

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(EXIT.OK);
}

// Per-command flag allowlist. Anything unrecognised is fatal: silently ignoring
// an unknown flag is how a typo'd --dry-run becomes a real mutation.
const VALUE_FLAGS = {
  sources: ["url"],
  check: ["url", "user"],
  list: ["url", "user", "source"],
  grant: ["url", "user", "source", "by"],
  revoke: ["url", "user", "source"],
};
const BOOL_FLAGS = {
  sources: [],
  check: [],
  list: ["revoked"],
  grant: ["dry-run"],
  revoke: ["dry-run"],
};
if (!VALUE_FLAGS[cmd]) die(`unknown command '${cmd}'.\n${HELP}`);

const allowed = new Set([...VALUE_FLAGS[cmd], ...BOOL_FLAGS[cmd]]);
const values = new Map();
const bools = new Set();
for (let i = 1; i < argv.length; i++) {
  const tok = argv[i];
  if (!tok.startsWith("--")) die(`unexpected argument '${tok}'.\n${HELP}`);
  if (tok.includes("=")) {
    // Rejected rather than supported, so `--dry-run=false` can never be read as
    // a truthy boolean flag.
    die(`use '--flag value', not '${tok}'.\n${HELP}`);
  }
  const name = tok.slice(2);
  if (!allowed.has(name)) {
    die(
      `unknown flag '--${name}' for '${cmd}'. Allowed: ` +
        `${[...allowed].map((f) => `--${f}`).join(" ")}\n${HELP}`,
    );
  }
  if (BOOL_FLAGS[cmd].includes(name)) {
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
const flag = (n) => values.get(n) ?? null;
const has = (n) => bools.has(n);
const dryRun = has("dry-run");

const rawUrl = flag("url") ?? process.env.DATABASE_URL ?? null;
if (!rawUrl) die("no connection string. Pass --url or set DATABASE_URL.");

/**
 * Credentials go in the environment, not argv: an argv connection string is
 * readable by any other user on the host via `ps` for the life of each call.
 * Falls back to argv only if the URL cannot be parsed, and says so.
 */
let pgEnv = { ...process.env };
let pgArgs = [];
let target;
try {
  const u = new URL(rawUrl);
  const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  pgEnv = {
    ...process.env,
    PGHOST: u.hostname,
    ...(u.port ? { PGPORT: u.port } : {}),
    ...(u.username ? { PGUSER: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { PGPASSWORD: decodeURIComponent(u.password) } : {}),
    PGDATABASE: db,
    ...(u.searchParams.get("sslmode")
      ? { PGSSLMODE: u.searchParams.get("sslmode") }
      : {}),
  };
  target = `${u.hostname}${u.port ? `:${u.port}` : ""}/${db}`;
} catch {
  pgArgs = [rawUrl];
  target = "<unparseable connection string; passed on argv>";
  console.error(
    "WARNING: could not parse the connection string, so it is being passed on " +
      "argv where `ps` can read it. Check the URL form.",
  );
}

// Explicit record and field separators. `-At` alone delimits records with \n,
// and psql does not escape a newline inside a value, so a source name
// containing one would be parsed as two rows. Written as escapes, not literal
// control bytes, so they survive editors and diffs.
const REC = "\u001e";
const FIELD = "\u001f";

const q = (sql) => {
  try {
    return execFileSync(
      "psql",
      [
        ...pgArgs,
        "-At",
        "-q",
        "-R",
        REC,
        "-F",
        FIELD,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: pgEnv,
      },
    )
      .split(REC)
      .map((r) => r.replace(/\n$/, ""))
      .filter((r) => r.length > 0)
      .map((r) => r.split(FIELD));
  } catch (err) {
    if (err.code === "ENOENT") {
      die("psql is not installed or not on PATH.", EXIT.OPERATIONAL);
    }
    if (err.code === "ENOBUFS") {
      die(
        "psql output exceeded the 32 MB buffer and was truncated — the query " +
          "succeeded but the result is unusable. Narrow it with --user/--source.",
        EXIT.OPERATIONAL,
      );
    }
    die(
      `psql failed (${target}):\n${(err.stderr || err.message || "").toString().trim()}`,
      EXIT.OPERATIONAL,
    );
  }
};

// `lit()` doubles quotes, which is sufficient only while
// standard_conforming_strings is on (the default since PG 9.1). If it were off,
// a backslash-quote in an admin-supplied user id would escape the literal. Fail
// loudly rather than silently relying on it.
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const scs = q("SHOW standard_conforming_strings")[0]?.[0];
if (scs !== "on") {
  die(
    `standard_conforming_strings is '${scs}', not 'on'. This tool quotes by ` +
      "doubling single quotes, which is unsafe under that setting.",
    EXIT.OPERATIONAL,
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireUuid = (v, what) => {
  if (!UUID_RE.test(v)) die(`${what} must be a uuid, got '${v}'`);
  return v;
};

/** The client-routed grant path, which this tool can read but not modify. */
const clientRoutedSources = (user) =>
  q(`
    SELECT sca.source_id::text, sta.client_id
    FROM staff_client_assignments sta
    JOIN source_client_assignments sca ON sca.client_id = sta.client_id
    WHERE sta.user_id = ${lit(user)} AND sta.revoked_at IS NULL
  `);

switch (cmd) {
  case "sources": {
    const rows = q(
      `SELECT s.id::text, s.kind, s.name,
              (SELECT count(*) FROM documents d WHERE d.source_id = s.id)::text
       FROM sources s ORDER BY s.name`,
    );
    if (rows.length === 0) {
      console.log("no sources");
      break;
    }
    console.log(
      "id                                    kind         docs  name",
    );
    for (const [id, kind, name, docs] of rows) {
      console.log(`${id}  ${kind.padEnd(11)}  ${docs.padStart(4)}  ${name}`);
    }
    break;
  }

  case "check": {
    const user = flag("user") ?? die("check needs --user <id>");
    // Mirrors resolveSourceIdsForUser in packages/db/src/queries.ts. The same
    // UNION also appears in resolveSharedSourceIdsForUsers there, so this is the
    // third copy — if that query gains a condition, this one must gain it too or
    // `check` will keep confidently reporting the old answer.
    const ids = q(`
      SELECT source_id::text FROM (
        SELECT sca.source_id
        FROM staff_client_assignments sta
        JOIN source_client_assignments sca ON sca.client_id = sta.client_id
        WHERE sta.user_id = ${lit(user)} AND sta.revoked_at IS NULL
        UNION
        SELECT source_id FROM staff_source_assignments
        WHERE user_id = ${lit(user)} AND revoked_at IS NULL
      ) combined
    `).map((r) => r[0]);
    console.log(`user:   ${user}`);
    console.log(`target: ${target}`);
    if (ids.length === 0) {
      console.log("resolves to: [] -- DENY-ALL. This user retrieves nothing.");
      console.log(
        "(an empty scope is the fail-closed case, not unrestricted access)",
      );
      process.exit(EXIT.ATTENTION);
    }
    const live = q(
      `SELECT id::text, name FROM sources
       WHERE id IN (${ids.map((i) => `${lit(i)}::uuid`).join(", ")})`,
    );
    const clientRouted = new Set(clientRoutedSources(user).map((r) => r[0]));
    console.log(`resolves to ${ids.length} source id(s):`);
    let dead = 0;
    for (const id of ids) {
      const row = live.find((r) => r[0] === id);
      const via = clientRouted.has(id)
        ? "via client assignment"
        : "direct grant";
      if (row) console.log(`  ${id}  ${row[1]}  (${via})`);
      else {
        dead++;
        console.log(`  ${id}  <NO SUCH SOURCE>  (${via})`);
      }
    }
    if (dead > 0) {
      console.log(
        `${dead} granted id(s) resolve to no live source and contribute nothing.`,
      );
      process.exit(EXIT.ATTENTION);
    }
    break;
  }

  case "list": {
    const user = flag("user");
    const source = flag("source");
    if (source) requireUuid(source, "--source");
    const where = [
      user ? `a.user_id = ${lit(user)}` : null,
      source ? `a.source_id = ${lit(source)}::uuid` : null,
      has("revoked") ? null : "a.revoked_at IS NULL",
    ].filter(Boolean);
    const rows = q(`
      SELECT a.user_id, a.source_id::text, coalesce(s.name, '<missing source>'),
             to_char(a.granted_at, 'YYYY-MM-DD HH24:MI'), a.granted_by,
             coalesce(to_char(a.revoked_at, 'YYYY-MM-DD HH24:MI'), '')
      FROM staff_source_assignments a
      LEFT JOIN sources s ON s.id = a.source_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.user_id, s.name
    `);
    console.log(
      "# DIRECT grants only. Client-routed access is not shown here;",
    );
    console.log("# use 'check --user <id>' for a user's effective scope.");
    if (rows.length === 0) {
      console.log(
        has("revoked")
          ? "no assignments match"
          : "no ACTIVE assignments match (use --revoked to include revoked rows)",
      );
      break;
    }
    for (const [u, sid, name, granted, by, revoked] of rows) {
      console.log(
        `${u}  ${sid}  ${name}  granted ${granted} by ${by}  ${revoked ? `REVOKED ${revoked}` : "active"}`,
      );
    }
    break;
  }

  case "grant": {
    const user = flag("user") ?? die("grant needs --user <id>");
    const source = requireUuid(
      flag("source") ?? die("grant needs --source <uuid>"),
      "--source",
    );
    const by =
      flag("by") ??
      die("grant needs --by <admin-id> (granted_by is the audit trail)");
    const found = q(`SELECT name FROM sources WHERE id = ${lit(source)}::uuid`);
    if (found.length === 0) {
      die(
        `source ${source} does not exist. Run 'sources' to list live ids -- ` +
          "granting a dead id produces a user who silently sees nothing.",
      );
    }
    const name = found[0][0];
    // Pre-check rather than RETURNING (xmax = 0): with ON CONFLICT, Postgres
    // uses speculative insertion and can leave a non-zero xmax on a row it
    // genuinely inserted, mislabelling a fresh grant as a re-activation.
    const prior = q(`
      SELECT coalesce(to_char(revoked_at, 'YYYY-MM-DD'), 'active')
      FROM staff_source_assignments
      WHERE user_id = ${lit(user)} AND source_id = ${lit(source)}::uuid`);
    const priorState = prior[0]?.[0] ?? null;
    const sql = `
      WITH ins AS (
        INSERT INTO staff_source_assignments (user_id, source_id, granted_by)
        VALUES (${lit(user)}, ${lit(source)}::uuid, ${lit(by)})
        ON CONFLICT (user_id, source_id) DO UPDATE
          SET revoked_at = NULL, granted_at = now(), granted_by = ${lit(by)}
        RETURNING 1
      )
      SELECT count(*)::text FROM ins`;
    console.log(`target: ${target}`);
    if (dryRun) {
      console.log(`DRY RUN -- would grant ${user} -> ${source} (${name})`);
      console.log(sql.trim());
      break;
    }
    const wrote = q(sql)[0]?.[0];
    if (wrote !== "1")
      die(`grant wrote ${wrote ?? "no"} rows, expected 1`, EXIT.OPERATIONAL);
    const label =
      priorState === null
        ? "[new]"
        : priorState === "active"
          ? "[already active, timestamps refreshed]"
          : `[RE-ACTIVATED -- was revoked ${priorState}]`;
    console.log(`granted ${user} -> ${source} (${name}) ${label}`);
    break;
  }

  case "revoke": {
    const user = flag("user") ?? die("revoke needs --user <id>");
    const source = requireUuid(
      flag("source") ?? die("revoke needs --source <uuid>"),
      "--source",
    );
    // Deliberately NOT requiring a live source: a grant to a since-deleted
    // source must still be revocable.
    const sql = `
      WITH upd AS (
        UPDATE staff_source_assignments
        SET revoked_at = now()
        WHERE user_id = ${lit(user)} AND source_id = ${lit(source)}::uuid
          AND revoked_at IS NULL
        RETURNING 1
      )
      SELECT count(*)::text FROM upd`;
    console.log(`target: ${target}`);
    if (dryRun) {
      console.log(`DRY RUN -- would revoke ${user} -> ${source}`);
      console.log(sql.trim());
      break;
    }
    const raw = q(sql)[0]?.[0];
    if (raw === undefined || !/^\d+$/.test(raw)) {
      // Defaulting to 0 here would report the benign "nothing changed" for what
      // is actually an unknown outcome.
      die(
        `revoke returned an unparseable result ('${raw}'); the access state is UNKNOWN. ` +
          "Re-run 'list --user … --revoked' before assuming anything.",
        EXIT.OPERATIONAL,
      );
    }
    if (Number(raw) > 0) {
      console.log(`revoked ${user} -> ${source} (row kept, revoked_at set)`);
      // A direct revoke does not remove client-routed access to the same source.
      const stillVia = clientRoutedSources(user).filter((r) => r[0] === source);
      if (stillVia.length > 0) {
        console.log(
          `WARNING: ${user} STILL has access to ${source} via client assignment ` +
            `'${stillVia[0][1]}'. This tool manages direct grants only.`,
        );
        process.exit(EXIT.ATTENTION);
      }
      break;
    }
    // Zero rows. Four different situations, four different operator actions.
    const existing = q(`
      SELECT coalesce(to_char(revoked_at, 'YYYY-MM-DD HH24:MI'), 'active')
      FROM staff_source_assignments
      WHERE user_id = ${lit(user)} AND source_id = ${lit(source)}::uuid`);
    const sourceExists =
      q(`SELECT 1 FROM sources WHERE id = ${lit(source)}::uuid`).length > 0;
    const stillVia = clientRoutedSources(user).filter((r) => r[0] === source);

    if (existing.length > 0) {
      console.log(
        `no change: grant for ${user} -> ${source} was already revoked ${existing[0][0]}`,
      );
    } else if (!sourceExists) {
      console.log(
        `no grant found, AND source ${source} does not exist -- check the uuid ` +
          "before concluding this user has no access.",
      );
    } else {
      console.log(`no direct grant has ever existed for ${user} -> ${source}`);
    }
    if (stillVia.length > 0) {
      console.log(
        `WARNING: ${user} nonetheless HAS access to ${source} via client assignment ` +
          `'${stillVia[0][1]}'. Nothing was revoked. Revoke the client assignment instead.`,
      );
      process.exit(EXIT.ATTENTION);
    }
    process.exit(EXIT.NOOP);
  }
}
