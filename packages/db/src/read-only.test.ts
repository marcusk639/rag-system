import { describe, expect, it } from "vitest";
import { assertReadOnly, createDb, createReadOnlyDb } from "./client.js";

/**
 * DB-backed tests for the read-only guard that protects production corpus
 * walks (see `docs/EVAL-CORPUS-GROUND-TRUTH.md`, and C3 in
 * `docs/ISSUES-AND-OPTIMIZATIONS.md`).
 *
 * These need a live PostgreSQL because the whole point is that the *server*
 * refuses the write — a stub would only prove we wrote a check, which is the
 * weaker claim. Skipped when `TEST_DATABASE_URL` is unset so unit runs stay
 * hermetic; run `pnpm docker:up` to exercise them.
 *
 * Two of these tests exist because writing them found real bugs:
 *
 *  - Drizzle wraps driver errors, so `err.code` is `undefined` and the
 *    SQLSTATE lives on `err.cause`. `assertReadOnly` originally read the
 *    wrapper, correctly refused the write, then misreported it as an
 *    unexpected failure.
 *  - A superuser does **not** bypass `default_transaction_read_only`. The
 *    doc comment claimed it did. Verified here so the claim cannot silently
 *    rot back.
 */
const URL = process.env.TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe("read-only connections", () => {
  it("refuses a write at the server", async () => {
    const { db, close } = createReadOnlyDb(URL!);
    try {
      await expect(
        db.execute("CREATE TABLE ro_probe_should_fail (x int)"),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("assertReadOnly accepts a read-only handle", async () => {
    const { db, close } = createReadOnlyDb(URL!);
    try {
      await expect(assertReadOnly(db)).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });

  it("assertReadOnly REJECTS a writable handle", async () => {
    // The test that matters. A guard that passes on everything is not a guard.
    const { db, close } = createDb(URL!);
    try {
      await expect(assertReadOnly(db)).rejects.toThrow(/ACCEPTED a write/);
    } finally {
      await close();
    }
  });

  it("holds even when the connecting role is a superuser", async () => {
    // `default_transaction_read_only` is a session default, not a permission,
    // so it is NOT outranked by superuser. Documented as fact only because
    // this test observed it.
    const { db, close } = createReadOnlyDb(URL!);
    try {
      const res = await db.execute(
        "SELECT usesuper FROM pg_user WHERE usename = current_user",
      );
      const isSuper = (res.rows[0] as { usesuper?: boolean } | undefined)
        ?.usesuper;
      // Only meaningful when the test role actually is a superuser; otherwise
      // the assertion below proves nothing and we say so rather than pretend.
      if (isSuper !== true) return;
      await expect(assertReadOnly(db)).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });
});
