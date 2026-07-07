import { describe, expect, it, afterEach, vi } from "vitest";
import { resolveRequestBearerToken } from "./rag-api.js";

describe("resolveRequestBearerToken — WEB_AUTH_MODE gating", () => {
  afterEach(() => {
    delete process.env.WEB_AUTH_MODE;
    delete process.env.RAG_API_STATIC_FALLBACK_TOKEN;
    vi.restoreAllMocks();
  });

  describe("default (entra) mode", () => {
    it("401s without calling getScopeToken when there is no session", async () => {
      const getSession = vi.fn().mockResolvedValue(null);
      const getScopeToken = vi.fn();

      const result = await resolveRequestBearerToken(getSession, getScopeToken);

      expect(result.errorResponse).toBeDefined();
      expect(result.errorResponse?.status).toBe(401);
      const body = await result.errorResponse?.json();
      expect(body.error.code).toBe("UNAUTHENTICATED");
      expect(getScopeToken).not.toHaveBeenCalled();
    });

    it("401s when the session has no oid", async () => {
      const getSession = vi.fn().mockResolvedValue({ oid: undefined });
      const getScopeToken = vi.fn();

      const result = await resolveRequestBearerToken(getSession, getScopeToken);

      expect(result.errorResponse?.status).toBe(401);
      expect(getScopeToken).not.toHaveBeenCalled();
    });

    it("mints and returns a per-user scope token when a session exists", async () => {
      const getSession = vi.fn().mockResolvedValue({ oid: "user-oid-123" });
      const getScopeToken = vi.fn().mockResolvedValue("scope-jwt");

      const result = await resolveRequestBearerToken(getSession, getScopeToken);

      expect(result.token).toBe("scope-jwt");
      expect(result.errorResponse).toBeUndefined();
      expect(getScopeToken).toHaveBeenCalledWith("user-oid-123");
    });
  });

  describe("static-fallback mode", () => {
    it("returns the shared static token WITHOUT ever calling getSession/getScopeToken", async () => {
      process.env.WEB_AUTH_MODE = "static-fallback";
      process.env.RAG_API_STATIC_FALLBACK_TOKEN = "emergency-static-token";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const getSession = vi.fn().mockResolvedValue(null);
      const getScopeToken = vi.fn();

      const result = await resolveRequestBearerToken(getSession, getScopeToken);

      expect(result.token).toBe("emergency-static-token");
      expect(result.errorResponse).toBeUndefined();
      expect(getSession).not.toHaveBeenCalled();
      expect(getScopeToken).not.toHaveBeenCalled();
    });

    it("bypasses the session gate even when there is no session at all (the scenario the flag exists for)", async () => {
      process.env.WEB_AUTH_MODE = "static-fallback";
      process.env.RAG_API_STATIC_FALLBACK_TOKEN = "emergency-static-token";
      // Simulates Entra ID being totally broken: auth() would never resolve
      // a session. The fallback path must not depend on it at all.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const getSession = vi.fn().mockResolvedValue(null);
      const getScopeToken = vi.fn();

      const result = await resolveRequestBearerToken(getSession, getScopeToken);

      expect(result.token).toBe("emergency-static-token");
      expect(result.errorResponse).toBeUndefined();
    });

    it("logs a warning each time the fallback path actually serves a request", async () => {
      process.env.WEB_AUTH_MODE = "static-fallback";
      process.env.RAG_API_STATIC_FALLBACK_TOKEN = "emergency-static-token";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const getSession = vi.fn();
      const getScopeToken = vi.fn();

      await resolveRequestBearerToken(getSession, getScopeToken);
      await resolveRequestBearerToken(getSession, getScopeToken);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0][0]).toMatch(/static-fallback/i);
    });

    it("returns a structured 500 CONFIG_ERROR (not a thrown exception) when the fallback token is unset", async () => {
      process.env.WEB_AUTH_MODE = "static-fallback";
      const getSession = vi.fn();
      const getScopeToken = vi.fn();

      const result = await resolveRequestBearerToken(getSession, getScopeToken);

      expect(result.token).toBeUndefined();
      expect(result.errorResponse).toBeDefined();
      expect(result.errorResponse?.status).toBe(500);
      const body = await result.errorResponse?.json();
      expect(body.error.code).toBe("CONFIG_ERROR");
      expect(body.error.message).toMatch(/RAG_API_STATIC_FALLBACK_TOKEN/);
      // Never touches session/scope-token machinery on this path either.
      expect(getSession).not.toHaveBeenCalled();
      expect(getScopeToken).not.toHaveBeenCalled();
    });

    it("does not log the fallback-usage warning when the fallback token is missing", async () => {
      process.env.WEB_AUTH_MODE = "static-fallback";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await resolveRequestBearerToken(vi.fn(), vi.fn());

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
