import { describe, expect, it, vi } from "vitest";
import { checkStaticFallbackMode } from "./instrumentation.js";

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
