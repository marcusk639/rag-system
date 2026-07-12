import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_CHUNK_TRIGGERS,
  REQUIRED_SEARCH_INDEXES,
} from "./required-indexes.js";

/**
 * Regression guard against the codebase's #1 fragility: the HNSW + GIN indexes
 * and the chunks_tsv_update trigger are owned by 0000_init.sql but are INVISIBLE
 * to the Drizzle model, so `drizzle-kit generate` will diff them as "removed"
 * and emit DROP statements into a new migration. Applying that silently degrades
 * retrieval with no error and no other failing test.
 *
 * This test scans every migration EXCEPT the owner (0000_init.sql) and fails if
 * any of them drops a protected object — turning that silent footgun into a
 * loud `pnpm test` failure at PR time.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");

/** The migration that legitimately owns (and re-creates) the protected objects. */
const OWNER_MIGRATION = "0000_init.sql";

const PROTECTED_OBJECTS = [
  ...REQUIRED_SEARCH_INDEXES,
  ...REQUIRED_CHUNK_TRIGGERS,
] as const;

/** Match `DROP INDEX`/`DROP TRIGGER [IF EXISTS] [schema.]<name>` for a protected object. */
function dropStatementsFor(sqlText: string, objectName: string): boolean {
  const escaped = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `drop\\s+(index|trigger)\\s+(if\\s+exists\\s+)?("?[\\w]+"?\\.)?"?${escaped}"?`,
    "i",
  );
  return re.test(sqlText);
}

describe("drizzle migration guard — protected search objects", () => {
  it("no generated migration drops the HNSW/GIN indexes or the tsv trigger", async () => {
    const entries = await readdir(MIGRATIONS_DIR);
    const sqlFiles = entries.filter(
      (f) => f.endsWith(".sql") && f !== OWNER_MIGRATION,
    );

    const violations: string[] = [];
    for (const file of sqlFiles) {
      const text = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      for (const obj of PROTECTED_OBJECTS) {
        if (dropStatementsFor(text, obj)) {
          violations.push(`${file} drops protected object "${obj}"`);
        }
      }
    }

    expect(
      violations,
      `A migration drops an object owned by ${OWNER_MIGRATION}. ` +
        `These objects are invisible to Drizzle, so "drizzle-kit generate" ` +
        `emits DROP statements for them. Remove the DROP(s) from the generated ` +
        `migration (the search indexes/trigger must survive), then re-run. ` +
        `Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("still scans at least one non-owner migration (guard is actually wired)", async () => {
    // Sanity: if the drizzle dir layout changes and we accidentally scan
    // nothing, this catches it so the guard can't silently become a no-op.
    const entries = await readdir(MIGRATIONS_DIR);
    const nonOwner = entries.filter(
      (f) => f.endsWith(".sql") && f !== OWNER_MIGRATION,
    );
    expect(nonOwner.length).toBeGreaterThan(0);
  });
});

/**
 * Regression guard for the migration-timestamp-ordering bug (found 2026-07-06,
 * fixed 2026-07-08): drizzle-orm's migrator applies a migration only if its
 * journal `when` exceeds the single most-recently-recorded timestamp, not
 * "has this specific migration run yet." A journal entry with a `when` smaller
 * than an earlier entry's causes every migration after it to be silently
 * skipped on any environment that migrates incrementally (exactly what a
 * `preDeployCommand` running on every deploy does) — invisible on a cold
 * start against an empty database, which is why it went unnoticed twice.
 */
describe("drizzle migration guard — journal timestamp ordering", () => {
  it("every journal entry's 'when' is strictly greater than the previous entry's", async () => {
    const journalPath = join(MIGRATIONS_DIR, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };

    const violations: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const curr = journal.entries[i]!;
      if (!(curr.when > prev.when)) {
        violations.push(
          `entry ${curr.idx} (${curr.tag}, when=${curr.when}) is not greater than entry ${prev.idx} (${prev.tag}, when=${prev.when})`,
        );
      }
    }

    expect(
      violations,
      `Journal entries must have strictly increasing 'when' values in file order, ` +
        `or drizzle-orm's migrator will silently skip migrations on an incremental ` +
        `apply. Check every existing entry's 'when' (not just the immediately-preceding ` +
        `one) before hand-authoring a new one. Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
