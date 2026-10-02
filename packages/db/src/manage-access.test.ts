import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "./manage-access.js";

/**
 * `parseArgs` carries two safety properties that nothing else verifies, and
 * both fail silently if broken:
 *
 *  - An unrecognised flag must be fatal. A mistyped `--url` otherwise falls
 *    through to `process.env.DATABASE_URL` — i.e. to production — and a
 *    mistyped boolean flag is simply ignored.
 *  - A flag value must be non-empty. `--by "$ADMIN"` with an unset variable
 *    would otherwise write `granted_by = ''` into the audit trail, which is
 *    exactly what `--by` exists to prevent.
 *
 * Same shape of risk as `migrate-entrypoint.test.ts` in this package: the
 * failure is not a crash, it is a wrong thing done quietly. `parseArgs` is
 * exported and `die` throws `UsageError` rather than calling `process.exit`
 * precisely so this can be asserted without stubbing the process.
 */
describe("parseArgs", () => {
  const ok = (argv: string[]) => parseArgs(argv);

  it("accepts a well-formed command", () => {
    const { cmd, values, bools } = ok([
      "grant",
      "--user",
      "u1",
      "--source",
      "s",
      "--by",
      "a",
    ]);
    expect(cmd).toBe("grant");
    expect(values.get("user")).toBe("u1");
    expect(values.get("by")).toBe("a");
    expect(bools.size).toBe(0);
  });

  it("records a boolean flag without consuming a value", () => {
    const { values, bools } = ok(["list", "--user", "u1", "--revoked"]);
    expect(bools.has("revoked")).toBe(true);
    expect(values.get("user")).toBe("u1");
  });

  it("rejects an unknown command", () => {
    expect(() => ok(["frobnicate"])).toThrow(UsageError);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    // The mistyped-`--url`-hits-production case.
    expect(() => ok(["check", "--user", "u", "--urll", "x"])).toThrow(
      /unknown flag/,
    );
  });

  it("rejects a flag that is valid for another command", () => {
    // `--by` belongs to grant, not revoke.
    expect(() =>
      ok(["revoke", "--user", "u", "--source", "s", "--by", "a"]),
    ).toThrow(/unknown flag/);
  });

  it("rejects --flag=value instead of reading it as truthy", () => {
    expect(() => ok(["grant", "--dry-run=true"])).toThrow(/use '--flag value'/);
  });

  it("rejects an empty value", () => {
    expect(() =>
      ok(["grant", "--user", "", "--source", "s", "--by", "a"]),
    ).toThrow(/non-empty/);
    expect(() =>
      ok(["grant", "--user", "u", "--source", "s", "--by", ""]),
    ).toThrow(/non-empty/);
  });

  it("rejects a missing value at end of argv", () => {
    expect(() => ok(["check", "--user"])).toThrow(/needs a non-empty value/);
  });

  it("rejects a value that is actually the next flag", () => {
    expect(() => ok(["grant", "--user", "--by", "a"])).toThrow(
      /needs a non-empty value/,
    );
  });

  it("rejects a repeated flag rather than silently picking one", () => {
    expect(() => ok(["check", "--user", "a", "--user", "b"])).toThrow(
      /more than once/,
    );
  });

  it("rejects a bare positional argument", () => {
    expect(() => ok(["check", "--user", "u", "stray"])).toThrow(
      /unexpected argument/,
    );
  });
});
