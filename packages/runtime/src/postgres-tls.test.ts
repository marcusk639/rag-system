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
});
