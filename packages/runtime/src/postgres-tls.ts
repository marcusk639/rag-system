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
  const mode = /[?&]sslmode=([a-z-]+)/.exec(databaseUrl)?.[1];
  return mode !== undefined && mode !== "disable";
}
