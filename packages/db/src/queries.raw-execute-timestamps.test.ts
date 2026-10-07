import { describe, expect, it } from "vitest";
import {
  listAssignmentHistoryForStaff,
  listSourceAssignmentHistoryForStaff,
  type StaffAssignmentHistoryRow,
  type StaffSourceAssignmentHistoryRow,
} from "./queries.js";
import type { Db } from "./client.js";

/**
 * A raw `db.execute()` hands back Postgres' WIRE STRING for a timestamp, never
 * a `Date`.
 *
 * drizzle's `NodePgPreparedQuery` installs a per-query `types.getTypeParser`
 * that returns `(val) => val` for TIMESTAMPTZ, TIMESTAMP, DATE and INTERVAL
 * (see `drizzle-orm/node-postgres/session.js`, `rawQueryConfig`), so that a
 * drizzle column's own `mapFromDriverValue` can own the conversion. A raw
 * execute has no column type to apply, so nothing converts it. Bare
 * node-postgres WOULD parse it to a Date — which is why this is so easy to get
 * wrong, and why both of these row types were declared `Date` for as long as
 * they have existed.
 *
 * Nothing crashed because both consumers already wrap defensively
 * (`manage-access.ts`'s `stamp`, and `SourceAccessHistoryForm` in
 * `apps/web/src/app/admin/access/access-forms.tsx`, which calls
 * `new Date(...)`). `manage-access.ts` documented the wrong declaration and
 * asked for "a regression test [...] with a fix to the declaration" — this is
 * that test.
 *
 * The format is also NOT ISO-8601 (`2026-10-06 00:00:00+00` — a space, not a
 * `T`), so a `z.string().datetime()` boundary would reject it.
 */

/** The exact shape of a timestamptz on the wire. */
const WIRE = "2026-10-06 00:00:00+00";

/**
 * Type-level guards. These are the only thing that catches a re-declaration:
 * both mappings are pass-throughs, so a test stubbing a `Date` would satisfy
 * either typing and the suite would defend whichever shape is declared. These
 * fail at `pnpm typecheck`, before anything reaches production.
 */
const _grantedAtIsAWireString: StaffAssignmentHistoryRow["grantedAt"] = WIRE;
const _revokedAtIsAWireString: StaffAssignmentHistoryRow["revokedAt"] = WIRE;
const _srcGrantedAtIsAWireString: StaffSourceAssignmentHistoryRow["grantedAt"] =
  WIRE;
const _srcRevokedAtIsAWireString: StaffSourceAssignmentHistoryRow["revokedAt"] =
  WIRE;
void _grantedAtIsAWireString;
void _revokedAtIsAWireString;
void _srcGrantedAtIsAWireString;
void _srcRevokedAtIsAWireString;

function dbReturning(rows: unknown[]): Db {
  return {
    execute: async () => ({ rows }),
  } as unknown as Db;
}

describe("listAssignmentHistoryForStaff — raw-execute timestamps", () => {
  it("passes the wire string through untouched", async () => {
    // Asserts the VALUE, not just the type: a future "fix" that wrapped these
    // in `new Date(...)` would change what every caller receives (and what an
    // API response serializes), so it must not pass silently.
    const out = await listAssignmentHistoryForStaff(
      dbReturning([
        {
          client_id: "c1",
          granted_at: WIRE,
          granted_by: "admin@example.com",
          revoked_at: null,
        },
      ]),
      "u1",
    );

    expect(out).toEqual([
      {
        clientId: "c1",
        grantedAt: WIRE,
        grantedBy: "admin@example.com",
        revokedAt: null,
      },
    ]);
    expect(out[0]!.grantedAt).not.toBeInstanceOf(Date);
  });

  it("passes a revoked_at wire string through as well", async () => {
    const out = await listAssignmentHistoryForStaff(
      dbReturning([
        {
          client_id: "c1",
          granted_at: WIRE,
          granted_by: "admin@example.com",
          revoked_at: "2026-10-07 09:30:00+00",
        },
      ]),
      "u1",
    );

    expect(out[0]!.revokedAt).toBe("2026-10-07 09:30:00+00");
    expect(out[0]!.revokedAt).not.toBeInstanceOf(Date);
  });
});

describe("listSourceAssignmentHistoryForStaff — raw-execute timestamps", () => {
  it("passes the wire string through untouched", async () => {
    const out = await listSourceAssignmentHistoryForStaff(
      dbReturning([
        {
          source_id: "s1",
          granted_at: WIRE,
          granted_by: "admin@example.com",
          revoked_at: null,
        },
      ]),
      "u1",
    );

    expect(out).toEqual([
      {
        sourceId: "s1",
        grantedAt: WIRE,
        grantedBy: "admin@example.com",
        revokedAt: null,
      },
    ]);
    expect(out[0]!.grantedAt).not.toBeInstanceOf(Date);
  });
});
