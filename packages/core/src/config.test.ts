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
