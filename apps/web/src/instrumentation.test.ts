import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStaticFallbackMode, register } from "./instrumentation.js";

describe("checkStaticFallbackMode", () => {
  it("logs nothing when WEB_AUTH_MODE is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkStaticFallbackMode({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs nothing when WEB_AUTH_MODE is not 'static-fallback'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkStaticFallbackMode({ WEB_AUTH_MODE: "entra" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns loudly on startup when static-fallback is active", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkStaticFallbackMode({ WEB_AUTH_MODE: "static-fallback" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WEB_AUTH_MODE=static-fallback is ACTIVE"),
    );
    warn.mockRestore();
  });
});

describe("register", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not run the static-fallback check when NEXT_RUNTIME is 'edge', even if static-fallback is active", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NEXT_RUNTIME = "edge";
    process.env.WEB_AUTH_MODE = "static-fallback";
    register();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("runs the static-fallback check in the Node.js runtime (NEXT_RUNTIME unset)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.NEXT_RUNTIME;
    process.env.WEB_AUTH_MODE = "static-fallback";
    register();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WEB_AUTH_MODE=static-fallback is ACTIVE"),
    );
    warn.mockRestore();
  });

  it("runs the static-fallback check in the Node.js runtime (NEXT_RUNTIME='nodejs')", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.WEB_AUTH_MODE = "static-fallback";
    register();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WEB_AUTH_MODE=static-fallback is ACTIVE"),
    );
    warn.mockRestore();
  });
});
