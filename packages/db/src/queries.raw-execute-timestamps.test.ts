import { describe, expect, expectTypeOf, it } from "vitest";
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
 * Nothing crashed because every consumer already tolerates either shape:
 * `manage-access.ts`'s `stamp` takes `Date | string | null`; both
 * `SourceAccessHistoryForm` and `AccessHistoryForm` in
 * `apps/web/src/app/admin/access/access-forms.tsx` wrap in `new Date(...)`;
 * and the two server actions in `apps/web/src/app/admin/access/actions.ts`
 * re-export these row types across an RSC boundary that was already carrying
 * the string.
 *
 * The format is also NOT ISO-8601 (`2026-10-06 00:00:00+00` — a space, not a
 * `T`), so a `z.string().datetime()` boundary would reject it.
 */

/** The exact shape of a timestamptz on the wire. */
const WIRE = "2026-10-06 00:00:00+00";

/**
 * Type-level guards — the only thing that catches a re-declaration, because
 * both mappings are pass-throughs: a runtime test stubbing a `Date` satisfies
 * either typing, so the suite would defend whichever shape were declared.
 *
 * `toEqualTypeOf`, not a bare `const x: T = WIRE` assignment. An assignment
 * only proves the declared type ACCEPTS a string, so it passes for
 * `Date | string`, `unknown` and `any` — and widening to `Date | string` is by
 * far the likeliest regression here, since `stamp` is typed that way and the
 * note on it argues for keeping the union. An exact-type assertion is
 * two-sided and rejects the hedge.
 *
 * These fire under plain `tsc`, so `pnpm typecheck`, `pnpm build` (this
 * package's tsconfig includes `src/**` and build is a real emit) and therefore
 * pre-push and CI all catch a regression. `vitest run` does NOT — there is no
 * `typecheck` block in the vitest config — and `expectTypeOf` is a runtime
 * no-op, so it costs the suite nothing.
 */
expectTypeOf<StaffAssignmentHistoryRow["grantedAt"]>().toEqualTypeOf<string>();
expectTypeOf<StaffAssignmentHistoryRow["revokedAt"]>().toEqualTypeOf<
  string | null
>();
expectTypeOf<
  StaffSourceAssignmentHistoryRow["grantedAt"]
>().toEqualTypeOf<string>();
expectTypeOf<StaffSourceAssignmentHistoryRow["revokedAt"]>().toEqualTypeOf<
  string | null
>();

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
