import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  API_TOKENS: "tok1",
} as NodeJS.ProcessEnv;

describe("loadConfig — PARSER_SECRET production gate", () => {
  it("development (default) does not require PARSER_SECRET", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.environment).toBe("development");
    expect(cfg.parser.secret).toBeUndefined();
  });

  it("test env does not require PARSER_SECRET", () => {
    const cfg = loadConfig({ ...BASE_ENV, NODE_ENV: "test" });
    expect(cfg.environment).toBe("test");
  });

  it("production WITHOUT PARSER_SECRET fails loud", () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: "production" })).toThrow(
      /PARSER_SECRET is required in production/,
    );
  });

  it("production WITH PARSER_SECRET loads", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      PARSER_SECRET: "shared-secret",
    });
    expect(cfg.environment).toBe("production");
    expect(cfg.parser.secret).toBe("shared-secret");
  });
});

describe("loadConfig — COMPLIANCE_MODE gate", () => {
  it("defaults to 'none' and does not check DPA", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.complianceMode).toBe("none");
  });

  it("client-data WITHOUT DPA on file throws loud", () => {
    expect(() =>
      loadConfig(
        { ...BASE_ENV, COMPLIANCE_MODE: "client-data" },
        { checkDpa: () => false },
      ),
    ).toThrow(/COMPLIANCE_MODE=client-data requires a signed DPA/);
  });

  it("client-data WITH DPA on file loads successfully", () => {
    const cfg = loadConfig(
      { ...BASE_ENV, COMPLIANCE_MODE: "client-data" },
      { checkDpa: () => true },
    );
    expect(cfg.complianceMode).toBe("client-data");
  });

  it("none mode does not invoke checkDpa at all", () => {
    let called = false;
    loadConfig(
      { ...BASE_ENV, COMPLIANCE_MODE: "none" },
      {
        checkDpa: () => {
          called = true;
          return false;
        },
      },
    );
    expect(called).toBe(false);
  });
});

describe("loadConfig — INTERNAL_SCOPE_JWT_SECRETS", () => {
  it("defaults to an empty array when unset", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.auth.internalScopeSecrets).toEqual([]);
  });

  it("parses a single secret", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "secret-one",
    });
    expect(cfg.auth.internalScopeSecrets).toEqual(["secret-one"]);
  });

  it("parses multiple comma-separated secrets (rotation) and trims whitespace", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "secret-one, secret-two , secret-three",
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([
      "secret-one",
      "secret-two",
      "secret-three",
    ]);
  });

  it("filters out empty entries from trailing/double commas", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "secret-one,,",
    });
    expect(cfg.auth.internalScopeSecrets).toEqual(["secret-one"]);
  });
});

describe("loadConfig — DOCS_GAP_DIGEST_* (Phase 4 documentation-gap digest)", () => {
  it("defaults to weekly Monday 6am UTC with a 0.3 score threshold when unset", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.docsGapDigest).toEqual({
      cron: "0 6 * * 1",
      tz: "UTC",
      minScore: 0.3,
    });
  });

  it("overrides cron/tz/minScore from env", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      DOCS_GAP_DIGEST_CRON: "0 0 * * *",
      DOCS_GAP_DIGEST_TZ: "America/Chicago",
      DOCS_GAP_DIGEST_MIN_SCORE: "0.5",
    });
    expect(cfg.docsGapDigest).toEqual({
      cron: "0 0 * * *",
      tz: "America/Chicago",
      minScore: 0.5,
    });
  });

  it("DOCS_GAP_DIGEST_MIN_SCORE=0 is a legitimate boundary value, not 'unset'", () => {
    const cfg = loadConfig({ ...BASE_ENV, DOCS_GAP_DIGEST_MIN_SCORE: "0" });
    expect(cfg.docsGapDigest.minScore).toBe(0);
  });

  it("a non-numeric DOCS_GAP_DIGEST_MIN_SCORE fails loud rather than silently coercing", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DOCS_GAP_DIGEST_MIN_SCORE: "not-a-number" }),
    ).toThrow();
  });

  it("an out-of-range DOCS_GAP_DIGEST_MIN_SCORE (outside 0-1) fails loud", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DOCS_GAP_DIGEST_MIN_SCORE: "1.5" }),
    ).toThrow();
  });
});
