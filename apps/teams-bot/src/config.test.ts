import { describe, expect, it } from "vitest";
import { loadBotConfig } from "./config.js";

const BASE = {
  MICROSOFT_APP_ID: "app-id",
  MICROSOFT_APP_PASSWORD: "app-pw",
  MICROSOFT_APP_TENANT_ID: "tenant-id",
  BOT_ENTRA_SSO_SCOPE: "api://botid-app-id/access_as_user",
  BOT_OAUTH_CONNECTION_NAME: "kb-bot-sso",
  INTERNAL_SCOPE_JWT_SECRET: "a".repeat(64),
  RAG_API_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://rag:rag@localhost:5432/rag",
};

describe("loadBotConfig", () => {
  it("loads a valid env", () => {
    expect(loadBotConfig(BASE).ragApiUrl).toBe("http://localhost:3000");
  });
  it("throws naming the missing var", () => {
    const { RAG_API_URL: _omit, ...rest } = BASE;
    expect(() => loadBotConfig(rest)).toThrow(/RAG_API_URL/);
  });
  it("requires BOT_OAUTH_CONNECTION_NAME (the Azure Bot OAuth connection setting name)", () => {
    const { BOT_OAUTH_CONNECTION_NAME: _omit, ...rest } = BASE;
    expect(() => loadBotConfig(rest)).toThrow(/BOT_OAUTH_CONNECTION_NAME/);
  });
  it("rejects an INTERNAL_SCOPE_JWT_SECRET shorter than 64 chars", () => {
    expect(() =>
      loadBotConfig({ ...BASE, INTERNAL_SCOPE_JWT_SECRET: "a".repeat(63) }),
    ).toThrow(/64/);
  });
});
