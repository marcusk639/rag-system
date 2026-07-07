import { describe, expect, it, vi } from "vitest";

vi.mock("./db.js", () => ({
  getWebDb: vi.fn(() => "fake-db-handle"),
}));

vi.mock("@rag/db", async () => {
  const actual = await vi.importActual<typeof import("@rag/db")>("@rag/db");
  return {
    ...actual,
    resolveSourceIdsForUser: vi.fn(async (_db: unknown, userId: string) =>
      userId === "oid-with-access" ? ["src-1", "src-2"] : [],
    ),
  };
});

import { resolveSourceIdsForUser } from "@rag/db";
import { getScopeAssertionToken } from "./scope-token.js";

const SECRET = "test-secret-at-least-32-bytes-long-here";

describe("getScopeAssertionToken", () => {
  it("mints a token embedding the resolved allowedSourceIds", async () => {
    process.env.INTERNAL_SCOPE_JWT_SECRET = SECRET;
    const token = await getScopeAssertionToken("oid-with-access");
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
      { algorithms: ["HS256"] },
    );
    expect(payload.sub).toBe("oid-with-access");
    expect(payload.allowedSourceIds).toEqual(["src-1", "src-2"]);
  });

  it("mints a deny-all token when the user has no assignments", async () => {
    process.env.INTERNAL_SCOPE_JWT_SECRET = SECRET;
    const token = await getScopeAssertionToken("oid-with-no-access");
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
      { algorithms: ["HS256"] },
    );
    expect(payload.allowedSourceIds).toEqual([]);
  });

  it("throws if INTERNAL_SCOPE_JWT_SECRET is not configured (fail loud on misconfig)", async () => {
    delete process.env.INTERNAL_SCOPE_JWT_SECRET;
    await expect(getScopeAssertionToken("oid-with-access")).rejects.toThrow(
      /INTERNAL_SCOPE_JWT_SECRET/,
    );
  });
});
