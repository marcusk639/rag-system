/**
 * Whether the Postgres connection will actually be encrypted.
 *
 * `no-verify` counts: it negotiates TLS and only skips certificate
 * verification. Omitting it from this check is what made the production
 * warning fire against an encrypted connection.
 *
 * ⚠ `sslmode=require` is NOT a safe default here. `pg-connection-string` >= 2.10
 * treats `prefer`/`require`/`verify-ca` as aliases for `verify-full` (see its
 * `deprecatedSslModeWarning`), so `require` against a self-signed server cert —
 * which is what Railway's `postgres-ssl` image serves — fails the connection
 * outright rather than encrypting it. Use `no-verify`, or
 * `uselibpqcompat=true&sslmode=require` for libpq semantics.
 */
export function isPostgresTlsActive(
  databaseSsl: "disable" | "require" | "no-verify" | undefined,
  databaseUrl: string,
): boolean {
  if (databaseSsl) return databaseSsl !== "disable";
  const mode = readSslMode(databaseUrl);
  return mode !== undefined && mode !== "disable";
}

/**
 * The effective `sslmode`, read the way the driver reads it.
 *
 * `pg-connection-string` assigns from `URLSearchParams.entries()`, so with a
 * duplicated parameter the LAST one wins. A regex taking the first match
 * disagreed with the driver in both directions — `?sslmode=no-verify&sslmode=disable`
 * reported TLS on a connection the driver leaves in plaintext, silencing the
 * production warning, and the reverse order warned about an encrypted one.
 * Matching on `URLSearchParams` keeps this in step with the driver by
 * construction. The value is NOT lower-cased, because the driver's `switch` is
 * case-sensitive: it does not recognise `sslmode=Disable` as disable and so
 * still negotiates TLS. Normalising the case here would report that connection
 * as unencrypted and emit a warning about an encrypted link — the same
 * cry-wolf failure this module was extracted to remove.
 *
 * Returns undefined when no mode is present, or when the string is not a URL
 * (libpq keyword/value form) — the caller then warns, which is the safe
 * direction to be wrong in.
 */
function readSslMode(databaseUrl: string): string | undefined {
  try {
    // getAll().at(-1), not get(): `get` returns the FIRST value for a repeated
    // key, which is the disagreement this function is here to remove.
    const all = new URL(databaseUrl).searchParams.getAll("sslmode");
    // `|| undefined` folds an empty `?sslmode=` in with "absent": the driver
    // only enables TLS when sslmode is truthy, so an empty value connects in
    // plaintext and must still warn.
    return all.at(-1)?.trim() || undefined;
  } catch {
    return undefined;
  }
}
