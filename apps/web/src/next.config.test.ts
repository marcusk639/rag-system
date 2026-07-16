import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.js";

describe("next.config security headers", () => {
  // Content-Security-Policy is intentionally NOT asserted here anymore: it
  // moved to middleware.ts (see middleware.test.ts's "middleware CSP nonce"
  // suite) because the nonce it carries must be generated fresh per request,
  // which next.config.ts's static headers() array cannot do. The four
  // headers below have no per-request state, so they stay static here.
  it("sets X-Frame-Options, HSTS, X-Content-Type-Options, and Referrer-Policy on every route", async () => {
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
    expect(byKey["Content-Security-Policy"]).toBeUndefined();
  });
});
