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
    loadConfig({ ...BASE_ENV, COMPLIANCE_MODE: "none" }, { checkDpa: () => { called = true; return false; } });
    expect(called).toBe(false);
  });
});
