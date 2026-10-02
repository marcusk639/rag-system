#!/usr/bin/env node
/**
 * Grant, revoke and inspect per-user source access.
 *
 * WHY THIS EXISTS
 *
 * `staff_source_assignments` is the table the web BFF reads (via
 * `resolveSourceIdsForUser` in @rag/db) to decide what a signed-in staff member
 * may retrieve. Until this script it had schema and a migration but no CLI and
 * no admin route: onboarding a user meant hand-written SQL against a database
 * with no public URL. An empty table is not an open door -- it is the
 * fail-closed deny-all case, so every user saw an empty knowledge base.
 *
 * `check` exists because that failure is silent from the outside: a user with
 * no grants and a user whose grants are wrong both see a knowledge base that
 * answers nothing. `check` runs the same query the BFF runs and reports the
 * resolved scope, so "this user sees nothing" is a visible state.
 *
 * SCOPE OF THIS TOOL -- read before trusting it
 *
 * It manages the DB-backed scope used by the WEB app only. It does NOT touch
 * `API_PRINCIPALS`, the env-var list used for direct API/MCP token access. That
 * distinction matters: `API_PRINCIPALS` has no foreign key, so it CAN hold a
 * source id that no longer exists -- which is exactly what happened when the
 * 2026-08-03 purge rebuilt the corpus under a new source uuid and left two
 * principals scoped to three dead ids, silently returning nothing for weeks.
 * This table cannot develop that fault: `source_id` carries
 * `REFERENCES sources(id) ON DELETE CASCADE`, so a deleted source takes its
 * assignment rows with it (verified empirically, not assumed).
 *
 * SAFETY
 *
 * - Revoke is a soft revoke (`revoked_at = now()`), never a DELETE. The schema
 *   comment on that column says so: the row is the audit trail.
 * - Grant is idempotent and un-revokes. The unique index on
 *   (user_id, source_id) means a re-grant must UPDATE; a plain INSERT would
 *   fail for anyone previously revoked.
 * - `granted_by` is NOT NULL by design, so `--by` is required for a grant.
 * - `--dry-run` prints the statement and changes nothing.
 *
 * Production `DATABASE_URL` resolves rag-postgres.railway.internal, which does
 * not resolve outside Railway's network, and rag-postgres exposes no public
 * URL. Run this from inside Railway; use a restored copy for inspection.
 *
 * Usage:
 *   node scripts/manage-access.mjs sources
 *   node scripts/manage-access.mjs check  --user <idp-user-id>
 *   node scripts/manage-access.mjs list   [--user <id>] [--source <uuid>] [--revoked]
 *   node scripts/manage-access.mjs grant  --user <id> --source <uuid> --by <admin> [--dry-run]
 *   node scripts/manage-access.mjs revoke --user <id> --source <uuid> [--dry-run]
 */

import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : null;
};
const has = (name) => argv.includes(`--${name}`);

const url = flag("url") ?? process.env.DATABASE_URL ?? null;
const dryRun = has("dry-run");

const die = (msg, code = 2) => {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
};

if (!cmd || cmd === "help" || has("help")) {
  console.log(
    [
      "Usage:",
      "  manage-access.mjs sources",
      "  manage-access.mjs check  --user <id>",
      "  manage-access.mjs list   [--user <id>] [--source <uuid>] [--revoked]",
      "  manage-access.mjs grant  --user <id> --source <uuid> --by <admin> [--dry-run]",
      "  manage-access.mjs revoke --user <id> --source <uuid> [--dry-run]",
      "",
      "Connection: --url <conn> or DATABASE_URL.",
    ].join("\n"),
  );
  process.exit(0);
}
if (!url) die("no connection string. Pass --url or set DATABASE_URL.");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEP = "";

/**
 * -q suppresses psql's command tag. Without it a statement like UPDATE emits
 * "UPDATE 0" on stdout, which parses as a data row and makes a zero-row DML
 * look like a success -- that bug shipped in the first draft of this file and
 * was caught by running revoke twice. Mutating statements are additionally
 * wrapped in a CTE that SELECTs a count, so the result shape is unambiguous
 * even if a future psql changes its tag behaviour.
 */
const q = (sql) => {
  try {
    return execFileSync(
      "psql",
      [url, "-At", "-q", "-F", SEP, "-v", "ON_ERROR_STOP=1", "-c", sql],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.split(SEP));
  } catch (err) {
    die(
      `psql failed:\n${(err.stderr || err.message || "").toString().trim()}`,
      1,
    );
  }
};

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const requireLiveSource = (sourceId) => {
  if (!UUID_RE.test(sourceId)) die(`--source must be a uuid, got ${sourceId}`);
  const rows = q(`SELECT name FROM sources WHERE id = ${lit(sourceId)}::uuid`);
  if (rows.length === 0) {
    die(
      `source ${sourceId} does not exist. Run 'sources' to list live ids -- ` +
        `granting a dead id produces a user who silently sees nothing.`,
    );
  }
  return rows[0][0];
};

switch (cmd) {
  case "sources": {
    const rows = q(
      `SELECT s.id, s.kind, s.name,
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
    // Mirrors resolveSourceIdsForUser in @rag/db. Kept in sync by hand; if that
    // query changes, change this one.
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
    console.log(`user: ${user}`);
    if (ids.length === 0) {
      console.log(
        "  resolves to: [] -- DENY-ALL. This user retrieves nothing.",
      );
      console.log(
        "  (an empty scope is the fail-closed case, not unrestricted access)",
      );
      break;
    }
    const live = q(
      `SELECT id::text, name FROM sources
       WHERE id IN (${ids.map((i) => `${lit(i)}::uuid`).join(", ")})`,
    );
    console.log(`  resolves to ${ids.length} source id(s):`);
    for (const id of ids) {
      const row = live.find((r) => r[0] === id);
      console.log(row ? `    ${id}  ${row[1]}` : `    ${id}  <no such source>`);
    }
    break;
  }

  case "list": {
    const user = flag("user");
    const source = flag("source");
    if (source && !UUID_RE.test(source))
      die(`--source must be a uuid, got ${source}`);
    const where = [
      user ? `a.user_id = ${lit(user)}` : null,
      source ? `a.source_id = ${lit(source)}::uuid` : null,
      has("revoked") ? null : "a.revoked_at IS NULL",
    ].filter(Boolean);
    const rows = q(`
      SELECT a.user_id, a.source_id::text, coalesce(s.name, '<missing source>'),
             a.granted_at::date::text, a.granted_by,
             coalesce(a.revoked_at::date::text, '')
      FROM staff_source_assignments a
      LEFT JOIN sources s ON s.id = a.source_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.user_id, s.name
    `);
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
    const source = flag("source") ?? die("grant needs --source <uuid>");
    const by =
      flag("by") ??
      die("grant needs --by <admin-id> (granted_by is the audit trail)");
    const name = requireLiveSource(source);
    // Pre-check rather than RETURNING (xmax = 0): with ON CONFLICT, Postgres
    // uses speculative insertion, which can leave a non-zero xmax on a row it
    // genuinely inserted -- so that trick mislabels a fresh grant as a
    // re-activation. Two statements race in theory; for an admin CLI the
    // accurate label is worth more than the atomicity.
    const prior = q(`
      SELECT coalesce(revoked_at::date::text, 'active')
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
    if (dryRun) {
      console.log(`DRY RUN -- would grant ${user} -> ${source} (${name})`);
      console.log(sql.trim());
      break;
    }
    const wrote = Number(q(sql)[0]?.[0] ?? 0);
    if (wrote !== 1) die(`grant wrote ${wrote} rows, expected 1`, 1);
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
    const source = flag("source") ?? die("revoke needs --source <uuid>");
    if (!UUID_RE.test(source)) die(`--source must be a uuid, got ${source}`);
    // Soft revoke only. schema.ts: "Null = active. Set to now() to revoke.
    // Never DELETE." The row is the record of who had access and when.
    const sql = `
      WITH upd AS (
        UPDATE staff_source_assignments
        SET revoked_at = now()
        WHERE user_id = ${lit(user)} AND source_id = ${lit(source)}::uuid
          AND revoked_at IS NULL
        RETURNING 1
      )
      SELECT count(*)::text FROM upd`;
    if (dryRun) {
      console.log(`DRY RUN -- would revoke ${user} -> ${source}`);
      console.log(sql.trim());
      break;
    }
    const affected = Number(q(sql)[0]?.[0] ?? 0);
    if (affected === 0) {
      console.log(`no ACTIVE grant for ${user} -> ${source}; nothing changed`);
      process.exit(1);
    }
    console.log(`revoked ${user} -> ${source} (row kept, revoked_at set)`);
    break;
  }

  default:
    die(`unknown command '${cmd}'. Run with --help.`);
}
