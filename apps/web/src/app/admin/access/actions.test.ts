import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admin-check", () => ({ isAdmin: vi.fn() }));
vi.mock("@/lib/graph-client", () => ({ resolveOidByEmail: vi.fn() }));
vi.mock("@/lib/db", () => ({ getWebDb: vi.fn(() => "fake-db") }));
vi.mock("@rag/db", async () => {
  const actual = await vi.importActual<typeof import("@rag/db")>("@rag/db");
  return {
    ...actual,
    grantClientAccess: vi.fn(),
    revokeClientAccess: vi.fn(),
  };
});

import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { resolveOidByEmail } from "@/lib/graph-client";
import { grantClientAccess, revokeClientAccess } from "@rag/db";
import { grantAccessAction, revokeAccessAction } from "./actions.js";

beforeEach(() => {
  // Reset mock call history between tests — without this, `grantClientAccess`
  // and `revokeClientAccess` call counts leak across tests within this file
  // (vitest doesn't clear mocks between tests by default; see the convention
  // established in graph-client.test.ts's `fetchMock.mockReset()`).
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({
    oid: "admin-oid-1",
    groups: [],
    hasGroupsOverage: false,
    user: {},
    expires: "",
  } as never);
  vi.mocked(isAdmin).mockResolvedValue(true);
});

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("grantAccessAction", () => {
  it("resolves the target email to an oid and grants access", async () => {
    vi.mocked(resolveOidByEmail).mockResolvedValue("target-oid-1");
    const result = await grantAccessAction(
      fd({ email: "jane@firm.com", clientId: "acme-2024" }),
    );
    expect(grantClientAccess).toHaveBeenCalledWith("fake-db", {
      userId: "target-oid-1",
      clientId: "acme-2024",
      grantedBy: "admin-oid-1",
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns an error when the email doesn't resolve to a known user", async () => {
    vi.mocked(resolveOidByEmail).mockResolvedValue(null);
    const result = await grantAccessAction(
      fd({ email: "nobody@firm.com", clientId: "acme-2024" }),
    );
    expect(result).toEqual({
      ok: false,
      error: "No Entra ID user found for nobody@firm.com",
    });
    expect(grantClientAccess).not.toHaveBeenCalled();
  });

  it("rejects when the caller is not an admin (defense in depth beyond page-level gating)", async () => {
    vi.mocked(isAdmin).mockResolvedValue(false);
    const result = await grantAccessAction(
      fd({ email: "jane@firm.com", clientId: "acme-2024" }),
    );
    expect(result).toEqual({ ok: false, error: "Forbidden" });
    expect(grantClientAccess).not.toHaveBeenCalled();
  });
});

describe("revokeAccessAction", () => {
  it("resolves the target email and revokes access", async () => {
    vi.mocked(resolveOidByEmail).mockResolvedValue("target-oid-1");
    const result = await revokeAccessAction(
      fd({ email: "jane@firm.com", clientId: "acme-2024" }),
    );
    expect(revokeClientAccess).toHaveBeenCalledWith("fake-db", {
      userId: "target-oid-1",
      clientId: "acme-2024",
    });
    expect(result).toEqual({ ok: true });
  });
});
