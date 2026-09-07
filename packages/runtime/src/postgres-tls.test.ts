import { describe, expect, it } from "vitest";
import { isPostgresTlsActive } from "./postgres-tls.js";

const URL_BASE = "postgres://u:p@host:5432/db";

describe("isPostgresTlsActive", () => {
  it("is false when neither the flag nor the URL asks for TLS", () => {
    expect(isPostgresTlsActive(undefined, URL_BASE)).toBe(false);
  });

  it("counts sslmode=no-verify as TLS — it encrypts, it just skips verification", () => {
    expect(
      isPostgresTlsActive(undefined, `${URL_BASE}?sslmode=no-verify`),
    ).toBe(true);
  });

  it("counts the verifying sslmodes as TLS", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      expect(
        isPostgresTlsActive(undefined, `${URL_BASE}?sslmode=${mode}`),
      ).toBe(true);
    }
  });

  it("treats sslmode=disable as no TLS", () => {
    expect(isPostgresTlsActive(undefined, `${URL_BASE}?sslmode=disable`)).toBe(
      false,
    );
  });

  it("lets an explicit DATABASE_SSL decide, overriding the URL", () => {
    expect(isPostgresTlsActive("no-verify", URL_BASE)).toBe(true);
    expect(isPostgresTlsActive("require", URL_BASE)).toBe(true);
    expect(isPostgresTlsActive("disable", `${URL_BASE}?sslmode=require`)).toBe(
      false,
    );
  });

  it("does not match sslmode as a substring of another parameter", () => {
    expect(isPostgresTlsActive(undefined, `${URL_BASE}?xsslmode=require`)).toBe(
      false,
    );
  });

  // pg-connection-string assigns from URLSearchParams.entries(), so the LAST
  // duplicate wins. Reading the first one reported TLS on a plaintext
  // connection and silenced the production warning.
  it("takes the last sslmode when the parameter is duplicated, as the driver does", () => {
    expect(
      isPostgresTlsActive(
        undefined,
        `${URL_BASE}?sslmode=no-verify&sslmode=disable`,
      ),
    ).toBe(false);
    expect(
      isPostgresTlsActive(
        undefined,
        `${URL_BASE}?sslmode=disable&sslmode=no-verify`,
      ),
    ).toBe(true);
  });

  // The driver's switch is case-sensitive, so a mis-cased mode falls through
  // its cases and TLS is still negotiated. Reporting these as "not active"
  // would warn about an encrypted connection.
  it("reports TLS active for a mis-cased mode, as the driver still negotiates it", () => {
    expect(
      isPostgresTlsActive(undefined, `${URL_BASE}?sslmode=NO-VERIFY`),
    ).toBe(true);
    expect(isPostgresTlsActive(undefined, `${URL_BASE}?sslmode=Disable`)).toBe(
      true,
    );
    expect(isPostgresTlsActive(undefined, `${URL_BASE}?sslmode=disable`)).toBe(
      false,
    );
  });

  it("treats an empty ?sslmode= as absent — the driver leaves it plaintext", () => {
    expect(isPostgresTlsActive(undefined, `${URL_BASE}?sslmode=`)).toBe(false);
  });

  it("warns rather than claims TLS when the string is not a parseable URL", () => {
    expect(
      isPostgresTlsActive(undefined, "host=h dbname=db sslmode=require"),
    ).toBe(false);
  });
});
