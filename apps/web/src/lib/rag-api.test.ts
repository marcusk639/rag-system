import { describe, expect, it, afterEach } from "vitest";
import { resolveBearerToken } from "./rag-api.js";

describe("resolveBearerToken — WEB_AUTH_MODE rollback flag", () => {
  afterEach(() => {
    delete process.env.WEB_AUTH_MODE;
    delete process.env.RAG_API_STATIC_FALLBACK_TOKEN;
  });

  it("uses the per-user scope token by default (entra mode)", () => {
    const result = resolveBearerToken({ scopeToken: "scope-jwt" });
    expect(result).toBe("scope-jwt");
  });

  it("uses the static fallback token when WEB_AUTH_MODE=static-fallback", () => {
    process.env.WEB_AUTH_MODE = "static-fallback";
    process.env.RAG_API_STATIC_FALLBACK_TOKEN = "emergency-static-token";
    const result = resolveBearerToken({ scopeToken: "scope-jwt" });
    expect(result).toBe("emergency-static-token");
  });

  it("throws if static-fallback mode is set but no fallback token is configured", () => {
    process.env.WEB_AUTH_MODE = "static-fallback";
    expect(() => resolveBearerToken({ scopeToken: "scope-jwt" })).toThrow(
      /RAG_API_STATIC_FALLBACK_TOKEN/,
    );
  });
});
