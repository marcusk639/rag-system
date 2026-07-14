import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.js";

describe("next.config security headers", () => {
  it("sets CSP, X-Frame-Options, HSTS, and X-Content-Type-Options on every route", async () => {
    expect(nextConfig.headers).toBeDefined();
    const rules = await nextConfig.headers!();
    expect(rules.length).toBeGreaterThan(0);

    const allRoutes = rules.find((r) => r.source === "/(.*)");
    expect(allRoutes).toBeDefined();

    const byKey = Object.fromEntries(
      allRoutes!.headers.map((h) => [h.key, h.value]),
    );

    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Strict-Transport-Security"]).toContain("max-age=");
    expect(byKey["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(byKey["Content-Security-Policy"]).toContain("default-src 'self'");
  });
});
